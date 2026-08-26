#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/playwright-mcp-aws}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "${APP_DIR}"
docker compose --env-file "${ENV_FILE}" ps
docker compose --env-file "${ENV_FILE}" exec -T tunnel \
  wget -qO- http://127.0.0.1:8080/readyz >/dev/null
docker compose --env-file "${ENV_FILE}" exec -T playwright node - "${1:-1}" "${2:-60}" < "${SCRIPT_DIR}/mcp-smoke.cjs"
