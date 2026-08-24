#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/playwright-mcp-aws}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
cd "${APP_DIR}"

docker compose --env-file "${ENV_FILE}" ps

echo "Checking tunnel readiness..."
docker compose --env-file "${ENV_FILE}" exec -T tunnel \
  wget -qO- http://127.0.0.1:8080/readyz >/dev/null

echo "Checking Playwright MCP tools and browser..."
docker compose --env-file "${ENV_FILE}" exec -T playwright node <<'NODE'
const endpoint = 'http://127.0.0.1:8931/mcp';
let sessionId = '';
let nextId = 1;

function decodeBody(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const data = trimmed.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(Boolean);
  return data.length ? JSON.parse(data[data.length - 1]) : null;
}

async function post(payload) {
  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  sessionId ||= response.headers.get('mcp-session-id') || '';
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return decodeBody(text);
}

async function request(method, params = {}) {
  const id = nextId++;
  const response = await post({ jsonrpc: '2.0', id, method, params });
  if (!response || response.id !== id) throw new Error(`Invalid MCP response for ${method}`);
  if (response.error) throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  return response.result;
}

(async () => {
  await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'playwright-mcp-aws-smoke', version: '1.0.0' },
  });
  await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  const tools = await request('tools/list');
  const names = new Set((tools.tools || []).map(t => t.name));
  for (const required of [
    'browser_navigate',
    'browser_take_screenshot',
    'browser_console_messages',
    'browser_network_requests',
  ]) {
    if (!names.has(required)) throw new Error(`missing tool: ${required}`);
  }

  await request('tools/call', {
    name: 'browser_navigate',
    arguments: { url: 'https://example.com' },
  });
  await request('tools/call', {
    name: 'browser_take_screenshot',
    arguments: { type: 'png', fullPage: true },
  });
  await request('tools/call', {
    name: 'browser_console_messages',
    arguments: { level: 'info', all: true },
  });
  await request('tools/call', {
    name: 'browser_network_requests',
    arguments: { static: false },
  });

  console.log(`OK: ${names.size} tools; navigation/screenshot/console/network passed.`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
NODE

echo "Smoke test passed."
