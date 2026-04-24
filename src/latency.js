import { downloadUrl } from './client.js';
import { summary, jitter } from './stats.js';

export async function measureLatency({ samples = 20, timeoutMs = 5000 } = {}) {
  // warmup probe to establish keep-alive connection (TLS/TCP handshake excluded from samples)
  try { await probe(timeoutMs); } catch {}

  const results = [];
  for (let i = 0; i < samples; i++) {
    try { results.push(await probe(timeoutMs)); } catch {}
  }
  return { ...summary(results), jitter: jitter(results), samples: results.length };
}

async function probe(timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const start = performance.now();
  try {
    const res = await fetch(downloadUrl(0), { signal: ctrl.signal, cache: 'no-store' });
    await res.arrayBuffer();
    return performance.now() - start;
  } finally {
    clearTimeout(t);
  }
}
