import { validateConfig, config, reloadConfig } from "./config/env.js";
import { logger } from "./config/logger.js";
import { initDatabase, closeDatabase, isPostgres } from "./memory/database.js";
import { loadConfigFromStore } from "./memory/config-store.js";
import { runMigrations } from "./memory/migrate.js";
import { MemoryService } from "./memory/memory-service.js";
import { EmbeddingService } from "./memory/embedding-service.js";
import { VectorMemoryService } from "./memory/vector-memory-service.js";
import { DiskMonitor } from "./memory/disk-monitor.js";
import { LLMService } from "./llm/llm-service.js";
import { Agent } from "./agent.js";
import { ConnectorManager } from "./connectors/connector-manager.js";
import { WhatsAppConnector } from "./connectors/whatsapp.js";
import { WebConnector } from "./connectors/web.js";
import { closeVectorPool } from "./memory/vector-db.js";
import { EditSession } from "./subagent/edit-session.js";
import { startHealthServer, setHealthy, registerAgentApiServices } from "./health.js";

async function main() {
  console.log(`
  ╔══════════════════════════════════╗
  ║          RICK AI v2.1           ║
  ║   Assistente pessoal multi-canal ║
  ║   + Sub-agentes (Claude/Search) ║
  ║   + SQLite fallback             ║
  ╚══════════════════════════════════╝
  `);

  // 1. Initialize database (PostgreSQL if DATABASE_URL is set, otherwise SQLite)
  const databaseUrl = process.env.DATABASE_URL || "";
  await initDatabase(databaseUrl || undefined, "./data/rick.db");
  logger.info({ backend: isPostgres() ? "postgresql" : "sqlite" }, "Database backend initialized");

  // 2. Run migrations (creates tables in whichever backend is active)
  logger.info("Running database migrations...");
  await runMigrations();
  setHealthy("postgresConnected", true); // marks DB as ready (even if SQLite)
  logger.info("Database ready");

  // 3. Load config from database and merge with process.env
  await loadConfigFromStore();
  reloadConfig(); // Rebuild the config object with newly injected env vars
  logger.info("Config store loaded");

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
    // In HEALTH_ONLY mode, mark as healthy immediately and just keep running
    // (the health server is already listening — deploy pipeline will curl it)
    setHealthy("whatsappConnected", true); // fake it so /health returns "ok"
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

  // 8. Create ConnectorManager and Agent
  const connectorManager = new ConnectorManager();
  const agent = new Agent(llm, memory, connectorManager, vectorMemory);

  // Register services for the sub-agent read-only API (/api/agent/*)
  registerAgentApiServices(memory, vectorMemory);

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
  const whatsapp = new WhatsAppConnector(connectorManager, memory);
  connectorManager.register(whatsapp);

  const web = new WebConnector(connectorManager);
  web.setWhatsAppConnector(whatsapp);
  web.setAgentBridge(agent.createWebBridge(web));
  connectorManager.register(web);

  // 10. Start all connectors
  await connectorManager.startAll();

  // 10b. Recover sub-agent sessions from containers that survived a restart
  agent.recoverOrphanedSessions().catch((err) => {
    logger.warn({ err }, "Failed to recover orphaned sub-agent sessions on startup");
  });

  // 11. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");
    stopReaper();
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
