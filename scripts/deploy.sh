#!/bin/sh
#
# Safe deploy pipeline for Rick (rick-ai).
# Called by edit-session.ts after Claude Code edits source code.
#
# Runs inside a docker:cli container (Alpine) with docker.sock mounted.
#
# Flow:
#   1. Backup current src/
#   2. Copy edited src from staging area
#   3. Build candidate image (includes tsc — if tsc fails, build fails)
#   4. Start candidate container in HEALTH_ONLY mode (no WhatsApp conflict)
#   5. Health check candidate via wget
#   6. If healthy: swap (stop current, promote candidate via docker compose)
#   7. Watchdog: monitor for 60s after swap
#   8. If unhealthy at any point: rollback
#
# Usage: deploy.sh <staging_dir>
#   staging_dir: directory containing the edited src/ files
#
# Exit codes:
#   0 = success
#   1 = build failed (includes tsc errors)
#   2 = smoke test failed
#   3 = watchdog failed (rollback performed)
#   4 = rollback failed (CRITICAL)

set -eu

# PROJECT_DIR can be passed as env var from edit-session.ts, fallback to $HOME/rick-ai
PROJECT_DIR="${PROJECT_DIR:-$HOME/rick-ai}"
STAGING_DIR="${1:-}"
BACKUP_DIR="$PROJECT_DIR/src.bak"
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

# ==================== STEP 1: BACKUP ====================

log "Step 1: Backing up current src/ to src.bak/"
rm -rf "$BACKUP_DIR"
cp -r "$PROJECT_DIR/src" "$BACKUP_DIR"
log "Backup created at $BACKUP_DIR"

# ==================== STEP 2: COPY STAGED FILES ====================

log "Step 2: Copying staged files to src/"
cp -r "$STAGING_DIR/src/"* "$PROJECT_DIR/src/"
log "Staged files applied"

# ==================== STEP 3: BUILD CANDIDATE ====================

# tsc runs as part of `npm run build` inside the Dockerfile.
# If TypeScript has errors, the Docker build fails here.
# Extract version info from git (if available) or from .rick-version file
if command -v git >/dev/null 2>&1 && [ -d "$PROJECT_DIR/.git" ]; then
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

log "Step 3: Building candidate image (includes tsc check)..."
if ! docker build --build-arg "COMMIT_SHA=$COMMIT_SHA" --build-arg "COMMIT_DATE=$COMMIT_DATE" -t "$CANDIDATE_TAG" -f "$PROJECT_DIR/Dockerfile" "$PROJECT_DIR" 2>&1; then
  err "Docker build failed (likely tsc errors)! Rolling back..."
  rm -rf "$PROJECT_DIR/src"
  cp -r "$BACKUP_DIR" "$PROJECT_DIR/src"
  rm -rf "$BACKUP_DIR"
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
  rm -rf "$PROJECT_DIR/src"
  cp -r "$BACKUP_DIR" "$PROJECT_DIR/src"
  rm -rf "$BACKUP_DIR"
  # Clean up candidate image
  docker rmi "$CANDIDATE_TAG" 2>/dev/null || true
  exit 2
fi

log "Smoke test passed!"

# ==================== STEP 6: SWAP ====================

log "Step 6: Swapping — promoting candidate image..."

# Re-tag the candidate image as the image docker-compose expects.
# This avoids rebuilding the image a second time — the candidate was already
# built and smoke-tested in steps 3-5.
COMPOSE_IMAGE="rick-ai-agent:latest"
docker tag "$CANDIDATE_TAG" "$COMPOSE_IMAGE"

# Restart the service using the pre-built image (no --build needed)
cd "$PROJECT_DIR"
docker compose -f "$COMPOSE_FILE" up -d 2>&1

log "Main service restarted with new code"

# Clean up candidate tag (the image is still referenced as $COMPOSE_IMAGE)
docker rmi "$CANDIDATE_TAG" 2>/dev/null || true

# ==================== STEP 7: WATCHDOG ====================

log "Step 7: Watchdog — monitoring for 60s..."

WATCH_OK=true
i=1
while [ "$i" -le 12 ]; do
  sleep 5
  RESP=$(wget -qO- "http://localhost:$HEALTH_PORT_MAIN/health" 2>/dev/null || echo "")
  if echo "$RESP" | grep -q '"status":"ok"'; then
    log "Watchdog check $i/12: healthy"
  else
    err "Watchdog check $i/12 FAILED: $RESP"
    WATCH_OK=false
    break
  fi
  i=$((i + 1))
done

if [ "$WATCH_OK" != "true" ]; then
  err "Watchdog detected failure! Rolling back..."
  rm -rf "$PROJECT_DIR/src"
  cp -r "$BACKUP_DIR" "$PROJECT_DIR/src"
  rm -rf "$BACKUP_DIR"

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
log "Done. Rick is running with the new code."
exit 0
