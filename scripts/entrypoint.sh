#!/bin/bash
# ============================================================================
# Rick AI — Container Entrypoint
#
# Manages the embedded PostgreSQL instance and handles automatic migration
# from SQLite to PostgreSQL when upgrading from older versions.
#
# Decision flow:
#   1. If DATABASE_URL is set in env → use external PostgreSQL (skip embedded)
#   2. If embedded PG has a config table with DATABASE_URL → export & use that
#   3. If /app/data/rick.db exists → migrate SQLite → embedded PG, then use PG
#   4. Otherwise → fresh install on embedded PG
#
# The embedded PostgreSQL data lives in /app/pgdata (must be on a volume).
# ============================================================================

set -euo pipefail

# Ensure PostgreSQL binaries are in PATH
export PATH="/usr/lib/postgresql/16/bin:$PATH"

PGDATA="/app/pgdata"
PGRUN="/var/run/postgresql"
PGLOG="/app/data/pg-startup.log"
EMBEDDED_DB="rick"
EMBEDDED_VECTOR_DB="rick_vectors"
EMBEDDED_URL="postgresql://rick@localhost:5432/${EMBEDDED_DB}"
EMBEDDED_VECTOR_URL="postgresql://rick@localhost:5432/${EMBEDDED_VECTOR_DB}"
SQLITE_DB="/app/data/rick.db"
SQLITE_MIGRATED="/app/data/rick.db.migrated"

log() { echo "[entrypoint] $(date '+%H:%M:%S') $*"; }
err() { echo "[entrypoint] ERROR: $*" >&2; }

# Run Node.js as the main process. If embedded PG is running, we can't use
# exec (which would replace the shell and lose the cleanup trap). Instead,
# run node in the foreground, forward signals, and wait.
run_node() {
  node dist/index.js &
  local node_pid=$!

  # Forward SIGTERM/SIGINT to node, then clean up PG
  trap "kill $node_pid 2>/dev/null; wait $node_pid 2>/dev/null; cleanup; exit 0" SIGTERM SIGINT

  wait "$node_pid"
  local exit_code=$?
  cleanup
  exit "$exit_code"
}

# ==================== EMBEDDED POSTGRESQL ====================

init_embedded_pg() {
  # Ensure the run directory exists (required by PostgreSQL)
  mkdir -p "$PGRUN"
  chown postgres:postgres "$PGRUN"

  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    log "Initializing embedded PostgreSQL database cluster..."
    mkdir -p "$PGDATA"
    chown postgres:postgres "$PGDATA"
    su - postgres -c "initdb -D '$PGDATA' --auth=trust --encoding=UTF8 --locale=C" > "$PGLOG" 2>&1

    # Configure for local-only connections, no network password required
    cat >> "$PGDATA/postgresql.conf" <<-CONF
listen_addresses = 'localhost'
max_connections = 20
shared_buffers = 64MB
work_mem = 4MB
maintenance_work_mem = 32MB
logging_collector = off
log_destination = 'stderr'
CONF

    # Allow local connections without password for all users
    cat > "$PGDATA/pg_hba.conf" <<-HBA
local   all   all   trust
host    all   all   127.0.0.1/32   trust
host    all   all   ::1/128        trust
HBA
    log "PostgreSQL cluster initialized"
  fi
}

start_embedded_pg() {
  log "Starting embedded PostgreSQL..."
  EMBEDDED_PG_STARTED=true
  su - postgres -c "pg_ctl -D '$PGDATA' -l '$PGLOG' -w start" > /dev/null 2>&1

  # Create the application user (idempotent)
  su - postgres -c "psql -c \"SELECT 1 FROM pg_roles WHERE rolname='rick'\" | grep -q 1 || psql -c \"CREATE USER rick WITH SUPERUSER\"" > /dev/null 2>&1

  # Create databases (idempotent)
  su - postgres -c "psql -lqt | cut -d'|' -f1 | grep -qw '${EMBEDDED_DB}' || createdb -O rick '${EMBEDDED_DB}'" > /dev/null 2>&1
  su - postgres -c "psql -lqt | cut -d'|' -f1 | grep -qw '${EMBEDDED_VECTOR_DB}' || createdb -O rick '${EMBEDDED_VECTOR_DB}'" > /dev/null 2>&1

  # Enable pgvector extension on the vector database
  su - postgres -c "psql -d '${EMBEDDED_VECTOR_DB}' -c 'CREATE EXTENSION IF NOT EXISTS vector'" > /dev/null 2>&1

  log "Embedded PostgreSQL is running"
}

stop_embedded_pg() {
  su - postgres -c "pg_ctl -D '$PGDATA' -m fast stop" > /dev/null 2>&1 || true
}

# ==================== SQLITE → POSTGRESQL MIGRATION ====================

migrate_sqlite_to_pg() {
  local target_url="$1"
  log "============================================"
  log "MIGRATING SQLite → PostgreSQL"
  log "Source: $SQLITE_DB"
  log "Target: $target_url"
  log "============================================"

  # Pre-flight: verify SQLite DB is readable
  if ! sqlite3 "$SQLITE_DB" "SELECT COUNT(*) FROM users;" > /dev/null 2>&1; then
    err "SQLite database is not readable or corrupted. Skipping migration."
    return 1
  fi

  # Use Node.js with better-sqlite3 + pg for the actual data migration.
  # This handles NULLs, booleans, column ordering, and type casting correctly.
  # Disable set -e temporarily so a migration failure doesn't abort the entrypoint.
  set +e
  node -e "
    const Database = require('better-sqlite3');
    const { Pool } = require('pg');

    const sqliteDb = new Database('$SQLITE_DB', { readonly: true });
    const pgPool = new Pool({ connectionString: '$target_url', max: 3 });

    const SKIP_TABLES = new Set(['migrations']);
    const BOOLEAN_COLS = { oauth_tokens: ['is_active'] };

    async function migrateTables() {
      const tables = sqliteDb.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'\").all().map(r => r.name);
      let totalSrc = 0, totalDest = 0;
      let allOk = true;

      for (const table of tables) {
        if (SKIP_TABLES.has(table)) { console.log('  ' + table + ': skipping'); continue; }
        const srcCount = sqliteDb.prepare('SELECT COUNT(*) as c FROM \"' + table + '\"').get().c;
        totalSrc += srcCount;
        if (srcCount === 0) { console.log('  ' + table + ': 0 rows (skipping)'); continue; }
        console.log('  ' + table + ': ' + srcCount + ' rows — migrating...');

        // Check table exists in PG
        try { await pgPool.query('SELECT 1 FROM \"' + table + '\" LIMIT 0'); }
        catch { console.error('  ' + table + ': does not exist in PG — skipping'); allOk = false; continue; }

        // Truncate
        await pgPool.query('TRUNCATE \"' + table + '\" CASCADE').catch(() => {});

        // Get column info from SQLite
        const cols = sqliteDb.pragma('table_info(\"' + table + '\")');
        const colNames = cols.map(c => c.name);
        const boolCols = new Set(BOOLEAN_COLS[table] || []);

        // Read all rows and insert in batches
        const rows = sqliteDb.prepare('SELECT * FROM \"' + table + '\"').all();
        const batchSize = 100;
        let inserted = 0;

        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const client = await pgPool.connect();
          try {
            await client.query('BEGIN');
            for (const row of batch) {
              const values = colNames.map((col, idx) => {
                let val = row[col];
                if (val === null || val === undefined) return null;
                if (boolCols.has(col)) return val === 1 || val === '1' || val === true;
                return val;
              });
              const placeholders = values.map((_, idx) => '\$' + (idx + 1));
              const sql = 'INSERT INTO \"' + table + '\" (\"' + colNames.join('\",\"') + '\") VALUES (' + placeholders.join(',') + ')';
              await client.query(sql, values);
              inserted++;
            }
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('  ' + table + ': batch insert failed: ' + err.message);
            allOk = false;
            break;
          } finally {
            client.release();
          }
        }

        // Verify count
        const destCount = (await pgPool.query('SELECT COUNT(*) as c FROM \"' + table + '\"')).rows[0].c;
        totalDest += parseInt(destCount);
        if (parseInt(destCount) === srcCount) {
          console.log('  ' + table + ': OK (' + destCount + ' rows)');
        } else {
          console.error('  ' + table + ': COUNT MISMATCH! Source=' + srcCount + ', Dest=' + destCount);
          allOk = false;
        }

        // Fix sequences
        try {
          const seqResult = await pgPool.query(
            \"SELECT pg_get_serial_sequence('\\\"\" + table + \"\\\"', a.attname) as seq, a.attname as col \" +
            \"FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \" +
            \"WHERE i.indrelid = '\\\"\" + table + \"\\\"'::regclass AND i.indisprimary LIMIT 1\"
          );
          if (seqResult.rows.length > 0 && seqResult.rows[0].seq) {
            await pgPool.query(\"SELECT setval('\" + seqResult.rows[0].seq + \"', COALESCE((SELECT MAX(\\\"\" + seqResult.rows[0].col + \"\\\") FROM \\\"\" + table + \"\\\"), 0) + 1, false)\");
          }
        } catch { /* no sequence for this table */ }
      }

      console.log('Migration totals: Source=' + totalSrc + ' rows, Dest=' + totalDest + ' rows');
      sqliteDb.close();
      await pgPool.end();
      process.exit(allOk && totalDest >= totalSrc ? 0 : 1);
    }

    migrateTables().catch(err => { console.error('Migration error:', err.message); process.exit(1); });
  "
  local migration_exit=$?
  set -e

  if [ "$migration_exit" -eq 0 ]; then
    log "Migration SUCCESSFUL — renaming SQLite DB to $SQLITE_MIGRATED"
    mv "$SQLITE_DB" "$SQLITE_MIGRATED"
    # Also move WAL/SHM files if they exist
    mv "${SQLITE_DB}-wal" "${SQLITE_MIGRATED}-wal" 2>/dev/null || true
    mv "${SQLITE_DB}-shm" "${SQLITE_MIGRATED}-shm" 2>/dev/null || true
    return 0
  else
    err "Migration had errors (exit code $migration_exit) — SQLite DB preserved at $SQLITE_DB"
    err "Please investigate and re-run migration manually."
    return 1
  fi
}

# ==================== CONFIG STORE CHECK ====================

# Read a config value from the embedded PostgreSQL config table.
# Returns empty string if not found.
read_pg_config() {
  local key="$1"
  local url="$2"
  psql -t "$url" -c "SELECT value FROM config WHERE key = '$key' LIMIT 1;" 2>/dev/null | tr -d ' \n' || echo ""
}

# Check if embedded PG has data (tables exist and have rows)
pg_has_data() {
  local url="$1"
  local count
  count=$(psql -t "$url" -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users';" 2>/dev/null | tr -d ' ')
  [ "${count:-0}" -gt 0 ] && {
    local user_count
    user_count=$(psql -t "$url" -c "SELECT COUNT(*) FROM users;" 2>/dev/null | tr -d ' ')
    [ "${user_count:-0}" -gt 0 ]
  }
}

# ==================== MAIN DECISION FLOW ====================

main() {
  # Ensure data directory exists (for logs and SQLite backup)
  mkdir -p /app/data

  # ------------------------------------------------------------------
  # CASE 1: DATABASE_URL is already in the environment
  # ------------------------------------------------------------------
  if [ -n "${DATABASE_URL:-}" ]; then
    log "DATABASE_URL is set in environment — using external PostgreSQL"
    # Still start embedded PG if VECTOR_DATABASE_URL is not set
    # (user might want vectors on embedded while main DB is external)
    if [ -z "${VECTOR_DATABASE_URL:-}" ]; then
      init_embedded_pg
      start_embedded_pg
      export VECTOR_DATABASE_URL="$EMBEDDED_VECTOR_URL"
      log "VECTOR_DATABASE_URL not set — using embedded PostgreSQL for vectors"
    fi
    run_node
  fi

  # ------------------------------------------------------------------
  # Check for migration marker file (left by a previous SQLite→external PG migration)
  # ------------------------------------------------------------------
  if [ -f "/app/data/.pg-config" ]; then
    log "Found migration marker file — loading external DB config"
    # shellcheck disable=SC1091
    . /app/data/.pg-config
    export DATABASE_URL VECTOR_DATABASE_URL
    log "DATABASE_URL from marker: ${DATABASE_URL:0:50}..."
    # Start embedded PG only if VECTOR_DATABASE_URL points to it
    if echo "${VECTOR_DATABASE_URL:-}" | grep -q "localhost"; then
      init_embedded_pg
      start_embedded_pg
    fi
    run_node
  fi

  # ------------------------------------------------------------------
  # No DATABASE_URL in env — we need the embedded PostgreSQL
  # ------------------------------------------------------------------
  init_embedded_pg
  start_embedded_pg

  # ------------------------------------------------------------------
  # CASE 2: Embedded PG has data and a config store with DATABASE_URL
  # ------------------------------------------------------------------
  if pg_has_data "$EMBEDDED_URL"; then
    local stored_db_url
    stored_db_url=$(read_pg_config "DATABASE_URL" "$EMBEDDED_URL")
    if [ -n "$stored_db_url" ]; then
      # Verify the external PG is reachable and has data before using it.
      # If it's empty/unreachable, fall back to embedded PG (which has the data).
      if pg_has_data "$stored_db_url"; then
        log "Found DATABASE_URL in embedded PG config store — external PG has data, using it"
        export DATABASE_URL="$stored_db_url"
        local stored_vector_url
        stored_vector_url=$(read_pg_config "VECTOR_DATABASE_URL" "$EMBEDDED_URL")
        if [ -n "$stored_vector_url" ]; then
          export VECTOR_DATABASE_URL="$stored_vector_url"
        elif [ -z "${VECTOR_DATABASE_URL:-}" ]; then
          export VECTOR_DATABASE_URL="$EMBEDDED_VECTOR_URL"
        fi
        run_node
      else
        log "WARNING: Config store has DATABASE_URL ($stored_db_url) but it has no data or is unreachable"
        log "Using embedded PostgreSQL which has the actual data"
      fi
    fi
    # PG has data but no external DATABASE_URL configured (or external is empty) — use embedded
    log "Embedded PostgreSQL has data — using it directly"
    export DATABASE_URL="$EMBEDDED_URL"
    if [ -z "${VECTOR_DATABASE_URL:-}" ]; then
      export VECTOR_DATABASE_URL="$EMBEDDED_VECTOR_URL"
    fi
    run_node
  fi

  # ------------------------------------------------------------------
  # CASE 3: SQLite DB exists — migrate to PostgreSQL
  # ------------------------------------------------------------------
  if [ -f "$SQLITE_DB" ]; then
    log "Found SQLite database at $SQLITE_DB"

    # Check if the SQLite config store has a DATABASE_URL configured.
    # If so, the user explicitly configured an external PG — migrate there.
    # Otherwise, migrate to the embedded PG.
    local configured_db_url
    configured_db_url=$(sqlite3 "$SQLITE_DB" "SELECT value FROM config WHERE key = 'DATABASE_URL' LIMIT 1;" 2>/dev/null || echo "")

    local migration_target_url
    local migration_target_label
    if [ -n "$configured_db_url" ]; then
      migration_target_url="$configured_db_url"
      migration_target_label="external PostgreSQL (from config store)"
      export DATABASE_URL="$configured_db_url"
      log "Config store has DATABASE_URL — will migrate to $migration_target_label"
    else
      migration_target_url="$EMBEDDED_URL"
      migration_target_label="embedded PostgreSQL"
      export DATABASE_URL="$EMBEDDED_URL"
      log "No DATABASE_URL in config store — will migrate to $migration_target_label"
    fi

    # Also check for VECTOR_DATABASE_URL in config store
    if [ -z "${VECTOR_DATABASE_URL:-}" ]; then
      local configured_vector_url
      configured_vector_url=$(sqlite3 "$SQLITE_DB" "SELECT value FROM config WHERE key = 'VECTOR_DATABASE_URL' LIMIT 1;" 2>/dev/null || echo "")
      if [ -n "$configured_vector_url" ]; then
        export VECTOR_DATABASE_URL="$configured_vector_url"
      else
        export VECTOR_DATABASE_URL="$EMBEDDED_VECTOR_URL"
      fi
    fi

    # In HEALTH_ONLY mode (deploy smoke test), skip the actual migration.
    # Just use the target PG and let Node.js create empty tables via migrations.
    # The real migration happens when the container starts for real (without HEALTH_ONLY).
    if [ "${HEALTH_ONLY:-}" = "true" ]; then
      log "HEALTH_ONLY mode — skipping SQLite migration (smoke test only)"
      run_node
    fi

    # Run Node.js in HEALTH_ONLY mode temporarily to execute migrations (create tables in target PG)
    log "Running migrations on $migration_target_label..."
    DATABASE_URL="$migration_target_url" VECTOR_DATABASE_URL="${VECTOR_DATABASE_URL}" HEALTH_ONLY=true \
      timeout 60 node dist/index.js &
    local node_pid=$!

    # Wait for health (migrations complete)
    local healthy=false
    for i in $(seq 1 30); do
      sleep 2
      if curl -sf http://localhost:80/health > /dev/null 2>&1; then
        healthy=true
        break
      fi
    done

    # Kill the temporary Node.js
    kill "$node_pid" 2>/dev/null || true
    wait "$node_pid" 2>/dev/null || true

    if [ "$healthy" = "true" ]; then
      # Now migrate data from SQLite to the target PG
      if migrate_sqlite_to_pg "$migration_target_url"; then
        # If we migrated to an EXTERNAL PG, save a marker file so the next restart
        # knows to use the external PG without needing to read the SQLite config store
        # (which has been renamed to .migrated).
        if [ "$migration_target_url" != "$EMBEDDED_URL" ]; then
          log "Saving external DB config to marker file for next restart..."
          cat > /app/data/.pg-config <<-MARKER
DATABASE_URL=$configured_db_url
VECTOR_DATABASE_URL=${configured_vector_url:-$EMBEDDED_VECTOR_URL}
MARKER
        fi
      fi
    else
      err "Failed to run migrations on $migration_target_label — SQLite preserved"
      err "Starting with $migration_target_label (empty or pre-existing)"
    fi

    run_node
  fi

  # ------------------------------------------------------------------
  # CASE 4: Fresh install — no SQLite, no data
  # ------------------------------------------------------------------
  log "Fresh install — using embedded PostgreSQL"
  export DATABASE_URL="$EMBEDDED_URL"
  if [ -z "${VECTOR_DATABASE_URL:-}" ]; then
    export VECTOR_DATABASE_URL="$EMBEDDED_VECTOR_URL"
  fi
  run_node
}

# Global flag to track if embedded PG was started (for cleanup on shutdown)
EMBEDDED_PG_STARTED=false

cleanup() {
  if [ "$EMBEDDED_PG_STARTED" = "true" ]; then
    log "Stopping embedded PostgreSQL..."
    stop_embedded_pg
  fi
}

trap 'cleanup; exit 0' SIGTERM SIGINT

main
