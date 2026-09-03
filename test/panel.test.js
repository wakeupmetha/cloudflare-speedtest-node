import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPanelClient } from '../src/panel.js';

function fakeLog() {
  const calls = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error', 'crit'].map((l) => [l, (m, f) => calls.push([l, m, f])]));
  return { log, calls, levels: () => calls.map((c) => c[0]) };
}

const state = () => ({
  agent: { version: '0.2.0', heartbeatMs: 30000 },
  node: { ip: '203.0.113.10' },
  running: false, nextRunAt: null, lastRunAt: null, lastRunError: null, last: null, geocheck: null,
});

async function withServer(handler, fn) {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body), url: req.url });
      handler(req, res, JSON.parse(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { await fn(url, received); } finally { server.close(); }
}

const okHandler = (commands = [], expectedIp = null) => (req, res) => {
  const good = req.headers.authorization === 'Bearer good';
  res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
  res.end(JSON.stringify(good
    ? { ok: true, node: 'de-fra-1', commands, expectedIp }
    : { error: 'unknown_token', hint: 'generate a token on /nodes' }));
};

test('good token: paired, body carried, command dispatched once, mismatch warned', async () => {
  await withServer(okHandler(['speedtest'], '198.51.100.7'), async (url, received) => {
    const { log, calls, levels } = fakeLog();
    const commands = [];
    const c = createPanelClient({ url, token: 'good', log, state, onCommand: async (cmd) => { commands.push(cmd); } });
    await c.beat();
    await new Promise((r) => setImmediate(r));
    assert.equal(received[0].url, '/api/agent/heartbeat');
    assert.equal(received[0].auth, 'Bearer good');
    assert.equal(received[0].body.agent.heartbeatMs, 30000);
    assert.deepEqual(commands, ['speedtest']);
    const s = c.status();
    assert.equal(s.paired, true);
    assert.equal(s.node, 'de-fra-1');
    assert.equal(s.lastError, null);
    assert.ok(s.lastOkAt);
    assert.ok(calls.some(([l, m]) => l === 'info' && m === 'paired as "de-fra-1"'));
    assert.ok(calls.some(([l, m]) => l === 'warn' && /address mismatch/.test(m)));
    // second beat: no repeated "paired", no repeated mismatch
    await c.beat();
    assert.equal(levels().filter((l) => l === 'warn').length, 1);
    assert.equal(calls.filter(([, m]) => m.startsWith('paired')).length, 1);
  });
});

test('rejected token: ERROR once, then debug; status says rejected', async () => {
  await withServer(okHandler(), async (url) => {
    const { log, calls, levels } = fakeLog();
    const c = createPanelClient({ url, token: 'bad', log, state, onCommand: async () => {} });
    await c.beat();
    await c.beat();
    assert.equal(levels().filter((l) => l === 'error').length, 1);
    assert.equal(levels().filter((l) => l === 'debug').length, 1);
    assert.match(calls[0][1], /token rejected/);
    assert.equal(calls[0][2].hint, 'generate a token on /nodes');
    assert.equal(c.status().paired, false);
    assert.match(c.status().lastError, /rejected/);
  });
});

test('unreachable: WARN once, debug after, INFO "paired" on recovery names the outage length', async () => {
  const { log, calls, levels } = fakeLog();
  let t = 1_000_000;
  const now = () => t;
  let failures = 2;
  const fetchImpl = async (u, init) => {
    if (failures-- > 0) throw new TypeError('fetch failed: ECONNREFUSED');
    return new Response(JSON.stringify({ ok: true, node: 'de-fra-1', commands: [], expectedIp: null }), { status: 200 });
  };
  const c = createPanelClient({ url: 'http://panel.local', token: 'good', log, state, onCommand: async () => {}, now, fetchImpl });
  await c.beat();          // WARN
  t += 30_000;
  await c.beat();          // debug
  assert.equal(levels().filter((l) => l === 'warn').length, 1);
  assert.equal(calls[0][1], 'unreachable');
  assert.match(calls[0][2].err, /ECONNREFUSED/);
  assert.equal(levels().filter((l) => l === 'debug').length, 1);
  assert.match(c.status().lastError, /unreachable/);
  t += 30_000;
  await c.beat();          // recovery
  const paired = calls.find(([l, m]) => l === 'info' && m.startsWith('paired'));
  assert.ok(paired);
  assert.equal(paired[2].after, '60s');
  assert.equal(c.status().paired, true);
  assert.equal(c.status().lastError, null);
});
