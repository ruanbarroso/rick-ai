#!/bin/sh
#
# Safe deploy pipeline for Rick (rick-ai).
# Called by the OTA update/import detached containers in health.ts.
#
# Runs inside a docker:cli container (Alpine) with docker.sock mounted.
#
# Flow:
#   1. Backup current managed project tree (all non-artifact files)
#   2. Sync staged tree to project dir (all non-artifact files)
#   3. Build candidate image (includes tsc — if tsc fails, build fails)
#   4. Start candidate container in HEALTH_ONLY mode (no WhatsApp conflict)
#   5. Health check candidate via wget
#   6. If healthy: swap (stop current, promote candidate via docker compose)
#   7. Watchdog: monitor for 60s after swap
#   8. If unhealthy at any point: rollback
#
# Usage: deploy.sh <staging_dir>
#   staging_dir: directory containing the edited project tree
#
# Exit codes:
#   0 = success
#   1 = build failed (includes tsc errors)
#   2 = smoke test failed
#   3 = watchdog failed (rollback performed)
#   4 = rollback failed (CRITICAL)

set -eu

# PROJECT_DIR defaults to $HOME/rick-ai
PROJECT_DIR="${PROJECT_DIR:-$HOME/rick-ai}"
STAGING_DIR="${1:-}"
BACKUP_DIR="$PROJECT_DIR/.deploy-backup"
CANDIDATE_TAG="rick-ai-agent:candidate"
CANDIDATE_NAME="rick-ai-candidate"
HEALTH_PORT_CANDIDATE=8081
HEALTH_PORT_MAIN=80
COMPOSE_FILE="$PROJECT_DIR/docker-compose.yml"

log() { echo "[deploy] $(date '+%H:%M:%S') $*"; }
err() { echo "[deploy] ERROR: $*" >&2; }

# ==================== VALIDATION ====================

if [ -z "$STAGING_DIR" ]; then
  err "Usage: deploy.sh <staging_dir>"
  exit 1
fi

if [ ! -d "$STAGING_DIR/src" ]; then
  err "No src/ directory found in staging dir: $STAGING_DIR"
  exit 1
fi

# ==================== HELPERS ====================

is_preserved_path() {
  case "$1" in
    .|..|.git|node_modules|dist|auth_info|data|.deploy-backup|.env|.rick-latest-version.json)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

clear_managed_tree() {
  for p in "$PROJECT_DIR"/* "$PROJECT_DIR"/.[!.]* "$PROJECT_DIR"/..?*; do
    [ -e "$p" ] || continue
    base=$(basename "$p")
    if is_preserved_path "$base"; then
      continue
    fi
    rm -rf "$p"
  done
}

do_rollback() {
  log "Restoring from backup..."
  if [ ! -f "$BACKUP_DIR/project-managed.tar" ]; then
    err "Backup archive not found: $BACKUP_DIR/project-managed.tar"
    return 1
  fi
  clear_managed_tree
  tar -C "$PROJECT_DIR" -xf "$BACKUP_DIR/project-managed.tar"
  rm -rf "$BACKUP_DIR"
}

# ==================== STEP 1: BACKUP ====================

log "Step 1: Backing up managed project tree"
rm -rf "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
tar -C "$PROJECT_DIR" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=auth_info \
  --exclude=data \
  --exclude=.deploy-backup \
  --exclude=.env \
  --exclude=.rick-latest-version.json \
  -cf "$BACKUP_DIR/project-managed.tar" .
log "Backup created at $BACKUP_DIR"

# ==================== STEP 2: COPY STAGED FILES ====================

log "Step 2: Syncing staged tree to project dir"

# Keep only runtime artifacts in place, then extract all non-artifact staged files.
clear_managed_tree
tar -C "$STAGING_DIR" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude=dist \
  --exclude=auth_info \
  --exclude=data \
  --exclude=.deploy-backup \
  --exclude=.env \
  --exclude=.rick-latest-version.json \
  -cf - . | tar -C "$PROJECT_DIR" -xf -

log "Staged files applied"

# ==================== STEP 3: BUILD CANDIDATE ====================

# tsc runs as part of `npm run build` inside the Dockerfile.
# If TypeScript has errors, the Docker build fails here.
#
# Version priority:
#   1. STAGING_DIR/.rick-version — set by OTA update (has the real new SHA)
#   2. git — fallback when staging doesn't have .rick-version
#   3. PROJECT_DIR/.rick-version — last resort
#
# Mark directory as safe — deploy runs as root inside docker:cli but files
# belong to ubuntu, causing git "dubious ownership" errors.
if [ -f "$STAGING_DIR/.rick-version" ]; then
  COMMIT_SHA=$(head -1 "$STAGING_DIR/.rick-version" 2>/dev/null || echo "unknown")
  COMMIT_DATE=$(tail -1 "$STAGING_DIR/.rick-version" 2>/dev/null || echo "unknown")
elif command -v git >/dev/null 2>&1 && [ -d "$PROJECT_DIR/.git" ]; then
  git config --global --add safe.directory "$PROJECT_DIR" 2>/dev/null || true
  COMMIT_SHA=$(cd "$PROJECT_DIR" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")
  COMMIT_DATE=$(cd "$PROJECT_DIR" && git log -1 --format='%cI' 2>/dev/null || echo "unknown")
elif [ -f "$PROJECT_DIR/.rick-version" ]; then
  COMMIT_SHA=$(head -1 "$PROJECT_DIR/.rick-version" 2>/dev/null || echo "unknown")
  COMMIT_DATE=$(tail -1 "$PROJECT_DIR/.rick-version" 2>/dev/null || echo "unknown")
else
  COMMIT_SHA="unknown"
  COMMIT_DATE="unknown"
fi
log "Version: $COMMIT_SHA ($COMMIT_DATE)"

# Persist version to .rick-version so the Dockerfile can pick it up
# even when --build-arg is not provided (e.g. docker compose up --build)
printf '%s\n%s\n' "$COMMIT_SHA" "$COMMIT_DATE" > "$PROJECT_DIR/.rick-version"

log "Step 3: Building candidate image (includes tsc check)..."
if ! docker build --build-arg "COMMIT_SHA=$COMMIT_SHA" --build-arg "COMMIT_DATE=$COMMIT_DATE" -t "$CANDIDATE_TAG" -f "$PROJECT_DIR/Dockerfile" "$PROJECT_DIR" 2>&1; then
  err "Docker build failed (likely tsc errors)! Rolling back..."
  do_rollback
  exit 1
fi
log "Candidate image built: $CANDIDATE_TAG"

# ==================== STEP 4: SMOKE TEST CANDIDATE ====================

log "Step 4: Starting candidate container for smoke test (HEALTH_ONLY mode)..."

# Stop any leftover candidate container
docker rm -f "$CANDIDATE_NAME" 2>/dev/null || true

# Start candidate in HEALTH_ONLY mode: only health server + DB check, no WhatsApp.
# This avoids conflicting with the running main container's WhatsApp session.
docker run -d \
  --name "$CANDIDATE_NAME" \
  --env-file "$PROJECT_DIR/.env" \
  -e HEALTH_ONLY=true \
  -p "$HEALTH_PORT_CANDIDATE:80" \
  "$CANDIDATE_TAG"

log "Candidate container started in HEALTH_ONLY mode, waiting for health..."

# ==================== STEP 5: HEALTH CHECK CANDIDATE ====================

HEALTHY=false
i=1
while [ "$i" -le 20 ]; do
  sleep 3
  RESP=$(wget -qO- "http://localhost:$HEALTH_PORT_CANDIDATE/health" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    HEALTHY=true
    log "Candidate is healthy after ${i}x3s"
    break
  fi
  log "Health check attempt $i/20: $RESP"
  i=$((i + 1))
done

# Stop candidate container (it was just for testing)
docker rm -f "$CANDIDATE_NAME" 2>/dev/null || true

if [ "$HEALTHY" != "true" ]; then
  err "Candidate failed health check! Rolling back..."
  do_rollback
  # Clean up candidate image
  docker rmi "$CANDIDATE_TAG" 2>/dev/null || true
  exit 2
fi

log "Smoke test passed!"

# ==================== STEP 6: SWAP ====================

log "Step 6: Swapping — promoting candidate image..."

# Re-tag the candidate image as the image docker-compose expects.
# docker-compose.yml explicitly sets `image: rick-ai-agent:latest` so
# the image name is predictable and doesn't depend on the project directory name.
COMPOSE_IMAGE="rick-ai-agent:latest"
docker tag "$CANDIDATE_TAG" "$COMPOSE_IMAGE"
log "Tagged candidate as $COMPOSE_IMAGE"

# Restart the service using the pre-built image (no --build needed).
# IMPORTANT: we do NOT use --build here because the image is already built
# and smoke-tested. Using --build would rebuild from scratch, wasting time.
cd "$PROJECT_DIR"
docker compose -f "$COMPOSE_FILE" up -d --no-build 2>&1

log "Main service restarted with new code"

# Clean up candidate tag (the image is still referenced as $COMPOSE_IMAGE)
docker rmi "$CANDIDATE_TAG" 2>/dev/null || true

# ==================== STEP 7: WATCHDOG ====================

# Wait for the container to become healthy.
# /health returns "status":"ok" when the database is connected (PostgreSQL or SQLite).
# WhatsApp and pgvector are optional — they do NOT gate health status.
# The watchdog tolerates initial failures (container still starting up)
# and only fails if the server never responds healthily within the timeout.

log "Step 7: Watchdog — waiting up to 120s for healthy response..."

WATCH_OK=false
i=1
MAX_CHECKS=24  # 24 * 5s = 120s
while [ "$i" -le "$MAX_CHECKS" ]; do
  sleep 5
  RESP=$(wget -qO- "http://localhost:$HEALTH_PORT_MAIN/health" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    log "Watchdog check $i/$MAX_CHECKS: healthy"
    WATCH_OK=true
    # App is running. Continue monitoring for a few more checks to catch immediate crashes.
    STABLE_CHECKS=0
    while [ "$STABLE_CHECKS" -lt 3 ] && [ "$i" -le "$MAX_CHECKS" ]; do
      sleep 5
      i=$((i + 1))
      RESP=$(wget -qO- "http://localhost:$HEALTH_PORT_MAIN/health" 2>/dev/null || echo "")
      if echo "$RESP" | grep -q '"status":"ok"'; then
        STABLE_CHECKS=$((STABLE_CHECKS + 1))
        log "Watchdog stability check $STABLE_CHECKS/3: ok"
      else
        log "Watchdog stability check: app went down, retrying..."
        STABLE_CHECKS=0
        WATCH_OK=false
        break
      fi
    done
    if [ "$WATCH_OK" = "true" ]; then
      break
    fi
  else
    log "Watchdog check $i/$MAX_CHECKS: waiting... ($RESP)"
  fi
  i=$((i + 1))
done

if [ "$WATCH_OK" != "true" ]; then
  err "Watchdog: app never became healthy within ${MAX_CHECKS}x5s! Rolling back..."
  do_rollback

  # Rebuild with old code
  cd "$PROJECT_DIR"
  if docker compose -f "$COMPOSE_FILE" up -d --build 2>&1; then
    log "Rollback successful — old version restored"
    exit 3
  else
    err "CRITICAL: Rollback build also failed!"
    exit 4
  fi
fi

# ==================== SUCCESS ====================

log "Deploy successful! Cleaning up backup..."
rm -rf "$BACKUP_DIR"

# Clean up Docker garbage left by previous deploys (dangling images, old build cache).
# This runs in the background to not delay the deploy completion.
log "Cleaning up Docker garbage..."
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --keep-storage 200MB >/dev/null 2>&1 || true

log "Done. Rick is running with the new code."
exit 0
