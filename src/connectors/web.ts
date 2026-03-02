import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import QRCode from "qrcode";
import type { Connector, ConnectorCapabilities, IncomingMessage as AgentIncomingMessage, SendMessageOptions } from "./types.js";
import type { ConnectorManager } from "./connector-manager.js";
import type { WhatsAppConnector } from "./whatsapp.js";
import type { MediaAttachment } from "../llm/types.js";
import type { UserService, User, UserWithIdentities } from "../auth/user-service.js";
import type { MemoryService } from "../memory/memory-service.js";
import { httpServer } from "../health.js";
import { config, reloadConfig } from "../config/env.js";
import { configGet, configSet, SETTINGS_KEY_MAP, ENV_SKIP_KEYS } from "../memory/config-store.js";
import { isPostgres, query } from "../memory/database.js";
import { logger, getLogBuffer } from "../config/logger.js";
import { ClaudeOAuthService } from "../auth/claude-oauth.js";
import { OpenAIOAuthService } from "../auth/openai-oauth.js";
import { claudeOAuthService, openaiOAuthService } from "../auth/oauth-singleton.js";
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
  /** Get conversation history for a user (uses numericUserId when available for RBAC) */
  getConversationHistory(userPhone: string, limit?: number, numericUserId?: number): Promise<Array<{ role: string; content: string; created_at?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }>; message_type?: string }>>;
  /** Get message history for a sub-agent session */
  getSessionHistory(sessionId: string): Promise<Array<{ role: string; content: string; created_at: string; message_type?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }> }>>;
  /** Get the persisted status of a session from the DB ('active' | 'done' | 'killed' | null) */
  getSessionStatusFromDB(sessionId: string): Promise<string | null>;
  /** Get message history for the active edit session */
  getEditHistory(): Promise<Array<{ role: string; content: string; created_at: string; message_type?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }> }>>;
  /** Send audio transcription update to all web clients */
  sendTranscription(audioUrl: string, transcription: string): void;
  /** Clear conversation history for a user (uses numericUserId when available for RBAC) */
  clearConversation(userPhone: string, numericUserId?: number): Promise<void>;
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
  /** RBAC: user service for admin management */
  private userService: UserService | null = null;
  /** RBAC: memory service for accessing user conversations/sessions */
  private memoryService: MemoryService | null = null;
  /** Numeric user ID of the admin (resolved on first auth) */
  private adminUserId: number | null = null;
  /** Tracks whether the agent is currently typing, so reconnecting clients restore the indicator */
  private currentlyTyping = false;
  /** Cached QR code data URL so late-connecting clients can still see the current QR */
  private pendingQrDataUrl: string | null = null;
  private claudeOAuth: ClaudeOAuthService = claudeOAuthService;
  private openaiOAuth: OpenAIOAuthService = openaiOAuthService;
  constructor(manager: ConnectorManager) {
    this.manager = manager;
  }

  /**
   * Wire up QR code forwarding from the WhatsApp connector.
   */
  setWhatsAppConnector(whatsapp: WhatsAppConnector): void {
    this.whatsappConnector = whatsapp;
    whatsapp.onQrCode((qr: string) => {
      QRCode.toDataURL(qr, { margin: 1, scale: 6 })
        .then((dataUrl) => {
          this.pendingQrDataUrl = dataUrl;
          this.broadcastToAuthenticated({ type: "qr", data: dataUrl });
        })
        .catch(() => {
          this.pendingQrDataUrl = qr;
          this.broadcastToAuthenticated({ type: "qr", data: qr });
        });
    });
    whatsapp.onConnectionChange((connected: boolean) => {
      if (connected) this.pendingQrDataUrl = null; // QR no longer needed
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
   * Wire up RBAC services for user management.
   */
  setUserService(userService: UserService, memoryService: MemoryService): void {
    this.userService = userService;
    this.memoryService = memoryService;
  }

  /**
   * Notify all authenticated web clients about a pending user count change.
   * Called by the WhatsApp connector when a new pending user is created.
   */
  async notifyPendingCount(): Promise<void> {
    if (!this.userService) return;
    try {
      const count = await this.userService.getPendingCount();
      this.broadcastToAuthenticated({ type: "pending_count", count });
    } catch (err) {
      logger.warn({ err }, "Failed to broadcast pending count");
    }
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

      // ── Keepalive: ping every 25s, kill if no pong within 10s ──
      let isAlive = true;
      ws.on("pong", () => { isAlive = true; });
      const pingInterval = setInterval(() => {
        if (!isAlive) { ws.terminate(); return; }
        isAlive = false;
        ws.ping();
      }, 25_000);

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

              // Resolve admin user ID for RBAC (once, cached)
              if (this.adminUserId === null && this.userService) {
                try {
                  const admin = await this.userService.getAdminUser();
                  if (admin) this.adminUserId = admin.id;
                } catch (_) { /* best-effort */ }
              }

              // Send pending user count with auth_ok
              let pendingCount = 0;
              if (this.userService) {
                try { pendingCount = await this.userService.getPendingCount(); } catch (_) {}
              }

              this.send(ws, { type: "auth_ok", pendingCount });
              logger.info("Web client authenticated");

              if (this.whatsappConnector) {
                this.send(ws, {
                  type: "status",
                  whatsapp: this.whatsappConnector.isConnected(),
                });
              }

              // Always restore the current typing indicator state for reconnecting clients
              // (e.g. after F5 or phone unlock). Sending composing:false is equally important
              // so clients that missed a "typing:false" event don't stay stuck on "processing".
              this.send(ws, { type: "typing", composing: this.currentlyTyping });

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
            case "connect_whatsapp":
              await this.handleConnectWhatsApp(ws);
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
            case "get_logs":
              this.handleGetLogs(ws);
              break;
            // ==================== RBAC: User Management ====================
            case "get_users":
              await this.handleGetUsers(ws);
              break;
            case "get_pending_count":
              await this.handleGetPendingCount(ws);
              break;
            case "get_user_detail":
              await this.handleGetUserDetail(ws, msg.userId);
              break;
            case "set_user_role":
              await this.handleSetUserRole(ws, msg.userId, msg.role);
              break;
            case "block_user":
              await this.handleBlockUser(ws, msg.userId);
              break;
            case "unblock_user":
              await this.handleUnblockUser(ws, msg.userId);
              break;
            case "update_user_profile":
              await this.handleUpdateUserProfile(ws, msg.userId, msg.profile, msg.displayName);
              break;
            case "get_user_conversations":
              await this.handleGetUserConversations(ws, msg.userId, msg.limit);
              break;
            case "get_user_sessions":
              await this.handleGetUserSessions(ws, msg.userId);
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
        clearInterval(pingInterval);
        clearTimeout(authTimeout);
        this.clients.delete(ws);
        logger.info({ totalClients: this.clients.size }, "Web client disconnected");
      });

      ws.on("error", (err) => {
        clearInterval(pingInterval);
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
        this.agentBridge.getSessionHistory(sessionId).then(async (history) => {
          if (ws.readyState !== WebSocket.OPEN) return;

          // Check if session exists (live) or has history (was alive before)
          const sessions = this.agentBridge!.getSessionsForUI();
          const session = sessions.find((s) => s.id === sessionId);

          const agentName = config.agentName;
          if (session) {
            // Session is live — send history + info
            ws.send(JSON.stringify({ type: "session_history", messages: history }));
            ws.send(JSON.stringify({ type: "session_info", session: { ...session, agentName } }));
          } else if (history.length > 0) {
            // Session is no longer in memory — check DB for the real status
            const dbStatus = await this.agentBridge!.getSessionStatusFromDB(sessionId);
            // Map DB status ('active'|'done'|'killed') to viewer state
            const state = dbStatus === "killed" ? "killed" : "done";
            ws.send(JSON.stringify({ type: "session_history", messages: history }));
            ws.send(JSON.stringify({ type: "session_info", session: { id: sessionId, state, agentName } }));
          } else {
            // Session doesn't exist and has no history — not found
            ws.send(JSON.stringify({ type: "session_not_found", sessionId }));
          }
        }).catch((err) => {
          logger.warn({ err, sessionId }, "Failed to load session history for viewer");
          // Send a fallback so the viewer doesn't stay stuck on "Trabalhando..."
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "session_info", session: { id: sessionId, state: "done", agentName: config.agentName } }));
          }
        });
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

    // Process files — supports both `files` array (new) and single `image` field (legacy)
    const files: Array<{ base64: string; mimeType: string; name?: string }> = [];
    if (msg.files && Array.isArray(msg.files)) {
      for (const f of msg.files) {
        if (f.base64 && f.mimeType) files.push(f);
      }
    } else if (msg.image) {
      // Legacy single image
      const mime = msg.imageMimeType || msg.mimeType;
      if (mime) files.push({ base64: msg.image, mimeType: mime });
    }

    // Conteúdo textual extraído de arquivos de texto (txt, csv, json, etc.)
    const fileTexts: string[] = [];
    // Generic file attachments (non-image/non-audio) for chat history display
    const fileInfos: Array<{ url: string; name: string; mimeType: string }> = [];
    const editModeActive = this.agentBridge?.isEditModeActive() ?? false;
    let imageAttachmentCount = 0;
    let attachmentCount = 0;

    for (const f of files) {
      const buffer = Buffer.from(f.base64, "base64");

      if (f.mimeType.startsWith("image/")) {
        // Imagens: tratamento existente
        const attachment: MediaAttachment = { data: buffer, mimeType: f.mimeType };
        imageMedias.push(attachment);
        imageAttachmentCount += 1;
        attachmentCount += 1;
        logger.info({ type: "image", size: buffer.length, mimeType: f.mimeType }, "Web image received");
        try {
          const id = genId();
          await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
          imageUrls.push(`/img/${id}`);
          logger.info({ imageUrl: `/img/${id}` }, "Image blob saved");
        } catch (err) {
          logger.error({ err }, "Failed to save image blob");
        }
      } else if (
        f.mimeType.startsWith("text/") ||
        f.mimeType === "application/json" ||
        f.mimeType === "application/xml" ||
        f.mimeType === "application/javascript"
      ) {
        // Arquivos de texto: decodificar conteúdo e incluir no prompt para o LLM
        const content = buffer.toString("utf-8");
        const fileName = f.name || "arquivo";
        fileTexts.push(`\n\n[Conteúdo do arquivo "${fileName}"]:\n${content}`);
        if (editModeActive) {
          imageMedias.push({ data: buffer, mimeType: f.mimeType });
          attachmentCount += 1;
        }
        logger.info({ type: "text-file", size: buffer.length, mimeType: f.mimeType, name: fileName }, "Web text file received");
        // Também salvar o blob para exibição no histórico com card de arquivo
        try {
          const id = genId();
          await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
          fileInfos.push({ url: `/file/${id}`, name: fileName, mimeType: f.mimeType });
          logger.info({ fileUrl: `/file/${id}`, name: fileName }, "Text file blob saved");
        } catch (err) {
          logger.error({ err }, "Failed to save text file blob");
        }
      } else if (f.mimeType === "application/pdf") {
        // PDFs: passar como anexo de media
        const attachment: MediaAttachment = { data: buffer, mimeType: f.mimeType };
        imageMedias.push(attachment);
        attachmentCount += 1;
        const fileName = f.name || "documento.pdf";
        logger.info({ type: "pdf", size: buffer.length, name: f.name }, "Web PDF received");
        try {
          const id = genId();
          await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
          imageUrls.push(`/img/${id}`);
        } catch (err) {
          logger.error({ err }, "Failed to save PDF blob");
        }
      } else {
        // Outros tipos binários: salvar e mostrar como card de arquivo genérico
        const fileName = f.name || "arquivo";
        if (editModeActive) {
          imageMedias.push({ data: buffer, mimeType: f.mimeType });
          attachmentCount += 1;
        }
        logger.info({ mimeType: f.mimeType, name: fileName }, "Generic file received");
        try {
          const id = genId();
          await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
          fileInfos.push({ url: `/file/${id}`, name: fileName, mimeType: f.mimeType });
          logger.info({ fileUrl: `/file/${id}`, name: fileName }, "Generic file blob saved");
        } catch (err) {
          logger.error({ err }, "Failed to save generic file blob");
        }
      }
    }

    // If no audio, first image becomes primary media; rest stay as imageMedias
    if (!media && imageMedias.length > 0) {
      media = imageMedias.shift();
    }

    // Build prompt text
    let promptText: string;
    const hasAttachments = attachmentCount > 0 || (!!media && !msg.audio);
    const hasImages = imageAttachmentCount > 0;
    if (media && msg.audio && hasAttachments) {
      promptText = text || "O usuario enviou um audio e arquivos anexados.";
    } else if (media && msg.audio) {
      promptText = text || "O usuario enviou um audio. Ouca, entenda e responda naturalmente.";
    } else if (hasAttachments) {
      if (hasImages && attachmentCount === imageAttachmentCount) {
        const count = imageAttachmentCount;
        promptText = text || (count > 1
          ? `O usuario enviou ${count} imagens. Analise e descreva o que voce ve.`
          : "O usuario enviou uma imagem. Analise a imagem e descreva o que voce ve.");
      } else {
        promptText = text || "O usuario enviou arquivos anexados. Leia-os e responda com base neles.";
      }
    } else {
      promptText = text;
    }

    // Acrescentar conteúdo de arquivos de texto ao prompt
    if (fileTexts.length > 0) {
      promptText = (promptText || "") + fileTexts.join("");
    }

    if (!promptText && !media) return;

    // Determine session context from client message
    const clientSessionId = msg.sessionId || undefined;

    // Echo user message back to all web clients (with session context)
    const echoPayload: Record<string, any> = { type: "message", text: promptText, from: "user" };
    if (clientSessionId) echoPayload.sessionId = clientSessionId;
    if (audioUrl) echoPayload.audioUrl = audioUrl;
    if (imageUrls.length > 0) echoPayload.imageUrls = imageUrls;
    if (fileInfos.length > 0) echoPayload.fileInfos = fileInfos;
    this.broadcastToAuthenticated(echoPayload);

    const incoming: AgentIncomingMessage = {
      connectorName: this.name,
      userId: config.ownerPhone,
      text: promptText,
      media,
      imageMedias: imageMedias.length > 0 ? imageMedias : undefined,
      audioUrl,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      fileInfos: fileInfos.length > 0 ? fileInfos : undefined,
      // RBAC: Web UI is always the admin
      numericUserId: this.adminUserId ?? undefined,
      userRole: "admin",
      userStatus: "active",
      // Web UI: messages from main session should never be intercepted by
      // sub-agent relay — sub-agents have their own dedicated UI panels.
      // Only skip when NOT targeting a specific sub-agent session.
      skipSubAgentRelay: !clientSessionId,
    };

    const response = await this.manager.handleIncomingMessage(incoming);

    // Re-resolve adminUserId if it was null (first message may have created the admin user)
    if (this.adminUserId === null && this.userService) {
      try {
        const admin = await this.userService.getAdminUser();
        if (admin) this.adminUserId = admin.id;
      } catch (_) { /* best-effort */ }
    }

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
      const githubToken = process.env.GITHUB_TOKEN || "";

      const anthropicConn = this.adminUserId != null
        ? await this.claudeOAuth.isConnected(this.adminUserId)
        : { connected: false };
      const openaiConn = this.adminUserId != null
        ? await this.openaiOAuth.isConnected(this.adminUserId)
        : { connected: false };

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
          githubToken: mask(githubToken),
          githubTokenSet: !!githubToken,
          agentName: config.agentName,
          agentLogo: (await configGet("AGENT_LOGO")) || "",
          webBaseUrl: config.webBaseUrl,
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
          if (!ENV_SKIP_KEYS.has(envKey)) process.env[envKey] = "";
          changed = true;
          if (restartNeeded.has(envKey)) needsRestart = true;
          continue;
        }
        if (value !== undefined && value !== "" && typeof value === "string" && !value.includes("****")) {
          // Only save if the value isn't masked (user actually changed it)
          await configSet(envKey, value);
          // Also update process.env so runtime picks it up (skip large values like logos)
          if (!ENV_SKIP_KEYS.has(envKey)) process.env[envKey] = value;
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

      // Reload config object so runtime picks up new values (e.g. AGENT_NAME)
      reloadConfig();
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

  // ==================== Logs ====================

  /**
   * Return the in-memory log buffer to the requesting client.
   */
  private handleGetLogs(ws: WebSocket): void {
    const entries = getLogBuffer();
    this.send(ws, { type: "logs", entries });
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

    const editUserId = this.adminUserId != null ? String(this.adminUserId) : config.ownerPhone;
    const result = await this.agentBridge.startEditMode(this.name, editUserId);
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

  private async handleConnectWhatsApp(ws: WebSocket): Promise<void> {
    if (!this.whatsappConnector) {
      this.send(ws, { type: "error", text: "Conector WhatsApp indisponivel." });
      return;
    }

    if (this.whatsappConnector.isConnected()) {
      // Já conectado — apenas sincroniza o status com o cliente
      this.broadcastToAuthenticated({ type: "status", whatsapp: true });
      return;
    }

    if (this.whatsappConnector.isStarting()) {
      // Socket already created and waiting for QR scan — send the cached QR if available
      if (this.pendingQrDataUrl) {
        this.send(ws, { type: "qr", data: this.pendingQrDataUrl });
      }
      return;
    }

    // Conector completamente parado (ex.: após logout) — inicia novamente
    try {
      await this.whatsappConnector.start();
    } catch (err) {
      logger.error({ err }, "Failed to start WhatsApp from web UI");
      this.send(ws, { type: "error", text: "Falha ao iniciar WhatsApp." });
    }
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
      const history = await this.agentBridge.getConversationHistory(config.ownerPhone, 50, this.adminUserId ?? undefined);
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
      await this.agentBridge.clearConversation(config.ownerPhone, this.adminUserId ?? undefined);
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

      if (this.adminUserId == null) {
        this.send(ws, { type: "oauth_result", provider, success: false, error: "Admin user not resolved yet." });
        return;
      }

      if (provider === "anthropic") {
        const res = await this.claudeOAuth.exchangeCode(this.adminUserId, input);
        this.send(ws, { type: "oauth_result", provider, success: res.success, error: res.error || null, email: res.email || null });
        return;
      }

      if (provider === "openai") {
        const res = await this.openaiOAuth.exchangeCallback(this.adminUserId, input);
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
      if (this.adminUserId == null) {
        this.send(ws, { type: "oauth_result", provider, success: false, error: "Admin user not resolved yet." });
        return;
      }
      if (provider === "anthropic") {
        await this.claudeOAuth.disconnect(this.adminUserId);
        this.send(ws, { type: "oauth_result", provider, success: true });
        return;
      }
      if (provider === "openai") {
        await this.openaiOAuth.disconnect(this.adminUserId);
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
  broadcastToSessionSubscribers(sessionId: string, role: string, text: string, messageType?: string): void {
    const subs = this.sessionSubscribers.get(sessionId);
    if (!subs || subs.size === 0) return;

    const payload = JSON.stringify({ type: "message", role, text, messageType: messageType || "text", time: new Date().toISOString() });
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

  // ==================== RBAC: User Management ====================

  private async handleGetUsers(ws: WebSocket): Promise<void> {
    if (!this.userService) {
      this.send(ws, { type: "users", users: [] });
      return;
    }

    try {
      const users = await this.userService.listUsers();
      // Attach identities for each user (lightweight — just connector + externalId)
      const usersWithIds = await Promise.all(
        users.map(async (u) => {
          const identities = await this.userService!.getIdentities(u.id);
          return {
            id: u.id,
            role: u.role,
            status: u.status,
            displayName: u.displayName,
            profile: u.profile,
            lastActivityAt: u.lastActivityAt?.toISOString() || null,
            createdAt: u.createdAt.toISOString(),
            identities: identities.map((i) => ({
              connector: i.connector,
              externalId: i.externalId,
              displayName: i.displayName,
            })),
          };
        })
      );
      this.send(ws, { type: "users", users: usersWithIds });
    } catch (err) {
      logger.error({ err }, "Failed to list users");
      this.send(ws, { type: "error", text: "Erro ao listar usuarios." });
    }
  }

  private async handleGetPendingCount(ws: WebSocket): Promise<void> {
    if (!this.userService) {
      this.send(ws, { type: "pending_count", count: 0 });
      return;
    }

    try {
      const count = await this.userService.getPendingCount();
      this.send(ws, { type: "pending_count", count });
    } catch (err) {
      logger.error({ err }, "Failed to get pending count");
      this.send(ws, { type: "pending_count", count: 0 });
    }
  }

  private async handleGetUserDetail(ws: WebSocket, userId: number): Promise<void> {
    if (!this.userService || !userId) {
      this.send(ws, { type: "error", text: "Usuario nao encontrado." });
      return;
    }

    try {
      const userWithIds = await this.userService.getUserWithIdentities(userId);
      if (!userWithIds) {
        this.send(ws, { type: "error", text: "Usuario nao encontrado." });
        return;
      }

      this.send(ws, {
        type: "user_detail",
        user: {
          id: userWithIds.id,
          role: userWithIds.role,
          status: userWithIds.status,
          displayName: userWithIds.displayName,
          profile: userWithIds.profile,
          lastActivityAt: userWithIds.lastActivityAt?.toISOString() || null,
          createdAt: userWithIds.createdAt.toISOString(),
          identities: userWithIds.identities.map((i) => ({
            connector: i.connector,
            externalId: i.externalId,
            displayName: i.displayName,
          })),
        },
      });
    } catch (err) {
      logger.error({ err, userId }, "Failed to get user detail");
      this.send(ws, { type: "error", text: "Erro ao carregar usuario." });
    }
  }

  private async handleSetUserRole(ws: WebSocket, userId: number, role: string): Promise<void> {
    if (!this.userService || !userId) {
      this.send(ws, { type: "error", text: "Dados invalidos." });
      return;
    }

    if (role !== "dev" && role !== "business") {
      this.send(ws, { type: "error", text: "Role invalida. Use 'dev' ou 'business'." });
      return;
    }

    try {
      const updated = await this.userService.setUserRole(userId, role);
      this.send(ws, {
        type: "user_updated",
        user: {
          id: updated.id,
          role: updated.role,
          status: updated.status,
          displayName: updated.displayName,
        },
      });
      // Broadcast updated pending count to all clients
      this.notifyPendingCount();
    } catch (err) {
      logger.error({ err, userId, role }, "Failed to set user role");
      this.send(ws, { type: "error", text: (err as Error).message || "Erro ao definir role." });
    }
  }

  private async handleBlockUser(ws: WebSocket, userId: number): Promise<void> {
    if (!this.userService || !userId) {
      this.send(ws, { type: "error", text: "Dados invalidos." });
      return;
    }

    try {
      const updated = await this.userService.blockUser(userId);
      this.send(ws, {
        type: "user_updated",
        user: {
          id: updated.id,
          role: updated.role,
          status: updated.status,
          displayName: updated.displayName,
        },
      });
    } catch (err) {
      logger.error({ err, userId }, "Failed to block user");
      this.send(ws, { type: "error", text: (err as Error).message || "Erro ao bloquear usuario." });
    }
  }

  private async handleUnblockUser(ws: WebSocket, userId: number): Promise<void> {
    if (!this.userService || !userId) {
      this.send(ws, { type: "error", text: "Dados invalidos." });
      return;
    }

    try {
      const updated = await this.userService.unblockUser(userId);
      this.send(ws, {
        type: "user_updated",
        user: {
          id: updated.id,
          role: updated.role,
          status: updated.status,
          displayName: updated.displayName,
        },
      });
      // Broadcast updated pending count to all clients
      this.notifyPendingCount();
    } catch (err) {
      logger.error({ err, userId }, "Failed to unblock user");
      this.send(ws, { type: "error", text: (err as Error).message || "Erro ao desbloquear usuario." });
    }
  }

  private async handleUpdateUserProfile(
    ws: WebSocket,
    userId: number,
    profile?: Record<string, any>,
    displayName?: string
  ): Promise<void> {
    if (!this.userService || !userId) {
      this.send(ws, { type: "error", text: "Dados invalidos." });
      return;
    }

    try {
      if (displayName !== undefined) {
        await this.userService.updateDisplayName(userId, displayName);
      }
      if (profile) {
        await this.userService.updateProfile(userId, profile);
      }

      const updated = await this.userService.getUserById(userId);
      if (updated) {
        this.send(ws, {
          type: "user_updated",
          user: {
            id: updated.id,
            role: updated.role,
            status: updated.status,
            displayName: updated.displayName,
            profile: updated.profile,
          },
        });
      }
    } catch (err) {
      logger.error({ err, userId }, "Failed to update user profile");
      this.send(ws, { type: "error", text: "Erro ao atualizar perfil." });
    }
  }

  private async handleGetUserConversations(ws: WebSocket, userId: number, limit?: number): Promise<void> {
    if (!this.memoryService || !userId) {
      this.send(ws, { type: "user_conversations", userId, messages: [] });
      return;
    }

    try {
      const messages = await this.memoryService.getConversationHistoryByUserId(userId, limit || 50);
      this.send(ws, { type: "user_conversations", userId, messages });
    } catch (err) {
      logger.error({ err, userId }, "Failed to load user conversations");
      this.send(ws, { type: "user_conversations", userId, messages: [] });
    }
  }

  private async handleGetUserSessions(ws: WebSocket, userId: number): Promise<void> {
    if (!userId) {
      this.send(ws, { type: "user_sessions", userId, sessions: [] });
      return;
    }

    try {
      const result = await query(
        `SELECT id, task, status, started_at, ended_at
         FROM sub_agent_sessions
         WHERE user_id = $1
         ORDER BY started_at DESC
         LIMIT 50`,
        [userId]
      );

      const sessions = result.rows.map((r: any) => ({
        id: r.id,
        task: r.task,
        status: r.status,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      }));

      this.send(ws, { type: "user_sessions", userId, sessions });
    } catch (err) {
      logger.error({ err, userId }, "Failed to load user sessions");
      this.send(ws, { type: "user_sessions", userId, sessions: [] });
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
