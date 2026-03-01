import { vectorQuery, closeVectorPool } from "./vector-db.js";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import { EmbeddingService } from "./embedding-service.js";

const VECTOR_MIGRATIONS = [
  {
    name: "001_embeddings",
    sql: `
      -- Ensure pgvector extension is enabled
      CREATE EXTENSION IF NOT EXISTS vector;

      -- Migrations tracking for vector DB
      CREATE TABLE IF NOT EXISTS vector_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Main embeddings table
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        category VARCHAR(100) NOT NULL DEFAULT 'conversation',
        source VARCHAR(50) NOT NULL DEFAULT 'auto',
        embedding vector(${EmbeddingService.DIMENSIONS}) NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Indexes for filtering
      CREATE INDEX IF NOT EXISTS idx_embeddings_category ON memory_embeddings(category);
      CREATE INDEX IF NOT EXISTS idx_embeddings_created ON memory_embeddings(created_at DESC);

      -- HNSW index for fast cosine similarity search
      CREATE INDEX IF NOT EXISTS idx_embeddings_vector ON memory_embeddings
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64);
    `,
  },
  {
    name: "002_hit_count",
    sql: `
      ALTER TABLE memory_embeddings
        ADD COLUMN IF NOT EXISTS hit_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_hit_at TIMESTAMPTZ;

      CREATE INDEX IF NOT EXISTS idx_embeddings_hit_count
        ON memory_embeddings(hit_count ASC, created_at ASC);
    `,
  },
  {
    name: "003_rbac_created_by",
    sql: `
      ALTER TABLE memory_embeddings
        ADD COLUMN IF NOT EXISTS created_by INTEGER;
    `,
    // NOTE: Backfilling created_by with the admin user ID is done in
    // backfillVectorCreatedBy() (called from runMigrations) because the
    // vector DB is a separate database and can't reference the users table.
  },
  {
    name: "004_drop_user_phone",
    sql: `
      DROP INDEX IF EXISTS idx_embeddings_user;
      ALTER TABLE memory_embeddings DROP COLUMN IF EXISTS user_phone;
    `,
  },
];

/**
 * Backfill created_by in memory_embeddings with the admin's user ID.
 * Called from runMigrations() AFTER main DB migrations (where the admin user
 * has been identified) and vector migrations have run.
 *
 * This is a separate function because the vector DB can't reference the
 * main DB's users table directly.
 */
export async function backfillVectorCreatedBy(adminUserId: number): Promise<void> {
  if (!config.vectorDatabaseUrl) return;

  try {
    const result = await vectorQuery(
      `UPDATE memory_embeddings SET created_by = $1 WHERE created_by IS NULL`,
      [adminUserId]
    );
    if ((result.rowCount ?? 0) > 0) {
      logger.info(
        { adminUserId, updated: result.rowCount },
        "Backfilled created_by in memory_embeddings"
      );
    }
  } catch (err) {
    logger.warn({ err }, "Failed to backfill created_by in vector DB (non-fatal)");
  }
}

export async function runVectorMigrations(): Promise<void> {
  if (!config.vectorDatabaseUrl) {
    logger.info("VECTOR_DATABASE_URL not configured, skipping vector migrations");
    return;
  }

  // Ensure migrations table exists
  await vectorQuery(`
    CREATE TABLE IF NOT EXISTS vector_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  for (const migration of VECTOR_MIGRATIONS) {
    const existing = await vectorQuery(
      "SELECT name FROM vector_migrations WHERE name = $1",
      [migration.name]
    );

    if (existing.rows.length === 0) {
      logger.info({ migration: migration.name }, "Applying vector migration");
      await vectorQuery(migration.sql);
      await vectorQuery("INSERT INTO vector_migrations (name) VALUES ($1)", [
        migration.name,
      ]);
      logger.info({ migration: migration.name }, "Vector migration applied");
    }
  }
}
