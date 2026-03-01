import { query, isPostgres, closeDatabase } from "./database.js";
import { closeVectorPool } from "./vector-db.js";
import { runVectorMigrations, backfillVectorCreatedBy } from "./vector-migrate.js";
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
  {
    name: "008_file_infos",
    statements: [
      // Generic file attachments metadata (JSON array of {url, name, mimeType})
      `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS file_infos TEXT`,
      `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS file_infos TEXT`,
    ],
  },

  // ==================== RBAC Migrations ====================

  {
    name: "009_rbac_schema",
    statements: [
      // -- 1. New columns on users table --
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT NULL`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS profile JSONB DEFAULT '{}'`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ`,

      // Make phone nullable — new RBAC users are identified by connector_identities,
      // not phone. Legacy users still have phone populated.
      // PostgreSQL: ALTER COLUMN ... DROP NOT NULL
      // SQLite: no-op (can't alter column constraints; handled via placeholder in app code)
      `ALTER TABLE users ALTER COLUMN phone DROP NOT NULL`,

      // -- 2. connector_identities table --
      `CREATE TABLE IF NOT EXISTS connector_identities (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        connector VARCHAR(50) NOT NULL,
        external_id VARCHAR(255) NOT NULL,
        display_name VARCHAR(255),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(connector, external_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ci_user ON connector_identities(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ci_lookup ON connector_identities(connector, external_id)`,

      // -- 3. sub_agent_sessions table --
      `CREATE TABLE IF NOT EXISTS sub_agent_sessions (
        id VARCHAR(64) PRIMARY KEY,
        user_id INTEGER NOT NULL,
        task TEXT,
        status VARCHAR(20) DEFAULT 'active',
        started_at TIMESTAMPTZ DEFAULT NOW(),
        ended_at TIMESTAMPTZ
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sas_user ON sub_agent_sessions(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sas_status ON sub_agent_sessions(user_id, status)`,

      // -- 4. Add user_id and created_by to existing tables --
      `ALTER TABLE memories ADD COLUMN IF NOT EXISTS user_id INTEGER`,
      `ALTER TABLE memories ADD COLUMN IF NOT EXISTS created_by INTEGER`,
      `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id INTEGER`,
      `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS user_id INTEGER`,
      `ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS user_id INTEGER`,

      // -- 5. New indexes --
      `CREATE INDEX IF NOT EXISTS idx_conversations_uid ON conversations(user_id, created_at DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_uid ON memories(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_memories_created_by ON memories(created_by)`,
    ],
  },

  {
    name: "010_rbac_data_migration",
    statements: [
      // Migrate existing data: everything belongs to the admin (owner).
      // Step 1: Set the existing owner user to role='admin', status='active'
      // Use is_owner = TRUE (PostgreSQL boolean); SQLite adapter converts to = 1
      `UPDATE users SET role = 'admin', status = 'active', display_name = name WHERE is_owner = TRUE`,

      // Step 2: Create connector_identity for the admin's WhatsApp
      // Uses INSERT ... SELECT to avoid failing if no owner exists (fresh installs)
      `INSERT INTO connector_identities (user_id, connector, external_id, display_name)
       SELECT id, 'whatsapp', phone, name FROM users WHERE role = 'admin'
       ON CONFLICT (connector, external_id) DO NOTHING`,

      // Step 3: Populate user_id in existing tables based on user_phone -> users.phone
      `UPDATE memories SET user_id = (SELECT id FROM users WHERE users.phone = memories.user_phone), created_by = (SELECT id FROM users WHERE users.phone = memories.user_phone) WHERE user_id IS NULL AND user_phone IS NOT NULL`,
      `UPDATE conversations SET user_id = (SELECT id FROM users WHERE users.phone = conversations.user_phone) WHERE user_id IS NULL AND user_phone IS NOT NULL`,
      `UPDATE oauth_tokens SET user_id = (SELECT id FROM users WHERE users.phone = oauth_tokens.user_phone) WHERE user_id IS NULL AND user_phone IS NOT NULL`,
    ],
  },

  {
    name: "011_rbac_memory_global",
    // This migration needs backend-specific SQL — handled in code below.
    // PostgreSQL: ALTER TABLE DROP CONSTRAINT (can't DROP INDEX on constraint-backing index)
    // SQLite: skip DROP (inline UNIQUE can't be dropped; old constraint is a superset, harmless)
    statements: [], // populated dynamically in runMigrations()
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

  // Populate dynamic migration statements that depend on the backend.
  const m011 = MIGRATIONS.find((m) => m.name === "011_rbac_memory_global");
  if (m011 && m011.statements.length === 0) {
    if (isPostgres()) {
      m011.statements = [
        // PostgreSQL: drop the UNIQUE constraint (ALTER TABLE, not DROP INDEX,
        // because the index backs a constraint and can't be dropped directly).
        `ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_user_phone_category_key_key`,

        // Deduplicate (category, key) pairs before creating the global unique index.
        // The old constraint was UNIQUE(user_phone, category, key), so different
        // user_phone values could produce duplicates on (category, key) alone.
        // Keep the most recently updated row for each (category, key) pair.
        `DELETE FROM memories WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (
               PARTITION BY category, key
               ORDER BY updated_at DESC NULLS LAST, id DESC
             ) AS rn
             FROM memories
           ) ranked WHERE rn > 1
         )`,

        `CREATE UNIQUE INDEX IF NOT EXISTS memories_category_key_unique ON memories(category, key)`,
      ];
    } else {
      // SQLite: can't drop inline UNIQUE constraints. The old constraint is a
      // superset of the new one — harmless. Just add the new unique index.
      // Deduplicate first, same logic but SQLite-compatible syntax.
      m011.statements = [
        `DELETE FROM memories WHERE id NOT IN (
           SELECT MIN(id) FROM memories GROUP BY category, key
         )`,
        `CREATE UNIQUE INDEX IF NOT EXISTS memories_category_key_unique ON memories(category, key)`,
      ];
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
          logger.debug(
            { migration: migration.name, stmt: stmt.substring(0, 120) },
            "Executing migration statement"
          );
          await query(stmt);
        } catch (err: any) {
          // Tolerate "already exists" errors for idempotency
          const msg = err.message || "";
          if (msg.includes("already exists") || msg.includes("duplicate")) {
            logger.warn({ stmt: stmt.substring(0, 60) }, "Skipping already-existing object");
          } else {
            logger.error(
              { migration: migration.name, stmt: stmt.substring(0, 200), err },
              "Migration statement failed"
            );
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

  // ==================== ADMIN BOOTSTRAP ====================
  // Admin is a unique Web UI-only user with no phone number.
  // On fresh installs (or if admin was accidentally deleted), create one.
  const existingAdmin = await query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existingAdmin.rows.length === 0) {
    await query(
      `INSERT INTO users (phone, display_name, role, status, is_owner) VALUES ('', 'Admin', 'admin', 'active', TRUE)`
    );
    logger.info("Bootstrap: created admin user for fresh install");
  }

  // Backfill created_by in vector DB embeddings with the admin user ID.
  // Must run after both main DB migrations (where admin is identified) and vector migrations.
  const adminRow = await query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (adminRow.rows.length > 0) {
    await backfillVectorCreatedBy(adminRow.rows[0].id);
  }
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
