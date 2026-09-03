import test from 'node:test';
import assert from 'node:assert/strict';
import { runBox, bootBanner, fatalBox } from '../src/format.js';

const WIDTH = 63; // 61 inner + two bars

const result = {
  download: { mbps: 918.54, min: 880.2, max: 1250.8, errors: 2 },
  upload: { mbps: 482.0, min: 455, max: 502, errors: 0 },
  latency: { median: 11.8, jitter: 1.6, loadedDownload: { median: 120.4 }, loadedUpload: { median: 134.9 } },
  quality: { bufferbloatGrade: 'A+', bufferbloatMs: 4.2, stabilityGrade: 'F', stabilityCvPct: 94.9 },
};

test('every box line is exactly the frame width — nothing truncated', () => {
  for (const box of [
    runBox({ n: 1, elapsedMs: 9800, result }),
    runBox({ n: 2, elapsedMs: 1200, error: 'no bytes transferred (download errors=4, upload errors=4) — speed.cloudflare.com unreachable?' }),
    bootBanner({ version: '0.2.0', node: { ip: '203.0.113.10', city: 'Frankfurt', country: 'Germany', countryCode: 'DE' }, bind: '127.0.0.1', port: 9101, intervalMs: 1800000, jitterPct: 0.15, historyCount: 12, panelUrl: 'https://console.aerio.my', geocheck: '/usr/local/bin/geocheck', geocheckIntervalMs: 21600000 }),
    fatalBox(['  ✗ TOKEN is not set — refusing to start.']),
  ]) {
    for (const line of box.split('\n')) assert.equal([...line].length, WIDTH, line);
  }
});

test('runBox carries the numbers a person reads', () => {
  const box = runBox({ n: 1, elapsedMs: 9800, result });
  assert.match(box, /918\.5 mbps/);
  assert.match(box, /loaded 120\/135 ms/);
  assert.match(box, /bloat A\+ \+4ms/);
  assert.match(box, /stability F  cv 94\.9%/);
  assert.match(box, /errors {5}download 2/);
});
