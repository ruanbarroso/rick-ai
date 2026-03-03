#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="rick-ai"
SCRIPT_DIR="$(cd "$(dirname "$(realpath "$0")")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVICE_TEMPLATE="${SCRIPT_DIR}/${SERVICE_NAME}.service"
SYSTEMD_DIR="/etc/systemd/system"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.yml"

if [[ ! -f "$SERVICE_TEMPLATE" ]]; then
  echo "Error: ${SERVICE_TEMPLATE} not found"
  exit 1
fi

echo "Installing ${SERVICE_NAME} systemd service..."
echo "  Project dir: ${PROJECT_DIR}"

# Substitute working directory and install
sed "s|__WORKING_DIR__|${PROJECT_DIR}|g" "$SERVICE_TEMPLATE" \
  | sudo tee "${SYSTEMD_DIR}/${SERVICE_NAME}.service" > /dev/null

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"

# Stop docker compose if already running (hand off to systemd)
if docker compose -f "$COMPOSE_FILE" ps --quiet 2>/dev/null | grep -q .; then
  echo "Stopping existing docker compose stack (systemd will manage it now)..."
  docker compose -f "$COMPOSE_FILE" down
fi

sudo systemctl start "$SERVICE_NAME"

echo ""
echo "Done! Rick AI is now managed by systemd."
echo ""
echo "Commands:"
echo "  sudo systemctl status ${SERVICE_NAME}    # check status"
echo "  sudo systemctl stop ${SERVICE_NAME}      # stop"
echo "  sudo systemctl start ${SERVICE_NAME}     # start"
echo "  sudo systemctl restart ${SERVICE_NAME}   # restart"
echo "  sudo systemctl reload ${SERVICE_NAME}    # rebuild & restart"
echo "  journalctl -u ${SERVICE_NAME} -f         # follow logs"
echo ""
