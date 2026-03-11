import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import QRCode from "qrcode";
import type { Connector, ConnectorCapabilities, IncomingMessage as AgentIncomingMessage, SendMessageOptions } from "./types.js";
import type { ConnectorManager } from "./connector-manager.js";
import type { WhatsAppConnector } from "./whatsapp.js";
import type { MediaAttachment } from "../llm/types.js";
import type { UserService, User, UserWithIdentities } from "../auth/user-service.js";

import { httpServer } from "../health.js";
import { config, reloadConfig } from "../config/env.js";
import { configGet, configSet, SETTINGS_KEY_MAP, ENV_SKIP_KEYS } from "../memory/config-store.js";
import { isPostgres, query } from "../memory/database.js";
import { logger, getLogBuffer, subscribeLogBuffer } from "../config/logger.js";
import { ClaudeOAuthService } from "../auth/claude-oauth.js";
import { OpenAIOAuthService } from "../auth/openai-oauth.js";
import { claudeOAuthService, openaiOAuthService } from "../auth/oauth-singleton.js";
import { GeminiProvider } from "../llm/providers/gemini.js";
import { resolveSessionsToken, getMainSessionName, getUserSessionsToken } from "../subagent/session-manager.js";
import { DEFAULT_SUBAGENT_EXECUTION_MODE, DEFAULT_SUBAGENT_MODEL, SUBAGENT_MODELS, type PendingQuestionPrompt, type SubAgentExecutionMode, type SubAgentModelId } from "../subagent/types.js";

/**
 * Web UI connector using WebSocket on the shared HTTP server.
 *
 * Handles:
 * - Chat messages (text, audio, image)
 * - Settings management (read/write .env)
 * - Sub-agent session listing
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
  /** Get sub-agent sessions for the UI (optionally filtered by owner user ID) */
  getSessionsForUI(ownerUserId?: number): Array<{
    id: string;
    state: string;
    taskDescription: string;
    variantName?: string;
    pendingQuestion?: PendingQuestionPrompt | null;
    sessionsToken?: string;
    preferredModel: SubAgentModelId;
    executionMode: SubAgentExecutionMode;
    numericUserId: number | null;
    createdAt: number;
    updatedAt: number;
  }>;
  /** Kill a sub-agent session */
  killSession(sessionId: string): Promise<void>;
  /** Send a message to a sub-agent session (follow-up) */
  sendToSession(
    sessionId: string,
    message: string,
    images?: MediaAttachment[],
    audioUrl?: string,
    imageUrls?: string[],
    fileInfos?: Array<{ url: string; name: string; mimeType: string }>
  ): Promise<void>;
  /** Get conversation history for a user (uses numericUserId when available for RBAC) */
  getConversationHistory(userPhone: string, limit?: number, numericUserId?: number): Promise<Array<{ role: string; content: string; created_at?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }>; message_type?: string }>>;
  /** Get message history for a sub-agent session */
  getSessionHistory(sessionId: string): Promise<Array<{ role: string; content: string; created_at: string; message_type?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }> }>>;
  /** Get the persisted status and variant name of a session from the DB */
  getSessionInfoFromDB(sessionId: string): Promise<{ status: string; variantName: string | null; numericUserId: number | null } | null>;
  /** Send audio transcription update to all web clients and main session viewers */
  sendTranscription(audioUrl: string, transcription: string, userId?: number): void;
  /** Clear conversation history for a user (uses numericUserId when available for RBAC) */
  clearConversation(userPhone: string, numericUserId?: number): Promise<void>;
  /** Create a blank sub-agent session (no initial task) and return the ack message */
  createBlankSubAgentSession(connectorName: string, userId: string): Promise<string>;
  /** Get conversation history for a user by numeric ID (for main session viewer) */
  getConversationHistoryByUserId(userId: number, limit?: number): Promise<Array<{ role: string; content: string; created_at?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }>; message_type?: string; connector_name?: string }>>;
  /** Handle an incoming message from the main session viewer */
  handleMainViewerMessage(numericUserId: number, userExternalId: string, text: string, userName?: string, userRole?: string, media?: MediaAttachment, imageMedias?: MediaAttachment[], audioUrl?: string, imageUrls?: string[], fileInfos?: Array<{ url: string; name: string; mimeType: string }>): Promise<string>;
  /** Register callback for broadcasting main-session messages to public viewers */
  setMainSessionCallback(cb: (userId: number, role: string, text: string, messageType?: string, connectorName?: string, mediaInfo?: { audioUrl?: string; imageUrls?: string[]; fileInfos?: Array<{ url: string; name: string; mimeType: string }> }) => void): void;
  /** Register callback for broadcasting typing state to public main-session viewers */
  setMainTypingCallback(cb: (userId: number, composing: boolean) => void): void;
  /** Interrupt any in-flight processing for a user. Returns true if there was something to interrupt. */
  interruptUser(userId: string): boolean;
  /** Check if a user currently has processing in flight. */
  isUserProcessing(userId: string): boolean;
  /** Interrupt a running sub-agent session. Returns true if there was a session to interrupt. */
  interruptSession(sessionId: string): boolean;
  /** Check if a sub-agent session is currently processing. */
  isSessionProcessing(sessionId: string): boolean;
  /** Set preferred primary model for a sub-agent session. */
  setSessionPreferredModel(sessionId: string, modelId: string): SubAgentModelId;
  /** Set execution mode for a sub-agent session. */
  setSessionExecutionMode(sessionId: string, mode: string): SubAgentExecutionMode;
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
  /** Public main-session WebSocket server (token-auth, for /m/:token viewers) */
  private mainWss: WebSocketServer | null = null;
  /** Public session WebSocket subscribers: sessionId → Set<WebSocket> */
  private sessionSubscribers = new Map<string, Set<WebSocket>>();
  /** Main session viewer subscribers: userId → Set<WebSocket> */
  private mainViewerSubscribers = new Map<number, Set<WebSocket>>();
  private clients = new Map<WebSocket, AuthenticatedClient>();
  private whatsappConnector: WhatsAppConnector | null = null;
  private agentBridge: WebAgentBridge | null = null;
  /** RBAC: user service for admin management */
  private userService: UserService | null = null;
  /** RBAC: memory service for accessing user conversations/sessions */

  /** Numeric user ID of the admin (resolved on first auth) */
  private adminUserId: number | null = null;
  /** Display name of the admin user (resolved alongside adminUserId) */
  private adminDisplayName: string | null = null;
  /** Tracks whether the agent is currently typing, so reconnecting clients restore the indicator */
  private currentlyTyping = false;
  /** Cached QR code data URL so late-connecting clients can still see the current QR */
  private pendingQrDataUrl: string | null = null;
  private claudeOAuth: ClaudeOAuthService = claudeOAuthService;
  private openaiOAuth: OpenAIOAuthService = openaiOAuthService;
  private unsubscribeLogStream: (() => void) | null = null;
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
   * Wire up agent bridge for settings and sessions.
   */
  setAgentBridge(bridge: WebAgentBridge): void {
    this.agentBridge = bridge;
    // Register callback so main-session viewers get real-time updates
    bridge.setMainSessionCallback((userId, role, text, messageType, connectorName, mediaInfo) => {
      this.broadcastToMainViewers(userId, role, text, messageType, mediaInfo);
    });
    // Register typing callback so main-session viewers see "Digitando..."
    bridge.setMainTypingCallback((userId, composing) => {
      this.broadcastTypingToMainViewers(userId, composing);
    });
  }

  /**
   * Wire up RBAC services for user management.
   */
  setUserService(userService: UserService): void {
    this.userService = userService;
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
    this.mainWss = new WebSocketServer({ noServer: true });

    if (!this.unsubscribeLogStream) {
      this.unsubscribeLogStream = subscribeLogBuffer((entry) => {
        this.broadcastToAuthenticated({ type: "log_entry", entry });
      });
    }

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
      // Public main session WebSocket: /ws/main?t=<token>
      if (request.url?.startsWith("/ws/main")) {
        this.mainWss!.handleUpgrade(request, socket, head, (ws) => {
          this.mainWss!.emit("connection", ws, request);
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

              // Resolve admin user ID and display name for RBAC (once, cached)
              if (this.adminUserId === null && this.userService) {
                try {
                  const admin = await this.userService.getAdminUser();
                  if (admin) {
                    this.adminUserId = admin.id;
                    this.adminDisplayName = admin.displayName || null;
                  }
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
              this.handleGetLogs(ws);
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

            case "test_database":
              await this.handleTestDatabase(ws, msg.which, msg.url);
              break;
            case "interrupt":
              // Interrupt main session (user's LLM request)
              // IMPORTANT: Use config.ownerPhone as the userId, matching what's used in handleUserMessage()
              if (this.agentBridge) {
                const interrupted = this.agentBridge.interruptUser(config.ownerPhone);
                this.send(ws, { type: "interrupt_result", interrupted });
                // Turn off typing indicator immediately when Stop is clicked.
                // Update currentlyTyping state so reconnecting clients get correct state.
                this.currentlyTyping = false;
                this.broadcastToAuthenticated({ type: "typing", composing: false });
                if (this.adminUserId) {
                  this.broadcastTypingToMainViewers(this.adminUserId, false);
                }
                logger.info({ userId: config.ownerPhone, interrupted }, "Admin interrupt request");
              }
              break;
            case "interrupt_session":
              // Interrupt a specific sub-agent session
              if (this.agentBridge && msg.sessionId) {
                const interrupted = this.agentBridge.interruptSession(msg.sessionId);
                this.send(ws, { type: "interrupt_result", sessionId: msg.sessionId, interrupted });
                logger.info({ sessionId: msg.sessionId, interrupted }, "Session interrupt request");
              }
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
      const sessionToken = url.searchParams.get("t") || "";
      let canWrite = false;

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
          const tokenUserId = sessionToken ? await resolveSessionsToken(sessionToken) : null;

          // Check if session exists (live) or has history (was alive before)
          const sessions = this.agentBridge!.getSessionsForUI();
          const session = sessions.find((s) => s.id === sessionId);

          const agentName = config.agentName;
          if (session) {
            canWrite = tokenUserId != null && tokenUserId === session.numericUserId;
            // Session is live — send history + info
            ws.send(JSON.stringify({ type: "session_history", messages: history }));
            const canManageProviders = session.numericUserId != null && session.numericUserId !== 1;
            ws.send(JSON.stringify({
              type: "session_info",
              session: {
                id: session.id,
                state: session.state,
                taskDescription: session.taskDescription,
                variantName: session.variantName,
                pendingQuestion: session.pendingQuestion,
                preferredModel: session.preferredModel || DEFAULT_SUBAGENT_MODEL,
                executionMode: session.executionMode || DEFAULT_SUBAGENT_EXECUTION_MODE,
                availableModels: SUBAGENT_MODELS,
                canManageProviders,
                canWrite,
                agentName,
              },
            }));
          } else if (history.length > 0) {
            // Session is no longer in memory — check DB for the real status
            const dbInfo = await this.agentBridge!.getSessionInfoFromDB(sessionId);
            canWrite = tokenUserId != null && tokenUserId === (dbInfo?.numericUserId ?? null);
            // Map DB status ('active'|'done'|'killed') to viewer state
            const state = dbInfo?.status === "killed" ? "killed" : "done";
            const variantName = dbInfo?.variantName || undefined;
            const canManageProviders = dbInfo?.numericUserId != null && dbInfo.numericUserId !== 1;
            ws.send(JSON.stringify({ type: "session_history", messages: history }));
            ws.send(JSON.stringify({
              type: "session_info",
              session: {
                id: sessionId,
                state,
                agentName,
                variantName,
                preferredModel: DEFAULT_SUBAGENT_MODEL,
                executionMode: DEFAULT_SUBAGENT_EXECUTION_MODE,
                availableModels: SUBAGENT_MODELS,
                canManageProviders,
                canWrite,
              },
            }));
          } else {
            // Session doesn't exist and has no history — not found
            ws.send(JSON.stringify({ type: "session_not_found", sessionId }));
          }
        }).catch((err) => {
          logger.warn({ err, sessionId }, "Failed to load session history for viewer");
          // Send a fallback so the viewer doesn't stay stuck on "Trabalhando..."
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: "session_info",
              session: {
                id: sessionId,
                state: "done",
                agentName: config.agentName,
                preferredModel: DEFAULT_SUBAGENT_MODEL,
                executionMode: DEFAULT_SUBAGENT_EXECUTION_MODE,
                availableModels: SUBAGENT_MODELS,
                canManageProviders: false,
                canWrite: false,
              },
            }));
          }
        });
      }

      // Handle messages from session viewer (user can send messages to the session)
      ws.on("message", async (data: Buffer | string) => {
        try {
          const raw = typeof data === "string" ? data : data.toString("utf-8");
          const msg = JSON.parse(raw);

          const isWriteAction =
            msg.type === "interrupt" ||
            msg.type === "set_model" ||
            msg.type === "set_mode" ||
            msg.type === "session_oauth_start" ||
            msg.type === "session_oauth_exchange" ||
            msg.type === "session_oauth_disconnect" ||
            msg.type === "message";
          if (isWriteAction && !canWrite) {
            ws.send(JSON.stringify({ type: "error", text: "Sessao online — somente leitura" }));
            return;
          }

          if (msg.type === "interrupt" && this.agentBridge) {
            // Interrupt the sub-agent session
            const interrupted = this.agentBridge.interruptSession(sessionId);
            ws.send(JSON.stringify({ type: "interrupt_result", sessionId, interrupted }));
            logger.info({ sessionId, interrupted }, "Session viewer interrupt request");
            return;
          }

          if (msg.type === "set_model" && this.agentBridge && typeof msg.modelId === "string") {
            try {
              const modelId = this.agentBridge.setSessionPreferredModel(sessionId, msg.modelId);
              const payload = JSON.stringify({ type: "model_updated", sessionId, modelId, availableModels: SUBAGENT_MODELS });
              const subs = this.sessionSubscribers.get(sessionId);
              if (subs) {
                for (const sub of subs) {
                  if (sub.readyState === WebSocket.OPEN) sub.send(payload);
                }
              }
            } catch (err) {
              const message = (err as Error).message || "Falha ao atualizar modelo";
              ws.send(JSON.stringify({ type: "error", text: message }));
            }
            return;
          }

          if (msg.type === "set_mode" && this.agentBridge && typeof msg.mode === "string") {
            try {
              const mode = this.agentBridge.setSessionExecutionMode(sessionId, msg.mode);
              const payload = JSON.stringify({ type: "mode_updated", sessionId, mode });
              const subs = this.sessionSubscribers.get(sessionId);
              if (subs) {
                for (const sub of subs) {
                  if (sub.readyState === WebSocket.OPEN) sub.send(payload);
                }
              }
            } catch (err) {
              const message = (err as Error).message || "Falha ao atualizar modo";
              ws.send(JSON.stringify({ type: "error", text: message }));
            }
            return;
          }

          if (msg.type === "get_session_oauth_status") {
            const status = await this.getSessionOAuthStatus(sessionId);
            ws.send(JSON.stringify({ type: "session_oauth_status", sessionId, status }));
            return;
          }

          if (msg.type === "session_oauth_start" && typeof msg.provider === "string") {
            try {
              const resolved = await this.resolveSessionOAuthUser(sessionId);
              if (!resolved.canManageProviders || resolved.userId == null) {
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Este usuario nao pode configurar provedores aqui." }));
                return;
              }
              if (msg.provider === "anthropic") {
                const { authUrl, state } = this.claudeOAuth.startAuth();
                ws.send(JSON.stringify({ type: "session_oauth_start", provider: msg.provider, authUrl, state }));
                return;
              }
              if (msg.provider === "openai") {
                const { authUrl, state } = this.openaiOAuth.startAuth();
                ws.send(JSON.stringify({ type: "session_oauth_start", provider: msg.provider, authUrl, state }));
                return;
              }
              ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Provider invalido." }));
            } catch (err) {
              logger.error({ err, sessionId, provider: msg.provider }, "Failed to start session OAuth flow");
              ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Falha ao iniciar OAuth." }));
            }
            return;
          }

          if (msg.type === "session_oauth_exchange" && typeof msg.provider === "string") {
            try {
              const resolved = await this.resolveSessionOAuthUser(sessionId);
              if (!resolved.canManageProviders || resolved.userId == null) {
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Este usuario nao pode configurar provedores aqui." }));
                return;
              }
              if (!msg.input || !String(msg.input).trim()) {
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Entrada vazia." }));
                return;
              }
              if (msg.provider === "anthropic") {
                const res = await this.claudeOAuth.exchangeCode(resolved.userId, String(msg.input));
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: res.success, error: res.error || null, email: res.email || null }));
              } else if (msg.provider === "openai") {
                const res = await this.openaiOAuth.exchangeCallback(resolved.userId, String(msg.input));
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: res.success, error: res.error || null, email: res.email || null }));
              } else {
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Provider invalido." }));
              }
              const status = await this.getSessionOAuthStatus(sessionId);
              ws.send(JSON.stringify({ type: "session_oauth_status", sessionId, status }));
            } catch (err) {
              logger.error({ err, sessionId, provider: msg.provider }, "Failed to exchange session OAuth callback/code");
              ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Falha ao concluir OAuth." }));
            }
            return;
          }

          if (msg.type === "session_oauth_disconnect" && typeof msg.provider === "string") {
            try {
              const resolved = await this.resolveSessionOAuthUser(sessionId);
              if (!resolved.canManageProviders || resolved.userId == null) {
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Este usuario nao pode configurar provedores aqui." }));
                return;
              }
              if (msg.provider === "anthropic") {
                await this.claudeOAuth.disconnect(resolved.userId);
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: true }));
              } else if (msg.provider === "openai") {
                await this.openaiOAuth.disconnect(resolved.userId);
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: true }));
              } else {
                ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Provider invalido." }));
              }
              const status = await this.getSessionOAuthStatus(sessionId);
              ws.send(JSON.stringify({ type: "session_oauth_status", sessionId, status }));
            } catch (err) {
              logger.error({ err, sessionId, provider: msg.provider }, "Failed to disconnect session OAuth");
              ws.send(JSON.stringify({ type: "session_oauth_result", provider: msg.provider, success: false, error: "Falha ao desconectar OAuth." }));
            }
            return;
          }

          if (msg.type === "message" && this.agentBridge) {
            let text = msg.text || "";
            const imageMedias: MediaAttachment[] = [];
            const imageUrls: string[] = [];
            const fileInfos: Array<{ url: string; name: string; mimeType: string }> = [];
            const fileTexts: string[] = [];
            let imageAttachmentCount = 0;
            let attachmentCount = 0;
            let audioUrl: string | undefined;

            const genId = () => Array.from({ length: 8 }, () =>
              Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
            ).join("");

            // Handle audio — transcribe via Gemini before forwarding
            if (msg.audio && msg.audioMimeType) {
              try {
                const buffer = Buffer.from(msg.audio, "base64");
                const media: MediaAttachment = { data: buffer, mimeType: msg.audioMimeType };

                try {
                  const id = genId();
                  await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, msg.audioMimeType]);
                  audioUrl = `/audio/${id}`;
                } catch (err) {
                  logger.error({ err }, "Failed to save audio blob (session viewer)");
                }

                const gemini = new GeminiProvider();
                if (gemini.isAvailable()) {
                  const result = await gemini.chat([
                    { role: "user", content: "Transcreva este áudio. Retorne APENAS o texto falado, sem prefixo, sem aspas, sem explicacao.", media },
                  ]);
                  const transcription = result.content.trim();
                  text = text ? `${text}\n\n[Áudio transcrito]: ${transcription}` : transcription;
                  // Broadcast transcription back to session viewer so it can
                  // replace the "Processando áudio…" placeholder in the DOM.
                  this.broadcastTranscriptionToSession(sessionId, audioUrl || "", transcription);
                } else {
                  const unavailableMsg = "O suporte a áudio está temporariamente indisponível. Por favor, digite sua mensagem.";
                  this.broadcastToSessionSubscribers(sessionId, "system", unavailableMsg);
                  return; // Don't forward the message — there's nothing to send
                }
              } catch (err) {
                logger.error({ err, sessionId }, "Session viewer audio transcription failed");
                text = text || "[erro ao transcrever áudio]";
              }
            }

            const files: Array<{ base64: string; mimeType: string; name?: string }> = [];
            if (msg.files && Array.isArray(msg.files)) {
              for (const f of msg.files) {
                if (f.base64 && f.mimeType) files.push(f);
              }
            }

            for (const f of files) {
              const buffer = Buffer.from(f.base64, "base64");

              if (f.mimeType.startsWith("image/")) {
                imageMedias.push({ data: buffer, mimeType: f.mimeType });
                imageAttachmentCount += 1;
                attachmentCount += 1;
                try {
                  const id = genId();
                  await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
                  imageUrls.push(`/img/${id}`);
                } catch (err) {
                  logger.error({ err }, "Failed to save image blob (session viewer)");
                }
              } else if (
                f.mimeType.startsWith("text/") ||
                f.mimeType === "application/json" ||
                f.mimeType === "application/xml" ||
                f.mimeType === "application/javascript"
              ) {
                const content = buffer.toString("utf-8");
                const fileName = f.name || "arquivo";
                fileTexts.push(`\n\n[Conteúdo do arquivo "${fileName}"]:\n${content}`);
                attachmentCount += 1;
                try {
                  const id = genId();
                  await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
                  fileInfos.push({ url: `/file/${id}`, name: fileName, mimeType: f.mimeType });
                } catch (err) {
                  logger.error({ err }, "Failed to save text file blob (session viewer)");
                }
              }
            }

            let promptText = text;
            const hasAttachments = attachmentCount > 0 || imageMedias.length > 0;
            if (!promptText && hasAttachments) {
              if (imageAttachmentCount > 0 && attachmentCount === imageAttachmentCount) {
                promptText = imageAttachmentCount > 1
                  ? `O usuario enviou ${imageAttachmentCount} imagens. Analise e descreva o que voce ve.`
                  : "O usuario enviou uma imagem. Analise a imagem e descreva o que voce ve.";
              } else {
                promptText = "O usuario enviou arquivos anexados. Leia-os e responda com base neles.";
              }
            }

            if (fileTexts.length > 0) {
              promptText = (promptText || "") + fileTexts.join("");
            }

            if (promptText || imageMedias.length > 0 || audioUrl || fileInfos.length > 0) {
              await this.handleSessionViewerMessage(
                sessionId,
                promptText,
                imageMedias.length > 0 ? imageMedias : undefined,
                audioUrl,
                imageUrls.length > 0 ? imageUrls : undefined,
                fileInfos.length > 0 ? fileInfos : undefined,
              );
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

    // ==================== Public main session WebSocket ====================
    this.mainWss.on("connection", (ws: WebSocket, request: IncomingMessage) => {
      const url = new URL(request.url || "", "http://localhost");
      const token = url.searchParams.get("t") || "";

      if (!token) {
        ws.close(4000, "Missing token");
        return;
      }

      // Resolve token → userId asynchronously
      resolveSessionsToken(token).then(async (userId) => {
        if (!userId) {
          ws.send(JSON.stringify({ type: "error", text: "Token invalido" }));
          ws.close(4001, "Invalid token");
          return;
        }

        // Subscribe this WebSocket to the user's main session
        if (!this.mainViewerSubscribers.has(userId)) {
          this.mainViewerSubscribers.set(userId, new Set());
        }
        this.mainViewerSubscribers.get(userId)!.add(ws);

        logger.info({ userId, subscribers: this.mainViewerSubscribers.get(userId)!.size }, "Main session viewer connected");

        // Send session info
        const mainName = getMainSessionName();
        ws.send(JSON.stringify({ type: "session_info", session: { id: "main", state: "running", variantName: mainName, agentName: config.agentName } }));

        // Send conversation history
        if (this.agentBridge) {
          try {
            const history = await this.agentBridge.getConversationHistoryByUserId(userId, 200);
            ws.send(JSON.stringify({ type: "session_history", messages: history }));
          } catch (err) {
            logger.warn({ err, userId }, "Failed to load main session history");
          }
        }

        // Send current typing state so viewer shows "Digitando..." if agent is already processing
        if (this.currentlyTyping) {
          ws.send(JSON.stringify({ type: "typing", composing: true }));
        }

        // Handle messages from main session viewer (supports text, audio, files)
        ws.on("message", async (data: Buffer | string) => {
          try {
            const raw = typeof data === "string" ? data : data.toString("utf-8");
            const msg = JSON.parse(raw);

            if (msg.type === "interrupt" && this.agentBridge) {
              // Interrupt the main session (user's LLM request)
              // Use the user's external ID (phone) as the userId for interrupt
              const userRow = await query(`SELECT phone FROM users WHERE id = $1`, [userId]);
              const userExternalId = userRow.rows[0]?.phone || String(userId);
              const interrupted = this.agentBridge.interruptUser(userExternalId);
              ws.send(JSON.stringify({ type: "interrupt_result", interrupted }));
              // Turn off typing indicator immediately when Stop is clicked.
              // Update currentlyTyping state so reconnecting clients get correct state.
              this.currentlyTyping = false;
              this.broadcastToAuthenticated({ type: "typing", composing: false });
              this.broadcastTypingToMainViewers(userId, false);
              logger.info({ userId, userExternalId, interrupted }, "Main viewer interrupt request");
              return;
            }

            if (msg.type === "message" && this.agentBridge) {
              try {
                // Get user's external ID, display name, and role for routing
                const userRow = await query(`SELECT phone, display_name, role FROM users WHERE id = $1`, [userId]);
                const userExternalId = userRow.rows[0]?.phone || String(userId);
                const userDisplayName = userRow.rows[0]?.display_name || undefined;
                const userRole = userRow.rows[0]?.role || "admin";

                // Process audio and files (same logic as handleClientMessage)
                let media: MediaAttachment | undefined;
                const imageMedias: MediaAttachment[] = [];
                let audioUrl: string | undefined;
                const imageUrls: string[] = [];
                const fileTexts: string[] = [];
                const fileInfos: Array<{ url: string; name: string; mimeType: string }> = [];
                let imageAttachmentCount = 0;
                let attachmentCount = 0;

                const genId = () => Array.from({ length: 8 }, () =>
                  Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
                ).join("");

                // Process audio
                const audioMime = msg.audioMimeType || msg.mimeType;
                if (msg.audio && audioMime) {
                  const buffer = Buffer.from(msg.audio, "base64");
                  media = { data: buffer, mimeType: audioMime };
                  logger.info({ type: "audio", size: buffer.length, mimeType: audioMime }, "Main viewer audio received");
                  try {
                    const id = genId();
                    await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, audioMime]);
                    audioUrl = `/audio/${id}`;
                  } catch (err) {
                    logger.error({ err }, "Failed to save audio blob (main viewer)");
                  }
                }

                // Process files
                const files: Array<{ base64: string; mimeType: string; name?: string }> = [];
                if (msg.files && Array.isArray(msg.files)) {
                  for (const f of msg.files) {
                    if (f.base64 && f.mimeType) files.push(f);
                  }
                }

                for (const f of files) {
                  const buffer = Buffer.from(f.base64, "base64");

                  if (f.mimeType.startsWith("image/")) {
                    imageMedias.push({ data: buffer, mimeType: f.mimeType });
                    imageAttachmentCount += 1;
                    attachmentCount += 1;
                    try {
                      const id = genId();
                      await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
                      imageUrls.push(`/img/${id}`);
                    } catch (err) {
                      logger.error({ err }, "Failed to save image blob (main viewer)");
                    }
                  } else if (
                    f.mimeType.startsWith("text/") ||
                    f.mimeType === "application/json" ||
                    f.mimeType === "application/xml" ||
                    f.mimeType === "application/javascript"
                  ) {
                    const content = buffer.toString("utf-8");
                    const fileName = f.name || "arquivo";
                    fileTexts.push(`\n\n[Conteúdo do arquivo "${fileName}"]:\n${content}`);
                    attachmentCount += 1;
                    try {
                      const id = genId();
                      await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
                      fileInfos.push({ url: `/file/${id}`, name: fileName, mimeType: f.mimeType });
                    } catch (err) {
                      logger.error({ err }, "Failed to save text file blob (main viewer)");
                    }
                  } else if (f.mimeType === "application/pdf") {
                    imageMedias.push({ data: buffer, mimeType: f.mimeType });
                    attachmentCount += 1;
                    try {
                      const id = genId();
                      await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
                      imageUrls.push(`/img/${id}`);
                    } catch (err) {
                      logger.error({ err }, "Failed to save PDF blob (main viewer)");
                    }
                  } else {
                    const fileName = f.name || "arquivo";
                    attachmentCount += 1;

                    // Tentar decodificar como texto (mesma heurística do web UI)
                    const isLikelyText = buffer.length <= 512_000 && !buffer.some((b: number) => b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b));
                    if (isLikelyText) {
                      const content = buffer.toString("utf-8");
                      fileTexts.push(`\n\n[Conteúdo do arquivo "${fileName}"]:\n${content}`);
                    } else {
                      const sizeKB = Math.round(buffer.length / 1024);
                      fileTexts.push(`\n\n[Arquivo anexado: "${fileName}" (${f.mimeType}, ${sizeKB}KB) — conteúdo binário, não é possível ler diretamente]`);
                    }

                    try {
                      const id = genId();
                      await query(`INSERT INTO audio_blobs (id, data, mime_type) VALUES ($1, $2, $3)`, [id, buffer, f.mimeType]);
                      fileInfos.push({ url: `/file/${id}`, name: fileName, mimeType: f.mimeType });
                    } catch (err) {
                      logger.error({ err }, "Failed to save generic file blob (main viewer)");
                    }
                  }
                }

                // If no audio, first image becomes primary media
                if (!media && imageMedias.length > 0) {
                  media = imageMedias.shift();
                }

                // Build prompt text
                const text = msg.text || "";
                const hasAttachments = attachmentCount > 0 || (!!media && !msg.audio);
                const hasImages = imageAttachmentCount > 0;
                let promptText: string;

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

                if (fileTexts.length > 0) {
                  promptText = (promptText || "") + fileTexts.join("");
                }

                if (!promptText && !media) return;

                const response = await this.agentBridge.handleMainViewerMessage(
                  userId, userExternalId, promptText, userDisplayName, userRole,
                  media, imageMedias.length > 0 ? imageMedias : undefined,
                  audioUrl, imageUrls.length > 0 ? imageUrls : undefined,
                  fileInfos.length > 0 ? fileInfos : undefined,
                );

                // If last user message (before this one) was from WhatsApp,
                // also relay the agent response to WhatsApp
                if (response) {
                  const lastUserMsg = await this.getLastUserMessageConnector(userId);
                  if (lastUserMsg === "whatsapp") {
                    this.manager.sendMessage("whatsapp", userExternalId, response).catch((err) => {
                      logger.warn({ err, userId }, "Failed to relay main-viewer response to WhatsApp");
                    });
                  }
                }
              } catch (err) {
                logger.error({ err, userId }, "Failed to handle main viewer message");
                this.broadcastToMainViewers(userId, "agent", `Erro: ${(err as Error).message}`);
              }
            }
          } catch (err) {
            logger.warn({ err, userId }, "Error processing main viewer message");
          }
        });

        ws.on("close", () => {
          const subs = this.mainViewerSubscribers.get(userId);
          if (subs) {
            subs.delete(ws);
            if (subs.size === 0) this.mainViewerSubscribers.delete(userId);
          }
          logger.info({ userId }, "Main session viewer disconnected");
        });

        ws.on("error", () => {
          const subs = this.mainViewerSubscribers.get(userId);
          if (subs) {
            subs.delete(ws);
            if (subs.size === 0) this.mainViewerSubscribers.delete(userId);
          }
        });
      }).catch((err) => {
        logger.warn({ err }, "Failed to resolve main session token");
        ws.close(4002, "Token resolution failed");
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

    if (this.unsubscribeLogStream) {
      this.unsubscribeLogStream();
      this.unsubscribeLogStream = null;
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
        // Outros tipos: tentar decodificar como texto UTF-8.
        // Muitos arquivos com application/octet-stream (.key, .env, .cfg, etc.)
        // são na verdade texto puro que o LLM pode ler.
        const fileName = f.name || "arquivo";
        attachmentCount += 1;
        logger.info({ mimeType: f.mimeType, name: fileName, size: buffer.length }, "Generic file received");

        // Heurística: se o buffer não contém bytes de controle (exceto \n, \r, \t),
        // é provavelmente texto legível.
        const isLikelyText = buffer.length <= 512_000 && !buffer.some((b) => b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b));
        if (isLikelyText) {
          const content = buffer.toString("utf-8");
          fileTexts.push(`\n\n[Conteúdo do arquivo "${fileName}"]:\n${content}`);
          logger.info({ type: "generic-as-text", name: fileName, chars: content.length }, "Generic file decoded as text");
        } else {
          // Binário real: informar nome, tipo e tamanho para o LLM ter contexto
          const sizeKB = Math.round(buffer.length / 1024);
          fileTexts.push(`\n\n[Arquivo anexado: "${fileName}" (${f.mimeType}, ${sizeKB}KB) — conteúdo binário, não é possível ler diretamente]`);
          logger.info({ type: "generic-binary", name: fileName, sizeKB }, "Binary file metadata added to prompt");
        }

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
      userName: this.adminDisplayName || undefined,
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
        if (admin) {
          this.adminUserId = admin.id;
          this.adminDisplayName = admin.displayName || null;
        }
      } catch (_) { /* best-effort */ }
    }

    if (response) {
      const respPayload: Record<string, any> = { type: "message", text: response, from: "agent" };
      if (clientSessionId) respPayload.sessionId = clientSessionId;
      this.broadcastToAuthenticated(respPayload);
    }

    // NOTE: typing:false is handled by agent.ts with generation-awareness.
    // Do NOT send typing:false here - it would override the generation logic
    // and turn off the indicator prematurely when messages are superseded.
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

      // Check if GitHub token has push access to the project repo
      let githubRepoWriteAccess = false;
      if (githubToken) {
        try {
          const repo = "ruanbarroso/rick-ai";
          const res = await fetch(`https://api.github.com/repos/${repo}`, {
            headers: { Authorization: `token ${githubToken}`, Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data = await res.json() as { permissions?: { push?: boolean } };
            githubRepoWriteAccess = !!data.permissions?.push;
          }
        } catch { /* network error — default to false */ }
      }

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
          githubRepoWriteAccess,
          agentName: config.agentName,
          agentLogo: (await configGet("AGENT_LOGO")) || "",
          webBaseUrl: config.webBaseUrl,
          whatsappConnected: this.whatsappConnector?.isConnected() || false,
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

  // ==================== Database Connection Test ====================

  /**
   * Test a PostgreSQL connection string (for DATABASE_URL or VECTOR_DATABASE_URL).
   */
  private async handleTestDatabase(ws: WebSocket, which: string, url: string): Promise<void> {
    if (!url || typeof url !== "string") {
      this.send(ws, { type: "test_database_result", which, success: false, error: "URL vazia" });
      return;
    }

    try {
      // Dynamic import to avoid bundling pg if not used
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 8000 });
      await client.connect();

      // For vector DB, also check if pgvector extension is available
      let vectorOk = false;
      if (which === "vector") {
        try {
          await client.query("CREATE EXTENSION IF NOT EXISTS vector");
          vectorOk = true;
        } catch {
          // Extension not available but connection works
        }
      }

      await client.end();

      const msg = which === "vector"
        ? (vectorOk ? "Conectado! Extensao pgvector disponivel." : "Conectado, mas extensao pgvector NAO encontrada.")
        : "Conectado com sucesso!";
      this.send(ws, { type: "test_database_result", which, success: true, message: msg, vectorOk });
    } catch (err: any) {
      const errMsg = err.message || "Erro desconhecido";
      logger.warn({ err: errMsg, which }, "Database connection test failed");
      this.send(ws, { type: "test_database_result", which, success: false, error: errMsg });
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

    const sessions = this.agentBridge.getSessionsForUI(this.adminUserId ?? undefined);
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
      const sessions = this.agentBridge.getSessionsForUI(this.adminUserId ?? undefined);
      this.broadcastToAuthenticated({ type: "sessions", sessions });
    } catch (err) {
      logger.error({ err }, "Failed to start blank sub-agent session");
      this.send(ws, { type: "error", text: "Erro ao criar nova sessao de sub-agente." });
    }
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

  private async resolveSessionOAuthUser(sessionId: string): Promise<{ userId: number | null; canManageProviders: boolean }> {
    if (!this.agentBridge) return { userId: null, canManageProviders: false };

    const liveSession = this.agentBridge.getSessionsForUI().find((s) => s.id === sessionId);
    const liveUserId = liveSession?.numericUserId ?? null;
    if (liveUserId != null) {
      return { userId: liveUserId, canManageProviders: liveUserId !== 1 };
    }

    const dbInfo = await this.agentBridge.getSessionInfoFromDB(sessionId);
    const dbUserId = dbInfo?.numericUserId ?? null;
    return { userId: dbUserId, canManageProviders: dbUserId != null && dbUserId !== 1 };
  }

  private async getSessionOAuthStatus(sessionId: string): Promise<{
    canManageProviders: boolean;
    providers: {
      anthropic: { connected: boolean; source: "user" | "admin" | "none"; email: string | null };
      openai: { connected: boolean; source: "user" | "admin" | "none"; email: string | null };
    };
  }> {
    const resolved = await this.resolveSessionOAuthUser(sessionId);
    const empty = {
      canManageProviders: false,
      providers: {
        anthropic: { connected: false, source: "none" as const, email: null },
        openai: { connected: false, source: "none" as const, email: null },
      },
    };

    if (!resolved.canManageProviders || resolved.userId == null) {
      return empty;
    }

    const adminUserId = 1;
    const [userClaude, userOpenAI, adminClaude, adminOpenAI] = await Promise.all([
      this.claudeOAuth.isConnected(resolved.userId),
      this.openaiOAuth.isConnected(resolved.userId),
      this.claudeOAuth.isConnected(adminUserId),
      this.openaiOAuth.isConnected(adminUserId),
    ]);

    const anthropic = userClaude.connected
      ? { connected: true, source: "user" as const, email: userClaude.email || null }
      : adminClaude.connected
        ? { connected: true, source: "admin" as const, email: adminClaude.email || null }
        : { connected: false, source: "none" as const, email: null };

    const openai = userOpenAI.connected
      ? { connected: true, source: "user" as const, email: userOpenAI.email || null }
      : adminOpenAI.connected
        ? { connected: true, source: "admin" as const, email: adminOpenAI.email || null }
        : { connected: false, source: "none" as const, email: null };

    return {
      canManageProviders: true,
      providers: {
        anthropic,
        openai,
      },
    };
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
  broadcastToSessionSubscribers(
    sessionId: string,
    role: string,
    text: string,
    messageType?: string,
    mediaInfo?: { audioUrl?: string; imageUrls?: string[]; fileInfos?: Array<{ url: string; name: string; mimeType: string }> }
  ): void {
    const subs = this.sessionSubscribers.get(sessionId);
    if (!subs || subs.size === 0) return;

    const msg: Record<string, any> = { type: "message", role, text, messageType: messageType || "text", time: new Date().toISOString() };
    if (mediaInfo?.audioUrl) msg.audioUrl = mediaInfo.audioUrl;
    if (mediaInfo?.imageUrls && mediaInfo.imageUrls.length > 0) msg.imageUrls = mediaInfo.imageUrls;
    if (mediaInfo?.fileInfos && mediaInfo.fileInfos.length > 0) msg.fileInfos = mediaInfo.fileInfos;
    const payload = JSON.stringify(msg);
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /**
   * Send a dedicated "transcription" event to session-viewer subscribers
   * so they can replace the "Processando áudio…" placeholder in real-time.
   */
  private broadcastTranscriptionToSession(sessionId: string, audioUrl: string, transcription: string): void {
    const subs = this.sessionSubscribers.get(sessionId);
    if (!subs || subs.size === 0) return;

    const payload = JSON.stringify({ type: "transcription", audioUrl, text: transcription });
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /**
   * Get the connector_name of the last user message before the current one.
   * Used to decide whether to relay the agent response to WhatsApp.
   */
  private async getLastUserMessageConnector(userId: number): Promise<string | null> {
    try {
      // Get the second-to-last user message (the one BEFORE the main-viewer message we just sent)
      const result = await query(
        `SELECT connector_name FROM conversations
         WHERE user_id = $1 AND role = 'user' AND connector_name IS NOT NULL AND connector_name != 'main-viewer'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      return result.rows[0]?.connector_name || null;
    } catch {
      return null;
    }
  }

  /**
   * Broadcast a message to all main session viewers for a given user.
   * Called when a message is sent/received in the main session (from any connector).
   */
  broadcastToMainViewers(userId: number, role: string, text: string, messageType?: string, mediaInfo?: { audioUrl?: string; imageUrls?: string[]; fileInfos?: Array<{ url: string; name: string; mimeType: string }> }): void {
    const subs = this.mainViewerSubscribers.get(userId);
    if (!subs || subs.size === 0) return;

    const msg: Record<string, any> = { type: "message", role, text, messageType: messageType || "text", time: new Date().toISOString() };
    if (mediaInfo?.audioUrl) msg.audioUrl = mediaInfo.audioUrl;
    if (mediaInfo?.imageUrls && mediaInfo.imageUrls.length > 0) msg.imageUrls = mediaInfo.imageUrls;
    if (mediaInfo?.fileInfos && mediaInfo.fileInfos.length > 0) msg.fileInfos = mediaInfo.fileInfos;
    const payload = JSON.stringify(msg);
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /**
   * Broadcast typing state to all main session viewers for a given user.
   */
  broadcastTypingToMainViewers(userId: number, composing: boolean): void {
    const subs = this.mainViewerSubscribers.get(userId);
    if (!subs || subs.size === 0) return;

    const payload = JSON.stringify({ type: "typing", composing });
    for (const ws of subs) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /**
   * Handle a message from a public session viewer — forwards it directly to the sub-agent session.
   */
  private async handleSessionViewerMessage(
    sessionId: string,
    text: string,
    images?: MediaAttachment[],
    audioUrl?: string,
    imageUrls?: string[],
    fileInfos?: Array<{ url: string; name: string; mimeType: string }>
  ): Promise<void> {
    if (!this.agentBridge) return;

    try {
      await this.agentBridge.sendToSession(sessionId, text, images, audioUrl, imageUrls, fileInfos);
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
          sessionsToken: getUserSessionsToken(userWithIds.id),
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
      const { user: updated, welcomeSent, welcomeError } = await this.userService.setUserRole(userId, role);
      this.send(ws, {
        type: "user_updated",
        user: {
          id: updated.id,
          role: updated.role,
          status: updated.status,
          displayName: updated.displayName,
        },
        welcomeSent,
        welcomeError,
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

  // ==================== Helpers ====================

  private send(ws: WebSocket, data: object): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  /** Send audio transcription update to all authenticated web clients and main session viewers */
  sendTranscription(audioUrl: string, transcription: string, userId?: number): void {
    const payload = { type: "transcription", audioUrl, text: transcription };
    // Broadcast to web-ui clients (admin panel)
    this.broadcastToAuthenticated(payload);
    // Broadcast to main-session-viewer subscribers for this user
    if (userId !== undefined) {
      const subs = this.mainViewerSubscribers.get(userId);
      if (subs && subs.size > 0) {
        const json = JSON.stringify(payload);
        for (const ws of subs) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(json);
          }
        }
      }
    }
  }

  private broadcastToAuthenticated(data: object): void {
    const payload = JSON.stringify(data);
    for (const [ws, client] of this.clients) {
      if (client.authenticated && ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  /** Public broadcast to all authenticated clients. Used by health/auto-update. */
  broadcast(data: object): void {
    this.broadcastToAuthenticated(data);
  }
}
