#!/usr/bin/env node
'use strict';

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_ENDPOINT = 'http://mcp-proxy:8931/mcp';

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function decodeBody(text, id) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const messages = trimmed.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => JSON.parse(line.slice(5).trim()));
  return messages.find(message => message.id === id) || null;
}

function createClient(endpoint, fetchImpl = fetch) {
  let sessionId = '';
  let nextId = 1;
  async function post(payload) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000),
    });
    sessionId ||= response.headers.get('mcp-session-id') || '';
    const text = await response.text();
    if (!response.ok) throw new Error(`${payload.method}: HTTP ${response.status}`);
    return decodeBody(text, payload.id);
  }
  return {
    async request(method, params = {}) {
      const id = nextId++;
      const response = await post({ jsonrpc: '2.0', id, method, params });
      if (!response || response.id !== id) throw new Error(`Invalid MCP response for ${method}`);
      if (response.error) throw new Error(`${method}: JSON-RPC error ${response.error.code}`);
      if (response.result?.isError) throw new Error(`${params.name || method}: MCP tool returned isError`);
      if (!response.result) throw new Error(`${method}: missing result`);
      return response.result;
    },
    notify(method) { return post({ jsonrpc: '2.0', method }); },
    async close() {
      if (!sessionId) return;
      await fetchImpl(endpoint, {
        method: 'DELETE', headers: { 'mcp-session-id': sessionId }, signal: AbortSignal.timeout(10000),
      });
    },
  };
}

function reaperCode(idleMs) {
  return `async (page) => {
    const context = page.context();
    const now = Date.now();
    const initKey = Symbol.for('chatgpt.playwright.tab-reaper.init-v1');
    const activityKeyName = 'chatgpt.playwright.tab-reaper.activity-v1';
    const installActivity = () => {
      const key = Symbol.for('chatgpt.playwright.tab-reaper.activity-v1');
      if (globalThis[key]) return;
      const state = { lastActivity: Date.now() };
      Object.defineProperty(globalThis, key, { value: state, configurable: false });
      const touch = () => { state.lastActivity = Date.now(); };
      const passive = { capture: true, passive: true };
      for (const type of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'input', 'change', 'submit'])
        addEventListener(type, touch, passive);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); }, true);
    };

    if (!context[initKey]) {
      await context.addInitScript(installActivity);
      context[initKey] = true;
    }

    const records = [];
    for (const candidate of context.pages()) {
      if (candidate.isClosed()) continue;
      let lastActivity = now;
      let protectedReason = null;
      try {
        await candidate.evaluate(installActivity);
        lastActivity = await candidate.evaluate(name => {
          const state = globalThis[Symbol.for(name)];
          return state && Number.isFinite(state.lastActivity) ? state.lastActivity : Date.now();
        }, activityKeyName);
      } catch {
        // Browser-internal and otherwise non-evaluable pages are kept rather than guessed stale.
        protectedReason = 'uninspectable';
      }
      let title = '';
      try { title = await candidate.title(); } catch {}
      records.push({ page: candidate, url: candidate.url(), title, lastActivity, protectedReason });
    }

    const stale = records
      .filter(record => !record.protectedReason && now - record.lastActivity >= ${idleMs})
      .sort((a, b) => a.lastActivity - b.lastActivity);
    const closed = [];
    const failures = [];
    for (const record of stale) {
      if (context.pages().length <= 1) break;
      try {
        await record.page.close({ runBeforeUnload: false });
        closed.push({ url: record.url, title: record.title, idleMs: now - record.lastActivity });
      } catch (error) {
        failures.push({ url: record.url, error: String(error && error.message || error) });
      }
    }

    return {
      time: new Date(now).toISOString(),
      idleMs: ${idleMs},
      before: records.length,
      stale: stale.length,
      closedCount: closed.length,
      after: context.pages().length,
      closed,
      protectedCount: records.filter(record => record.protectedReason).length,
      failures,
    };
  }`;
}

function parseToolSummary(result) {
  const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  const match = text.match(/### Result\s*\n(\{[^\n]*\})/);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

async function sweep(endpoint, idleMs, fetchImpl = fetch) {
  const client = createClient(endpoint, fetchImpl);
  try {
    await client.request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'playwright-mcp-tab-reaper', version: '1.0.0' },
    });
    await client.notify('notifications/initialized');
    const list = await client.request('tools/list');
    if (!(list.tools || []).some(tool => tool.name === 'browser_run_code_unsafe'))
      throw new Error('Missing tool: browser_run_code_unsafe');
    const result = await client.request('tools/call', {
      name: 'browser_run_code_unsafe', arguments: { code: reaperCode(idleMs) },
    });
    return parseToolSummary(result);
  } finally {
    await client.close().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const endpoint = process.env.TAB_REAPER_MCP_URL || DEFAULT_ENDPOINT;
  const idleMs = positiveInteger(process.env.TAB_REAPER_IDLE_MS, DEFAULT_IDLE_MS, 'TAB_REAPER_IDLE_MS');
  const intervalMs = positiveInteger(process.env.TAB_REAPER_INTERVAL_MS, DEFAULT_INTERVAL_MS, 'TAB_REAPER_INTERVAL_MS');
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });

  while (!stopping) {
    const started = Date.now();
    try {
      const summary = await sweep(endpoint, idleMs);
      console.log(JSON.stringify({
        time: new Date().toISOString(), status: 'passed', idleMs, intervalMs,
        ...(summary || {}),
      }));
    } catch (error) {
      console.error(JSON.stringify({
        time: new Date().toISOString(), status: 'error', idleMs, intervalMs,
        error: String(error && error.message || error),
      }));
    }
    const remaining = intervalMs - (Date.now() - started);
    if (!stopping && remaining > 0) await sleep(remaining);
  }
}

module.exports = {
  DEFAULT_ENDPOINT, DEFAULT_IDLE_MS, DEFAULT_INTERVAL_MS, positiveInteger,
  decodeBody, createClient, reaperCode, parseToolSummary, sweep,
};

if (require.main === module)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
