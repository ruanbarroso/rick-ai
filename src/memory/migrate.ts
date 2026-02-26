import { query, isPostgres, closeDatabase } from "./database.js";
import { closeVectorPool } from "./vector-db.js";
import { runVectorMigrations } from "./vector-migrate.js";
import { ensureConfigTable } from "./config-store.js";
import { logger } from "../config/logger.js";

/**
 * Rebased migration — single clean schema for both SQLite and PostgreSQL.
 *
 * PostgreSQL uses native types (SERIAL, TIMESTAMPTZ, JSONB, GIN indexes).
 * SQLite gets adapted types via the database.ts abstraction layer.
 *
 * NOTE: Each statement must be executed individually because SQLite's
 * better-sqlite3 driver doesn't support multi-statement exec via prepare().
 * PostgreSQL supports multi-statement queries, but we keep them separate
 * for consistency and better error reporting.
 */

interface Migration {
  name: string;
  /** Individual SQL statements (executed one at a time) */
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    name: "001_rebased_schema",
    statements: [
      // Users table
      `CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        phone VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(255),
        is_owner BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // Memories table (things the agent remembers)
      `CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        user_phone VARCHAR(50) NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'general',
        key VARCHAR(255) NOT NULL,
        value TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_phone, category, key)
      )`,

      // Conversation history
      `CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        user_phone VARCHAR(50) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        model_used VARCHAR(100),
        tokens_used INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // Message tracking (WhatsApp message IDs)
      `CREATE TABLE IF NOT EXISTS message_log (
        id SERIAL PRIMARY KEY,
        wa_message_id VARCHAR(255) UNIQUE NOT NULL,
        author VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // OAuth tokens
      `CREATE TABLE IF NOT EXISTS oauth_tokens (
        id SERIAL PRIMARY KEY,
        user_phone VARCHAR(50) NOT NULL,
        provider VARCHAR(50) NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expires_at BIGINT NOT NULL,
        scopes JSONB DEFAULT '[]',
        account_email VARCHAR(255),
        org_name VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_phone, provider)
      )`,

      // Config store (dynamic runtime configuration)
      `CREATE TABLE IF NOT EXISTS config (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,

      // Indexes — memories
      `CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_phone)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(user_phone, category)`,
      // GIN full-text index (PostgreSQL only — silently skipped on SQLite via adaptSqlForSqlite)
      `CREATE INDEX IF NOT EXISTS idx_memories_search ON memories USING GIN(to_tsvector('portuguese', key || ' ' || value))`,

      // Indexes — conversations
      `CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_phone, created_at DESC)`,

      // Indexes — message_log
      `CREATE INDEX IF NOT EXISTS idx_message_log_wa_id ON message_log(wa_message_id)`,

      // Indexes — oauth_tokens
      `CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user_provider ON oauth_tokens(user_phone, provider)`,
    ],
  },
  {
    name: "002_session_messages",
    statements: [
      `CREATE TABLE IF NOT EXISTS session_messages (
        id SERIAL PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_session_messages_sid ON session_messages(session_id, created_at ASC)`,
    ],
  },
  {
    name: "003_audio_blobs",
    statements: [
      // Audio blobs table — stores raw audio data for playback
      `CREATE TABLE IF NOT EXISTS audio_blobs (
        id VARCHAR(32) PRIMARY KEY,
        data BYTEA NOT NULL,
        mime_type VARCHAR(50) NOT NULL DEFAULT 'audio/webm',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      // Add audio_url column to conversations for persisting audio references
      `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS audio_url VARCHAR(255)`,
    ],
  },
  {
    name: "004_image_url",
    statements: [
      `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS image_url VARCHAR(255)`,
    ],
  },
  {
    name: "005_message_type",
    statements: [
      `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS message_type VARCHAR(50) DEFAULT 'text'`,
    ],
  },
  {
    name: "006_session_messages_message_type",
    statements: [
      `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(50) DEFAULT 'text'`,
    ],
  },
  {
    name: "007_session_messages_media",
    statements: [
      `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS audio_url VARCHAR(500)`,
      `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS image_urls TEXT`,
    ],
  },
];

export async function runMigrations(): Promise<void> {
  // Ensure migrations table exists
  await query(`
    CREATE TABLE IF NOT EXISTS migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Check if legacy migrations exist (from pre-rebased schema).
  // If they do, it means the DB already has all tables — just register the rebased
  // migration as applied and add the new config table.
  const legacyCheck = await query(
    "SELECT name FROM migrations WHERE name = $1",
    ["001_initial"]
  );
  const hasLegacy = legacyCheck.rows.length > 0;

  if (hasLegacy) {
    // DB was created by old migration system. Check if rebased is already registered.
    const rebasedCheck = await query(
      "SELECT name FROM migrations WHERE name = $1",
      ["001_rebased_schema"]
    );
    if (rebasedCheck.rows.length === 0) {
      logger.info("Legacy migrations detected — registering rebased schema and adding config table");
      // Only add the new config table (all other tables already exist)
      await ensureConfigTable();
      await query(
        "INSERT INTO migrations (name) VALUES ($1)",
        ["001_rebased_schema"]
      );
    }
  }

  // Run all migrations that haven't been applied yet.
  // This handles both fresh databases (runs everything) and legacy databases
  // (001_rebased_schema already registered, but newer migrations like 002_* need to run).
  for (const migration of MIGRATIONS) {
    const existing = await query(
      "SELECT name FROM migrations WHERE name = $1",
      [migration.name]
    );

    if (existing.rows.length === 0) {
      logger.info({ migration: migration.name }, "Applying migration");

      for (const stmt of migration.statements) {
        try {
          await query(stmt);
        } catch (err: any) {
          // Tolerate "already exists" errors for idempotency
          const msg = err.message || "";
          if (msg.includes("already exists") || msg.includes("duplicate")) {
            logger.warn({ stmt: stmt.substring(0, 60) }, "Skipping already-existing object");
          } else {
            throw err;
          }
        }
      }

      await query("INSERT INTO migrations (name) VALUES ($1)", [migration.name]);
      logger.info({ migration: migration.name }, "Migration applied");
    }
  }

  // Ensure config table exists (idempotent — safe to call always)
  await ensureConfigTable();

  // Run vector DB migrations (separate database — only if vectorDatabaseUrl is set)
  await runVectorMigrations();
}

// Compatibility: mark old migrations as applied if the new rebased one is present.
// This handles the case where the DB already has data from the old 001/002/003 migrations.
export async function markLegacyMigrationsAsApplied(): Promise<void> {
  const legacyNames = ["001_initial", "002_message_tracking", "003_oauth_tokens"];
  for (const name of legacyNames) {
    await query(
      `INSERT INTO migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [name]
    );
  }
}
