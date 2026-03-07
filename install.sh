#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed or not in PATH."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose plugin is required."
  exit 1
fi

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
  if [[ -f "$SCRIPT_DIR/.env.example" ]]; then
    cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
    echo "Created .env from .env.example"
    echo "Review .env if you need to adjust HOST_PORT or bootstrap values, then rerun ./install.sh"
    exit 1
  fi
  echo "Error: missing .env and .env.example"
  exit 1
fi

if ! grep -q '^COREVIEW_BOOTSTRAP_TOKEN=' "$SCRIPT_DIR/.env"; then
  echo "COREVIEW_BOOTSTRAP_TOKEN=" >> "$SCRIPT_DIR/.env"
fi

BOOTSTRAP_TOKEN_VALUE="$(grep -E '^COREVIEW_BOOTSTRAP_TOKEN=' "$SCRIPT_DIR/.env" 2>/dev/null | tail -n 1 | cut -d'=' -f2- | tr -d '[:space:]')"
if [[ -z "$BOOTSTRAP_TOKEN_VALUE" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    BOOTSTRAP_TOKEN_VALUE="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=' | cut -c1-24)"
  else
    BOOTSTRAP_TOKEN_VALUE="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=' | cut -c1-24)"
  fi
  if [[ -n "$BOOTSTRAP_TOKEN_VALUE" ]]; then
    sed -i "s/^COREVIEW_BOOTSTRAP_TOKEN=.*/COREVIEW_BOOTSTRAP_TOKEN=$BOOTSTRAP_TOKEN_VALUE/" "$SCRIPT_DIR/.env"
  fi
fi

mkdir -p "$SCRIPT_DIR/data"

echo "Starting CoreView with Docker..."
cd "$SCRIPT_DIR"
docker compose up -d --build

HOST_PORT_VALUE="$(grep -E '^HOST_PORT=' "$SCRIPT_DIR/.env" 2>/dev/null | tail -n 1 | cut -d'=' -f2- | tr -d '[:space:]')"
if [[ -z "$HOST_PORT_VALUE" ]]; then
  HOST_PORT_VALUE="3210"
fi

echo
echo "CoreView should be available at:"
echo "  http://localhost:${HOST_PORT_VALUE}/system"
if [[ -n "${BOOTSTRAP_TOKEN_VALUE:-}" ]]; then
  echo
  echo "Bootstrap token (required on first setup):"
  echo "  ${BOOTSTRAP_TOKEN_VALUE}"
fi
echo
echo "If this host is remote, replace localhost with the host IP or DNS name."
