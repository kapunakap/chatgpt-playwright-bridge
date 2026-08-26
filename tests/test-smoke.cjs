const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeBody, createClient, assertScreenshot, smoke } = require('../scripts/mcp-smoke.cjs');

test('stdin entrypoint runs and rejects invalid iteration counts', () => {
  const { spawnSync } = require('node:child_process');
  const { readFileSync } = require('node:fs');
  const child = spawnSync(process.execPath, ['-', '0', '60'], {
    input: readFileSync(require.resolve('../scripts/mcp-smoke.cjs')), encoding: 'utf8',
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Use 1\.\.31 iterations/);
});

function response(payload, status = 200, session = '') {
  return { ok: status < 400, status, headers: { get: () => session }, text: async () => JSON.stringify(payload) };
}

test('selects the matching SSE response among notifications', () => {
  assert.deepEqual(decodeBody('data: {"method":"notifications/progress"}\n\ndata: {"id":2,"result":{}}\n', 2), { id: 2, result: {} });
});

test('HTTP, JSON-RPC, and tool-level errors fail instead of passing', async () => {
  for (const [reply, status, expected] of [
    [{}, 503, /HTTP 503/],
    [{ id: 1, error: { code: -32000 } }, 200, /JSON-RPC error/],
    [{ id: 1, result: { isError: true, content: [{ type: 'text', text: 'Browser already in use' }] } }, 200, /isError/],
    [{ id: 9, result: {} }, 200, /Invalid MCP response/],
  ]) {
    const client = createClient('http://unused', async () => response(reply, status));
    await assert.rejects(client.request('tools/call', { name: 'browser_navigate' }), expected);
  }
});

test('carries MCP session across calls and closes only that session', async () => {
  const seen = [];
  const client = createClient('http://unused', async (_, options) => {
    seen.push(options);
    const id = options.body ? JSON.parse(options.body).id : null;
    return response({ id, result: {} }, 200, 'test-session');
  });
  await client.request('initialize');
  await client.request('tools/list');
  await client.close();
  assert.equal(seen[1].headers['mcp-session-id'], 'test-session');
  assert.equal(seen[2].method, 'DELETE');
  assert.equal(seen[2].headers['mcp-session-id'], 'test-session');
});

test('missing, empty, and invalid screenshot content fail', () => {
  for (const content of [[], [{ type: 'text', text: 'saved screenshot' }],
    [{ type: 'image', mimeType: 'image/png', data: '' }],
    [{ type: 'image', mimeType: 'image/png', data: Buffer.from('not a png'.repeat(5)).toString('base64') }]]) {
    assert.throws(() => assertScreenshot({ content }), /Screenshot/);
  }
  const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(16)]);
  assert.doesNotThrow(() => assertScreenshot({ content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }));
});

test('smoke rejects a navigation result for the wrong page', async () => {
  const names = ['browser_navigate', 'browser_tabs', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests'];
  const client = { notify: async () => {}, request: async method => method === 'tools/list'
    ? { tools: names.map(name => ({ name })) } : { content: [{ type: 'text', text: 'about:blank' }] } };
  await assert.rejects(smoke(client), /did not reach Example Domain/);
});
