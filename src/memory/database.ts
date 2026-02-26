import { Pool, PoolClient } from "pg";
import { logger } from "../config/logger.js";

/**
 * Unified database abstraction layer.
 *
 * Supports two backends:
 *   - PostgreSQL (via pg Pool) — used when DATABASE_URL is set
 *   - SQLite (via better-sqlite3) — fallback when no DATABASE_URL
 *
 * All consumers call `query()` and `transaction()` from this module.
 * The active backend is determined at init time and cannot change without restart.
 *
 * SQLite compatibility:
 *   - $1, $2 placeholders are rewritten to ?1, ?2
 *   - SERIAL → INTEGER PRIMARY KEY AUTOINCREMENT
 *   - TIMESTAMPTZ → TEXT (ISO strings)
 *   - ILIKE → LIKE (SQLite is case-insensitive by default for ASCII)
 *   - JSONB → TEXT (stored as JSON strings)
 *   - ON CONFLICT ... DO UPDATE uses SQLite's UPSERT syntax (same)
 *   - RETURNING * is supported in SQLite >= 3.35 (better-sqlite3 bundles >= 3.43)
 *   - GIN indexes and ts_vector are skipped silently
 *
 * Query result format (pg-compatible):
 *   { rows: any[], rowCount: number }
 */

// ==================== Types ====================

export interface QueryResult {
  rows: any[];
  rowCount: number;
}

type Backend = "pg" | "sqlite";

// ==================== State ====================

let backend: Backend | null = null;
let pgPool: Pool | null = null;
let sqliteDb: any = null; // better-sqlite3 Database instance

// ==================== Initialization ====================

/**
 * Initialize the database backend.
 * Call this once at startup before any queries.
 *
 * @param databaseUrl - PostgreSQL connection string, or empty/undefined for SQLite
 * @param sqlitePath  - Path for the SQLite file (default: ./data/rick.db)
 */
export async function initDatabase(
  databaseUrl?: string,
  sqlitePath: string = "./data/rick.db"
): Promise<void> {
  if (backend) {
    logger.warn("Database already initialized");
    return;
  }

  if (databaseUrl) {
    // PostgreSQL backend
    pgPool = new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: false,
    });

    pgPool.on("error", (err) => {
      logger.error({ err }, "Unexpected pg pool error");
    });

    // Test connection
    const client = await pgPool.connect();
    client.release();

    backend = "pg";
    logger.info("Database initialized: PostgreSQL");
  } else {
    // SQLite backend
    const { default: Database } = await import("better-sqlite3");
    const { mkdirSync } = await import("node:fs");
    const { dirname } = await import("node:path");

    // Ensure directory exists
    mkdirSync(dirname(sqlitePath), { recursive: true });

    sqliteDb = new Database(sqlitePath);

    // Performance pragmas
    sqliteDb.pragma("journal_mode = WAL");
    sqliteDb.pragma("synchronous = NORMAL");
    sqliteDb.pragma("cache_size = -64000"); // 64MB
    sqliteDb.pragma("foreign_keys = ON");

    backend = "sqlite";
    logger.info({ path: sqlitePath }, "Database initialized: SQLite");
  }
}

// ==================== Query ====================

/**
 * Execute a SQL query. Works with both pg and SQLite.
 *
 * For pg: uses $1, $2 parameter syntax (native).
 * For SQLite: rewrites $N → ?N, adapts SQL syntax.
 */
export async function query(text: string, params?: any[]): Promise<QueryResult> {
  if (!backend) throw new Error("Database not initialized. Call initDatabase() first.");

  if (backend === "pg") {
    const client = await pgPool!.connect();
    try {
      const result = await client.query(text, params);
      return { rows: result.rows, rowCount: result.rowCount || 0 };
    } finally {
      client.release();
    }
  }

  // SQLite
  return sqliteQuery(text, params);
}

/**
 * Execute a transaction.
 *
 * For pg: uses BEGIN/COMMIT/ROLLBACK with a PoolClient.
 * For SQLite: uses better-sqlite3's transaction() wrapper.
 */
export async function transaction<T>(
  fn: (queryFn: (text: string, params?: any[]) => Promise<QueryResult>) => Promise<T>
): Promise<T> {
  if (!backend) throw new Error("Database not initialized. Call initDatabase() first.");

  if (backend === "pg") {
    const client = await pgPool!.connect();
    try {
      await client.query("BEGIN");
      const queryFn = async (text: string, params?: any[]): Promise<QueryResult> => {
        const result = await client.query(text, params);
        return { rows: result.rows, rowCount: result.rowCount || 0 };
      };
      const result = await fn(queryFn);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // SQLite transaction
  const sqliteTxn = sqliteDb.transaction(() => {
    // This is synchronous in better-sqlite3 — we can't use async inside.
    // We'll handle this differently.
  });

  // For SQLite, we wrap in BEGIN/COMMIT manually since the fn is async
  sqliteDb.exec("BEGIN");
  try {
    const queryFn = async (text: string, params?: any[]): Promise<QueryResult> => {
      return sqliteQuery(text, params);
    };
    const result = await fn(queryFn);
    sqliteDb.exec("COMMIT");
    return result;
  } catch (err) {
    sqliteDb.exec("ROLLBACK");
    throw err;
  }
}

// ==================== Close ====================

export async function closeDatabase(): Promise<void> {
  if (backend === "pg" && pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (backend === "sqlite" && sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  backend = null;
}

// ==================== Utilities ====================

/**
 * Get the current backend type.
 */
export function getBackend(): Backend | null {
  return backend;
}

/**
 * Check if using PostgreSQL.
 */
export function isPostgres(): boolean {
  return backend === "pg";
}

/**
 * Get the raw pg Pool (for pg-specific operations like LISTEN/NOTIFY).
 * Returns null if not using pg.
 */
export function getPgPool(): Pool | null {
  return pgPool;
}

// ==================== SQLite Internals ====================

/**
 * Adapt a PostgreSQL query to SQLite syntax and execute it.
 */
function sqliteQuery(text: string, params?: any[]): QueryResult {
  let sql = adaptSqlForSqlite(text);
  const adaptedParams = adaptParamsForSqlite(params);

  // Determine if this is a read or write query
  const trimmed = sql.trimStart().toUpperCase();
  const isSelect = trimmed.startsWith("SELECT") || trimmed.startsWith("WITH");
  const hasReturning = /\bRETURNING\b/i.test(sql);

  try {
    if (isSelect) {
      const stmt = sqliteDb.prepare(sql);
      const rows = stmt.all(...(adaptedParams || []));
      return { rows, rowCount: rows.length };
    }

    if (hasReturning) {
      const stmt = sqliteDb.prepare(sql);
      const rows = stmt.all(...(adaptedParams || []));
      return { rows, rowCount: rows.length };
    }

    // Write query (INSERT, UPDATE, DELETE) without RETURNING
    const stmt = sqliteDb.prepare(sql);
    const result = stmt.run(...(adaptedParams || []));
    return { rows: [], rowCount: result.changes };
  } catch (err: any) {
    // If the error is about a missing table/column, return empty result
    // for CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
    if (
      trimmed.startsWith("CREATE TABLE IF NOT EXISTS") ||
      trimmed.startsWith("CREATE INDEX IF NOT EXISTS") ||
      trimmed.startsWith("CREATE EXTENSION")
    ) {
      return { rows: [], rowCount: 0 };
    }
    // Enrich the error with the adapted SQL to ease debugging
    logger.debug(
      { adaptedSql: sql.substring(0, 200), err },
      "sqliteQuery failed"
    );
    throw err;
  }
}

/**
 * Adapt PostgreSQL SQL to SQLite-compatible SQL.
 */
function adaptSqlForSqlite(sql: string): string {
  let adapted = sql;

  // Replace $N placeholders with ?N (for positional params), but ONLY outside
  // single-quoted string literals.  The alternation matches a complete
  // single-quoted SQL string first (returned unchanged) so that occurrences of
  // $N inside literals such as DEFAULT '$1_prefix' or CHECK (col LIKE '$1%')
  // are NOT converted into ?N parameter slots.  If they were converted, SQLite
  // would see no unquoted '?' placeholders (sqlite3_bind_parameter_count → 0)
  // while better-sqlite3 still counted the arguments, triggering:
  //   RangeError: Too many parameter values were provided
  //
  // SQL standard single-quote escaping: '' (two consecutive single-quotes)
  // represents a literal single-quote inside a string — handled by |'' in the
  // character class so the regex does not exit the literal prematurely.
  adapted = adapted.replace(/'(?:[^']|'')*'|\$(\d+)/g, (match, pN) => {
    // pN is defined only when the \$(\d+) branch matched (outside a string).
    return pN !== undefined ? `?${pN}` : match;
  });

  // SERIAL → INTEGER PRIMARY KEY AUTOINCREMENT
  // Handle "id SERIAL PRIMARY KEY" pattern
  adapted = adapted.replace(
    /(\w+)\s+SERIAL\s+PRIMARY\s+KEY/gi,
    "$1 INTEGER PRIMARY KEY AUTOINCREMENT"
  );

  // TIMESTAMPTZ → TEXT
  adapted = adapted.replace(/\bTIMESTAMPTZ\b/gi, "TEXT");

  // JSONB → TEXT
  adapted = adapted.replace(/\bJSONB\b/gi, "TEXT");

  // VARCHAR(N) → TEXT (SQLite doesn't enforce length)
  adapted = adapted.replace(/\bVARCHAR\s*\(\d+\)/gi, "TEXT");

  // BOOLEAN → INTEGER (SQLite uses 0/1)
  adapted = adapted.replace(/\bBOOLEAN\b/gi, "INTEGER");

  // DEFAULT NOW() → DEFAULT (datetime('now'))
  adapted = adapted.replace(/\bDEFAULT\s+NOW\(\)/gi, "DEFAULT (datetime('now'))");

  // Standalone NOW() → datetime('now') (used in INSERT/UPDATE values)
  adapted = adapted.replace(/\bNOW\(\)/gi, "datetime('now')");

  // ILIKE → LIKE (SQLite LIKE is case-insensitive for ASCII)
  adapted = adapted.replace(/\bILIKE\b/gi, "LIKE");

  // Remove PostgreSQL-specific GIN indexes
  if (/CREATE\s+INDEX.*USING\s+GIN/i.test(adapted)) {
    return "SELECT 1"; // no-op
  }

  // Remove ts_vector-based indexes
  if (/to_tsvector/i.test(adapted) && /CREATE\s+INDEX/i.test(adapted)) {
    return "SELECT 1"; // no-op
  }

  // Replace full-text search queries with simple LIKE
  // to_tsvector(...) @@ plainto_tsquery(...) → column LIKE '%term%'
  // This is handled in memory-service.ts by checking getBackend()

  // DEFAULT TRUE → DEFAULT 1, DEFAULT FALSE → DEFAULT 0
  adapted = adapted.replace(/\bDEFAULT\s+TRUE\b/gi, "DEFAULT 1");
  adapted = adapted.replace(/\bDEFAULT\s+FALSE\b/gi, "DEFAULT 0");

  // BIGINT → INTEGER (SQLite has no BIGINT, but INTEGER handles big values)
  adapted = adapted.replace(/\bBIGINT\b/gi, "INTEGER");

  // BYTEA → BLOB (PostgreSQL binary type → SQLite native blob type)
  adapted = adapted.replace(/\bBYTEA\b/gi, "BLOB");

  // CREATE EXTENSION → no-op
  if (/^\s*CREATE\s+EXTENSION/i.test(adapted)) {
    return "SELECT 1";
  }

  // Remove IF NOT EXISTS from ALTER TABLE (SQLite doesn't support it the same way)
  // "ADD COLUMN IF NOT EXISTS" → need special handling
  if (/ALTER\s+TABLE.*ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i.test(adapted)) {
    // SQLite 3.35+ supports ADD COLUMN but not IF NOT EXISTS syntax
    // We'll handle this via try/catch in the caller
    adapted = adapted.replace(/\bIF\s+NOT\s+EXISTS\b/gi, "");
  }

  // HNSW index → no-op
  if (/USING\s+hnsw/i.test(adapted)) {
    return "SELECT 1";
  }

  // vector(...) type → TEXT
  adapted = adapted.replace(/\bvector\s*\(\d+\)/gi, "TEXT");

  // pg_database_size → return 0
  if (/pg_database_size/i.test(adapted)) {
    return "SELECT 0 as size_bytes";
  }

  // $N::vector → ?N (remove type cast)
  adapted = adapted.replace(/\?(\d+)::vector/gi, "?$1");

  // ANY($N) → needs special handling in SQLite (not supported natively)
  // We'll handle this in callers that use it

  return adapted;
}

/**
 * Adapt parameters for SQLite (convert JS types to SQLite-compatible values).
 */
function adaptParamsForSqlite(params?: any[]): any[] | undefined {
  if (!params) return undefined;

  return params.map((p) => {
    if (p === true) return 1;
    if (p === false) return 0;
    if (p === null || p === undefined) return null;
    if (typeof p === "object" && !(p instanceof Buffer)) {
      // JSON objects → stringify
      return JSON.stringify(p);
    }
    return p;
  });
}
