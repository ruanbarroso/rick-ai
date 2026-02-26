import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Connector, ConnectorCapabilities, IncomingMessage as AgentIncomingMessage, SendMessageOptions } from "./types.js";
import type { ConnectorManager } from "./connector-manager.js";
import type { WhatsAppConnector } from "./whatsapp.js";
import type { MediaAttachment } from "../llm/types.js";
import { httpServer } from "../health.js";
import { config } from "../config/env.js";
import { configSet, SETTINGS_KEY_MAP } from "../memory/config-store.js";
import { isPostgres, query } from "../memory/database.js";
import { logger } from "../config/logger.js";
import { ClaudeOAuthService } from "../auth/claude-oauth.js";
import { OpenAIOAuthService } from "../auth/openai-oauth.js";
import { GeminiProvider } from "../llm/providers/gemini.js";

/**
 * Web UI connector using WebSocket on the shared HTTP server.
 *
 * Handles:
 * - Chat messages (text, audio, image)
 * - Settings management (read/write .env)
 * - Sub-agent session listing
 * - Edit mode activation
 * - WhatsApp QR code forwarding
 */

interface AuthenticatedClient {
  ws: WebSocket;
  authenticated: boolean;
}

/**
 * Interface for the Agent methods the WebConnector needs.
 * Avoids circular imports by using a minimal type.
 */
export interface WebAgentBridge {
  /** Get sub-agent sessions for the UI */
  getSessionsForUI(): Array<{
    id: string;
    state: string;
    taskDescription: string;
    createdAt: number;
  }>;
  /** Kill a sub-agent session */
  killSession(sessionId: string): Promise<void>;
  /** Send a message to a sub-agent session (follow-up) */
  sendToSession(sessionId: string, message: string): Promise<void>;
  /** Check if edit mode is active */
  isEditModeActive(): boolean;
  /** Start edit mode (returns error message or empty string on success) */
  startEditMode(connectorName: string, userId: string): Promise<string>;
  /** Stop edit mode (returns error message or empty string on success) */
  stopEditMode(): Promise<string>;
  /** Get conversation history for a user */
  getConversationHistory(userPhone: string, limit?: number): Promise<Array<{ role: string; content: string; audio_url?: string; image_urls?: string[]; message_type?: string }>>;
  /** Get message history for a sub-agent session */
  getSessionHistory(sessionId: string): Promise<Array<{ role: string; content: string; created_at: string; message_type?: string }>>;
  /** Get message history for the active edit session */
  getEditHistory(): Promise<Array<{ role: string; content: string; created_at: string; message_type?: string }>>;
  /** Send audio transcription update to all web clients */
  sendTranscription(audioUrl: string, transcription: string): void;
  /** Clear conversation history for a user */
  clearConversation(userPhone: string): Promise<void>;
  /** Create a blank sub-agent session (no initial task) and return the ack message */
  createBlankSubAgentSession(connectorName: string, userId: string): Promise<string>;
}

export class WebConnector implements Connector {
  readonly name = "web";
  readonly capabilities: ConnectorCapabilities = {
    polls: false,
    typing: true,
    media: true,
    richText: true,
  };

  private manager: ConnectorManager;
  private wss: WebSocketServer | null = null;
  /** Public session WebSocket server (no auth, for /s/:id viewers) */
  private sessionWss: WebSocketServer | null = null;
  /** Public session WebSocket subscribers: sessionId → Set<WebSocket> */
  private sessionSubscribers = new Map<string, Set<WebSocket>>();
  private clients = new Map<WebSocket, AuthenticatedClient>();
  private whatsappConnector: WhatsAppConnector | null = null;
  private agentBridge: WebAgentBridge | null = null;
  /** Tracks whether the agent is currently typing, so reconnecting clients restore the indicator */
  private currentlyTyping = false;
  private claudeOAuth = new ClaudeOAuthService();
  private openaiOAuth = new OpenAIOAuthService();
  constructor(manager: ConnectorManager) {
    this.manager = manager;
  }

  /**
   * Wire up QR code forwarding from the WhatsApp connector.
   */
  setWhatsAppConnector(whatsapp: WhatsAppConnector): void {
    this.whatsappConnector = whatsapp;
    whatsapp.onQrCode((qr: string) => {
      this.broadcastToAuthenticated({ type: "qr", data: qr });
    });
    whatsapp.onConnectionChange((connected: boolean) => {
      this.broadcastToAuthenticated({ type: "status", whatsapp: connected });
    });
  }

  /**
   * Wire up agent bridge for settings/sessions/edit-mode.
   */
  setAgentBridge(bridge: WebAgentBridge): void {
    this.agentBridge = bridge;
  }

  /**
   * Notify web clients of edit mode state change.
   */
  notifyEditMode(active: boolean): void {
    this.broadcastToAuthenticated({ type: "edit_mode", active });
  }

  // ==================== Connector interface ====================

  async start(): Promise<void> {
    if (!config.webAuthPassword) {
      logger.warn("WEB_AUTH_PASSWORD not set — web connector disabled for security");
      return;
    }

    if (!httpServer) {
      logger.error("HTTP server not started — cannot attach WebSocket server");
      return;
    }

    this.wss = new WebSocketServer({ noServer: true });
    this.sessionWss = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (request: IncomingMessage, socket, head) => {
      if (request.url === "/ws") {
        this.wss!.handleUpgrade(request, socket, head, (ws) => {
          this.wss!.emit("connection", ws, request);
        });
        return;
      }
      // Public session WebSocket: /ws/session?id=<sessionId>
      if (request.url?.startsWith("/ws/session")) {
        this.sessionWss!.handleUpgrade(request, socket, head, (ws) => {
          this.sessionWss!.emit("connection", ws, request);
        });
        return;
      }
      socket.destroy();
    });

    this.wss.on("connection", (ws: WebSocket) => {
      const client: AuthenticatedClient = { ws, authenticated: false };
      this.clients.set(ws, client);

      logger.info({ totalClients: this.clients.size }, "Web client connected");

      const authTimeout = setTimeout(() => {
        if (!client.authenticated) {
          this.send(ws, { type: "auth_fail", reason: "Timeout — autenticacao nao recebida." });
          ws.close();
        }
      }, 10000);

      ws.on("message", async (data: Buffer | string) => {
        try {
          const raw = typeof data === "string" ? data : data.toString("utf-8");
          const msg = JSON.parse(raw);

          if (!client.authenticated) {
            if (msg.type === "auth" && msg.password === config.webAuthPassword) {
              client.authenticated = true;
              clearTimeout(authTimeout);
              this.send(ws, { type: "auth_ok" });
              logger.info("Web client authenticated");

              if (this.whatsappConnector) {
                this.send(ws, {
                  type: "status",
                  whatsapp: this.whatsappConnector.isConnected(),
                });
              }

              // Restore typing indicator state for reconnecting clients (e.g. after F5)
              if (this.currentlyTyping) {
                this.send(ws, { type: "typing", composing: true });
              }

              // Restore edit mode state for reconnecting clients (e.g. after F5)
              if (this.agentBridge?.isEditModeActive()) {
                this.send(ws, { type: "edit_mode", active: true });
                // Also restore edit session message history so F5 doesn't lose it
                try {
                  const editHistory = await this.agentBridge.getEditHistory();
                  if (editHistory.length > 0) {
                    this.send(ws, { type: "edit_history", messages: editHistory });
                  }
                } catch (_) {
                  // Best-effort: if history load fails, UI is still functional
                }
              }
            } else {
              this.send(ws, { type: "auth_fail", reason: "Senha incorreta." });
              ws.close();
            }
            return;
          }

          // Authenticated — route by message type
          switch (msg.type) {
            case "message":
              await this.handleClientMessage(msg);
              break;
            case "get_settings":
              await this.handleGetSettings(ws);
              break;
            case "save_settings":
              await this.handleSaveSettings(ws, msg.settings || {});
              break;
            case "get_sessions":
              this.handleGetSessions(ws);
              break;
            case "kill_session":
              await this.handleKillSession(ws, msg.sessionId);
              break;
            case "start_edit":
              await this.handleStartEdit(ws);
              break;
            case "stop_edit":
              await this.handleStopEdit(ws);
              break;
            case "get_history":
              await this.handleGetHistory(ws);
              break;
            case "clear_history":
              await this.handleClearHistory(ws);
              break;
            case "get_session_history":
              await this.handleGetSessionHistory(ws, msg.sessionId);
              break;
            case "disconnect_whatsapp":
              await this.handleDisconnectWhatsApp(ws);
              break;
            case "oauth_start":
              await this.handleOAuthStart(ws, msg.provider);
              break;
            case "oauth_exchange":
              await this.handleOAuthExchange(ws, msg.provider, msg.input || "");
              break;
            case "oauth_disconnect":
              await this.handleOAuthDisconnect(ws, msg.provider);
              break;
            case "start_subagent":
              await this.handleStartSubAgent(ws);
              break;
            default:
              logger.warn({ type: msg.type }, "Unknown WebSocket message type");
          }
        } catch (err) {
          logger.error({ err }, "Error processing web client message");
          this.send(ws, { type: "error", text: "Erro processando mensagem." });
        }
      });

      ws.on("close", () => {
        clearTimeout(authTimeout);
        this.clients.delete(ws);
        logger.info({ totalClients: this.clients.size }, "Web client disconnected");
      });

      ws.on("error", (err) => {
        logger.warn({ err }, "Web client WebSocket error");
        this.clients.delete(ws);
      });
    });

    // ==================== Public session WebSocket ====================
    this.sessionWss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      const url = new URL(request.url || "", "http://localhost");
      const sessionId = url.searchParams.get("id") || "";

      if (!sessionId) {
        ws.close(4000, "Missing session ID");
        return;
      }

      // Subscribe this WebSocket to the session
      if (!this.sessionSubscribers.has(sessionId)) {
        this.sessionSubscribers.set(sessionId, new Set());
      }
      this.sessionSubscribers.get(sessionId)!.add(ws);

      logger.info({ sessionId, subscribers: this.sessionSubscribers.get(sessionId)!.size }, "Session viewer connected");

      // Send existing session history + info
      if (this.agentBridge) {
        this.agentBridge.getSessionHistory(sessionId).then((history) => {
          if (ws.readyState !== WebSocket.OPEN) return;

          // Check if session exists (live) or has history (was alive before)
          const sessions = this.agentBridge!.getSessionsForUI();
          const session = sessions.find((s) => s.id === sessionId);

          if (session) {
            // Session is live — send history + info
            ws.send(JSON.stringify({ type: "session_history", messages: history }));
            ws.send(JSON.stringify({ type: "session_info", session }));
          } else if (history.length > 0) {
            // Session was killed but has persisted history — show as done
            ws.send(JSON.stringify({ type: "session_history", messages: history }));
            ws.send(JSON.stringify({ type: "session_info", session: { id: sessionId, state: "done" } }));
          } else {
            // Session doesn't exist and has no history — not found
            ws.send(JSON.stringify({ type: "session_not_found", sessionId }));
          }
        }).catch(() => {});
      }

      // Handle messages from session viewer (user can send messages to the session)
      ws.on("message", async (data: Buffer | string) => {
        try {
          const raw = typeof data === "string" ? data : data.toString("utf-8");
          const msg = JSON.parse(raw);

          if (msg.type === "message" && this.agentBridge) {
            let text = msg.text || "";

            // Handle audio — transcribe via Gemini before forwarding
            if (msg.audio && msg.audioMimeType) {
              try {
                const buffer = Buffer.from(msg.audio, "base64");
                const media: MediaAttachment = { data: buffer, mimeType: msg.audioMimeType };
                const gemini = new GeminiProvider();
                if (gemini.isAvailable()) {
                  const result = await gemini.chat([
                    { role: "user", content: "Transcreva este áudio. Retorne APENAS o texto falado, sem prefixo, sem aspas, sem explicacao.", media },
                  ]);
                  const transcription = result.content.trim();
                  text = text ? `${text}\n\n[Áudio transcrito]: ${transcription}` : transcription;
                  // Broadcast transcription back to session viewer
                  this.broadcastToSessionSubscribers(sessionId, "system", `_Transcrição: ${transcription}_`);
                } else {
                  text = text || "[áudio recebido, transcrição indisponível]";
                }
              } catch (err) {
                logger.error({ err, sessionId }, "Session viewer audio transcription failed");
                text = text || "[erro ao transcrever áudio]";
              }
            }

            if (text) {
              await this.handleSessionViewerMessage(sessionId, text);
            }
          }
        } catch (err) {
          logger.warn({ err, sessionId }, "Error processing session viewer message");
        }
      });

      ws.on("close", () => {
        const subs = this.sessionSubscribers.get(sessionId);
        if (subs) {
          subs.delete(ws);
          if (subs.size === 0) this.sessionSubscribers.delete(sessionId);
        }
        logger.info({ sessionId }, "Session viewer disconnected");
      });

      ws.on("error", () => {
        const subs = this.sessionSubscribers.get(sessionId);
        if (subs) {
          subs.delete(ws);
          if (subs.size === 0) this.sessionSubscribers.delete(sessionId);
        }
      });
    });

    logger.info("Web connector started (WebSocket on /ws)");
  }

  async stop(): Promise<void> {
    if (this.wss) {
      for (const [ws] of this.clients) {
        ws.close();
      }
      this.clients.clear();
      this.wss.close();
      this.wss = null;
      logger.info("Web connector stopped");
    }
  }

  async sendMessage(userId: string, text: string, options?: SendMessageOptions): Promise<void> {
    const payload: Record<string, any> = { type: "message", text, from: "agent" };
    if (options?.sessionId) {
      payload.sessionId = options.sessionId;
    }
    if (options?.messageType) {
      payload.messageType = options.messageType;
    }
    this.broadcastToAuthenticated(payload);
  }

  async setTyping(userId: string, composing: boolean): Promise<void> {
    this.currentlyTyping = composing;
    this.broadcastToAuthenticated({ type: "typing", composing });
  }

  // ==================== Chat Messages ====================

  private async handleClientMessage(msg: any): Promise<void> {
    const text = msg.text || "";
    let media: MediaAttachment | undefined;              // primary media (audio)
    const imageMedias: MediaAttachment[] = [];           // all image attachments
    let audioUrl: string | undefined;
    const imageUrls: string[] = [];

    

    // Helper: generate random 16-char hex ID
    const genId = () => Array.from({ length: 8 }, () =>
      Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
    ).join("");

    // Process audio
    const audioMime = msg.audioMimeType || msg.mimeType;
    if (msg.audio && audioMime) {
      const buffer = Buffer.from(msg.audio, "base64");
      media = { data: buffer, mimeType: audioMime };
      logger.info({ type: "audio", size: buffer.length, mimeType: audioMime }, "Web audio received");
      try {
        const id = genId();
        await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, audioMime]);
        audioUrl = `/audio/${id}`;
        logger.info({ audioUrl }, "Audio blob saved");
      } catch (err) {
        logger.error({ err }, "Failed to save audio blob");
      }
    }

    // Process images — supports both `files` array (new) and single `image` field (legacy)
    const files: Array<{ base64: string; mimeType: string }> = [];
    if (msg.files && Array.isArray(msg.files)) {
      for (const f of msg.files) {
        if (f.base64 && f.mimeType) files.push(f);
      }
    } else if (msg.image) {
      // Legacy single image
      const mime = msg.imageMimeType || msg.mimeType;
      if (mime) files.push({ base64: msg.image, mimeType: mime });
    }

    for (const f of files) {
      const buffer = Buffer.from(f.base64, "base64");
      const attachment: MediaAttachment = { data: buffer, mimeType: f.mimeType };
      imageMedias.push(attachment);
      logger.info({ type: "image", size: buffer.length, mimeType: f.mimeType }, "Web image received");
      try {
        const id = genId();
        await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
        imageUrls.push(`/img/${id}`);
        logger.info({ imageUrl: `/img/${id}` }, "Image blob saved");
      } catch (err) {
        logger.error({ err }, "Failed to save image blob");
      }
    }

    // If no audio, first image becomes primary media; rest stay as imageMedias
    if (!media && imageMedias.length > 0) {
      media = imageMedias.shift();
    }

    // Build prompt text
    let promptText: string;
    const hasImages = imageMedias.length > 0 || (media && !msg.audio);
    if (media && msg.audio && hasImages) {
      promptText = text || "O usuario enviou um audio e imagens.";
    } else if (media && msg.audio) {
      promptText = text || "O usuario enviou um audio. Ouca, entenda e responda naturalmente.";
    } else if (hasImages) {
      const count = imageUrls.length;
      promptText = text || (count > 1
        ? `O usuario enviou ${count} imagens. Analise e descreva o que voce ve.`
        : "O usuario enviou uma imagem. Analise a imagem e descreva o que voce ve.");
    } else {
      promptText = text;
    }

    if (!promptText && !media) return;

    // Determine session context from client message
    const clientSessionId = msg.sessionId || undefined;

    // Echo user message back to all web clients (with session context)
    const echoPayload: Record<string, any> = { type: "message", text: promptText, from: "user" };
    if (clientSessionId) echoPayload.sessionId = clientSessionId;
    if (audioUrl) echoPayload.audioUrl = audioUrl;
    if (imageUrls.length > 0) echoPayload.imageUrls = imageUrls;
    this.broadcastToAuthenticated(echoPayload);

    const incoming: AgentIncomingMessage = {
      connectorName: this.name,
      userId: config.ownerPhone,
      userName: "Ruan",
      text: promptText,
      media,
      imageMedias: imageMedias.length > 0 ? imageMedias : undefined,
      audioUrl,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
    };

    const response = await this.manager.handleIncomingMessage(incoming);

    if (response) {
      const respPayload: Record<string, any> = { type: "message", text: response, from: "agent" };
      if (clientSessionId) respPayload.sessionId = clientSessionId;
      this.broadcastToAuthenticated(respPayload);
    }
  }

  // ==================== Settings ====================

  /**
   * Read settings from config store and process.env (with API keys masked).
   */
  private async handleGetSettings(ws: WebSocket): Promise<void> {
    try {
      const mask = (val: string | undefined) =>
        val && val.length > 6 ? val.substring(0, 3) + "****" + val.substring(val.length - 3) : val ? "****" : "";

      // Read current effective values (process.env has config store + .env merged)
      const geminiKey = process.env.GEMINI_API_KEY || "";
      const anthropicKey = process.env.ANTHROPIC_API_KEY || "";
      const openaiKey = process.env.OPENAI_API_KEY || "";
      const dbUrl = process.env.DATABASE_URL || "";
      const vectorUrl = process.env.VECTOR_DATABASE_URL || "";
      const devRepo = process.env.DEV_REPO_URL || "";

      const anthropicConn = await this.claudeOAuth.isConnected(config.ownerPhone);
      const openaiConn = await this.openaiOAuth.isConnected(config.ownerPhone);

      this.send(ws, {
        type: "settings",
        settings: {
          geminiApiKey: mask(geminiKey),
          geminiApiKeySet: !!geminiKey,
          anthropicApiKey: mask(anthropicKey),
          anthropicApiKeySet: !!anthropicKey,
          openaiApiKey: mask(openaiKey),
          openaiApiKeySet: !!openaiKey,
          anthropicOAuthConnected: anthropicConn.connected,
          openaiOAuthEmail: openaiConn.email || null,
          anthropicOAuthEmail: anthropicConn.email || null,
          openaiOAuthConnected: openaiConn.connected,
          databaseUrl: dbUrl,
          vectorDatabaseUrl: vectorUrl,
          devRepoUrl: devRepo,
          whatsappConnected: this.whatsappConnector?.isConnected() || false,
          editModeActive: this.agentBridge?.isEditModeActive() || false,
          dbBackend: isPostgres() ? "postgresql" : "sqlite",
        },
      });
    } catch (err) {
      logger.error({ err }, "Failed to read settings");
      this.send(ws, { type: "error", text: "Erro ao carregar configuracoes." });
    }
  }

  /**
   * Save settings to the config store (database).
   * Settings that require a restart (DATABASE_URL, etc.) show a hint in the UI.
   */
  private async handleSaveSettings(ws: WebSocket, settings: Record<string, string>): Promise<void> {
    try {
      let changed = false;
      const restartNeeded = new Set(["DATABASE_URL", "VECTOR_DATABASE_URL", "WEB_AUTH_PASSWORD"]);
      let needsRestart = false;

      for (const [settingKey, envKey] of Object.entries(SETTINGS_KEY_MAP)) {
        const value = settings[settingKey];
        if (value === "__CLEAR__") {
          await configSet(envKey, "");
          process.env[envKey] = "";
          changed = true;
          if (restartNeeded.has(envKey)) needsRestart = true;
          continue;
        }
        if (value !== undefined && value !== "" && typeof value === "string" && !value.includes("****")) {
          // Only save if the value isn't masked (user actually changed it)
          await configSet(envKey, value);
          // Also update process.env so runtime picks it up
          process.env[envKey] = value;
          changed = true;
          if (restartNeeded.has(envKey)) {
            needsRestart = true;
          }
        }
      }

      if (!changed) {
        this.send(ws, { type: "settings_saved", success: true });
        return;
      }

      logger.info({ keys: Object.keys(settings) }, "Settings saved to config store");
      this.send(ws, {
        type: "settings_saved",
        success: true,
        needsRestart,
      });
    } catch (err) {
      logger.error({ err }, "Failed to save settings");
      this.send(ws, { type: "settings_saved", success: false, error: "Erro ao salvar configuracoes." });
    }
  }

  // ==================== Sessions ====================

  private handleGetSessions(ws: WebSocket): void {
    if (!this.agentBridge) {
      this.send(ws, { type: "sessions", sessions: [] });
      return;
    }

    const sessions = this.agentBridge.getSessionsForUI();
    this.send(ws, { type: "sessions", sessions });
  }

  private async handleKillSession(ws: WebSocket, sessionId: string): Promise<void> {
    if (!this.agentBridge || !sessionId) {
      this.send(ws, { type: "error", text: "Sessao nao encontrada." });
      return;
    }

    try {
      await this.agentBridge.killSession(sessionId);
      // Send updated sessions list
      this.handleGetSessions(ws);
    } catch (err) {
      logger.error({ err, sessionId }, "Failed to kill session");
      this.send(ws, { type: "error", text: "Erro ao encerrar sessao." });
    }
  }

  private async handleStartSubAgent(ws: WebSocket): Promise<void> {
    if (!this.agentBridge) {
      this.send(ws, { type: "error", text: "Agent nao configurado." });
      return;
    }

    try {
      const ack = await this.agentBridge.createBlankSubAgentSession(this.name, config.ownerPhone);
      // Broadcast ack as agent message in the main chat (all authenticated clients)
      this.broadcastToAuthenticated({ type: "message", text: ack, from: "agent" });
      // Broadcast updated sessions list so every open tab refreshes the sidebar
      const sessions = this.agentBridge.getSessionsForUI();
      this.broadcastToAuthenticated({ type: "sessions", sessions });
    } catch (err) {
      logger.error({ err }, "Failed to start blank sub-agent session");
      this.send(ws, { type: "error", text: "Erro ao criar nova sessao de sub-agente." });
    }
  }

  // ==================== Edit Mode ====================

  private async handleStartEdit(ws: WebSocket): Promise<void> {
    if (!this.agentBridge) {
      this.send(ws, { type: "error", text: "Agent nao configurado." });
      return;
    }

    const result = await this.agentBridge.startEditMode(this.name, config.ownerPhone);
    if (result) {
      // Non-empty result means there was an error message
      this.send(ws, { type: "error", text: result });
    }
    // Success: the Agent will send edit_mode notification via notifyEditMode()
  }

  private async handleStopEdit(ws: WebSocket): Promise<void> {
    if (!this.agentBridge) {
      this.send(ws, { type: "error", text: "Agent nao configurado." });
      return;
    }

    const result = await this.agentBridge.stopEditMode();
    if (result) {
      this.send(ws, { type: "error", text: result });
      return;
    }

    this.notifyEditMode(false);
  }

  private async handleDisconnectWhatsApp(ws: WebSocket): Promise<void> {
    if (!this.whatsappConnector) {
      this.send(ws, { type: "error", text: "Conector WhatsApp indisponivel." });
      return;
    }

    try {
      await this.whatsappConnector.disconnectForRelogin();
      this.broadcastToAuthenticated({ type: "status", whatsapp: false });
      this.send(ws, { type: "info", text: "WhatsApp desconectado. Escaneie novo QR para reconectar." });
    } catch (err) {
      logger.error({ err }, "Failed to disconnect WhatsApp from web UI");
      this.send(ws, { type: "error", text: "Falha ao desconectar WhatsApp." });
    }
  }

  private async handleGetHistory(ws: WebSocket): Promise<void> {
    if (!this.agentBridge) {
      this.send(ws, { type: "history", messages: [] });
      return;
    }

    try {
      const history = await this.agentBridge.getConversationHistory(config.ownerPhone, 50);
      this.send(ws, { type: "history", messages: history });
    } catch (err) {
      logger.error({ err }, "Failed to load conversation history");
      this.send(ws, { type: "history", messages: [] });
    }
  }

  private async handleClearHistory(ws: WebSocket): Promise<void> {
    if (!this.agentBridge) {
      this.send(ws, { type: "error", text: "Agent not ready." });
      return;
    }

    try {
      await this.agentBridge.clearConversation(config.ownerPhone);
      // Notify all authenticated clients so every open tab clears
      this.broadcastToAuthenticated({ type: "history_cleared" });
      logger.info("Conversation history cleared via web UI");
    } catch (err) {
      logger.error({ err }, "Failed to clear conversation history");
      this.send(ws, { type: "error", text: "Falha ao limpar historico." });
    }
  }

  private async handleGetSessionHistory(ws: WebSocket, sessionId: string): Promise<void> {
    if (!this.agentBridge || !sessionId) {
      this.send(ws, { type: "session_history", sessionId: sessionId || "", messages: [] });
      return;
    }

    try {
      const history = await this.agentBridge.getSessionHistory(sessionId);
      this.send(ws, { type: "session_history", sessionId, messages: history });
    } catch (err) {
      logger.error({ err, sessionId }, "Failed to load session history");
      this.send(ws, { type: "session_history", sessionId, messages: [] });
    }
  }

  private async handleOAuthStart(ws: WebSocket, provider: string): Promise<void> {
    try {
      if (provider === "anthropic") {
        const { authUrl, state } = this.claudeOAuth.startAuth();
        this.send(ws, { type: "oauth_start", provider, authUrl, state });
        return;
      }
      if (provider === "openai") {
        const { authUrl, state } = this.openaiOAuth.startAuth();
        this.send(ws, { type: "oauth_start", provider, authUrl, state });
        return;
      }
      this.send(ws, { type: "error", text: "Provider OAuth invalido." });
    } catch (err) {
      logger.error({ err, provider }, "Failed to start OAuth flow");
      this.send(ws, { type: "error", text: "Falha ao iniciar OAuth." });
    }
  }

  private async handleOAuthExchange(ws: WebSocket, provider: string, input: string): Promise<void> {
    try {
      if (!input?.trim()) {
        this.send(ws, { type: "oauth_result", provider, success: false, error: "Entrada vazia." });
        return;
      }

      if (provider === "anthropic") {
        const res = await this.claudeOAuth.exchangeCode(config.ownerPhone, input);
        this.send(ws, { type: "oauth_result", provider, success: res.success, error: res.error || null, email: res.email || null });
        return;
      }

      if (provider === "openai") {
        const res = await this.openaiOAuth.exchangeCallback(config.ownerPhone, input);
        this.send(ws, { type: "oauth_result", provider, success: res.success, error: res.error || null, email: res.email || null });
        return;
      }

      this.send(ws, { type: "oauth_result", provider, success: false, error: "Provider invalido." });
    } catch (err) {
      logger.error({ err, provider }, "Failed to exchange OAuth callback/code");
      this.send(ws, { type: "oauth_result", provider, success: false, error: "Falha ao concluir OAuth." });
    }
  }

  private async handleOAuthDisconnect(ws: WebSocket, provider: string): Promise<void> {
    try {
      if (provider === "anthropic") {
        await this.claudeOAuth.disconnect(config.ownerPhone);
        this.send(ws, { type: "oauth_result", provider, success: true });
        return;
      }
      if (provider === "openai") {
        await this.openaiOAuth.disconnect(config.ownerPhone);
        this.send(ws, { type: "oauth_result", provider, success: true });
        return;
      }
      this.send(ws, { type: "oauth_result", provider, success: false, error: "Provider invalido." });
    } catch (err) {
      logger.error({ err, provider }, "Failed to disconnect OAuth");
      this.send(ws, { type: "oauth_result", provider, success: false, error: "Falha ao desconectar OAuth." });
    }
  }

  // ==================== Public session broadcast ====================

  /**
   * Broadcast a message to all public session WebSocket subscribers for a given session.
   * Called by the SessionManager's onSessionMessage callback.
   */
  broadcastToSessionSubscribers(sessionId: string, role: string, text: string): void {
    const subs = this.sessionSubscribers.get(sessionId);
    if (!subs || subs.size === 0) return;

    const payload = JSON.stringify({ type: "message", role, text, time: new Date().toISOString() });
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /**
   * Handle a message from a public session viewer — forwards it directly to the sub-agent session.
   */
  private async handleSessionViewerMessage(sessionId: string, text: string): Promise<void> {
    if (!this.agentBridge) return;

    try {
      await this.agentBridge.sendToSession(sessionId, text);
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to send message to session from viewer");
      this.broadcastToSessionSubscribers(sessionId, "agent", `Erro: ${(err as Error).message}`);
    }
  }

  // ==================== Helpers ====================

  private send(ws: WebSocket, data: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /** Send audio transcription update to all authenticated web clients */
  sendTranscription(audioUrl: string, transcription: string): void {
    this.broadcastToAuthenticated({ type: "transcription", audioUrl, text: transcription });
  }

  private broadcastToAuthenticated(data: object): void {
    const payload = JSON.stringify(data);
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }
}
