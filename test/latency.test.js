import test from 'node:test';
import assert from 'node:assert/strict';
import { measureLatency } from '../src/latency.js';
import { downloadUrl, uploadUrl } from '../src/client.js';

test('measureLatency: duration loop, lost probes counted, jitter is stddev', async () => {
  let i = 0;
  const rtts = [10, 12, 14, 10, 12];
  const probe = async () => {
    const v = rtts[i++ % rtts.length];
    if (i === 3) throw new Error('timeout'); // i=1 is the warm-up
    return v;
  };
  const r = await measureLatency({ durationMs: 300, intervalMs: 50, probe });
  assert.ok(r.sent >= 4, `sent=${r.sent}`);
  assert.equal(r.lost, 1);
  assert.equal(r.samples, r.sent - r.lost);
  assert.ok(r.jitter > 0);
  assert.ok(r.median >= 10 && r.median <= 14);
});

test('client urls: measId on normal requests, during= on loaded probes', () => {
  assert.equal(downloadUrl(0, '123', undefined), 'https://speed.cloudflare.com/__down?bytes=0&measId=123');
  assert.equal(downloadUrl(0, '123', 'download'), 'https://speed.cloudflare.com/__down?bytes=0&during=download');
  assert.equal(uploadUrl('123'), 'https://speed.cloudflare.com/__up?measId=123');
});
