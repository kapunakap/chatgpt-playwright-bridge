#!/usr/bin/env node
'use strict';

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
      if (sessionId) await fetchImpl(endpoint, {
        method: 'DELETE', headers: { 'mcp-session-id': sessionId }, signal: AbortSignal.timeout(10000),
      });
    },
  };
}

function assertScreenshot(result) {
  const image = result.content?.find(item => item.type === 'image' && item.mimeType === 'image/png');
  if (!image || typeof image.data !== 'string') throw new Error('Screenshot image content missing');
  const data = Buffer.from(image.data, 'base64');
  if (data.length < 24 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error('Screenshot is not a nonempty PNG');
  }
}

async function smoke(client, iterations = 1, intervalSeconds = 60) {
  await client.request('initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'playwright-mcp-aws-smoke', version: '2.0.0' },
  });
  await client.notify('notifications/initialized');
  const list = await client.request('tools/list');
  const names = new Set((list.tools || []).map(tool => tool.name));
  for (const name of ['browser_navigate', 'browser_tabs', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests']) {
    if (!names.has(name)) throw new Error(`Missing tool: ${name}`);
  }
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const navigation = await client.request('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    const text = navigation.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
    if (!text.includes('https://example.com') || !text.includes('Example Domain')) throw new Error('Navigation did not reach Example Domain');
    const tabs = await client.request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } });
    if (!tabs.content?.some(item => item.type === 'text' && item.text.includes('Example Domain'))) throw new Error('Tab list missing Example Domain');
    assertScreenshot(await client.request('tools/call', { name: 'browser_take_screenshot', arguments: { type: 'png', fullPage: true } }));
    await client.request('tools/call', { name: 'browser_console_messages', arguments: { level: 'info', all: false } });
    await client.request('tools/call', { name: 'browser_network_requests', arguments: { static: false } });
    console.log(JSON.stringify({ time: new Date().toISOString(), iteration, iterations, toolCount: names.size, status: 'passed' }));
    if (iteration < iterations) await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  }
}

module.exports = { decodeBody, createClient, assertScreenshot, smoke };
if (require.main === module || process.argv[1] === '-') {
  const iterations = Number(process.argv[2] || 1);
  const interval = Number(process.argv[3] || 60);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 31 || !Number.isFinite(interval) || interval < 0 || interval > 60) {
    throw new Error('Use 1..31 iterations and 0..60 interval seconds');
  }
  const client = createClient('http://mcp-proxy:8931/mcp');
  smoke(client, iterations, interval).catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => client.close().catch(() => {}));
}
