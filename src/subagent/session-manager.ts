import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubAgentSession, SessionState } from "./types.js";
import type { ConnectorManager } from "../connectors/connector-manager.js";
import type { MediaAttachment } from "../llm/types.js";
import { query } from "../memory/database.js";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { createAgentToken } from "./agent-token.js";
import type { MemoryService } from "../memory/memory-service.js";
import { subagentImageBuilder, SUBAGENT_RUNTIME_IMAGE } from "./subagent-image-builder.js";

const execFileAsync = promisify(execFile);

/**
 * Normalize an arbitrary string into a valid env-var name segment (uppercase, underscores only).
 * Returns null if the input contains no valid characters (all special chars).
 */
function sanitizeEnvKey(raw: string): string | null {
  const sanitized = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return sanitized || null;
}

/** Variant name suffixes — must match frontend AGENT_NAMES_SUFFIXES array */
const VARIANT_SUFFIXES = ["Prime", "Alpha", "Beta", "Gamma", "Delta", "Omega", "Neo", "Zero", "Nova", "Flux"];

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** Get a variant name for a session ID (deterministic, matches frontend). */
export function getSessionRickName(sessionId: string): string {
  const suffix = VARIANT_SUFFIXES[hashString(sessionId) % VARIANT_SUFFIXES.length];
  return `${config.agentName} ${suffix}`;
}

/** Callback for broadcasting messages to public session subscribers (WebSocket viewers). */
export type SessionMessageCallback = (sessionId: string, role: string, text: string, messageType?: string) => void;

/**
 * Manages unified sub-agent sessions — container lifecycle, NDJSON stdin/stdout relay.
 * Each session gets its own Docker container with Chromium + Playwright + all LLM providers.
 */
export class SessionManager {
  private sessions = new Map<string, SubAgentSession>();
  private connectorManager: ConnectorManager;
  private memoryService: MemoryService | null;
  private onSessionMessage: SessionMessageCallback | null = null;

  /** Active child processes for each session (docker exec) */
  private processes = new Map<string, ChildProcess>();

  constructor(connectorManager: ConnectorManager, memoryService?: MemoryService) {
    this.connectorManager = connectorManager;
    this.memoryService = memoryService ?? null;
  }

  setSessionMessageCallback(cb: SessionMessageCallback): void {
    this.onSessionMessage = cb;
  }

  // ==================== SESSION RECOVERY ====================

  async recoverSessions(): Promise<number> {
    try {
      const { stdout } = await execFileAsync("docker", [
        "ps",
        "--filter", "name=subagent-",
        "--filter", "status=running",
        "--format", "{{.Names}}\t{{.ID}}\t{{.CreatedAt}}",
      ]);

      const lines = stdout.trim().split("\n").filter((l) => l.trim());
      if (lines.length === 0) {
        logger.info("Session recovery: no running subagent containers found");
        return 0;
      }

      let recovered = 0;
      for (const line of lines) {
        const [containerName, containerId, createdAt] = line.split("\t");
        if (!containerName || !containerId) continue;

        // Parse: subagent-{id}
        const match = containerName.match(/^subagent-([a-f0-9]+)$/);
        if (!match) {
          // Try legacy format: subagent-{type}-{id}
          const legacyMatch = containerName.match(/^subagent-(?:code|research)-([a-f0-9]+)$/);
          if (!legacyMatch) {
            logger.warn({ containerName }, "Session recovery: skipping unrecognized container");
            continue;
          }
          // Kill legacy containers — they use the old architecture
          try {
            await execFileAsync("docker", ["rm", "-f", containerName]);
            logger.info({ containerName }, "Session recovery: killed legacy container");
          } catch {}
          continue;
        }

        const id = match[1];
        if (this.sessions.has(id)) continue;

        let createdTime = Date.now();
        if (createdAt) {
          const cleaned = createdAt.replace(" UTC", "").replace(" +0000", "Z").trim();
          const parsed = new Date(cleaned);
          if (!isNaN(parsed.getTime())) createdTime = parsed.getTime();
        }

        // Restore routing metadata from DB so messages reach the original user/connector
        let connectorName = "web";
        let userId = "owner";
        let numericUserId: number | null = null;
        try {
          const dbRow = await query(
            `SELECT connector_name, user_external_id, user_id FROM sub_agent_sessions WHERE id = $1`,
            [id]
          );
          if (dbRow.rows.length > 0) {
            connectorName = dbRow.rows[0].connector_name || "web";
            userId = dbRow.rows[0].user_external_id || "owner";
            numericUserId = dbRow.rows[0].user_id ?? null;
          }
        } catch (err) {
          logger.warn({ err, sessionId: id }, "Session recovery: failed to restore routing metadata from DB, using defaults");
        }

        const session: SubAgentSession = {
          id,
          containerId: containerId.trim(),
          containerName,
          state: "waiting_user",
          taskDescription: "(sessao recuperada apos reinicio)",
          credentials: {},
          connectorName,
          userId,
          numericUserId,
          output: "",
          pendingQuestion: null,
          recovered: true,
          createdAt: createdTime,
          updatedAt: Date.now(),
        };

        this.sessions.set(id, session);
        recovered++;

        // Start the NDJSON process for recovered session
        this.startAgentProcess(session).catch((err) => {
          logger.error({ err, sessionId: id }, "Failed to start agent process for recovered session");
        });

        logger.info({ sessionId: id, containerName }, "Session recovery: recovered subagent");
      }

      if (recovered > 0) {
        logger.info({ recovered }, "Session recovery: total sessions recovered");
      }
      return recovered;
    } catch (err) {
      logger.error({ err }, "Session recovery: failed to list containers");
      return 0;
    }
  }

  // ==================== SESSION GETTERS ====================

  getSession(id: string): SubAgentSession | null {
    return this.sessions.get(id) || null;
  }

  /** Get the session that sent the most recent poll (for vote resolution). */
  getLastPollSession(): SubAgentSession | null {
    // TODO: Track lastPollSessionId when polls are implemented in unified sub-agent
    return null;
  }

  isValidSession(id: string): boolean {
    return this.sessions.has(id);
  }

  /**
   * Look up the persisted status of a session from the DB.
   * Returns 'active' | 'done' | 'killed' | null (not found).
   */
  async getSessionStatusFromDB(sessionId: string): Promise<string | null> {
    try {
      const result = await query(
        `SELECT status FROM sub_agent_sessions WHERE id = $1`,
        [sessionId]
      );
      if (result.rows.length > 0) {
        return result.rows[0].status;
      }
      return null;
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to query session status from DB");
      return null;
    }
  }

  getLiveSessions(): SubAgentSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state === "starting" || s.state === "running" || s.state === "waiting_user" || s.state === "done"
    );
  }

  getDoneSessions(): SubAgentSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "done");
  }

  /** Get done sessions belonging to a specific user (by phone/userId). */
  getDoneSessionsForUser(userId: string): SubAgentSession[] {
    return this.getDoneSessions().filter((s) => s.userId === userId);
  }

  getRunningSessions(): SubAgentSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state === "starting" || s.state === "running"
    );
  }

  /** Get running sessions belonging to a specific user. */
  getRunningSessionsForUser(userId: string): SubAgentSession[] {
    return this.getRunningSessions().filter((s) => s.userId === userId);
  }

  hasLiveSessions(): boolean {
    return this.getLiveSessions().length > 0;
  }

  hasDoneSessions(): boolean {
    return this.getDoneSessions().length > 0;
  }

  /** Check if a specific user has done sessions. */
  hasDoneSessionsForUser(userId: string): boolean {
    return this.getDoneSessionsForUser(userId).length > 0;
  }

  getMostRecentDoneSession(): SubAgentSession | null {
    const done = this.getDoneSessions();
    if (done.length === 0) return null;
    return done.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  /** Get the most recent done session for a specific user. */
  getMostRecentDoneSessionForUser(userId: string): SubAgentSession | null {
    const done = this.getDoneSessionsForUser(userId);
    if (done.length === 0) return null;
    return done.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  /**
   * Auto-expire stale "done" sessions.
   * Sessions in "done" state for longer than maxAgeMs are auto-killed.
   * This prevents stale sessions from intercepting all WhatsApp messages.
   */
  async expireStaleDoneSessions(maxAgeMs: number = 30 * 60 * 1000): Promise<number> {
    const now = Date.now();
    const stale = this.getDoneSessions().filter((s) => now - s.updatedAt > maxAgeMs);
    let expired = 0;
    for (const session of stale) {
      logger.info({ sessionId: session.id, userId: session.userId, ageMinutes: Math.round((now - session.updatedAt) / 60000) }, "Auto-expiring stale done session");
      try {
        await this.killSession(session.id);
        expired++;
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, "Failed to auto-expire session");
      }
    }
    return expired;
  }

  // ==================== SESSION LIFECYCLE ====================

  /**
   * Create a new sub-agent session.
   * @param taskDescription - What the user wants (optional, can be empty for blank sessions)
   * @param connectorName - Which connector originated the request
   * @param userId - User ID for routing responses
   * @param credentials - Resolved credentials to pass to the sub-agent
   * @param env - Environment variables to pass to the container
   */
  async createSession(
    taskDescription: string,
    connectorName: string,
    userId: string,
    credentials: Record<string, string>,
    env: Record<string, string>,
    images?: MediaAttachment[],
    numericUserId?: number
  ): Promise<SubAgentSession> {
    const id = randomBytes(8).toString("hex");
    const containerName = `subagent-${id}`;

    const session: SubAgentSession = {
      id,
      containerId: null,
      containerName,
      state: "starting",
      taskDescription,
      credentials,
      connectorName,
      userId,
      numericUserId: numericUserId ?? null,
      output: "",
      pendingQuestion: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(id, session);

    // Show immediate feedback in the session viewer while the container is being prepared.
    await this.sendToUser(session, "Preparando ambiente do sub-agente...");

    // Persist session to DB for audit trail
    if (numericUserId) {
      this.persistSessionToDB(session).catch((err) =>
        logger.warn({ err, sessionId: id }, "Failed to persist session to DB")
      );
    }

    try {
      let notified = false;
      await subagentImageBuilder.ensureForSession({
        onStatus: (status) => {
          if (notified) return;
          notified = true;
          const text = status === "building_fresh"
            ? "Primeira execucao detectada. Construindo imagem do sub-agente..."
            : status === "waiting_first_build"
              ? "Aguardando finalizacao da preparacao inicial do sub-agente..."
              : "Atualizacao da imagem em segundo plano. Iniciando com a imagem atual...";
          this.sendToUser(session, text, "tool_use").catch(() => {});
        },
      });
      await this.startContainer(session, env, images);
    } catch (err) {
      logger.error({ err, sessionId: id }, "Failed to start sub-agent container");
      session.state = "killed";
      this.sessions.delete(id);
      // Update DB status
      this.updateSessionStatus(id, "killed").catch(() => {});
      throw err;
    }

    return session;
  }

  warmupSubagentImage(): void {
    subagentImageBuilder.warmup("startup");
  }

  /**
   * Send a user message to an existing session.
   */
  async sendToSession(sessionId: string, message: string, images?: MediaAttachment[], audioUrl?: string, imageUrls?: string[], fileInfos?: Array<{ url: string; name: string; mimeType: string }>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.containerId) {
      throw new Error(`No session with id ${sessionId}`);
    }

    session.state = "running";
    session.pendingQuestion = null;
    session.updatedAt = Date.now();

    // Persist user message and broadcast to session subscribers
    this.saveSessionMessage(sessionId, "user", message, "text", audioUrl, imageUrls, fileInfos).catch(() => {});
    if (this.onSessionMessage) {
      this.onSessionMessage(sessionId, "user", message);
    }

    // Copy images into the container and collect paths
    const imagePaths = await this.injectImages(session, images);

    // Send via stdin NDJSON
    const payload: any = { type: "message", text: message };
    if (imagePaths.length > 0) payload.images = imagePaths;
    this.sendToAgentProcess(sessionId, payload);
  }

  async killSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Kill the agent process
    const proc = this.processes.get(sessionId);
    if (proc) {
      try { proc.kill("SIGTERM"); } catch {}
      this.processes.delete(sessionId);
    }

    // Kill the container
    if (session.containerId) {
      try {
        await execFileAsync("docker", ["rm", "-f", session.containerName]);
        logger.info({ sessionId, container: session.containerName }, "Sub-agent container killed");
      } catch (err) {
        logger.warn({ err, container: session.containerName }, "Failed to kill container");
      }
    }

    session.state = "killed";
    session.updatedAt = Date.now();

    // Notify session viewers of state change
    if (this.onSessionMessage) {
      this.onSessionMessage(sessionId, "system", JSON.stringify({ state: "killed" }), "system");
    }

    // Persist final state to DB (session_messages are NOT deleted — kept for audit)
    this.updateSessionStatus(sessionId, "killed").catch(() => {});
    this.sessions.delete(sessionId);
  }

  async killAll(): Promise<number> {
    const live = this.getLiveSessions();
    for (const session of live) {
      await this.killSession(session.id);
    }
    return live.length;
  }

  async getSessionHistory(sessionId: string): Promise<Array<{ role: string; content: string; created_at: string; message_type?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }> }>> {
    try {
      const result = await query(
        `SELECT role, content, created_at, message_type, audio_url, image_urls, file_infos FROM session_messages WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId]
      );
      return result.rows.map((row: any) => {
        const msg: { role: string; content: string; created_at: string; message_type?: string; audio_url?: string; image_urls?: string[]; file_infos?: Array<{ url: string; name: string; mimeType: string }> } = {
          role: row.role,
          content: row.content,
          created_at: row.created_at,
        };
        if (row.message_type) msg.message_type = row.message_type;
        if (row.audio_url) msg.audio_url = row.audio_url;
        if (row.image_urls) {
          try {
            const parsed = JSON.parse(row.image_urls);
            msg.image_urls = Array.isArray(parsed) ? parsed : [row.image_urls];
          } catch {
            msg.image_urls = [row.image_urls];
          }
        }
        if (row.file_infos) {
          try {
            const parsed = JSON.parse(row.file_infos);
            msg.file_infos = Array.isArray(parsed) ? parsed : undefined;
          } catch {
            // Ignore malformed JSON
          }
        }
        return msg;
      });
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to load session history");
      return [];
    }
  }

  // ==================== CONTAINER MANAGEMENT ====================

  private async startContainer(session: SubAgentSession, env: Record<string, string>, images?: MediaAttachment[]): Promise<void> {
    // === Agent API: generate JWT and resolve upfront credentials ===
    const agentApiEnv = await this.buildAgentApiEnv(session);

    // Pass resolved service credentials as RICK_CRED_* env vars.
    // Never embed them in prompt text to avoid leaking to LLM provider logs.
    const credentialEnv: Record<string, string> = {};
    for (const [service, cred] of Object.entries(session.credentials)) {
      const sanitized = sanitizeEnvKey(service);
      if (!sanitized) {
        logger.warn({ service, sessionId: session.id }, "Credential service name sanitizes to empty — skipping");
        continue;
      }
      credentialEnv[`RICK_CRED_${sanitized}`] = cred;
    }

    const mergedEnv = { ...env, ...agentApiEnv, ...credentialEnv };
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(mergedEnv)) {
      if (v) envArgs.push("-e", `${k}=${v}`);
    }

    // Start the container
    const { stdout } = await execFileAsync("docker", [
      "run", "-d", "--init", "--ipc=host",
      "--add-host=host.docker.internal:host-gateway",
      "--name", session.containerName,
      ...envArgs,
      SUBAGENT_RUNTIME_IMAGE,
      "sleep", "86400", // 24h max lifetime
    ]);

    session.containerId = stdout.trim();
    logger.info({ sessionId: session.id, container: session.containerName, containerId: session.containerId }, "Sub-agent container started");

    // Start the agent process
    await this.startAgentProcess(session);

    // If there's a task description, send it as the first message
    if (session.taskDescription && session.taskDescription.trim()) {
      session.state = "running";
      session.updatedAt = Date.now();

      // Persist and broadcast user message
      this.saveSessionMessage(session.id, "user", session.taskDescription).catch(() => {});
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "user", session.taskDescription);
      }

      // Copy images into container and send to agent
      // Credentials are available as RICK_CRED_* / RICK_SECRET_* env vars — not in the prompt
      const imagePaths = await this.injectImages(session, images);
      const payload: any = { type: "message", text: session.taskDescription };
      if (imagePaths.length > 0) payload.images = imagePaths;
      this.sendToAgentProcess(session.id, payload);
    } else {
      // Blank session — waiting for user to send first message
      session.state = "waiting_user";
      session.updatedAt = Date.now();
      // Notify session viewers so they update from "Trabalhando..." to "Aguardando..."
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
      }
    }
  }

  /**
   * Build environment variables for the Agent API (JWT token + upfront credentials).
   * Same mechanism as EditSession.buildAgentApiEnv — all sub-agents share the same API.
   */
  private async buildAgentApiEnv(session: SubAgentSession): Promise<Record<string, string>> {
    const agentEnv: Record<string, string> = {};

    // JWT token for authenticating against Rick's /api/agent/* endpoints
    // numericUserId is embedded so API endpoints can skip the getOrCreateUser DB call
    const token = createAgentToken(session.id, session.userId, 86400, session.numericUserId ?? undefined); // 24h TTL matches container lifetime
    const apiUrl = `http://host.docker.internal:${config.webPort}`;
    agentEnv.RICK_SESSION_TOKEN = token;
    agentEnv.RICK_API_URL = apiUrl;

    // Resolve upfront credentials from sensitive memory categories (global)
    if (this.memoryService) {
      try {
        const sensitiveCategories = ["credenciais", "tokens", "senhas", "secrets", "passwords", "credentials"];
        for (const category of sensitiveCategories) {
          // Use global memories — credentials are shared across all users
          const mems = await this.memoryService.listGlobalMemories(category);
          for (const mem of mems) {
            const sanitized = sanitizeEnvKey(mem.key);
            if (!sanitized) continue;
            agentEnv[`RICK_SECRET_${sanitized}`] = mem.value;
          }
        }
        logger.info(
          { sessionId: session.id, secretCount: Object.keys(agentEnv).length - 2 },
          "Sub-agent: upfront credentials resolved",
        );
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, "Sub-agent: failed to resolve upfront credentials");
      }
    }

    return agentEnv;
  }

  private async startAgentProcess(session: SubAgentSession): Promise<void> {
    const proc = spawn("docker", [
      "exec", "-i", session.containerName,
      "node", "/app/agent.mjs",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    this.processes.set(session.id, proc);

    let buffer = "";

    proc.stdout!.on("data", (data: Buffer) => {
      buffer += data.toString();
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.substring(0, newlineIdx).trim();
        buffer = buffer.substring(newlineIdx + 1);
        if (line) this.handleAgentOutput(session, line);
      }
    });

    proc.stderr!.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) logger.debug({ sessionId: session.id, stderr: text.substring(0, 200) }, "Sub-agent stderr");
    });

    proc.on("exit", (code) => {
      logger.info({ sessionId: session.id, exitCode: code }, "Sub-agent process exited");
      this.processes.delete(session.id);
      if (session.state === "running" || session.state === "starting" || session.state === "waiting_user") {
        session.state = "done";
        session.updatedAt = Date.now();
        this.sendToUser(session, "(Sub-agente encerrou)");
        // Notify session viewers of state change
        if (this.onSessionMessage) {
          this.onSessionMessage(session.id, "system", JSON.stringify({ state: "done" }), "system");
        }
        this.updateSessionStatus(session.id, "done").catch(() => {});
      }
    });

    proc.on("error", (err) => {
      logger.error({ err, sessionId: session.id }, "Sub-agent process error");
      this.processes.delete(session.id);
    });
  }

  private handleAgentOutput(session: SubAgentSession, line: string): void {
    try {
      const msg = JSON.parse(line);
      
      switch (msg.type) {
        case "ready":
          logger.info({ sessionId: session.id, providers: msg.providers, tools: msg.tools?.length }, "Sub-agent ready");
          // Inject conversation history from DB so the agent has full context
          // (only for recovered sessions — new sessions get their first message via sendToAgentProcess)
          if (session.recovered) {
            this.injectHistory(session).catch((err: any) => {
              logger.warn({ err, sessionId: session.id }, "Failed to inject history into agent");
            });
          }
          break;

        case "history_loaded":
          logger.info({ sessionId: session.id, count: msg.count }, "Agent conversation history restored");
          // After history injection, session is ready for user input
          session.state = "waiting_user";
          session.updatedAt = Date.now();
          if (this.onSessionMessage) {
            this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
          }
          break;

        case "message":
          if (msg.text) {
            session.output += msg.text + "\n";
            session.updatedAt = Date.now();
            session.lastMessageText = msg.text;
            this.sendToUser(session, msg.text);
          }
          break;

        case "status":
          // Status updates (tool execution, LLM switching, context rotation)
          if (msg.message) {
            // Format for terminal block: wrap tool name and args in backticks
            // Input: "Executando: read_file (path.js)"  →  "Executando: `read_file` `path.js`"
            const statusText = msg.message.replace(
              /^(Executando:\s*)(\S+?)(?:\s+\(([^)]+)\))?$/,
              (_: string, prefix: string, tool: string, arg?: string) =>
                arg ? `${prefix}\`${tool}\` \`${arg}\`` : `${prefix}\`${tool}\``
            );
            this.sendToUser(session, statusText, "tool_use");
          }
          break;

        case "waiting_user":
          // Agent finished processing this turn — waiting for user's next message.
          // Session stays alive; compose bar shown to user.
          session.state = "waiting_user";
          session.updatedAt = Date.now();
          if (msg.result) {
            session.output += msg.result + "\n";
            if (msg.result !== session.lastMessageText) {
              this.sendToUser(session, msg.result);
            }
          }
          // Notify session viewers of state change
          if (this.onSessionMessage) {
            this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
          }
          logger.info({ sessionId: session.id }, "Sub-agent waiting for user input");
          break;

        case "done":
          session.state = "done";
          session.updatedAt = Date.now();
          if (msg.result) {
            session.output += msg.result + "\n";
            // Only send the result if it wasn't already sent as the last "message" event
            // (the LLM loop emits intermediate text AND done.result, causing duplicates)
            if (msg.result !== session.lastMessageText) {
              this.sendToUser(session, msg.result);
            }
          }
          // Notify session viewers of state change (not rendered as a chat bubble)
          if (this.onSessionMessage) {
            this.onSessionMessage(session.id, "system", JSON.stringify({ state: "done" }), "system");
          }
          // Persist done state to DB
          this.updateSessionStatus(session.id, "done").catch(() => {});
          logger.info({ sessionId: session.id }, "Sub-agent task done");
          break;

        case "error":
          logger.error({ sessionId: session.id, error: msg.message }, "Sub-agent error");
          if (msg.message) {
            this.sendToUser(session, `Erro: ${msg.message}`);
          }
          break;

        case "pong":
          break;

        default:
          logger.debug({ sessionId: session.id, msgType: msg.type }, "Unknown sub-agent message type");
      }
    } catch (err) {
      // Non-JSON output — treat as plain text
      if (line.trim()) {
        session.output += line + "\n";
        this.sendToUser(session, line);
      }
    }
  }

  /**
   * Load conversation history from DB and send to the agent process so it
   * has full context (needed after recovery or process restart).
   * Only sends user + agent text messages (skips tool_use, system, etc.).
   */
  private async injectHistory(session: SubAgentSession): Promise<void> {
    const history = await this.getSessionHistory(session.id);
    // Filter to only user/agent text messages (the LLM doesn't need tool_use or system messages)
    const messages = history
      .filter((m) => (m.role === "user" || m.role === "agent") && m.content && m.message_type !== "tool_use" && m.message_type !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    if (messages.length === 0) return;

    logger.info({ sessionId: session.id, messageCount: messages.length }, "Injecting conversation history into agent");
    this.sendToAgentProcess(session.id, { type: "history", messages });
  }

  private sendToAgentProcess(sessionId: string, msg: any): void {
    const proc = this.processes.get(sessionId);
    if (!proc || !proc.stdin || proc.stdin.destroyed) {
      logger.warn({ sessionId }, "Cannot send to agent: no active process");
      return;
    }
    try {
      proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      logger.error({ err, sessionId }, "Failed to write to agent stdin");
    }
  }

  // ==================== OUTPUT ROUTING ====================

  private async sendToUser(session: SubAgentSession, text: string, messageType: string = "text"): Promise<void> {
    // O subagente roda de forma assíncrona — as mensagens intermediárias NÃO são
    // encaminhadas de volta ao conector principal (sessão do usuário). O usuário
    // acompanha o progresso na página pública da sessão (/s/:id).
    // Broadcast apenas para subscribers da sessão na web UI (página /s/:id)
    if (this.onSessionMessage) {
      this.onSessionMessage(session.id, "agent", text, messageType);
    }
    this.saveSessionMessage(session.id, "agent", text, messageType).catch(() => {});
  }

  // ==================== SESSION PERSISTENCE (RBAC audit) ====================

  /**
   * Insert a new row into sub_agent_sessions for audit trail.
   * Stores connector_name and user_external_id so sessions can be re-routed correctly after restart.
   */
  private async persistSessionToDB(session: SubAgentSession): Promise<void> {
    if (!session.numericUserId) return;
    try {
      await query(
        `INSERT INTO sub_agent_sessions (id, user_id, task, status, connector_name, user_external_id, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [session.id, session.numericUserId, session.taskDescription || null, "active",
          session.connectorName, session.userId]
      );
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, "Failed to persist session to DB");
    }
  }

  /**
   * Update the status (and ended_at) of a sub_agent_sessions row.
   */
  private async updateSessionStatus(sessionId: string, status: string): Promise<void> {
    try {
      const endedAt = status === "active" ? null : new Date().toISOString();
      await query(
        `UPDATE sub_agent_sessions SET status = $1, ended_at = $2 WHERE id = $3`,
        [status, endedAt, sessionId]
      );
    } catch (err) {
      logger.warn({ err, sessionId, status }, "Failed to update session status in DB");
    }
  }

  // ==================== MESSAGE PERSISTENCE ====================

  private async saveSessionMessage(
    sessionId: string,
    role: string,
    content: string,
    messageType: string = "text",
    audioUrl?: string,
    imageUrls?: string[],
    fileInfos?: Array<{ url: string; name: string; mimeType: string }>
  ): Promise<void> {
    try {
      const imageUrlsJson = imageUrls && imageUrls.length > 0 ? JSON.stringify(imageUrls) : null;
      const fileInfosJson = fileInfos && fileInfos.length > 0 ? JSON.stringify(fileInfos) : null;
      await query(
        `INSERT INTO session_messages (session_id, role, content, message_type, audio_url, image_urls, file_infos) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sessionId, role, content, messageType, audioUrl || null, imageUrlsJson, fileInfosJson]
      );
    } catch (err) {
      logger.warn({ err, sessionId, role }, "Failed to save session message");
    }
  }

  // deleteSessionMessages removed — session messages are now preserved for admin audit.
  // Only edit session messages are deleted on /exit (handled in agent.ts onCloseCb).

  // ==================== IMAGE INJECTION ====================

  /**
   * Copy image attachments into a running sub-agent container.
   * Returns the list of paths inside the container (e.g. /tmp/img-xxx.png).
   */
  private async injectImages(session: SubAgentSession, images?: MediaAttachment[]): Promise<string[]> {
    if (!images || images.length === 0 || !session.containerId) return [];

    const paths: string[] = [];
    for (const img of images) {
      if (!img.mimeType.startsWith("image/")) continue;
      try {
        const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const id = randomBytes(4).toString("hex");
        const containerPath = `/tmp/img-${id}.${ext}`;
        const tmpFile = join(tmpdir(), `subagent-img-${id}.${ext}`);

        await writeFile(tmpFile, img.data);
        try {
          await execFileAsync("docker", ["cp", tmpFile, `${session.containerName}:${containerPath}`]);
          paths.push(containerPath);
        } finally {
          await unlink(tmpFile).catch(() => {});
        }
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, "Failed to inject image into sub-agent container");
      }
    }
    return paths;
  }

}

