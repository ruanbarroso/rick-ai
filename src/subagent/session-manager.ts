import { execFile, spawn, ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes, createHash } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubAgentSession, SessionState, DEFAULT_SUBAGENT_MODEL, DEFAULT_SUBAGENT_EXECUTION_MODE, SubAgentModelId, isSubAgentExecutionMode, isSubAgentModelId, SubAgentMetricsSnapshot, SubAgentExecutionMode, PendingQuestionItem, PendingQuestionPrompt } from "./types.js";
import type { ConnectorManager } from "../connectors/connector-manager.js";
import type { MediaAttachment } from "../llm/types.js";
import { query } from "../memory/database.js";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { createAgentToken } from "./agent-token.js";
import type { MemoryService } from "../memory/memory-service.js";
import { subagentImageBuilder, SUBAGENT_RUNTIME_IMAGE } from "./subagent-image-builder.js";
import { formatToolLifecycleLine, normalizeStatusToolLine } from "./tool-status.js";

const execFileAsync = promisify(execFile);

/**
 * Normalize an arbitrary string into a valid env-var name segment (uppercase, underscores only).
 * Returns null if the input contains no valid characters (all special chars).
 */
function sanitizeEnvKey(raw: string): string | null {
  const sanitized = raw.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");
  return sanitized || null;
}

function isExecutionOperationalFailure(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  return normalized.startsWith("falha operacional: esta rodada exigia execucao");
}

/**
 * Rick variant names — canonical Rick and Morty character names from the wiki.
 * Used when agentName is "Rick". Excludes "Rick Sanchez" and "Rick C-137" (the main Rick).
 * Sorted alphabetically for predictable sequential assignment.
 */
const RICK_VARIANT_NAMES: string[] = [
  "Adjudicator Rick", "Afro Rick", "Alien Rick", "Antenna Rick", "Aqua Rick",
  "Bald Rick", "Barber Rick", "Beard Rick", "Big Fat Rick", "Big Rick",
  "Black Magic Rick", "Bootleg Portal Chemist Rick", "Bubble Gum Rick",
  "Careless Rick", "Cat Rick", "Commander Rick", "Completionist Rick",
  "Cool Rick", "Cop Rick", "Crazy Cat Rick", "Cronenberg Rick",
  "Curly-haired Rick", "Cyclops Rick",
  "Dandy Rick", "Disheveled Rick", "Doc Smith", "Doofus Rick", "Dreamy Rick",
  "Druggie Rick", "Dumb Rick",
  "Earring Rick", "Evil Rick", "Eye Patch Rick",
  "Fancy Rick", "Farmer Rick", "Fascist Rick", "Female Doofus Rick",
  "Flat Top Rick", "Four Eyes Rick",
  "Garment District Rick", "Glockenspiel Rick", "Grandpa Rick", "Grateful Rick",
  "Guard Rick", "Guilty Rick",
  "Happy Rick", "Hawaiian Rick", "Headband Rick", "Healthy Rick", "Hologram Rick",
  "Homesteader Rick", "Hopeful Rick", "Hothead Rick",
  "Indiana Jones Rick", "Insightful Rick", "Insurance Rick", "Investigator Rick",
  "James Bond Rick", "Jerricky", "Jerryboree Employee Rick", "Jerry Rick",
  "John McLane Rick", "John Rick", "Josuke Rick", "Juggling Rick", "Junk Yard Rick",
  "Killer Droid Rick",
  "Lab Rick", "Leg Rick", "Little Ricky Wrap-it-up", "Lizard Rick",
  "Maximums Rickimus", "Mechanical Rick", "Memory Rick", "Morty Rick",
  "Mullet Rick", "Mumbling Rick", "Mustache Rick", "Mysterious Rick",
  "Nega-Rick", "Nerd Rick", "Nice Rick", "Night Rick", "Novelist Rick",
  "Oddjob Rick", "Old God Rick",
  "Pickle Rick", "Plumber Rick", "Private Sector Rick",
  "Quantum Rick",
  "Radar Rick", "Rebel Rick", "Reek", "Regional Manager Rick",
  "Retired General Rick", "Revengeful Rick", "Rick D. Sanchez III",
  "Rick Guilt Rick", "Rick Prime", "RickBot", "Ricktiminus Sancheziminius",
  "Rick Jerry", "Riq IV", "Robot Rick", "Rule 63 Cosplay Rick",
  "Salesman Rick", "Scarecrow Rick", "Sci-Fi Politician Rick", "Sheikh Rick",
  "Shibuya Rick", "Shrimp Rick", "Simple Rick", "Slow Jamz Rick", "Slow Rick",
  "Solicitor Rick", "Space Jam Rick", "Stan Lee Rick", "Steve Jobs Rick",
  "Story Train Rick", "Super Fan Rick", "Super Weird Rick", "Survivor Rick",
  "Teacher Rick", "Teddy Rick", "The Scientist Formerly Known as Rick",
  "The Scientist Known as Rick", "Tiny Rick", "Toxic Rick", "Trafficker Rick",
  "Turtleneck Rick",
  "Visor Rick",
  "Wasp Rick", "Western Rick", "Woman Rick",
  "Yellow Shirt Rick", "Yo-Yo Rick", "Young Rick",
  "Zero Rick", "Zeta Alpha Rick",
];

/**
 * Generic variant suffixes — used when agentName is NOT "Rick" (e.g. "Zoe").
 * "Alpha" is excluded because it's reserved for the main session ("{Agent} Alpha").
 * Pre-shuffled for unpredictable sequential assignment.
 */
const GENERIC_VARIANT_SUFFIXES: string[] = [
  // Shuffled mix of Greek letters, space/sci-fi, tech, and NATO phonetic terms.
  "Nebula", "Kilo", "Sigma", "Forge", "Eclipse", "Tango", "Vortex", "Pi",
  "Whiskey", "Bolt", "Lambda", "Quasar", "Root", "Echo", "Prism", "Gamma",
  "Stellar", "Node", "Foxtrot", "Zenith", "Psi", "Spark", "Helix", "Romeo",
  "Core", "Delta", "Cosmo", "Victor", "Theta", "Nexus", "Shell", "Quebec",
  "Nova", "Kappa", "Pulse", "Orbit", "Charlie", "Zeta", "Cipher", "Lima",
  "Omega", "Patch", "Astral", "Bravo", "Eta", "Vector", "Mike", "Flux",
  "Daemon", "Xi", "Photon", "Sierra", "Axiom", "Iota", "Stack", "Hotel",
  "Phi", "Apex", "Byte", "Juliet", "Tau", "Onyx", "Grid", "Oscar",
  "Epsilon", "Synth", "Papa", "Vertex", "Mu", "Arc", "India", "Rho",
  "Matrix", "Golf", "Upsilon", "Proxy", "X-Ray", "Nu", "Aether", "Yankee",
  "Chi", "Pulsar", "Uniform", "Omicron", "Neo", "Kernel", "Beta", "Quantum",
  "Zero", "Prime",
];

/**
 * Get the display name for the main (primary) session.
 * Rick → "Rick C-137", anything else → "{agentName} Alpha".
 */
export function getMainSessionName(): string {
  if (config.agentName.toLowerCase() === "rick") return "Rick C-137";
  return `${config.agentName} Alpha`;
}

/**
 * Get a variant name for a sub-agent session.
 *
 * Uses sequential rotation per user: the Nth session for a user gets name[N % len].
 * Falls back to hash-based naming if no userId is available.
 *
 * When agentName is "Rick", uses canonical Rick and Morty character names.
 * Otherwise, uses "{agentName} {suffix}" with generic suffixes.
 */
export async function getSessionVariantName(sessionId: string, numericUserId?: number | null): Promise<string> {
  const isRick = config.agentName.toLowerCase() === "rick";
  const names = isRick ? RICK_VARIANT_NAMES : GENERIC_VARIANT_SUFFIXES;

  let index: number;

  if (numericUserId) {
    // Sequential rotation: count how many sessions this user has had before this one
    try {
      const result = await query(
        `SELECT COUNT(*) AS cnt FROM sub_agent_sessions WHERE user_id = $1 AND id != $2`,
        [numericUserId, sessionId],
      );
      index = parseInt(result.rows[0]?.cnt ?? "0", 10);
    } catch {
      // Fallback to hash if DB query fails
      index = hashString(sessionId);
    }
  } else {
    // No user context — use deterministic hash of sessionId
    index = hashString(sessionId);
  }

  if (isRick) {
    return names[index % names.length];
  }
  return `${config.agentName} ${names[index % names.length]}`;
}

/** Synchronous hash-based fallback (for cases without DB access, e.g. frontend). */
function hashString(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

/**
 * Generate a deterministic public token for a user's sessions dashboard.
 * Token = first 16 hex chars of SHA-256("rick-sessions-" + userId).
 * No DB storage needed — token can be recomputed from user ID at any time.
 */
export function getUserSessionsToken(userId: number): string {
  return createHash("sha256").update("rick-sessions-" + userId).digest("hex").substring(0, 16);
}

/**
 * Resolve a sessions dashboard token back to a user ID.
 * Brute-forces user IDs 1..maxId since the token space is small and deterministic.
 * Returns null if no matching user found.
 */
export async function resolveSessionsToken(token: string): Promise<number | null> {
  // Check all users (not just those with sub-agent sessions)
  // so the main session viewer works for users who never used sub-agents.
  const result = await query(
    `SELECT id FROM users ORDER BY id`,
  );
  for (const row of result.rows) {
    const uid = row.id as number;
    if (getUserSessionsToken(uid) === token) return uid;
  }
  return null;
}

/** Callback for broadcasting messages to public session subscribers (WebSocket viewers). */
export type SessionMessageCallback = (
  sessionId: string,
  role: string,
  text: string,
  messageType?: string,
  mediaInfo?: { audioUrl?: string; imageUrls?: string[]; fileInfos?: Array<{ url: string; name: string; mimeType: string }> }
) => void;

/** Callback fired when a sub-agent session completes — used for post-session learning. */
export type SessionDoneCallback = (
  sessionId: string,
  taskDescription: string,
  sessionOutput: string,
  numericUserId: number | null
) => void;

/**
 * Manages unified sub-agent sessions — container lifecycle, NDJSON stdin/stdout relay.
 * Each session gets its own Docker container with Chromium + Playwright + all LLM providers.
 */
export class SessionManager {
  private sessions = new Map<string, SubAgentSession>();
  private connectorManager: ConnectorManager;
  private memoryService: MemoryService | null;
  private onSessionMessage: SessionMessageCallback | null = null;
  private onSessionDone: SessionDoneCallback | null = null;

  private readonly metricsStartedAt = Date.now();
  private metricsCounters: SubAgentMetricsSnapshot["counters"] = {
    sessionsCreated: 0,
    sessionsRecovered: 0,
    sessionsKilled: 0,
    sessionsInterrupted: 0,
    sessionsFailed: 0,
    turnsCompleted: 0,
    providerErrors: 0,
    fallbackUsed: 0,
    timeoutRetries: 0,
    authRetries: 0,
    maxStepsHits: 0,
    contextCompactions: 0,
    noExecutionGuards: 0,
    toolCallsStarted: 0,
    toolCallsCompleted: 0,
    toolCallsErrored: 0,
  };

  /** Active child processes for each session (docker exec) */
  private processes = new Map<string, ChildProcess>();

  /**
   * Generation counter per session for interrupt handling.
   * When interrupt is called, generation is incremented so in-flight responses are discarded.
   */
  private sessionGenerations = new Map<string, number>();

  /**
   * Timers for recovery message acknowledgement.
   * When resumeInterruptedTurn re-sends a user message after server restart,
   * we start a timer. If the agent doesn't emit any activity event within the
   * timeout, we revert the session to waiting_user so the UI doesn't stay
   * stuck on "Digitando..." forever.
   */
  private recoveryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly RECOVERY_ACK_TIMEOUT_MS = 60_000; // 60 seconds

  /** Cached Docker network name for sub-agent containers (null = use default bridge) */
  private resolvedNetwork: string | null = null;
  /** Cached API host for sub-agents to reach the main container */
  private resolvedApiHost: string | null = null;

  constructor(connectorManager: ConnectorManager, memoryService?: MemoryService) {
    this.connectorManager = connectorManager;
    this.memoryService = memoryService ?? null;
    this.detectDockerNetwork();
  }

  /**
   * Detect the Docker network of the main container (if running inside Docker).
   * Sub-agents will be attached to the same network so they can reach the host API
   * via container name instead of host.docker.internal.
   */
  private detectDockerNetwork(): void {
    const hostname = process.env.HOSTNAME;
    if (!hostname) return; // Not running in Docker

    execFileAsync("docker", [
      "inspect", "--format",
      "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}",
      hostname,
    ]).then(async ({ stdout }) => {
      const net = stdout.trim();
      if (net && net !== "bridge" && net !== "host") {
        this.resolvedNetwork = net;
        let apiHost = hostname;
        try {
          const { stdout: nameOut } = await execFileAsync("docker", [
            "inspect", "--format", "{{.Name}}", hostname,
          ]);
          const containerName = nameOut.trim().replace(/^\//, "");
          if (containerName) apiHost = containerName;
        } catch {
          // Fallback to hostname (container id) when name lookup fails.
        }

        this.resolvedApiHost = apiHost;
        logger.info({ network: net, apiHost }, "Sub-agents will use main container's Docker network");
      }
    }).catch(() => {
      // Not running in Docker or inspect failed — sub-agents will use default bridge
    });
  }

  private getCurrentApiUrl(): string {
    const apiHost = this.resolvedApiHost ?? "host.docker.internal";
    return `http://${apiHost}:${config.webPort}`;
  }

  setSessionMessageCallback(cb: SessionMessageCallback): void {
    this.onSessionMessage = cb;
  }

  setSessionDoneCallback(cb: SessionDoneCallback): void {
    this.onSessionDone = cb;
  }

  getMetricsSnapshot(): SubAgentMetricsSnapshot {
    const live = this.getLiveSessions();
    const running = live.filter((s) => s.state === "starting" || s.state === "running");
    const waiting = live.filter((s) => s.state === "waiting_user");
    const done = live.filter((s) => s.state === "done");
    const failed = live.filter((s) => s.state === "failed");

    return {
      startedAt: this.metricsStartedAt,
      gauges: {
        liveSessions: live.length,
        runningSessions: running.length,
        waitingUserSessions: waiting.length,
        doneSessions: done.length,
        failedSessions: failed.length,
      },
      counters: { ...this.metricsCounters },
      liveSessionsList: live.map((s) => ({
        id: s.id,
        state: s.state,
        taskDescription: s.taskDescription,
        variantName: s.variantName,
        connectorName: s.connectorName,
        userId: s.userId,
        sessionsToken: s.numericUserId != null ? getUserSessionsToken(s.numericUserId) : undefined,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    };
  }

  // ==================== SESSION RECOVERY ====================

  /**
   * Resync sessions after a main container restart.
   *
   * Unlike the old recoverSessions(), this method does NOT start a new agent
   * process inside the container. The agent is already running as PID 1.
   * Instead it:
   * 1. Lists running subagent containers
   * 2. Queries each agent's HTTP /health endpoint for current state
   * 3. Fetches missed events from the agent's local outbox
   * 4. Processes those events through handleAgentOutput (updates DB, notifies viewers)
   * 5. Reconnects the live stream bridge
   * 6. Sends a fresh JWT token so the agent can continue calling Rick's API
   */
  async recoverSessions(): Promise<number> {
    // Clean up dead subagent containers (exited after server restart, OOM, etc.)
    try {
      const { stdout: deadOut } = await execFileAsync("docker", [
        "ps", "-a",
        "--filter", "name=subagent-",
        "--filter", "status=exited",
        "--format", "{{.Names}}",
      ]);
      const deadContainers = deadOut.trim().split("\n").filter((l) => l.trim());
      if (deadContainers.length > 0) {
        logger.info({ count: deadContainers.length }, "Session resync: cleaning up dead subagent containers");
        for (const name of deadContainers) {
          const match = name.match(/^subagent-([a-f0-9]+)$/);
          if (match) {
            // Mark session as done in DB so it doesn't get recovered again
            this.updateSessionStatus(match[1], "done").catch(() => {});
          }
          execFileAsync("docker", ["rm", "-f", name]).catch(() => {});
        }
      }
    } catch (err) {
      logger.warn({ err }, "Session resync: failed to clean up dead containers");
    }

    try {
      const { stdout } = await execFileAsync("docker", [
        "ps",
        "--filter", "name=subagent-",
        "--filter", "status=running",
        "--format", "{{.Names}}\t{{.ID}}\t{{.CreatedAt}}",
      ]);

      const lines = stdout.trim().split("\n").filter((l) => l.trim());
      if (lines.length === 0) {
        logger.info("Session resync: no running subagent containers found");
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
            logger.warn({ containerName }, "Session resync: skipping unrecognized container");
            continue;
          }
          // Kill legacy containers — they use the old architecture
          try {
            await execFileAsync("docker", ["rm", "-f", containerName]);
            logger.info({ containerName }, "Session resync: killed legacy container");
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
        let variantName: string | undefined;
        let taskDescription: string | undefined;
        let lastSyncedEventId = 0;
        try {
          const dbRow = await query(
            `SELECT task, connector_name, user_external_id, user_id, variant_name, last_synced_event_id FROM sub_agent_sessions WHERE id = $1`,
            [id]
          );
          if (dbRow.rows.length > 0) {
            taskDescription = dbRow.rows[0].task || undefined;
            connectorName = dbRow.rows[0].connector_name || "web";
            userId = dbRow.rows[0].user_external_id || "owner";
            numericUserId = dbRow.rows[0].user_id ?? null;
            variantName = dbRow.rows[0].variant_name || undefined;
            lastSyncedEventId = dbRow.rows[0].last_synced_event_id ?? 0;
          }
        } catch (err) {
          logger.warn({ err, sessionId: id }, "Session resync: failed to restore routing metadata from DB, using defaults");
        }

        // If variant_name wasn't persisted (old session), compute it now
        if (!variantName) {
          variantName = await getSessionVariantName(id, numericUserId);
        }

        // Query the agent's actual state via HTTP
        let agentState = "waiting_user";
        let agentLastEventId = 0;
        try {
          const raw = await this.querySubagentHttp(containerName, "/health");
          const health = JSON.parse(raw);
          agentState = health.state || "waiting_user";
          agentLastEventId = health.lastEventId || 0;
          logger.info({ sessionId: id, agentState, agentLastEventId, lastSyncedEventId }, "Session resync: agent health queried");
        } catch (err) {
          logger.warn({ err, sessionId: id }, "Session resync: agent HTTP not reachable, using DB state");
        }

        // Map agent state to session state
        let sessionState: SessionState = "waiting_user";
        if (agentState === "running") sessionState = "running";
        else if (agentState === "done") sessionState = "done";
        else if (agentState === "error") sessionState = "failed";

        const session: SubAgentSession = {
          id,
          containerId: containerId.trim(),
          containerName,
          state: sessionState,
          taskDescription: taskDescription || "(sessao recuperada apos reinicio)",
          credentials: {},
          connectorName,
          userId,
          numericUserId,
          variantName,
          preferredModel: DEFAULT_SUBAGENT_MODEL,
          executionMode: DEFAULT_SUBAGENT_EXECUTION_MODE,
          output: "",
          pendingQuestion: null,
          recovered: true,
          createdAt: createdTime,
          updatedAt: Date.now(),
        };

        // Track last synced event ID on the session object
        (session as any)._lastSyncedEventId = lastSyncedEventId;

        this.sessions.set(id, session);
        recovered++;
        this.metricsCounters.sessionsRecovered += 1;

        // Fetch and process missed events from the agent's local outbox.
        // Use recoveryReplay=true so events are only used to rebuild in-memory state
        // (session.output, session.state) without re-saving to DB or broadcasting
        // to session viewers — those events were already persisted before the restart.
        if (agentLastEventId > lastSyncedEventId) {
          try {
            const { events } = await this.fetchSubagentEvents(containerName, lastSyncedEventId);
            logger.info({ sessionId: id, missedEvents: events.length }, "Session resync: processing missed events");
            for (const evt of events) {
              if (evt.data) {
                this.handleAgentOutput(session, JSON.stringify(evt.data), true);
              }
              if (typeof evt.id === "number") {
                (session as any)._lastSyncedEventId = evt.id;
              }
            }
            // Persist progress
            this.updateLastSyncedEventId(id, (session as any)._lastSyncedEventId).catch(() => {});
          } catch (err) {
            logger.warn({ err, sessionId: id }, "Session resync: failed to fetch missed events");
          }
        }

        // Determine if this container has the new architecture (HTTP control server + stream bridge)
        // or the old one (agent.mjs started via docker exec). If HTTP health check succeeded,
        // it's a new-architecture container. Otherwise, fall back to the legacy approach.
        const isNewArchitecture = agentLastEventId > 0 || sessionState === "running";

        if (isNewArchitecture) {
          // NEW ARCHITECTURE: send token via HTTP, reconnect stream bridge
          const token = createAgentToken(id, userId, 86400, numericUserId ?? undefined);
          const apiUrl = this.getCurrentApiUrl();
          await this.sendHttpCommand(containerName, {
            type: "update_token",
            token,
            apiUrl,
          });

          // Reconnect the live stream bridge (picking up from last synced event)
          const afterEventId = (session as any)._lastSyncedEventId ?? 0;
          this.startAgentProcess(session, afterEventId).catch((err) => {
            logger.error({ err, sessionId: id }, "Session resync: failed to reconnect stream bridge");
          });
        } else {
          // LEGACY FALLBACK: container was created with old image (no HTTP server, no stream bridge).
          // Start a new agent.mjs process via docker exec (old behavior).
          // This process will exit immediately if agent.mjs is already PID 1 (new image),
          // but for old images it starts the actual agent.
          logger.info({ sessionId: id }, "Session resync: legacy container detected, using docker exec fallback");
          const legacyProc = spawn("docker", [
            "exec", "-i", containerName,
            "node", "/app/agent.mjs",
          ], { stdio: ["pipe", "pipe", "pipe"] });
          this.processes.set(id, legacyProc);

          let buffer = "";
          legacyProc.stdout!.on("data", (data: Buffer) => {
            buffer += data.toString();
            let newlineIdx;
            while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
              const ln = buffer.substring(0, newlineIdx).trim();
              buffer = buffer.substring(newlineIdx + 1);
              if (ln) this.handleAgentOutput(session, ln);
            }
          });
          legacyProc.stderr!.on("data", (data: Buffer) => {
            const text = data.toString();
            if (text.trim()) logger.debug({ sessionId: id, stderr: text.trim().substring(0, 500) }, "Legacy sub-agent stderr");
          });
          legacyProc.on("exit", (code) => {
            this.processes.delete(id);
            if (session.state === "running" || session.state === "starting" || session.state === "waiting_user") {
              const crashed = code !== 0 && code !== null;
              if (crashed) {
                this.sendToUser(session, `Erro: o sub-agente encerrou inesperadamente (codigo ${code}).`, "error");
              }
              const newState = crashed ? "failed" : "done";
              if (crashed) this.metricsCounters.sessionsFailed += 1;
              session.state = newState;
              session.updatedAt = Date.now();
              if (this.onSessionMessage) {
                this.onSessionMessage(session.id, "system", JSON.stringify({ state: newState }), "system");
              }
              this.updateSessionStatus(session.id, newState).catch(() => {});
              execFileAsync("docker", ["rm", "-f", session.containerName]).catch(() => {});
            }
          });
          legacyProc.on("error", (err) => {
            logger.error({ err, sessionId: id }, "Legacy sub-agent process error");
            this.processes.delete(id);
          });
        }

        // Notify session viewers of current state
        if (this.onSessionMessage) {
          this.onSessionMessage(session.id, "system", JSON.stringify({ state: session.state }), "system");
        }

        // Check for unsent user messages: if the agent is in waiting_user but the
        // last DB message is from the user, it means a user message arrived AFTER
        // the agent's last response but BEFORE the server restart. Re-send it.
        if (session.state === "waiting_user") {
          this.checkAndResendUnsentMessage(session).catch((err) => {
            logger.warn({ err, sessionId: id }, "Session resync: failed to check for unsent messages");
          });
        }

        logger.info({ sessionId: id, containerName, state: session.state }, "Session resync: session recovered");
      }

      if (recovered > 0) {
        logger.info({ recovered }, "Session resync: total sessions recovered");
      }
      return recovered;
    } catch (err) {
      logger.error({ err }, "Session resync: failed to list containers");
      return 0;
    }
  }

  /**
   * Persist the last synced event ID for a session to the DB.
   * Used for resuming event consumption after a restart.
   */
  private async updateLastSyncedEventId(sessionId: string, eventId: number): Promise<void> {
    try {
      await query(
        `UPDATE sub_agent_sessions SET last_synced_event_id = $1 WHERE id = $2`,
        [eventId, sessionId]
      );
    } catch (err) {
      logger.warn({ err, sessionId, eventId }, "Failed to update last_synced_event_id");
    }
  }

  /**
   * Persist sync state for all live sessions.
   * Called during graceful shutdown so the next startup can resume from the correct position.
   */
  async persistAllSyncState(): Promise<void> {
    for (const session of this.sessions.values()) {
      const lastSynced = (session as any)._lastSyncedEventId;
      if (typeof lastSynced === "number" && lastSynced > 0) {
        await this.updateLastSyncedEventId(session.id, lastSynced).catch(() => {});
      }
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
   * Look up the persisted status and variant name of a session from the DB.
   * Returns { status, variantName } or null if not found.
   */
  async getSessionInfoFromDB(sessionId: string): Promise<{ status: string; variantName: string | null; numericUserId: number | null } | null> {
    try {
      const result = await query(
        `SELECT status, variant_name, user_id FROM sub_agent_sessions WHERE id = $1`,
        [sessionId]
      );
      if (result.rows.length > 0) {
        const row = result.rows[0];
        // Compute variant name on-the-fly for old sessions without one stored
        const variantName = row.variant_name || await getSessionVariantName(sessionId, row.user_id ?? null);
        return {
          status: row.status,
          variantName,
          numericUserId: row.user_id ?? null,
        };
      }
      return null;
    } catch (err) {
      logger.warn({ err, sessionId }, "Failed to query session info from DB");
      return null;
    }
  }

  getLiveSessions(): SubAgentSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.state === "starting" || s.state === "running" || s.state === "waiting_user" || s.state === "done" || s.state === "failed"
    );
  }

  getDoneSessions(): SubAgentSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.state === "done" || s.state === "failed");
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
    numericUserId?: number,
    imageUrls?: string[],
    fileInfos?: Array<{ url: string; name: string; mimeType: string }>
  ): Promise<SubAgentSession> {
    const id = randomBytes(8).toString("hex");
    const containerName = `subagent-${id}`;

    // Compute variant name before persisting so it's available immediately
    const variantName = await getSessionVariantName(id, numericUserId);

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
      variantName,
      preferredModel: DEFAULT_SUBAGENT_MODEL,
      executionMode: DEFAULT_SUBAGENT_EXECUTION_MODE,
      output: "",
      pendingQuestion: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(id, session);
    this.metricsCounters.sessionsCreated += 1;

    // Persist session to DB for audit trail
    if (numericUserId) {
      this.persistSessionToDB(session).catch((err) =>
        logger.warn({ err, sessionId: id }, "Failed to persist session to DB")
      );
    }

    try {
      await subagentImageBuilder.ensureForSession();
      await this.startContainer(session, env, images, imageUrls, fileInfos);
    } catch (err) {
      logger.error({ err, sessionId: id }, "Failed to start sub-agent container");
      session.state = "killed";
      this.sessions.delete(id);
      // Clean up container if it was partially created
      execFileAsync("docker", ["rm", "-f", session.containerName]).catch(() => {});
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

    // Clear any pending recovery timeout — a new user message supersedes it
    this.clearRecoveryTimeout(sessionId);

    // Increment generation for this new message
    const generation = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, generation);

    session.state = "running";
    session.pendingQuestion = null;
    session.turnHadStreamedText = false; // reset for new turn
    session.updatedAt = Date.now();
    if (this.onSessionMessage) {
      this.onSessionMessage(session.id, "system", JSON.stringify({ state: "running" }), "system");
    }

    // Persist user message and broadcast to session subscribers
    this.saveSessionMessage(sessionId, "user", message, "text", audioUrl, imageUrls, fileInfos).catch(() => {});
    if (this.onSessionMessage) {
      this.onSessionMessage(
        sessionId,
        "user",
        message,
        "text",
        {
          audioUrl,
          imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined,
          fileInfos: fileInfos && fileInfos.length > 0 ? fileInfos : undefined,
        },
      );
    }

    // Copy images into the container and collect paths
    const imagePaths = await this.injectImages(session, images);

    // Send via stdin NDJSON with generation number
    const payload: any = {
      type: "message",
      text: message,
      generation,
      model: session.preferredModel,
      mode: session.executionMode,
    };
    if (imagePaths.length > 0) payload.images = imagePaths;
    this.sendToAgentProcess(sessionId, payload);
  }

  async killSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      // Session not in memory (e.g. already expired or server restarted) —
      // still update the DB and try to remove the container
      try {
        await execFileAsync("docker", ["rm", "-f", `subagent-${sessionId}`], { timeout: 15_000 });
        logger.info({ sessionId }, "Orphan sub-agent container killed");
      } catch { /* container may not exist */ }
      await this.updateSessionStatus(sessionId, "killed");
      this.metricsCounters.sessionsKilled += 1;
      return;
    }

    // Clear any pending recovery timeout
    this.clearRecoveryTimeout(sessionId);

    // Kill the agent process
    const proc = this.processes.get(sessionId);
    if (proc) {
      try { proc.kill("SIGTERM"); } catch {}
      this.processes.delete(sessionId);
    }

    // Kill the container (with timeout to prevent gateway timeouts when container is Dead/stuck)
    if (session.containerId) {
      try {
        await execFileAsync("docker", ["rm", "-f", session.containerName], { timeout: 15_000 });
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
    this.metricsCounters.sessionsKilled += 1;
  }

  async killAll(): Promise<number> {
    const live = this.getLiveSessions();
    for (const session of live) {
      await this.killSession(session.id);
    }
    return live.length;
  }

  /**
   * Interrupt a running session without killing it.
   * Sends an interrupt signal to the agent process, which will abort the current LLM call
   * and return to waiting_user state.
   * Returns true if there was a session to interrupt.
   */
  interruptSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // Only interrupt if the session is actually running
    if (session.state !== "running" && session.state !== "starting") {
      return false;
    }

    // Increment generation so in-flight responses are discarded.
    // This is critical for the Stop button case where no new message is sent.
    const newGen = (this.sessionGenerations.get(sessionId) ?? 0) + 1;
    this.sessionGenerations.set(sessionId, newGen);

    // Update session state immediately so UI shows correct state on reconnect
    session.state = "waiting_user";
    session.updatedAt = Date.now();
    
    // Notify session viewers of state change immediately
    if (this.onSessionMessage) {
      this.onSessionMessage(sessionId, "system", JSON.stringify({ state: "waiting_user" }), "system");
    }

    // Send interrupt message with the new generation to the agent process
    this.sendToAgentProcess(sessionId, { type: "interrupt", generation: newGen });
    
    logger.info({ sessionId, generation: newGen }, "Sent interrupt signal to sub-agent");
    this.metricsCounters.sessionsInterrupted += 1;
    return true;
  }

  /**
   * Check if a session is currently processing (running or starting).
   */
  isSessionProcessing(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.state === "running" || session.state === "starting";
  }

  setSessionPreferredModel(sessionId: string, modelId: string): SubAgentModelId {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No session with id ${sessionId}`);
    }
    if (!isSubAgentModelId(modelId)) {
      throw new Error("Modelo invalido");
    }
    session.preferredModel = modelId;
    session.updatedAt = Date.now();

    // Notify the agent process of the model change so it takes effect on the next turn.
    // This avoids a mismatch where the session object has a new model but the agent
    // process still uses the old one until the next sendToSession call.
    this.sendToAgentProcess(sessionId, { type: "update_model", modelId });
    logger.info({ sessionId, modelId }, "Sent model update to agent process");

    return session.preferredModel;
  }

  setSessionExecutionMode(sessionId: string, mode: string): SubAgentExecutionMode {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`No session with id ${sessionId}`);
    }
    if (!isSubAgentExecutionMode(mode)) {
      throw new Error("Modo invalido");
    }
    session.executionMode = mode;
    session.updatedAt = Date.now();
    return session.executionMode;
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

  // ==================== SUBAGENT HTTP CONTROL ====================

  /** Port exposed by the agent's built-in HTTP control server inside its container. */
  private static readonly SUBAGENT_HTTP_PORT = 3000;

  /**
   * Execute a curl command inside a subagent container to reach its local HTTP server.
   * Works regardless of Docker network topology (same network, default bridge, etc.)
   * because it runs inside the container itself.
   */
  private async querySubagentHttp(containerName: string, path: string, method: string = "GET", body?: string): Promise<string> {
    const url = `http://localhost:${SessionManager.SUBAGENT_HTTP_PORT}${path}`;
    const args = ["exec", containerName, "curl", "-sf", "--max-time", "5", "-X", method];
    if (body) {
      args.push("-H", "Content-Type: application/json", "-d", body);
    }
    args.push(url);
    const { stdout } = await execFileAsync("docker", args, { timeout: 10_000 });
    return stdout.trim();
  }

  /**
   * Poll the subagent's /health endpoint until it reports ready.
   * Retries for up to 30 seconds with 1-second intervals.
   */
  private async waitForAgentReady(session: SubAgentSession): Promise<void> {
    const maxAttempts = 30;
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        const raw = await this.querySubagentHttp(session.containerName, "/health");
        const health = JSON.parse(raw);
        if (health.status === "ok") {
          logger.info({ sessionId: session.id, attempt: i }, "Sub-agent HTTP control server ready");
          return;
        }
      } catch {
        // Not ready yet — curl failed or agent not listening
      }
      if (i < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // Don't throw — the agent may still be starting up but the stdin stream
    // can connect anyway. Log a warning and proceed.
    logger.warn({ sessionId: session.id }, "Sub-agent HTTP control server not ready after 30s — proceeding with stdin stream");
  }

  /**
   * Fetch missed events from a subagent's local event store.
   * Returns parsed events array and the lastEventId.
   */
  private async fetchSubagentEvents(containerName: string, afterEventId: number = 0): Promise<{ events: any[]; lastEventId: number }> {
    try {
      const raw = await this.querySubagentHttp(containerName, `/events?after=${afterEventId}`);
      const result = JSON.parse(raw);
      return {
        events: Array.isArray(result.events) ? result.events : [],
        lastEventId: typeof result.lastEventId === "number" ? result.lastEventId : afterEventId,
      };
    } catch (err) {
      logger.warn({ err, containerName, afterEventId }, "Failed to fetch subagent events");
      return { events: [], lastEventId: afterEventId };
    }
  }

  /**
   * Send a command to a subagent via its HTTP control server.
   * Used when the stdin stream is not available (e.g. during resync after restart).
   */
  private async sendHttpCommand(containerName: string, command: any): Promise<boolean> {
    try {
      await this.querySubagentHttp(containerName, "/command", "POST", JSON.stringify(command));
      return true;
    } catch (err) {
      logger.warn({ err, containerName, type: command?.type }, "Failed to send HTTP command to subagent");
      return false;
    }
  }

  // ==================== CONTAINER MANAGEMENT ====================

  private async startContainer(session: SubAgentSession, env: Record<string, string>, images?: MediaAttachment[], imageUrls?: string[], fileInfos?: Array<{ url: string; name: string; mimeType: string }>): Promise<void> {
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

    // Attach sub-agent to the same Docker network as the main container (if detected).
    // This allows sub-agents to reach the host API by container name.
    // Falls back to default bridge + host.docker.internal when not on a custom network.
    const networkArgs: string[] = this.resolvedNetwork
      ? ["--network", this.resolvedNetwork]
      : ["--add-host=host.docker.internal:host-gateway"];

    // No memory/CPU limits — containers share host resources freely.
    // The pids-limit is kept as a safety net against fork bombs.
    const resourceArgs = ["--pids-limit", "512"];

    // The container CMD is now `node /app/agent.mjs` (set in Dockerfile).
    // The agent starts as a resident process and exposes an HTTP control
    // server on port 3000 for reconnection after main container restarts.
    // No more `sleep 86400` — the agent IS the main process.
    const buildDockerRunArgs = (withResourceLimits: boolean) => [
      "run", "-d", "--init", "--ipc=host",
      ...(withResourceLimits ? resourceArgs : []),
      ...networkArgs,
      "--name", session.containerName,
      ...envArgs,
      SUBAGENT_RUNTIME_IMAGE,
    ];

    // Start the container — retry without resource limits if the host doesn't support them
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("docker", buildDockerRunArgs(true)));
    } catch (firstErr: any) {
      // The container may have been partially created with the failing name — clean up
      try { await execFileAsync("docker", ["rm", "-f", session.containerName]); } catch { /* ignore */ }
      logger.warn({ err: firstErr?.message, sessionId: session.id }, "docker run with resource limits failed — retrying without limits");
      ({ stdout } = await execFileAsync("docker", buildDockerRunArgs(false)));
    }

    session.containerId = stdout.trim();
    logger.info({ sessionId: session.id, container: session.containerName, containerId: session.containerId }, "Sub-agent container started");

    // Wait for the agent's HTTP control server to become ready
    await this.waitForAgentReady(session);

    // Connect the live NDJSON stream (stdin/stdout via docker exec)
    await this.startAgentProcess(session);

    // If there's a task description, send it as the first message
    if (session.taskDescription && session.taskDescription.trim()) {
      session.state = "running";
      session.updatedAt = Date.now();
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "system", JSON.stringify({ state: "running" }), "system");
      }

      // Persist and broadcast user message (include image/file URLs for viewer display)
      this.saveSessionMessage(session.id, "user", session.taskDescription, "text", undefined, imageUrls, fileInfos).catch(() => {});
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "user", session.taskDescription, "text", {
          imageUrls: imageUrls && imageUrls.length > 0 ? imageUrls : undefined,
          fileInfos: fileInfos && fileInfos.length > 0 ? fileInfos : undefined,
        });
      }

      // Copy images into container and send to agent
      // Credentials are available as RICK_CRED_* / RICK_SECRET_* env vars — not in the prompt
      const imagePaths = await this.injectImages(session, images);
      const payload: any = {
        type: "message",
        text: session.taskDescription,
        model: session.preferredModel,
        mode: session.executionMode,
      };
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
   * Build environment variables for the Agent API (JWT token + upfront credentials).
   */
  private async buildAgentApiEnv(session: SubAgentSession): Promise<Record<string, string>> {
    const agentEnv: Record<string, string> = {};

    // JWT token for authenticating against Rick's /api/agent/* endpoints
    // numericUserId is embedded so API endpoints can skip the getOrCreateUser DB call
    const token = createAgentToken(session.id, session.userId, 86400, session.numericUserId ?? undefined); // 24h TTL matches container lifetime
    // When running inside Docker on a custom network, use the container hostname
    // so sub-agents on the same network can reach us. Fall back to host.docker.internal.
    const apiUrl = this.getCurrentApiUrl();
    agentEnv.RICK_SESSION_TOKEN = token;
    agentEnv.RICK_API_URL = apiUrl;
    agentEnv.RICK_PLAYWRIGHT_MCP_COMMAND = process.env.RICK_PLAYWRIGHT_MCP_COMMAND
      || JSON.stringify(["node", "/app/node_modules/@playwright/mcp/cli.js", "--browser", "chrome", "--no-sandbox"]);

    const gitIdentity = await this.buildSubagentGitIdentity(session, agentEnv);
    agentEnv.GIT_AUTHOR_NAME = gitIdentity.name;
    agentEnv.GIT_COMMITTER_NAME = gitIdentity.name;
    agentEnv.GIT_AUTHOR_EMAIL = gitIdentity.email;
    agentEnv.GIT_COMMITTER_EMAIL = gitIdentity.email;

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

  private async buildSubagentGitIdentity(session: SubAgentSession, agentEnv: Record<string, string>): Promise<{ name: string; email: string }> {
    const fallbackName = (session.variantName || `${config.agentName} Subagent`).trim();

    let host = "localhost";
    const webBaseUrl = config.webBaseUrl?.trim();
    if (webBaseUrl) {
      try {
        const parsed = new URL(webBaseUrl);
        if (parsed.hostname) host = parsed.hostname;
      } catch {
        // Ignore malformed WEB_BASE_URL and fall back below
      }
    }

    if (host === "localhost") {
      try {
        const parsedApi = new URL(this.getCurrentApiUrl());
        if (parsedApi.hostname) host = parsedApi.hostname;
      } catch {
        // Keep localhost fallback
      }
    }

    const fallback = {
      name: fallbackName,
      email: `subagent@${host}`,
    };

    const githubToken = (agentEnv.RICK_SECRET_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "").trim();
    if (!githubToken) {
      return fallback;
    }

    try {
      const timeout = AbortSignal.timeout(8000);
      const profileRes = await fetch("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${githubToken}`,
          "User-Agent": "rick-ai-subagent",
        },
        signal: timeout,
      });

      if (!profileRes.ok) {
        return fallback;
      }

      const profile = await profileRes.json() as { login?: string; name?: string; email?: string | null };
      const githubName = (profile.name || profile.login || "").trim();
      let githubEmail = (profile.email || "").trim();

      if (!githubEmail) {
        const emailRes = await fetch("https://api.github.com/user/emails", {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${githubToken}`,
            "User-Agent": "rick-ai-subagent",
          },
          signal: timeout,
        });
        if (emailRes.ok) {
          const emails = await emailRes.json() as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
          const primaryVerified = emails.find((e) => e.primary && e.verified && e.email);
          const primary = emails.find((e) => e.primary && e.email);
          const any = emails.find((e) => e.email);
          githubEmail = (primaryVerified?.email || primary?.email || any?.email || "").trim();
        }
      }

      return {
        name: githubName || fallback.name,
        email: githubEmail || fallback.email,
      };
    } catch {
      return fallback;
    }
  }

  /**
   * Connect a live NDJSON stream to the subagent via stream-bridge.mjs.
   *
   * The agent.mjs runs as PID 1 (resident process) inside the container.
   * The stream-bridge.mjs is a lightweight relay that:
   * - Reads stdin and forwards commands as POST /command to localhost:3000
   * - Polls GET /events from localhost:3000 and writes NDJSON to stdout
   *
   * If this bridge process dies (e.g. main container restarts), the agent
   * continues working autonomously. Events are stored in its local SQLite
   * outbox and will be fetched via HTTP when the main container reconnects.
   *
   * @param afterEventId - Start streaming events after this event ID (for resync)
   */
  private async startAgentProcess(session: SubAgentSession, afterEventId: number = 0): Promise<void> {
    const proc = spawn("docker", [
      "exec", "-i", session.containerName,
      "node", "/app/stream-bridge.mjs", String(afterEventId),
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

    // Collect stderr for error reporting
    let stderrBuffer = "";
    proc.stderr!.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrBuffer += text;
      // Log immediately for debugging (truncated)
      if (text.trim()) logger.debug({ sessionId: session.id, stderr: text.trim().substring(0, 500) }, "Sub-agent stderr");
    });

    // Store stderr buffer on session for access in exit handler
    (session as any)._stderrBuffer = () => stderrBuffer;

    proc.on("exit", (code) => {
      // Get stderr buffer if available
      const getStderr = (session as any)._stderrBuffer;
      const stderr = getStderr ? getStderr() : "";

      this.processes.delete(session.id);

      // The stream bridge exiting does NOT mean the agent died.
      // The agent is PID 1 in its own container and continues working.
      // We need to check the actual agent state before declaring failure.

      // If this was a clean exit (code 0), the bridge just disconnected.
      // If non-zero, the bridge itself crashed (not the agent).
      if (code !== 0 && code !== null) {
        logger.warn({ sessionId: session.id, exitCode: code, stderr: stderr.substring(0, 1000) }, "Stream bridge exited with error");
      } else {
        logger.info({ sessionId: session.id }, "Stream bridge disconnected");
      }

      // Check actual agent health before changing session state
      this.checkAgentHealthAndRecover(session).catch((err) => {
        logger.warn({ err, sessionId: session.id }, "Failed to check agent health after bridge disconnect");
      });
    });

    proc.on("error", (err) => {
      logger.error({ err, sessionId: session.id }, "Sub-agent process error");
      this.processes.delete(session.id);
      // Notify user about process spawn failure
      this.sendToUser(session, `Erro: falha ao iniciar o sub-agente: ${err.message}`, "error");
    });
  }

  /**
   * After the stream bridge disconnects, check if the actual agent is still alive
   * and decide whether to reconnect or declare the session done/failed.
   */
  private async checkAgentHealthAndRecover(session: SubAgentSession): Promise<void> {
    // Don't interfere with sessions that are already terminated
    if (session.state === "killed" || session.state === "failed" || session.state === "done") return;
    // Don't reconnect if there's already a live bridge process
    if (this.processes.has(session.id)) return;

    // Check if the container is still running
    try {
      const { stdout } = await execFileAsync("docker", [
        "inspect", "--format", "{{.State.Running}}", session.containerName,
      ], { timeout: 5_000 });
      if (stdout.trim() !== "true") {
        // Container is dead — the agent truly exited
        logger.info({ sessionId: session.id }, "Agent container stopped — marking session as done");
        session.state = "done";
        session.updatedAt = Date.now();
        if (this.onSessionMessage) {
          this.onSessionMessage(session.id, "system", JSON.stringify({ state: "done" }), "system");
        }
        this.updateSessionStatus(session.id, "done").catch(() => {});
        execFileAsync("docker", ["rm", "-f", session.containerName]).catch(() => {});
        return;
      }
    } catch {
      // Container doesn't exist — same as stopped
      session.state = "done";
      session.updatedAt = Date.now();
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "system", JSON.stringify({ state: "done" }), "system");
      }
      this.updateSessionStatus(session.id, "done").catch(() => {});
      return;
    }

    // Container is still running — check agent health via HTTP
    try {
      const raw = await this.querySubagentHttp(session.containerName, "/health");
      const health = JSON.parse(raw);
      logger.info({ sessionId: session.id, agentState: health.state, lastEventId: health.lastEventId }, "Agent still alive after bridge disconnect — reconnecting");

      // Fetch any missed events before reconnecting the stream.
      // Use recoveryReplay=true to avoid re-saving/re-broadcasting events
      // that were already persisted — only rebuild in-memory state.
      const lastSynced = (session as any)._lastSyncedEventId ?? 0;
      const { events } = await this.fetchSubagentEvents(session.containerName, lastSynced);
      for (const evt of events) {
        if (evt.data) {
          this.handleAgentOutput(session, JSON.stringify(evt.data), true);
        }
        if (typeof evt.id === "number") {
          (session as any)._lastSyncedEventId = evt.id;
        }
      }

      // Reconnect the stream bridge
      const afterEventId = (session as any)._lastSyncedEventId ?? 0;
      await this.startAgentProcess(session, afterEventId);
    } catch (err) {
      // Agent HTTP not reachable but container running — may be starting up or crashed internally
      logger.warn({ err, sessionId: session.id }, "Agent HTTP not reachable — will retry via resync");
    }
  }

  /**
   * Process a single NDJSON line from the sub-agent.
   *
   * @param recoveryReplay - When true, only update in-memory state (output, session.state).
   *   Do NOT save to DB or broadcast to session viewers. Used during recoverSessions()
   *   to replay events that were already persisted before the server restart.
   */
  private handleAgentOutput(session: SubAgentSession, line: string, recoveryReplay: boolean = false): void {
    try {
      const msg = JSON.parse(line);

      // Track event ID from the stream bridge for sync state.
      // The stream bridge injects _eventId into each event payload so we can
      // persist the sync position and avoid re-fetching events after a restart.
      if (typeof msg._eventId === "number") {
        const prevId = (session as any)._lastSyncedEventId ?? 0;
        if (msg._eventId > prevId) {
          (session as any)._lastSyncedEventId = msg._eventId;
          // Persist every 10 events to avoid excessive DB writes
          if (msg._eventId % 10 === 0 || msg.type === "waiting_user" || msg.type === "done") {
            this.updateLastSyncedEventId(session.id, msg._eventId).catch(() => {});
          }
        }
        delete msg._eventId; // Clean up so downstream code doesn't see it
      }

      // If the agent emits any substantive event, clear the recovery timeout —
      // it proves the agent received and is processing the re-sent message.
      if (!recoveryReplay && (msg.type === "message" || msg.type === "status" || msg.type === "tool_call" ||
          msg.type === "waiting_user" || msg.type === "question" || msg.type === "provider_error")) {
        this.clearRecoveryTimeout(session.id);
      }
      
      switch (msg.type) {
        case "ready":
          if (recoveryReplay) break; // Skip — ready events during replay are stale
          logger.info({ sessionId: session.id, providers: msg.providers, tools: msg.tools?.length }, "Sub-agent ready");
          // For recovered sessions: inject fresh JWT token and conversation history
          // (the old token in the container's env may be invalid if JWT_SECRET changed)
          if (session.recovered) {
            this.injectFreshToken(session);
            this.injectHistory(session).catch((err: any) => {
              logger.warn({ err, sessionId: session.id }, "Failed to inject history into agent");
            });
          }
          break;

        case "token_updated":
          logger.info({ sessionId: session.id }, "Agent JWT token updated successfully");
          break;

        case "history_loaded":
          if (recoveryReplay) break; // Skip — history_loaded during replay is stale
          logger.info({ sessionId: session.id, count: msg.count }, "Agent conversation history restored");
          // After history injection, check if the last message was from the user
          // (i.e. the agent was mid-turn when the server restarted). If so, re-send
          // that message automatically so the user doesn't have to repeat themselves.
          if (session.recovered) {
            this.resumeInterruptedTurn(session).catch((err: any) => {
              logger.warn({ err, sessionId: session.id }, "Failed to resume interrupted turn after recovery");
            });
          } else {
            session.state = "waiting_user";
            session.updatedAt = Date.now();
            if (this.onSessionMessage) {
              this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
            }
          }
          break;

        case "message":
          if (msg.text) {
            if (!recoveryReplay && session.state !== "running") {
              session.state = "running";
              if (this.onSessionMessage) {
                this.onSessionMessage(session.id, "system", JSON.stringify({ state: "running" }), "system");
              }
            }
            session.output += msg.text + "\n";
            session.updatedAt = Date.now();
            session.turnHadStreamedText = true;
            if (!recoveryReplay) this.sendToUser(session, msg.text);
          }
          break;

        case "status":
          // Status updates (tool execution, LLM switching, context rotation)
          if (msg.message) {
            if (!recoveryReplay && session.state !== "running") {
              session.state = "running";
              if (this.onSessionMessage) {
                this.onSessionMessage(session.id, "system", JSON.stringify({ state: "running" }), "system");
              }
            }
            if (!recoveryReplay) {
              const statusText = normalizeStatusToolLine(msg.message);
              this.sendToUser(session, statusText, "tool_use");
            }
          }
          break;

        case "tool_call":
          if (msg.event && msg.name) {
            if (!recoveryReplay && session.state !== "running") {
              session.state = "running";
              if (this.onSessionMessage) {
                this.onSessionMessage(session.id, "system", JSON.stringify({ state: "running" }), "system");
              }
            }

            if (!recoveryReplay) {
              if (msg.event === "start") {
                this.metricsCounters.toolCallsStarted += 1;
                const toolLine = formatToolLifecycleLine({
                  event: "start",
                  name: msg.name,
                  args: typeof msg.input === "object" && msg.input ? msg.input : {},
                });
                this.sendToUser(session, toolLine, "tool_use");
              } else if (msg.event === "completed") {
                this.metricsCounters.toolCallsCompleted += 1;
                const toolLine = formatToolLifecycleLine({
                  event: "completed",
                  name: msg.name,
                  durationMs: typeof msg.durationMs === "number" ? msg.durationMs : undefined,
                  outputPreview: typeof msg.outputPreview === "string" ? msg.outputPreview : undefined,
                });
                this.sendToUser(session, toolLine, "tool_use");
              } else if (msg.event === "error") {
                this.metricsCounters.toolCallsErrored += 1;
                const toolLine = formatToolLifecycleLine({
                  event: "error",
                  name: msg.name,
                  message: typeof msg.message === "string" ? msg.message : "erro na ferramenta",
                });
                this.sendToUser(session, toolLine, "tool_use");
              }
            }
            session.updatedAt = Date.now();
          }
          break;

        case "question": {
          const questions = Array.isArray(msg.questions)
            ? msg.questions
              .map((item: any): PendingQuestionItem | null => {
                if (!item || typeof item !== "object") return null;
                const question = String(item.question || "").trim();
                const header = String(item.header || "").trim();
                const options = Array.isArray(item.options)
                  ? item.options
                    .map((option: any) => ({
                      label: String(option?.label || "").trim(),
                      description: String(option?.description || "").trim(),
                    }))
                    .filter((option: { label: string }) => option.label)
                  : [];
                if (!question || !header || options.length === 0) return null;
                return {
                  question,
                  header,
                  options,
                  multiple: item.multiple === true,
                  custom: item.custom !== false,
                };
              })
              .filter(Boolean) as PendingQuestionItem[]
            : [];

          if (questions.length === 0) break;

          const requestId = typeof msg.requestId === "string" && msg.requestId.trim()
            ? msg.requestId.trim()
            : `question_${Date.now()}`;

          const pendingQuestion: PendingQuestionPrompt = { requestId, questions };
          session.pendingQuestion = pendingQuestion;
          session.state = "waiting_user";
          session.updatedAt = Date.now();
          session.turnHadStreamedText = false;

          if (!recoveryReplay) {
            this.sendToUser(session, JSON.stringify(pendingQuestion), "question");

            if (this.onSessionMessage) {
              this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
            }
          }

          logger.info({ sessionId: session.id, requestId, questionCount: questions.length }, "Sub-agent asked a question");
          break;
        }

        case "model_active":
          if (isSubAgentModelId(msg.modelId)) {
            session.preferredModel = msg.modelId;
            session.updatedAt = Date.now();
            if (!recoveryReplay && this.onSessionMessage) {
              this.onSessionMessage(
                session.id,
                "system",
                JSON.stringify({ activeModel: msg.modelId, activeModelName: msg.modelName || null }),
                "system",
              );
            }
          }
          break;

        case "provider_error":
          if (msg.message) {
            if (!recoveryReplay) {
              const message = String(msg.message);
              this.metricsCounters.providerErrors += 1;
              if (message.includes("Limite maximo de passos")) this.metricsCounters.maxStepsHits += 1;
              if (message.includes("Sem execucao concreta detectada")) this.metricsCounters.noExecutionGuards += 1;
              this.sendToUser(session, msg.message, "error");
            }
          }
          break;

        case "fallback_used":
          if (!recoveryReplay) this.metricsCounters.fallbackUsed += 1;
          break;

        case "provider_retry":
          if (!recoveryReplay) {
            if (msg.reason === "timeout") this.metricsCounters.timeoutRetries += 1;
            if (msg.reason === "auth") this.metricsCounters.authRetries += 1;
          }
          break;

        case "context_compacted":
          if (!recoveryReplay) this.metricsCounters.contextCompactions += 1;
          break;

        case "waiting_user":
          // Agent finished processing this turn — waiting for user's next message.
          // Session stays alive; compose bar shown to user.
          session.state = "waiting_user";
          session.updatedAt = Date.now();
          if (msg.result) {
            session.output += msg.result + "\n";
            // Only send the result text if it wasn't already streamed via "message" events.
            // The agent emits each text chunk as "message" during streaming AND the full
            // concatenated text as "waiting_user" result — sending both causes duplicates.
            if (!recoveryReplay && !session.turnHadStreamedText) {
              const messageType = isExecutionOperationalFailure(msg.result) ? "error" : "text";
              this.sendToUser(session, msg.result, messageType);
            }
          }
          session.turnHadStreamedText = false; // reset for next turn
          if (!recoveryReplay) {
            // Notify session viewers of state change
            if (this.onSessionMessage) {
              this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
            }
            logger.info({ sessionId: session.id }, "Sub-agent waiting for user input");
            this.metricsCounters.turnsCompleted += 1;
          }
          break;

        case "done":
          session.state = "done";
          session.updatedAt = Date.now();
          if (msg.result) {
            session.output += msg.result + "\n";
            // Only send the result if it wasn't already streamed via "message" events
            if (!recoveryReplay && !session.turnHadStreamedText) {
              this.sendToUser(session, msg.result);
            }
          }
          session.turnHadStreamedText = false;
          if (!recoveryReplay) {
            // Notify session viewers of state change (not rendered as a chat bubble)
            if (this.onSessionMessage) {
              this.onSessionMessage(session.id, "system", JSON.stringify({ state: "done" }), "system");
            }
            // Persist done state to DB
            this.updateSessionStatus(session.id, "done").catch(() => {});
            // Fire post-session learning callback (fire-and-forget)
            if (this.onSessionDone && session.output.trim()) {
              try {
                this.onSessionDone(session.id, session.taskDescription, session.output, session.numericUserId);
              } catch (err) {
                logger.warn({ err, sessionId: session.id }, "Post-session learning callback failed");
              }
            }
            logger.info({ sessionId: session.id }, "Sub-agent task done");
          }
          break;

        case "error":
          if (!recoveryReplay) {
            logger.error({ sessionId: session.id, error: msg.message }, "Sub-agent error");
            if (msg.message) {
              this.sendToUser(session, `Erro: ${msg.message}`, "error");
            }
          }
          // After an error, the sub-agent returns to waiting for input —
          // update state so the UI shows the compose bar instead of "Digitando..."
          session.state = "waiting_user";
          session.updatedAt = Date.now();
          if (!recoveryReplay && this.onSessionMessage) {
            this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
          }
          break;

        case "pong":
          break;

        default:
          logger.debug({ sessionId: session.id, msgType: msg.type }, "Unknown sub-agent message type");
      }
    } catch (err) {
      // Non-JSON output from the agent process.
      // This can happen from Docker exec overhead, Node.js warnings, or binary garbage.
      // Log for debugging but do NOT relay to the user — only NDJSON messages should be visible.
      if (line.trim()) {
        logger.debug({ sessionId: session.id, rawLine: line.substring(0, 200) }, "Sub-agent non-JSON stdout (ignored)");
      }
    }
  }

  /**
   * Send a fresh JWT token to a recovered session.
   * The container's original RICK_SESSION_TOKEN may be invalid if JWT_SECRET changed.
   * The agent will update its env var dynamically when it receives this message.
   */
  private injectFreshToken(session: SubAgentSession): void {
    // Generate a fresh token with the current JWT_SECRET
    const token = createAgentToken(
      session.id,
      session.userId,
      86400, // 24h TTL
      session.numericUserId ?? undefined
    );
    const apiUrl = this.getCurrentApiUrl();
    logger.info({ sessionId: session.id, apiUrl }, "Injecting fresh JWT token into recovered session");
    this.sendToAgentProcess(session.id, { type: "update_token", token, apiUrl });
  }

  /**
   * After recovery, check if the last message in history was from the user
   * (meaning the agent was mid-turn when the server restarted). If so,
   * automatically re-send that message so the agent resumes work without
   * the user having to repeat themselves.
   */
  private async resumeInterruptedTurn(session: SubAgentSession): Promise<void> {
    const history = await this.getSessionHistory(session.id);
    // Find the last user text message (skip tool_use, system, errors)
    const textMessages = history.filter(
      (m) => (m.role === "user" || m.role === "agent") && m.content && m.message_type !== "tool_use" && m.message_type !== "system"
    );
    const lastMsg = textMessages.length > 0 ? textMessages[textMessages.length - 1] : null;

    if (lastMsg && lastMsg.role === "user") {
      // The agent never finished responding — re-send the user's message
      logger.info(
        { sessionId: session.id, messagePreview: lastMsg.content.substring(0, 80) },
        "Session recovery: re-sending interrupted user message"
      );
      // Notify the viewer that the session is resuming
      this.sendToUser(session, "(Sessao recuperada apos atualizacao — retomando tarefa...)", "system");

      // Set state to running and re-send the message directly to the agent process.
      // We do NOT use sendToSession() because it would re-persist the user message
      // to the DB and re-broadcast it to the viewer (causing duplicates).
      const generation = (this.sessionGenerations.get(session.id) ?? 0) + 1;
      this.sessionGenerations.set(session.id, generation);
      session.state = "running";
      session.pendingQuestion = null;
      session.turnHadStreamedText = false;
      session.updatedAt = Date.now();
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "system", JSON.stringify({ state: "running" }), "system");
      }
      this.sendToAgentProcess(session.id, {
        type: "message",
        text: lastMsg.content,
        generation,
        model: session.preferredModel,
        mode: session.executionMode,
      });

      // Start a timeout: if the agent doesn't acknowledge with any activity event
      // (message, status, tool_call, waiting_user, question, etc.) within the
      // timeout window, revert the state to waiting_user so the UI doesn't stay
      // stuck on "Digitando..." forever.
      this.startRecoveryTimeout(session);
    } else {
      // The agent had already responded — just wait for new user input
      session.state = "waiting_user";
      session.updatedAt = Date.now();
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
      }
    }
  }

  /**
   * Check for unsent user messages after session recovery.
   *
   * Handles the case where a user message arrived via the session viewer AFTER
   * the agent's last response but BEFORE the server restart. The message is
   * persisted in session_messages (the viewer WebSocket handler saves it)
   * but was never forwarded to the agent via sendToSession().
   *
   * Waits briefly for the stream bridge to connect before sending.
   */
  private async checkAndResendUnsentMessage(session: SubAgentSession): Promise<void> {
    const history = await this.getSessionHistory(session.id);
    // Find the last user/agent text message (skip tool_use, system, errors)
    const textMessages = history.filter(
      (m) => (m.role === "user" || m.role === "agent") && m.content && m.message_type !== "tool_use" && m.message_type !== "system"
    );
    const lastMsg = textMessages.length > 0 ? textMessages[textMessages.length - 1] : null;

    if (!lastMsg || lastMsg.role !== "user") return;

    // Wait a moment for the stream bridge to connect before sending
    await new Promise((r) => setTimeout(r, 2000));

    logger.info(
      { sessionId: session.id, messagePreview: lastMsg.content.substring(0, 80) },
      "Session resync: found unsent user message — re-sending to agent"
    );

    // Re-send the message directly to the agent process.
    // We do NOT use sendToSession() because the message is already in the DB.
    const generation = (this.sessionGenerations.get(session.id) ?? 0) + 1;
    this.sessionGenerations.set(session.id, generation);
    session.state = "running";
    session.pendingQuestion = null;
    session.turnHadStreamedText = false;
    session.updatedAt = Date.now();
    if (this.onSessionMessage) {
      this.onSessionMessage(session.id, "system", JSON.stringify({ state: "running" }), "system");
    }
    this.sendToAgentProcess(session.id, {
      type: "message",
      text: lastMsg.content,
      generation,
      model: session.preferredModel,
      mode: session.executionMode,
    });

    // Start recovery timeout in case the agent doesn't respond
    this.startRecoveryTimeout(session);
  }

  /**
   * Start a recovery acknowledgement timeout for a session.
   * If the agent doesn't emit any activity event within RECOVERY_ACK_TIMEOUT_MS,
   * we assume the re-sent message was lost and revert the session to waiting_user.
   */
  private startRecoveryTimeout(session: SubAgentSession): void {
    // Clear any existing timer for this session
    this.clearRecoveryTimeout(session.id);

    const timer = setTimeout(() => {
      this.recoveryTimeouts.delete(session.id);
      // Only revert if the session is still in "running" state (the recovery turn hasn't progressed)
      if (session.state !== "running") return;

      logger.warn(
        { sessionId: session.id, timeoutMs: SessionManager.RECOVERY_ACK_TIMEOUT_MS },
        "Recovery timeout: agent did not acknowledge re-sent message — reverting to waiting_user"
      );

      session.state = "waiting_user";
      session.updatedAt = Date.now();
      if (this.onSessionMessage) {
        this.onSessionMessage(session.id, "system", JSON.stringify({ state: "waiting_user" }), "system");
      }
    }, SessionManager.RECOVERY_ACK_TIMEOUT_MS);

    this.recoveryTimeouts.set(session.id, timer);
  }

  /**
   * Clear a recovery timeout for a session (called when the agent emits activity).
   */
  private clearRecoveryTimeout(sessionId: string): void {
    const timer = this.recoveryTimeouts.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.recoveryTimeouts.delete(sessionId);
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

  /**
   * Send a command to the agent process.
   * Primary path: write to the stream bridge's stdin (lowest latency).
   * Fallback: POST /command via the agent's HTTP control server.
   */
  private sendToAgentProcess(sessionId: string, msg: any): void {
    // Try the live stream bridge first (stdin → stream-bridge → POST /command)
    const proc = this.processes.get(sessionId);
    if (proc && proc.stdin && !proc.stdin.destroyed) {
      try {
        proc.stdin.write(JSON.stringify(msg) + "\n");
        return;
      } catch (err) {
        logger.warn({ err, sessionId }, "Failed to write to stream bridge stdin — falling back to HTTP");
      }
    }

    // Fallback: send via HTTP directly to the agent
    const session = this.sessions.get(sessionId);
    if (session?.containerName) {
      this.sendHttpCommand(session.containerName, msg).catch((err) => {
        logger.error({ err, sessionId }, "Failed to send command via HTTP fallback");
      });
    } else {
      logger.warn({ sessionId }, "Cannot send to agent: no active stream and no container name");
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
        `INSERT INTO sub_agent_sessions (id, user_id, task, status, connector_name, user_external_id, variant_name, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [session.id, session.numericUserId, session.taskDescription || null, "active",
          session.connectorName, session.userId, session.variantName || null]
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

  // ==================== IMAGE INJECTION ====================

  /**
   * Copy media attachments (images, PDFs, documents) into a running sub-agent container.
   * Returns the list of paths inside the container (e.g. /tmp/img-xxx.png, /tmp/file-xxx.pdf).
   */
  private async injectImages(session: SubAgentSession, images?: MediaAttachment[]): Promise<string[]> {
    if (!images || images.length === 0 || !session.containerId) return [];

    const paths: string[] = [];
    for (const attachment of images) {
      try {
        const ext = this.getFileExtension(attachment);
        const id = randomBytes(4).toString("hex");
        const prefix = attachment.mimeType.startsWith("image/") ? "img" : "file";
        const containerPath = `/tmp/${prefix}-${id}.${ext}`;
        const tmpFile = join(tmpdir(), `subagent-${prefix}-${id}.${ext}`);

        await writeFile(tmpFile, attachment.data);
        try {
          await execFileAsync("docker", ["cp", tmpFile, `${session.containerName}:${containerPath}`]);
          paths.push(containerPath);
        } finally {
          await unlink(tmpFile).catch(() => {});
        }
      } catch (err) {
        logger.warn({ err, sessionId: session.id }, "Failed to inject attachment into sub-agent container");
      }
    }
    return paths;
  }

  /** Derive a file extension from a MediaAttachment's mimeType or fileName. */
  private getFileExtension(attachment: MediaAttachment): string {
    // Prefer extension from original fileName if available
    if (attachment.fileName) {
      const dotIdx = attachment.fileName.lastIndexOf(".");
      if (dotIdx > 0) return attachment.fileName.substring(dotIdx + 1).toLowerCase();
    }
    // Common MIME → extension mappings
    const mimeMap: Record<string, string> = {
      "application/pdf": "pdf",
      "application/msword": "doc",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
      "application/vnd.ms-excel": "xls",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
      "application/vnd.ms-powerpoint": "ppt",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
      "text/plain": "txt",
      "text/csv": "csv",
      "application/json": "json",
      "application/zip": "zip",
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    return mimeMap[attachment.mimeType] || attachment.mimeType.split("/")[1] || "bin";
  }

}

