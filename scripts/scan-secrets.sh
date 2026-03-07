#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "git is required for secret scan."
  exit 2
fi

tmp_file="$(mktemp)"
trap 'rm -f "$tmp_file"' EXIT

# Scan tracked files first. Ignore generated/runtime dirs only.
while IFS= read -r path; do
  case "$path" in
    data/*|node_modules/*)
      continue
      ;;
  esac
  echo "$path" >> "$tmp_file"
done < <(git ls-files)

if [[ ! -s "$tmp_file" ]]; then
  while IFS= read -r path; do
    rel="${path#./}"
    case "$rel" in
      data/*|node_modules/*|.git/*)
        continue
        ;;
    esac
    echo "$rel" >> "$tmp_file"
  done < <(find . -type f | sort)
fi

if [[ ! -s "$tmp_file" ]]; then
  echo "No files to scan."
  exit 0
fi

scan_patterns=(
  '(MQTT_PASSWORD|IMMICH_API_KEY|HA_TOKEN|BOOTSTRAP_TOKEN|COREVIEW_BOOTSTRAP_TOKEN|event_webhook_token)[[:space:]]*[:=][[:space:]]*[A-Za-z0-9._~+/\-]{8,}'
  '(api[_-]?key|secret|token|password)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9._~+/\-]{20,}'
  '(authorization|bearer)[[:space:]]*[:=][[:space:]]*["'"'"']?Bearer[[:space:]]+[A-Za-z0-9._~+/\-]{20,}'
  '(x-api-key|x-auth-token)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9._~+/\-]{20,}'
  '-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_\-]{35}'
  'ghp_[A-Za-z0-9]{36}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
)

scan_status=1
while IFS= read -r file_path; do
  for pattern in "${scan_patterns[@]}"; do
    if grep -nE "$pattern" "$file_path" >/dev/null 2>&1; then
      grep -nE "$pattern" "$file_path" || true
      scan_status=0
      break
    fi
  done
done < "$tmp_file"

if [[ "$scan_status" -eq 0 ]]; then
  echo
  echo "Potential secret values detected in tracked files."
  echo "Remove values or move them to untracked runtime configuration before commit."
  exit 1
fi

echo "Secret scan passed."
