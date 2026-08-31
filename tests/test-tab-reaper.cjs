const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_IDLE_MS, DEFAULT_INTERVAL_MS, positiveInteger, decodeBody, createClient,
  reaperCode, parseToolSummary, sweep,
} = require('../scripts/tab-reaper.cjs');

function response(payload, status = 200, session = '', body = JSON.stringify(payload)) {
  return {
    ok: status < 400,
    status,
    headers: { get: name => name === 'mcp-session-id' ? session : null },
    text: async () => body,
  };
}

function summary(overrides = {}) {
  return {
    before: 3, stale: 2, closedCount: 2, after: 1,
    protectedCount: 0, failureCount: 0, remainingStale: 0,
    ...overrides,
  };
}

test('uses the required positive defaults and rejects invalid configuration', () => {
  assert.equal(DEFAULT_IDLE_MS, 1800000);
  assert.equal(DEFAULT_INTERVAL_MS, 60000);
  assert.equal(positiveInteger(undefined, DEFAULT_IDLE_MS, 'idle'), DEFAULT_IDLE_MS);
  assert.equal(positiveInteger('', DEFAULT_INTERVAL_MS, 'interval'), DEFAULT_INTERVAL_MS);
  for (const value of ['0', '-1', '1.5', 'Infinity', 'not-a-number']) {
    assert.throws(() => positiveInteger(value, 1, 'TAB_REAPER_IDLE_MS'), /positive integer/);
  }
});

test('decodes JSON and matching SSE responses, and rejects malformed SSE', () => {
  assert.deepEqual(decodeBody('{"id":4,"result":{}}', 4), { id: 4, result: {} });
  assert.deepEqual(decodeBody('event: message\ndata: {"method":"notifications/progress"}\n\ndata: {"id":4,"result":{}}\n', 4), {
    id: 4, result: {},
  });
  assert.throws(() => decodeBody('data: not-json\n', 4), SyntaxError);
  assert.equal(decodeBody('', 4), null);
});

test('parses complete tool summaries and fails missing or unparseable output', () => {
  const parsed = parseToolSummary({ content: [{ type: 'text', text: `### Result\n${JSON.stringify(summary(), null, 2)}` }] });
  assert.deepEqual(parsed, summary());
  for (const result of [
    { content: [] },
    { content: [{ type: 'text', text: '### Result\nnot-json' }] },
    { content: [{ type: 'text', text: `### Result\n${JSON.stringify({ before: 1 })}` }] },
    { isError: true, content: [{ type: 'text', text: 'details must not be logged' }] },
  ]) assert.throws(() => parseToolSummary(result), /result|summary|isError/);
});

test('generated sweep code is context-wide, selection-free, safe, and activity-aware', () => {
  const code = reaperCode(1800000);
  assert.match(code, /context\.pages\(\)/);
  assert.match(code, /context\.addInitScript/);
  assert.match(code, /context\.pages\(\)\.length <= 1/);
  for (const event of ['pointerdown', 'touchstart', 'keydown', 'beforeinput', 'input', 'change', 'submit', 'wheel', 'pageshow', 'popstate', 'hashchange', 'visibilitychange']) {
    assert.match(code, new RegExp(`['"]${event}['"]`));
  }
  assert.doesNotMatch(code, /browser_tabs|browserTab|selectedTab|currentTab/);
  assert.doesNotMatch(code, /\.url\(\)|\.title\(\)/);
  assert.doesNotMatch(code, /closed\s*:/);
});

test('fake MCP transport completes a sweep and closes only its session', async () => {
  const seen = [];
  const fetchImpl = async (_, options) => {
    seen.push(options);
    if (options.method === 'DELETE') return response({}, 200);
    const request = JSON.parse(options.body);
    if (request.method === 'initialize') return response({ id: request.id, result: {} }, 200, 'reaper-session');
    if (request.method === 'notifications/initialized') return response({}, 202, 'reaper-session', '');
    if (request.method === 'tools/list') return response({ id: request.id, result: { tools: [{ name: 'browser_run_code_unsafe' }] } }, 200, 'reaper-session');
    return response({ id: request.id, result: { content: [{ type: 'text', text: `### Result\n${JSON.stringify(summary())}` }] } }, 200, 'reaper-session');
  };
  assert.deepEqual(await sweep('http://unused', 1800000, fetchImpl), summary());
  assert.equal(seen.at(-1).method, 'DELETE');
  assert.equal(seen.at(-1).headers['mcp-session-id'], 'reaper-session');
  assert.equal(seen.filter(item => item.method === 'POST')[1].headers['mcp-session-id'], 'reaper-session');
});

test('HTTP, JSON-RPC, tool errors, invalid results, and close failures fail the sweep', async () => {
  const cases = [
    async (_, options) => response({}, 503),
    async (_, options) => {
      const request = JSON.parse(options.body);
      return response({ id: request.id, error: { code: -32000 } }, 200, 'session');
    },
    async (_, options) => {
      const request = JSON.parse(options.body);
      return response({ id: request.id, result: { isError: true } }, 200, 'session');
    },
    async (_, options) => {
      const request = JSON.parse(options.body);
      return response({ id: request.id, result: { content: [{ type: 'text', text: '### Result' }] } }, 200, 'session');
    },
  ];
  for (const fetchImpl of cases) await assert.rejects(sweep('http://unused', 1, fetchImpl));

  const client = createClient('http://unused', async (_, options) => options.method === 'DELETE'
    ? response({}, 503)
    : response({ id: JSON.parse(options.body).id, result: {} }, 200, 'session'));
  await client.request('initialize');
  await assert.rejects(client.close(), /session close: HTTP 503/);

  const notificationClient = createClient('http://unused', async (_, options) => {
    const request = JSON.parse(options.body);
    return request.method === 'notifications/initialized'
      ? response({ error: { code: -32001 } }, 200, 'session')
      : response({ id: request.id, result: {} }, 200, 'session');
  });
  await notificationClient.request('initialize');
  await assert.rejects(notificationClient.notify('notifications/initialized'), /JSON-RPC error/);
});
