#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/playwright-mcp-aws}"
DOCKER_COMPOSE_VERSION="${DOCKER_COMPOSE_VERSION:-v5.4.0}"
SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

: "${OPENAI_TUNNEL_ID:?OPENAI_TUNNEL_ID is required}"
: "${SSM_API_KEY_PARAMETER:?SSM_API_KEY_PARAMETER is required}"

PLAYWRIGHT_MCP_IMAGE="${PLAYWRIGHT_MCP_IMAGE:-mcr.microsoft.com/playwright/mcp:v0.0.75}"
TUNNEL_CLIENT_IMAGE="${TUNNEL_CLIENT_IMAGE:-ghcr.io/openai/tunnel-client@sha256:0f009d151bf346c629b1745e9b8b8c3f4b2e8e71e382c81b8719d2ddf33a912c}"
PLAYWRIGHT_DATA_DIR="${PLAYWRIGHT_DATA_DIR:-/var/lib/playwright-mcp-aws}"
LOG_LEVEL="${LOG_LEVEL:-info}"

if command -v dnf >/dev/null 2>&1; then
  dnf install -y docker jq
  if ! command -v curl >/dev/null 2>&1; then
    dnf install -y curl-minimal
  fi
elif command -v yum >/dev/null 2>&1; then
  yum install -y docker jq
  if ! command -v curl >/dev/null 2>&1; then
    yum install -y curl-minimal
  fi
else
  echo "This MVP bootstrap supports Amazon Linux (dnf/yum)." >&2
  exit 1
fi

systemctl enable --now docker

install -d -m 0755 /usr/local/lib/docker/cli-plugins
case "$(uname -m)" in
  aarch64|arm64) compose_arch="aarch64" ;;
  x86_64|amd64) compose_arch="x86_64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

compose_url="https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${compose_arch}"
curl -fsSL "${compose_url}" -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

install -d -m 0755 "${APP_DIR}"
install -m 0644 "${SOURCE_DIR}/docker-compose.yml" "${APP_DIR}/docker-compose.yml"
install -m 0755 "${SOURCE_DIR}/scripts/start.sh" "${APP_DIR}/start.sh"

# The official Playwright MCP image runs as the Node image's uid/gid 1000.
# Make the persistent EBS-backed bind mount writable without running MCP as root.
install -d -o 1000 -g 1000 -m 0700 "${PLAYWRIGHT_DATA_DIR}"

cat > "${APP_DIR}/.env" <<ENV
PLAYWRIGHT_MCP_IMAGE=${PLAYWRIGHT_MCP_IMAGE}
TUNNEL_CLIENT_IMAGE=${TUNNEL_CLIENT_IMAGE}
OPENAI_TUNNEL_ID=${OPENAI_TUNNEL_ID}
SSM_API_KEY_PARAMETER=${SSM_API_KEY_PARAMETER}
OPENAI_RUNTIME_API_KEY_FILE=/run/playwright-mcp-aws/openai_runtime_api_key
PLAYWRIGHT_DATA_DIR=${PLAYWRIGHT_DATA_DIR}
LOG_LEVEL=${LOG_LEVEL}
ENV
chmod 0600 "${APP_DIR}/.env"

cat > /etc/systemd/system/playwright-mcp-aws.service <<'UNIT'
[Unit]
Description=Playwright MCP + OpenAI Secure MCP Tunnel
Wants=network-online.target
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/playwright-mcp-aws
ExecStart=/opt/playwright-mcp-aws/start.sh
ExecReload=/opt/playwright-mcp-aws/start.sh
ExecStop=/usr/bin/docker compose --env-file /opt/playwright-mcp-aws/.env -f /opt/playwright-mcp-aws/docker-compose.yml down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable playwright-mcp-aws.service
systemctl restart playwright-mcp-aws.service
