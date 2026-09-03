// Multi-stream download / upload against speed.cloudflare.com, following
// cloudflare-speed-cli's engine/throughput.rs:
//
//   - N workers each loop "one request after another" until the phase clock
//     runs out; a sampler records the aggregate rate every 200 ms.
//   - The first max(20 %, 1 s) of the phase is ramp-up (TCP slow start) and
//     is excluded from the reported numbers.
//   - The headline `mbps` is the MEAN of the steady-state samples; median and
//     quartiles ride along, and the coefficient of variation feeds the
//     stability grade.
//   - A failed request backs the worker off 100 ms instead of hot-looping,
//     a 429 halves the download request size (floor 100 KB), and an upload
//     that fails has its bytes taken back out of the counter.

import { randomBytes } from 'node:crypto';
import { downloadUrl, uploadUrl, headers } from './client.js';
import { summary, cvPct } from './stats.js';

const SAMPLE_INTERVAL_MS = 200;
const RAMP_UP_FRACTION = 0.2;
const MIN_RAMP_UP_MS = 1000;
const UPLOAD_CHUNK_SIZE = 64 * 1024;
const MIN_DOWNLOAD_BYTES_PER_REQ = 100_000;
const WORKER_ERROR_BACKOFF_MS = 100;

export function measureDownload({ concurrency = 4, durationMs = 5000, bytesPerRequest = 10_000_000, measId } = {}) {
  return runStreams({
    concurrency,
    durationMs,
    bytesPerReq: bytesPerRequest,
    streamFn: (ctx) => downloadStream(ctx, measId),
  });
}

export function measureUpload({ concurrency = 4, durationMs = 5000, bytesPerRequest = 5_000_000, measId } = {}) {
  const chunk = randomBytes(UPLOAD_CHUNK_SIZE);
  return runStreams({
    concurrency,
    durationMs,
    bytesPerReq: bytesPerRequest,
    streamFn: (ctx) => uploadStream(ctx, chunk, measId),
  });
}

/**
 * Drive `concurrency` workers of `streamFn({signal, counter, state})` for
 * `durationMs`, sampling the aggregate rate. Exported for tests, which pass a
 * synthetic streamFn.
 */
export async function runStreams({ concurrency, durationMs, streamFn, sampleIntervalMs = SAMPLE_INTERVAL_MS, bytesPerReq = 0 }) {
  const ctrl = new AbortController();
  const counter = { bytes: 0 };
  const state = { errors: 0, bytesPerReq };
  const samples = []; // { tMs, mbps }
  const t0 = performance.now();
  const stopAt = t0 + durationMs;

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(workerLoop(streamFn, counter, state, ctrl.signal, stopAt));
  }

  let lastT = t0;
  let lastBytes = 0;
  const sampler = setInterval(() => {
    const now = performance.now();
    const dtSec = (now - lastT) / 1000;
    const dBytes = counter.bytes - lastBytes;
    if (dtSec > 0) samples.push({ tMs: now - t0, mbps: (dBytes * 8) / 1_000_000 / dtSec });
    lastT = now;
    lastBytes = counter.bytes;
  }, sampleIntervalMs);

  await sleep(durationMs);
  ctrl.abort();
  clearInterval(sampler);
  await Promise.allSettled(workers);

  const cutoffMs = Math.max(MIN_RAMP_UP_MS, durationMs * RAMP_UP_FRACTION);
  const steady = samples.filter((s) => s.tMs >= cutoffMs).map((s) => s.mbps);
  // No usable steady window (phase too short) → fall back to the whole
  // phase, as the upstream does.
  const used = steady.length >= 2 ? steady : samples.map((s) => s.mbps);
  const s = summary(used);
  return {
    mbps: s.mean,
    ...s,
    cvPct: cvPct(used),
    samples: used.length,
    totalBytes: Math.max(0, counter.bytes),
    durationMs,
    errors: state.errors,
  };
}

async function workerLoop(streamFn, counter, state, signal, stopAt) {
  while (!signal.aborted && performance.now() < stopAt) {
    try {
      await streamFn({ signal, counter, state });
    } catch {
      // The phase-end abort also rejects the in-flight request; that is
      // not an error, and neither is worth a retry.
      if (signal.aborted) return;
      state.errors++;
      await sleep(WORKER_ERROR_BACKOFF_MS);
    }
  }
}

async function downloadStream({ signal, counter, state }, measId) {
  const res = await fetch(downloadUrl(state.bytesPerReq, measId), {
    signal,
    cache: 'no-store',
    headers: headers(),
  });
  if (!res.ok) {
    if (res.status === 429) {
      const next = Math.max(MIN_DOWNLOAD_BYTES_PER_REQ, Math.floor(state.bytesPerReq / 2));
      if (next < state.bytesPerReq) state.bytesPerReq = next;
    }
    await res.arrayBuffer().catch(() => {});
    throw new Error(`download ${res.status}`);
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    if (value) counter.bytes += value.byteLength;
  }
}

async function uploadStream({ signal, counter, state }, chunk, measId) {
  let remaining = state.bytesPerReq;
  let counted = 0;
  // Bytes are counted as the HTTP client pulls chunks (backpressure-aware),
  // and taken back out if the request fails — the server never received them.
  const body = new ReadableStream({
    pull(controller) {
      if (signal.aborted || remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(chunk.length, remaining);
      controller.enqueue(size === chunk.length ? chunk : chunk.subarray(0, size));
      counter.bytes += size;
      counted += size;
      remaining -= size;
    },
    cancel() {
      remaining = 0;
    },
  });
  try {
    const res = await fetch(uploadUrl(measId), {
      method: 'POST',
      body,
      duplex: 'half',
      signal,
      headers: { ...headers(), 'content-type': 'application/octet-stream' },
    });
    if (res.body) await res.arrayBuffer().catch(() => {});
    if (!res.ok) throw new Error(`upload ${res.status}`);
  } catch (e) {
    // An abort at phase end is not a failure: those bytes went out and the
    // rate sampler already saw them.
    if (!signal.aborted) counter.bytes -= counted;
    throw e;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
