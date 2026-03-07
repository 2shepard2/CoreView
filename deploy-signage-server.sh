#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONTAINER_HELPER="$ROOT_DIR/scripts/update/container-helper.sh"

TARGET_LXC="${1:-110}"
TARGET_IP="${2:-192.168.1.35}"
REMOTE_DIR="/opt/signage-server"

if [[ ! -x "$CONTAINER_HELPER" ]]; then
  echo "Error: missing $CONTAINER_HELPER"
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  if [[ -f "$SCRIPT_DIR/.env.example" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    echo "Created $SCRIPT_DIR/.env from .env.example"
    echo "Review HOST_PORT/bootstrap/proxy settings if needed, then rerun."
    exit 1
  fi
fi

echo "Preparing remote directory in LXC $TARGET_LXC ($TARGET_IP)..."
ssh -o ConnectTimeout=10 root@"$TARGET_IP" "mkdir -p '$REMOTE_DIR/server/public'"

echo "Copying deployment files to LXC $TARGET_LXC..."
scp -o ConnectTimeout=10 "$SCRIPT_DIR/docker-compose.yml" root@"$TARGET_IP":"$REMOTE_DIR/docker-compose.yml"
scp -o ConnectTimeout=10 "$SCRIPT_DIR/.env" root@"$TARGET_IP":"$REMOTE_DIR/.env"
scp -o ConnectTimeout=10 "$SCRIPT_DIR/server/package.json" root@"$TARGET_IP":"$REMOTE_DIR/server/package.json"
scp -o ConnectTimeout=10 "$SCRIPT_DIR/server/Dockerfile" root@"$TARGET_IP":"$REMOTE_DIR/server/Dockerfile"
scp -o ConnectTimeout=10 "$SCRIPT_DIR/server/server.js" root@"$TARGET_IP":"$REMOTE_DIR/server/server.js"
scp -o ConnectTimeout=10 "$SCRIPT_DIR/server/public/index.html" root@"$TARGET_IP":"$REMOTE_DIR/server/public/index.html"
scp -o ConnectTimeout=10 "$SCRIPT_DIR/server/public/dashboard.html" root@"$TARGET_IP":"$REMOTE_DIR/server/public/dashboard.html"

echo "Starting signage-server stack..."
ssh -o ConnectTimeout=10 root@"$TARGET_IP" "cd '$REMOTE_DIR' && docker compose up -d --build"

echo "Done. Validate with:"
echo "  ssh root@$TARGET_IP \"cd $REMOTE_DIR && docker compose ps\""
