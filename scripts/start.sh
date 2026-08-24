#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/playwright-mcp-aws}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
RUNTIME_DIR="${RUNTIME_DIR:-/run/playwright-mcp-aws}"

if [[ ! -r "${ENV_FILE}" ]]; then
  echo "missing ${ENV_FILE}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

: "${SSM_API_KEY_PARAMETER:?SSM_API_KEY_PARAMETER is required}"
: "${OPENAI_TUNNEL_ID:?OPENAI_TUNNEL_ID is required}"

install -d -m 0700 "${RUNTIME_DIR}"
secret_file="${RUNTIME_DIR}/openai_runtime_api_key"

aws ssm get-parameter \
  --name "${SSM_API_KEY_PARAMETER}" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text > "${secret_file}"
chmod 0600 "${secret_file}"

export OPENAI_RUNTIME_API_KEY_FILE="${secret_file}"
cd "${APP_DIR}"

docker compose --env-file "${ENV_FILE}" pull
docker compose --env-file "${ENV_FILE}" up -d --remove-orphans

docker compose --env-file "${ENV_FILE}" ps
