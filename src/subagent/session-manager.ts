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

const execFileAsync = promisify(execFile);

/** Rick variant names — must match frontend RICK_NAMES array */
const RICK_NAMES = [
  "Rick Prime",
  "Doofus Rick",
  "Simple Rick",
  "Wasp Rick",
  "Cop Rick",
  "Toxic Rick",
  "Pickle Rick",
  "Council Rick",
  "Aqua Rick",
  "Evil Rick",
];

function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/** Get the Rick variant name for a session ID (deterministic, matches frontend). */
export function getSessionRickName(sessionId: string): string {
  return RICK_NAMES[hashString(sessionId) % RICK_NAMES.length];
}

/** Callback for broadcasting messages to public session subscribers (WebSocket viewers). */
export type SessionMessageCallback = (sessionId: string, role: string, text: string) => void;

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

        const session: SubAgentSession = {
          id,
          containerId: containerId.trim(),
          containerName,
          state: "running",
          taskDescription: "(sessao recuperada apos reinicio)",
          credentials: {},
          connectorName: "web",
          userId: "owner",
          output: "",
          pendingQuestion: null,
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

  getLiveSessions(): SubAgentSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state === "starting" || s.state === "running" || s.state === "waiting_user" || s.state === "done"
    );
  }

  getDoneSessions(): SubAgentSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "done");
  }

  getRunningSessions(): SubAgentSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state === "starting" || s.state === "running"
    );
  }

  hasLiveSessions(): boolean {
    return this.getLiveSessions().length > 0;
  }

  hasDoneSessions(): boolean {
    return this.getDoneSessions().length > 0;
  }

  getMostRecentDoneSession(): SubAgentSession | null {
    const done = this.getDoneSessions();
    if (done.length === 0) return null;
    return done.sort((a, b) => b.updatedAt - a.updatedAt)[0];
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
    images?: MediaAttachment[]
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
      output: "",
      pendingQuestion: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(id, session);

    try {
      await this.startContainer(session, env, images);
    } catch (err) {
      logger.error({ err, sessionId: id }, "Failed to start sub-agent container");
      session.state = "killed";
      this.sessions.delete(id);
      throw err;
    }

    return session;
  }

  /**
   * Send a user message to an existing session.
   */
  async sendToSession(sessionId: string, message: string, images?: MediaAttachment[]): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.containerId) {
      throw new Error(`No session with id ${sessionId}`);
    }

    session.state = "running";
    session.pendingQuestion = null;
    session.updatedAt = Date.now();

    // Persist user message and broadcast to session subscribers
    this.saveSessionMessage(sessionId, "user", message).catch(() => {});
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
      this.onSessionMessage(sessionId, "system", JSON.stringify({ state: "killed" }));
    }

    this.deleteSessionMessages(sessionId).catch(() => {});
    this.sessions.delete(sessionId);
  }

  async killAll(): Promise<number> {
    const live = this.getLiveSessions();
    for (const session of live) {
      await this.killSession(session.id);
    }
    return live.length;
  }

  async getSessionHistory(sessionId: string): Promise<Array<{ role: string; content: string; created_at: string; message_type?: string }>> {
    try {
      const result = await query(
        `SELECT role, content, created_at, message_type FROM session_messages WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId]
      );
      return result.rows;
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to load session history");
      return [];
    }
  }

  // ==================== CONTAINER MANAGEMENT ====================

  private async startContainer(session: SubAgentSession, env: Record<string, string>, images?: MediaAttachment[]): Promise<void> {
    // === Agent API: generate JWT and resolve upfront credentials ===
    const agentApiEnv = await this.buildAgentApiEnv(session);

    const mergedEnv = { ...env, ...agentApiEnv };
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
      "subagent",
      "sleep", "86400", // 24h max lifetime
    ]);

    session.containerId = stdout.trim();
    logger.info({ sessionId: session.id, container: session.containerName, containerId: session.containerId }, "Sub-agent container started");

    // Start the agent process
    await this.startAgentProcess(session);

    // If there's a task description, send it as the first message
    if (session.taskDescription && session.taskDescription.trim()) {
      const enrichedPrompt = this.buildEnrichedPrompt(session.taskDescription, session.credentials);
      session.state = "running";
      session.updatedAt = Date.now();

      // Persist and broadcast user message
      this.saveSessionMessage(session.id, "user", session.taskDescription).catch(() => {});
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "user", session.taskDescription);
      }

      // Copy images into container and send to agent
      const imagePaths = await this.injectImages(session, images);
      const payload: any = { type: "message", text: enrichedPrompt };
      if (imagePaths.length > 0) payload.images = imagePaths;
      this.sendToAgentProcess(session.id, payload);
    } else {
      // Blank session — waiting for user to send first message
      session.state = "waiting_user";
      session.updatedAt = Date.now();
    }
  }

  /**
   * Build environment variables for the Agent API (JWT token + upfront credentials).
   * Same mechanism as EditSession.buildAgentApiEnv — all sub-agents share the same API.
   */
  private async buildAgentApiEnv(session: SubAgentSession): Promise<Record<string, string>> {
    const agentEnv: Record<string, string> = {};

    // JWT token for authenticating against Rick's /api/agent/* endpoints
    const token = createAgentToken(session.id, session.userId, 86400); // 24h TTL matches container lifetime
    const apiUrl = `http://host.docker.internal:${config.webPort}`;
    agentEnv.RICK_SESSION_TOKEN = token;
    agentEnv.RICK_API_URL = apiUrl;

    // Resolve upfront credentials from sensitive memory categories
    if (this.memoryService) {
      try {
        const sensitiveCategories = ["credenciais", "tokens", "senhas", "secrets", "passwords", "credentials"];
        for (const category of sensitiveCategories) {
          const mems = await this.memoryService.listMemories(session.userId, category);
          for (const mem of mems) {
            const envKey = `RICK_SECRET_${mem.key
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, "_")
              .replace(/^_|_$/g, "")}`;
            agentEnv[envKey] = mem.value;
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
      if (session.state === "running" || session.state === "starting") {
        session.state = "done";
        session.updatedAt = Date.now();
        this.sendToUser(session, "(Sub-agente encerrou)");
        // Notify session viewers of state change
        if (this.onSessionMessage) {
          this.onSessionMessage(session.id, "system", JSON.stringify({ state: "done" }));
        }
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
          break;

        case "message":
          if (msg.text) {
            session.output += msg.text + "\n";
            session.updatedAt = Date.now();
            this.sendToUser(session, msg.text);
          }
          break;

        case "status":
          // Status updates (tool execution, LLM switching, context rotation)
          if (msg.message) {
            this.sendToUser(session, `_${msg.message}_`);
          }
          break;

        case "done":
          session.state = "done";
          session.updatedAt = Date.now();
          if (msg.result) {
            session.output += msg.result + "\n";
            this.sendToUser(session, msg.result);
          }
          // Notify session viewers of state change
          if (this.onSessionMessage) {
            this.onSessionMessage(session.id, "system", JSON.stringify({ state: "done" }));
          }
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

  private async sendToUser(session: SubAgentSession, text: string): Promise<void> {
    // Rota para o conector de origem (WhatsApp, Web, etc.) usando connectorName e userId da sessão
    this.connectorManager.sendMessage(session.connectorName, session.userId, text).catch((err) => {
      logger.warn({ err, sessionId: session.id, connector: session.connectorName }, "sendToUser: failed to send via connector");
    });
    // Broadcast para subscribers da sessão na web UI (página /s/:id)
    if (this.onSessionMessage) {
      this.onSessionMessage(session.id, "agent", text);
    }
    this.saveSessionMessage(session.id, "agent", text).catch(() => {});
  }

  // ==================== MESSAGE PERSISTENCE ====================

  private async saveSessionMessage(sessionId: string, role: string, content: string, messageType: string = "text"): Promise<void> {
    try {
      await query(
        `INSERT INTO session_messages (session_id, role, content, message_type) VALUES ($1, $2, $3, $4)`,
        [sessionId, role, content, messageType]
      );
    } catch (err) {
      logger.warn({ err, sessionId, role }, "Failed to save session message");
    }
  }

  private async deleteSessionMessages(sessionId: string): Promise<void> {
    try {
      await query(`DELETE FROM session_messages WHERE session_id = $1`, [sessionId]);
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to delete session messages");
    }
  }

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

  // ==================== HELPERS ====================

  private buildEnrichedPrompt(taskDescription: string, credentials: Record<string, string>): string {
    if (Object.keys(credentials).length === 0) return taskDescription;

    const credBlock = Object.entries(credentials)
      .map(([service, cred]) => `[Credencial ${service}]: ${cred}`)
      .join("\n");

    return `${taskDescription}\n\n--- CREDENCIAIS DISPONIVEIS ---\n${credBlock}\n--- FIM CREDENCIAIS ---`;
  }
}
