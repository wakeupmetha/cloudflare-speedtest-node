import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/scheduler.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runOnce shares the in-flight run; hooks get result / error; loop state resets', async () => {
  let calls = 0;
  const done = [];
  const errors = [];
  const s = new Scheduler({
    name: 't', intervalMs: 60_000, minIntervalMs: 10, firstDelayMs: 0, jitterPct: 0,
    run: async () => { calls++; await sleep(20); if (calls === 2) throw new Error('boom'); return calls; },
    onDone: (r) => done.push(r),
    onError: (e) => errors.push(e.message),
  });
  const [a, b] = await Promise.all([s.runOnce(), s.runOnce()]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.deepEqual(done, [1]);
  assert.ok(s.lastRunAt);
  await assert.rejects(s.runOnce(), /boom/);
  assert.deepEqual(errors, ['boom']);
  assert.equal(s.running, false);
  assert.equal(s.inflight, null);
});

test('a throwing hook is contained', async () => {
  const s = new Scheduler({ name: 't', intervalMs: 0, run: async () => 1, onDone: () => { throw new Error('hook'); } });
  assert.equal(await s.runOnce(), 1);
});

test('start(): first tick after firstDelayMs, keeps going after a failed run; 0 disables', async () => {
  let calls = 0;
  const s = new Scheduler({
    name: 't', intervalMs: 30, minIntervalMs: 10, firstDelayMs: 0, jitterPct: 0,
    run: async () => { calls++; if (calls === 1) throw new Error('x'); },
  });
  s.start();
  assert.ok(s.nextRunAt);
  await sleep(120);
  s.stop();
  assert.ok(calls >= 2, `calls=${calls}`);
  assert.equal(s.nextRunAt, null);

  const off = new Scheduler({ name: 't', intervalMs: 0, run: async () => {} });
  off.start();
  assert.equal(off.enabled, false);
  assert.equal(off.nextRunAt, null);
});
