import { validateConfig, config, reloadConfig } from "./config/env.js";
import { logger } from "./config/logger.js";
import { initDatabase, closeDatabase, isPostgres } from "./memory/database.js";
import { loadConfigFromStore } from "./memory/config-store.js";
import { runMigrations, runPostConfigVectorMigrations } from "./memory/migrate.js";
import { MemoryService } from "./memory/memory-service.js";
import { EmbeddingService } from "./memory/embedding-service.js";
import { VectorMemoryService } from "./memory/vector-memory-service.js";
import { DiskMonitor } from "./memory/disk-monitor.js";
import { LLMService } from "./llm/llm-service.js";
import { Agent } from "./agent.js";
import { ConnectorManager } from "./connectors/connector-manager.js";
import { WhatsAppConnector } from "./connectors/whatsapp.js";
import { WebConnector } from "./connectors/web.js";
import { UserService } from "./auth/user-service.js";
import { closeVectorPool } from "./memory/vector-db.js";
import { EditSession } from "./subagent/edit-session.js";
import { startHealthServer, setHealthy, registerAgentApiServices, registerSessionKiller } from "./health.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function main() {
  console.log(`
  ╔══════════════════════════════════╗
  ║          RICK AI v2.1           ║
  ╚══════════════════════════════════╝
  `);

  // 1. Initialize database (PostgreSQL if DATABASE_URL is set, otherwise SQLite)
  const databaseUrl = process.env.DATABASE_URL || "";
  await initDatabase(databaseUrl || undefined, "./data/rick.db");
  const dbBackend = isPostgres() ? "PostgreSQL" : "SQLite (./data/rick.db)";
  logger.info({ backend: dbBackend }, "Database: %s", dbBackend);

  // 2. Run migrations (creates tables in whichever backend is active)
  logger.info("Running database migrations...");
  await runMigrations();
  setHealthy("postgresConnected", true); // marks DB as ready (even if SQLite)
  logger.info("Database ready");

  // 3. Load config from database and merge with process.env
  await loadConfigFromStore();
  reloadConfig(); // Rebuild the config object with newly injected env vars
  logger.info("Config store loaded");

  // 3b. Run vector DB migrations now that VECTOR_DATABASE_URL may be available from config store
  await runPostConfigVectorMigrations();

  // 4. Validate config (after config store has injected values)
  validateConfig();
  logger.info("Configuration validated");

  // 5. Start HTTP server (health check + web UI + WebSocket)
  startHealthServer(config.webPort);

  // HEALTH_ONLY mode: used by deploy pipeline smoke test.
  // Starts health server + DB check only — no connectors, no agent.
  // This prevents conflicting with the running main container's WhatsApp session.
  const healthOnly = process.env.HEALTH_ONLY === "true";

  if (healthOnly) {
    // In HEALTH_ONLY mode, mark as ready and just keep running.
    // DB is already connected (postgresConnected=true from migration step above),
    // so isHealthy() returns true. No need to fake whatsappConnected.
    setHealthy("ready", true);
    logger.info("HEALTH_ONLY mode — skipping connectors and agent initialization");

    // Keep process alive
    const shutdown = async (signal: string) => {
      logger.info({ signal }, "Shutting down (HEALTH_ONLY)...");
      await closeDatabase();
      await closeVectorPool();
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    return;
  }

  // 6. Initialize services
  const memory = new MemoryService();
  const llm = new LLMService();

  // 7. Initialize vector memory if configured
  let vectorMemory: VectorMemoryService | undefined;
  let diskMonitor: DiskMonitor | undefined;
  if (config.vectorDatabaseUrl) {
    const embeddingService = new EmbeddingService();
    vectorMemory = new VectorMemoryService(embeddingService);
    setHealthy("pgvectorConnected", true);
    logger.info("Vector memory service initialized (pgvector)");

    // 7b. Start disk monitor for automatic eviction
    diskMonitor = new DiskMonitor(vectorMemory, {
      maxDbSizeBytes: config.vectorDbMaxSizeGb * 1024 * 1024 * 1024,
      intervalMs: config.diskCheckIntervalMinutes * 60 * 1000,
    });
    diskMonitor.start();
  } else {
    logger.info("Vector memory not configured (VECTOR_DATABASE_URL missing)");
  }

  // 8. Create services and Agent
  const userService = new UserService();
  const connectorManager = new ConnectorManager();
  const agent = new Agent(llm, memory, connectorManager, vectorMemory);

  // Kick off centralized sub-agent image warmup in background.
  // First sessions can then reuse the ready image instead of triggering a cold build.
  agent.warmupSubagentImage();

  // Warm up edit-mode image as well.
  // Edit mode is strict: if version changed, sessions wait for rebuild completion.
  EditSession.warmupImage();

  // Register services for the sub-agent read-only API (/api/agent/*)
  registerAgentApiServices(memory, vectorMemory);

  // Register session killer for the public sessions API
  registerSessionKiller((sessionId) => agent.killSession(sessionId));

  // Wire welcome message sender: UserService → ConnectorManager
  userService.setWelcomeSender(async (connector, externalId, text) => {
    const conn = connectorManager.get(connector);
    if (!conn) {
      throw new Error(`Connector "${connector}" não registrado`);
    }
    await conn.sendMessage(externalId, text);
  });

  // Wire ConnectorManager → Agent
  connectorManager.onMessage(async (msg) => agent.handleMessage(msg));
  connectorManager.onPollVote(async (userId, options) => {
    // Poll votes currently only come from WhatsApp. The connectorName is "whatsapp".
    // When more connectors support polls, we'll need to pass connectorName through the vote event.
    await agent.handlePollVote("whatsapp", userId, options);
  });

  logger.info("Agent initialized with ConnectorManager");

  // 8b. Clean up orphaned edit-session containers from previous runs
  EditSession.cleanupOrphans().catch((err) => {
    logger.warn({ err }, "Failed to clean up orphaned edit sessions on startup");
  });
  const stopReaper = EditSession.startReaper();

  // 9. Register connectors
  const whatsapp = new WhatsAppConnector(connectorManager, memory, userService);
  connectorManager.register(whatsapp);

  const web = new WebConnector(connectorManager);
  web.setWhatsAppConnector(whatsapp);
  web.setAgentBridge(agent.createWebBridge(web));
  web.setUserService(userService, memory);
  connectorManager.register(web);

  // Wire pending user notifications: WhatsApp → Web UI badge
  whatsapp.onPendingUser(() => {
    web.notifyPendingCount();
  });

  // 10. Start all connectors
  await connectorManager.startAll();

  // Mark the app as fully initialized (DB ready, config loaded, connectors started).
  // WhatsApp may still be reconnecting in the background — that's fine, it's optional.
  setHealthy("ready", true);
  logger.info("App fully initialized and ready");

  // 10b. Recover sub-agent sessions from containers that survived a restart
  agent.recoverOrphanedSessions().catch((err) => {
    logger.warn({ err }, "Failed to recover orphaned sub-agent sessions on startup");
  });

  // 10c. Periodic Docker cleanup — prevents disk from filling up with dangling images,
  // build cache, stopped containers, and stale tmp dirs.
  const DOCKER_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
  const STALE_SESSION_INTERVAL = 5 * 60 * 1000;   // 5 minutes
  const dockerCleanupTimer = setInterval(async () => {
    try {
      // Prune stopped containers (not edit-session — those are handled by the reaper)
      await execFileAsync("docker", ["container", "prune", "-f"], { timeout: 30_000 });
      // Prune dangling images (old subagent/edit/agent rebuilds)
      await execFileAsync("docker", ["image", "prune", "-f"], { timeout: 30_000 });
      // Prune build cache older than 24h
      await execFileAsync("docker", ["builder", "prune", "-f", "--filter", "until=24h"], { timeout: 30_000 });
      // Clean stale tmp dirs from failed deploys/imports
      await execFileAsync("sh", ["-c", "rm -rf /tmp/rick-update-* /tmp/rick-import-* /tmp/rick-publish-* 2>/dev/null || true"], { timeout: 10_000 });
      logger.info("Periodic Docker cleanup completed");
    } catch (err) {
      logger.warn({ err }, "Periodic Docker cleanup failed");
    }
  }, DOCKER_CLEANUP_INTERVAL);

  // Proactive stale session expiry — don't rely solely on incoming messages to trigger cleanup
  const staleSessionTimer = setInterval(() => {
    agent.expireStaleSessions().catch((err) => {
      logger.warn({ err }, "Proactive stale session expiry failed");
    });
  }, STALE_SESSION_INTERVAL);

  // 11. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    stopReaper();
    clearInterval(dockerCleanupTimer);
    clearInterval(staleSessionTimer);
    diskMonitor?.stop();
    await connectorManager.stopAll();
    await closeDatabase();
    await closeVectorPool();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception");
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "Unhandled rejection");
  });
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start");
  process.exit(1);
});
