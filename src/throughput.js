import { randomBytes } from 'node:crypto';
import { downloadUrl, uploadUrl } from './client.js';
import { summary } from './stats.js';

const SAMPLE_INTERVAL_MS = 200;
const RAMP_UP_FRACTION = 0.2;
const MIN_RAMP_UP_MS = 1000;
const UPLOAD_CHUNK_SIZE = 64 * 1024;

export async function measureDownload({ concurrency = 8, durationMs = 10000, bytesPerRequest = 25_000_000 } = {}) {
  return runStreams({
    concurrency,
    durationMs,
    streamFn: ({ signal, counter }) => downloadStream(bytesPerRequest, signal, counter)
  });
}

export async function measureUpload({ concurrency = 8, durationMs = 10000, bytesPerRequest = 10_000_000 } = {}) {
  const chunk = randomBytes(UPLOAD_CHUNK_SIZE);
  return runStreams({
    concurrency,
    durationMs,
    streamFn: ({ signal, counter }) => uploadStream(bytesPerRequest, chunk, signal, counter)
  });
}

async function runStreams({ concurrency, durationMs, streamFn }) {
  const ctrl = new AbortController();
  const counter = { bytes: 0 };
  const samples = []; // { tMs, mbps }
  const stopAt = performance.now() + durationMs;

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(workerLoop(streamFn, counter, ctrl.signal, stopAt));
  }

  const sampleStart = performance.now();
  let lastT = sampleStart;
  let lastBytes = 0;
  const sampler = setInterval(() => {
    const now = performance.now();
    const dtSec = (now - lastT) / 1000;
    const dBytes = counter.bytes - lastBytes;
    if (dtSec > 0) samples.push({ tMs: now - sampleStart, mbps: (dBytes * 8) / 1_000_000 / dtSec });
    lastT = now;
    lastBytes = counter.bytes;
  }, SAMPLE_INTERVAL_MS);

  await sleep(durationMs);
  ctrl.abort();
  clearInterval(sampler);
  await Promise.allSettled(workers);

  const cutoffMs = Math.max(MIN_RAMP_UP_MS, durationMs * RAMP_UP_FRACTION);
  const steady = samples.filter((s) => s.tMs >= cutoffMs).map((s) => s.mbps);
  return {
    ...summary(steady),
    samples: steady.length,
    totalBytes: counter.bytes,
    durationMs
  };
}

async function workerLoop(streamFn, counter, signal, stopAt) {
  while (!signal.aborted && performance.now() < stopAt) {
    try { await streamFn({ signal, counter }); }
    catch { /* abort or transient error — loop continues until stopAt/abort */ }
  }
}

async function downloadStream(bytes, signal, counter) {
  const res = await fetch(downloadUrl(bytes), { signal, cache: 'no-store' });
  if (!res.body) return;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) counter.bytes += value.byteLength;
  }
}

async function uploadStream(bytes, chunk, signal, counter) {
  const body = makeUploadStream(bytes, chunk, counter, signal);
  const res = await fetch(uploadUrl(), {
    method: 'POST',
    body,
    duplex: 'half',
    signal,
    headers: { 'content-type': 'application/octet-stream' }
  });
  // drain any response body
  if (res.body) { try { await res.arrayBuffer(); } catch {} }
}

function makeUploadStream(bytes, chunk, counter, signal) {
  let remaining = bytes;
  return new ReadableStream({
    pull(controller) {
      if (signal.aborted || remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.length, remaining);
      const slice = size === chunk.length ? chunk : chunk.subarray(0, size);
      controller.enqueue(slice);
      counter.bytes += size;
      remaining -= size;
    },
    cancel() { remaining = 0; }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
