// RTT probes against /__down?bytes=0, the way cloudflare-speed-cli's
// engine/latency.rs does them: for a DURATION at a fixed interval, not a fixed
// count, so an idle 2 s window and a loaded window the length of the download
// phase are the same loop. Jitter is the sample stddev (stats.js).

import { downloadUrl, headers } from './client.js';
import { summary, stddev } from './stats.js';

export async function measureLatency({
  durationMs = 2000,
  intervalMs = 250,
  timeoutMs = 2000,
  measId,
  during,
  probe,
} = {}) {
  const doProbe = probe ?? (() => httpProbe({ measId, during, timeoutMs }));

  // Warm-up establishes the keep-alive connection so the TCP/TLS handshake
  // is not counted as the first sample. Outside `sent`.
  try { await doProbe(); } catch { /* ignore */ }

  const samples = [];
  let sent = 0;
  const start = performance.now();
  while (performance.now() - start < durationMs) {
    sent++;
    try { samples.push(await doProbe()); } catch { /* lost probe */ }
    await sleep(intervalMs);
  }
  return {
    ...summary(samples),
    jitter: stddev(samples),
    samples: samples.length,
    sent,
    lost: sent - samples.length,
  };
}

async function httpProbe({ measId, during, timeoutMs }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(downloadUrl(0, measId, during), {
      signal: ctrl.signal,
      cache: 'no-store',
      headers: headers(),
    });
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`probe ${res.status}`);
    return performance.now() - start;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
