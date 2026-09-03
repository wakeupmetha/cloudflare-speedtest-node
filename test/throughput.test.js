import test from 'node:test';
import assert from 'node:assert/strict';
import { runStreams } from '../src/throughput.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runStreams: steady-state mean is the headline, errors are counted, phase-end abort is not', async () => {
  let calls = 0;
  const r = await runStreams({
    concurrency: 2,
    durationMs: 1500,
    sampleIntervalMs: 100,
    streamFn: async ({ signal, counter }) => {
      calls++;
      if (calls === 1) throw new Error('transient');
      while (!signal.aborted) {
        counter.bytes += 125_000; // 1 Mbit per 50 ms per worker
        await sleep(50);
      }
      throw new Error('aborted'); // the fetch-abort shape; must not count
    },
  });
  assert.ok(r.mbps > 0, 'rate measured');
  assert.equal(r.mean, r.mbps, 'headline is the mean');
  assert.ok(r.samples >= 3, `steady samples: ${r.samples}`);
  assert.equal(r.errors, 1);
  assert.equal(r.durationMs, 1500);
  assert.ok(r.totalBytes > 0);
  assert.ok(r.cvPct !== null);
});

test('runStreams: a failed worker backs off instead of hot-looping', async () => {
  let calls = 0;
  const r = await runStreams({
    concurrency: 1,
    durationMs: 600,
    sampleIntervalMs: 100,
    streamFn: async () => { calls++; throw new Error('down'); },
  });
  // 600 ms / 100 ms backoff ≈ 6 attempts, never hundreds.
  assert.ok(calls <= 8 && calls >= 3, `calls=${calls}`);
  assert.equal(r.errors, calls);
  assert.equal(r.mbps, 0);
});
