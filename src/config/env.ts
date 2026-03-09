import dotenv from "dotenv";
dotenv.config();

/**
 * Runtime configuration.
 *
 * Values are read from process.env (which can be populated by .env file,
 * container env, or injected from the config store at startup).
 *
 * The config store (database) injects values into process.env before this
 * object is constructed, so all sources are unified.
 *
 * Note: This object is constructed once at module load time.
 * Call `reloadConfig()` after the config store loads to refresh values.
 */

export let config = buildConfig();

function buildConfig() {
  return {
    // LLM Providers
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || "",
      model: process.env.GEMINI_MODEL || "gemini-3-flash-preview",
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY || "",
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      model: process.env.OPENAI_MODEL || "gpt-5.3-codex",
    },
    // Database
    /** PostgreSQL connection string. If empty, Rick uses SQLite. */
    databaseUrl: process.env.DATABASE_URL || "",
    vectorDatabaseUrl: process.env.VECTOR_DATABASE_URL || "",

    // WhatsApp
    ownerPhone: process.env.OWNER_PHONE || "",

    // Agent
    agentName: process.env.AGENT_NAME || "Rick",
    agentLanguage: process.env.AGENT_LANGUAGE || "pt-BR",
    maxMemoryItems: parseInt(process.env.MAX_MEMORY_ITEMS || "1000"),
    conversationHistoryLimit: parseInt(
      process.env.CONVERSATION_HISTORY_LIMIT || "20"
    ),

    // Disk monitor (pgvector eviction)
    /** Max vector DB size in GB before eviction starts. Default: 36 (80% of 45GB) */
    vectorDbMaxSizeGb: parseFloat(process.env.VECTOR_DB_MAX_SIZE_GB || "36"),
    /** Check interval in minutes. Default: 10 */
    diskCheckIntervalMinutes: parseInt(process.env.DISK_CHECK_INTERVAL_MINUTES || "10"),

    // Web UI
    /** Port for the HTTP + WebSocket server (web UI + health). Default: 80 */
    webPort: parseInt(process.env.WEB_PORT || "80"),
    /** Password for web UI authentication. Required for web connector to start. */
    webAuthPassword: process.env.WEB_AUTH_PASSWORD || "",
    /** Public base URL for session links (e.g. https://rick.barroso.tec.br). No trailing slash. */
    webBaseUrl: (process.env.WEB_BASE_URL || "").replace(/\/$/, ""),
  } as const;
}

/**
 * Reload the config object from process.env.
 * Call this after the config store has injected values into process.env.
 */
export function reloadConfig(): void {
  config = buildConfig();
}

export function validateConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!config.gemini.apiKey) {
    errors.push("GEMINI_API_KEY é obrigatório. Sem ele o chat não funciona.");
  }
  if (!config.webAuthPassword) {
    warnings.push("WEB_AUTH_PASSWORD not set — Web UI will be disabled");
  }
  if (!process.env.MEMORY_ENCRYPTION_KEY) {
    warnings.push("MEMORY_ENCRYPTION_KEY not set — credentials stored as plaintext");
  }

  for (const w of warnings) {
    console.warn(`[config] ${w}`);
  }
  if (errors.length > 0) {
    throw new Error(
      `Configuration errors:\n${errors.map((e) => `  - ${e}`).join("\n")}\n\nFix these in your .env file or run: bash scripts/setup.sh`
    );
  }
}
