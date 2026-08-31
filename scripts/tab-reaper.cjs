#!/usr/bin/env node
'use strict';

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_ENDPOINT = 'http://mcp-proxy:8931/mcp';
const SUMMARY_FIELDS = ['before', 'stale', 'closedCount', 'after', 'protectedCount', 'failureCount', 'remainingStale'];

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function decodeBody(text, id) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);

  const messages = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data) messages.push(JSON.parse(data));
  }
  return messages.find(message => message && message.id === id) || null;
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
    async notify(method, params = {}) {
      const response = await post({ jsonrpc: '2.0', method, params });
      if (response?.error) throw new Error(`${method}: JSON-RPC error ${response.error.code}`);
      if (response?.result?.isError) throw new Error(`${method}: MCP tool returned isError`);
      return response;
    },
    async close() {
      if (!sessionId) return;
      const response = await fetchImpl(endpoint, {
        method: 'DELETE', headers: { 'mcp-session-id': sessionId }, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`MCP session close: HTTP ${response.status}`);
      sessionId = '';
    },
  };
}

function reaperCode(idleMs) {
  return `async (page) => {
    const context = page.context();
    const now = Date.now();
    const lockKey = Symbol.for('chatgpt.playwright.tab-reaper.lock-v1');
    const initKey = Symbol.for('chatgpt.playwright.tab-reaper.init-v2');
    const activityKeyName = 'chatgpt.playwright.tab-reaper.activity-v2';
    const installActivity = () => {
      const key = Symbol.for('chatgpt.playwright.tab-reaper.activity-v2');
      if (globalThis[key]) return;
      const state = { lastActivity: Date.now() };
      Object.defineProperty(globalThis, key, { value: state, configurable: false });
      const touch = () => { state.lastActivity = Date.now(); };
      const passive = { capture: true, passive: true };
      for (const type of [
        'pointerdown', 'pointerup', 'pointermove', 'touchstart', 'touchmove', 'keydown',
        'beforeinput', 'input', 'change', 'submit', 'wheel', 'pageshow', 'popstate', 'hashchange',
      ]) addEventListener(type, touch, passive);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) touch(); }, true);
    };

    const previous = context[lockKey] || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    const queued = Promise.resolve(previous).catch(() => {}).then(() => current);
    try {
      Object.defineProperty(context, lockKey, { value: queued, configurable: true });
    } catch {
      // Some host objects are not extensible; the last-tab check still applies.
    }
    await previous.catch(() => {});

    try {
      let install = context[initKey];
      if (!install) {
        const pending = context.addInitScript(installActivity);
        try {
          Object.defineProperty(context, initKey, { value: pending, configurable: true });
        } catch {
          // The page-level symbol makes repeated registration harmless if needed.
        }
        install = pending;
      }
      try {
        await install;
      } catch (error) {
        try {
          if (context[initKey] === install) delete context[initKey];
        } catch {}
        throw error;
      }

      const records = [];
      for (const candidate of context.pages()) {
        if (candidate.isClosed()) continue;
        let lastActivity = 0;
        let protectedPage = false;
        try {
          await candidate.evaluate(installActivity);
          lastActivity = await candidate.evaluate(name => {
            const state = globalThis[Symbol.for(name)];
            return state && Number.isFinite(state.lastActivity) ? state.lastActivity : 0;
          }, activityKeyName);
          if (!Number.isFinite(lastActivity) || lastActivity < 1) protectedPage = true;
        } catch {
          // Browser-internal and otherwise non-evaluable pages stay open.
          protectedPage = true;
        }
        records.push({ page: candidate, lastActivity, protectedPage });
      }

      const stale = records
        .filter(record => !record.protectedPage && now - record.lastActivity >= ${idleMs})
        .sort((a, b) => a.lastActivity - b.lastActivity);
      let closedCount = 0;
      let failureCount = 0;
      for (const record of stale) {
        if (context.pages().length <= 1) break;
        if (record.page.isClosed()) continue;
        try {
          await record.page.close({ runBeforeUnload: false });
          closedCount++;
        } catch {
          failureCount++;
        }
      }

      return {
        time: new Date(now).toISOString(),
        idleMs: ${idleMs},
        before: records.length,
        stale: stale.length,
        closedCount,
        after: context.pages().length,
        protectedCount: records.filter(record => record.protectedPage).length,
        failureCount,
        remainingStale: stale.length - closedCount,
      };
    } finally {
      release();
      try {
        if (context[lockKey] === queued) delete context[lockKey];
      } catch {}
    }
  }`;
}

function extractJsonObject(text) {
  const marker = text.indexOf('### Result');
  const startAt = marker >= 0 ? text.indexOf('{', marker) : text.trimStart().startsWith('{') ? text.indexOf('{') : -1;
  if (startAt < 0) throw new Error('Missing browser_run_code_unsafe result');

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = startAt; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return text.slice(startAt, index + 1);
  }
  throw new Error('Unparseable browser_run_code_unsafe result');
}

function parseToolSummary(result) {
  if (!result || result.isError) throw new Error('browser_run_code_unsafe returned isError');
  const text = (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  let summary;
  try {
    summary = JSON.parse(extractJsonObject(text));
  } catch (error) {
    if (error.message.startsWith('Missing') || error.message.startsWith('Unparseable')) throw error;
    throw new Error('Unparseable browser_run_code_unsafe result');
  }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary))
    throw new Error('Unparseable browser_run_code_unsafe result');
  for (const field of SUMMARY_FIELDS) {
    if (!Number.isSafeInteger(summary[field]) || summary[field] < 0)
      throw new Error(`Invalid browser_run_code_unsafe summary: ${field}`);
  }
  return Object.fromEntries(SUMMARY_FIELDS.map(field => [field, summary[field]]));
}

async function sweep(endpoint, idleMs, fetchImpl = fetch) {
  const client = createClient(endpoint, fetchImpl);
  let primaryError;
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
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await client.close();
    } catch (error) {
      if (!primaryError) throw error;
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function diagnostic(error) {
  const message = String(error && error.message || error);
  const http = message.match(/HTTP (\d{3})/);
  if (http) return `mcp_http_${http[1]}`;
  if (message.includes('JSON-RPC error')) return 'mcp_jsonrpc_error';
  if (message.includes('isError')) return 'mcp_tool_error';
  if (message.includes('result')) return 'mcp_invalid_result';
  if (message.includes('Missing tool')) return 'mcp_missing_tool';
  return 'mcp_sweep_error';
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
        time: new Date().toISOString(), status: 'passed', idleMs, intervalMs, ...summary,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        time: new Date().toISOString(), status: 'error', idleMs, intervalMs,
        diagnostic: diagnostic(error),
      }));
    }
    const remaining = intervalMs - (Date.now() - started);
    if (!stopping && remaining > 0) await sleep(remaining);
  }
}

module.exports = {
  DEFAULT_ENDPOINT, DEFAULT_IDLE_MS, DEFAULT_INTERVAL_MS, positiveInteger,
  decodeBody, createClient, reaperCode, parseToolSummary, sweep, diagnostic,
};

if (require.main === module)
  main().catch(error => { console.error(diagnostic(error)); process.exitCode = 1; });
