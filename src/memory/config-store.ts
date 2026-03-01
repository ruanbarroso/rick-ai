import { query } from "./database.js";
import { logger } from "../config/logger.js";

/**
 * Config store backed by the database (SQLite or PostgreSQL).
 *
 * Stores dynamic configuration that can be changed at runtime via the Web UI.
 * These values are persisted across restarts and take precedence over defaults,
 * but .env / process.env values take precedence over the config store.
 *
 * Priority (highest first):
 *   1. process.env (set in .env file or container env)
 *   2. config store (database)
 *   3. hardcoded defaults
 */

/**
 * Ensure the config table exists. Called during migrations.
 */
export async function ensureConfigTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS config (
      key VARCHAR(255) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

/**
 * Get a config value from the database.
 * Returns null if the key doesn't exist.
 */
export async function configGet(key: string): Promise<string | null> {
  const result = await query(
    "SELECT value FROM config WHERE key = $1",
    [key]
  );
  return result.rows.length > 0 ? result.rows[0].value : null;
}

/**
 * Set a config value in the database.
 * Creates the key if it doesn't exist, updates if it does.
 */
export async function configSet(key: string, value: string): Promise<void> {
  await query(
    `INSERT INTO config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = $3, updated_at = NOW()`,
    [key, value, value]
  );
  logger.info({ key }, "Config saved to database");
}

/**
 * Delete a config key from the database.
 */
export async function configDelete(key: string): Promise<boolean> {
  const result = await query(
    "DELETE FROM config WHERE key = $1",
    [key]
  );
  return result.rowCount > 0;
}

/**
 * Get all config values as a key-value map.
 */
export async function configGetAll(): Promise<Record<string, string>> {
  const result = await query("SELECT key, value FROM config");
  const map: Record<string, string> = {};
  for (const row of result.rows) {
    map[row.key] = row.value;
  }
  return map;
}

/**
 * Set multiple config values at once.
 */
export async function configSetMany(entries: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(entries)) {
    await configSet(key, value);
  }
}

/**
 * Mapping from settings UI keys to config store keys.
 * These are the keys used by the Web UI settings panel.
 */
export const SETTINGS_KEY_MAP: Record<string, string> = {
  geminiApiKey: "GEMINI_API_KEY",
  anthropicApiKey: "ANTHROPIC_API_KEY",
  openaiApiKey: "OPENAI_API_KEY",
  databaseUrl: "DATABASE_URL",
  vectorDatabaseUrl: "VECTOR_DATABASE_URL",
  devRepoUrl: "DEV_REPO_URL",
  webAuthPassword: "WEB_AUTH_PASSWORD",
  githubToken: "GITHUB_TOKEN",
};

/**
 * Load all config store values and merge with process.env defaults.
 * Returns a merged config object. process.env always takes precedence.
 *
 * This is called at startup after database init to populate runtime config.
 */
export async function loadConfigFromStore(): Promise<Record<string, string>> {
  try {
    const stored = await configGetAll();
    const merged: Record<string, string> = {};

    for (const [_uiKey, envKey] of Object.entries(SETTINGS_KEY_MAP)) {
      // Priority: process.env > config store > empty
      const envVal = process.env[envKey];
      const storeVal = stored[envKey];

      if (envVal) {
        merged[envKey] = envVal;
      } else if (storeVal) {
        merged[envKey] = storeVal;
        // Also inject into process.env so config reads pick it up
        process.env[envKey] = storeVal;
      }
    }

    const storeOnly = Object.keys(stored).filter(
      (k) => !Object.values(SETTINGS_KEY_MAP).includes(k) && !process.env[k]
    );
    for (const key of storeOnly) {
      merged[key] = stored[key];
      process.env[key] = stored[key];
    }

    logger.info(
      { fromStore: Object.keys(stored).length, merged: Object.keys(merged).length },
      "Config loaded from database"
    );

    return merged;
  } catch (err) {
    logger.warn({ err }, "Failed to load config from store (table may not exist yet)");
    return {};
  }
}
