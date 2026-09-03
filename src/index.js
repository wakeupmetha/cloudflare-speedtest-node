// Boot: read env, refuse to start without a TOKEN, look up this node's
// public IP/geo, construct the two schedulers (speedtest, geocheck), the
// heartbeat client and the local HTTP API, print the banner, and wire
// SIGINT/SIGTERM. Everything here is composition; behaviour lives in the
// modules it imports.

import { dirname, join } from 'node:path';

import { logger, logConfig } from './log.js';
import { VERSION } from './version.js';
import { createAgent } from './server.js';
import { HistoryStore, defaultDataFile } from './storage.js';
import { Scheduler } from './scheduler.js';
import { runSpeedtest } from './speedtest.js';
import { DEFAULT_ARGS, SCHEMA, loadDigest, resolveGeocheckBin, runGeocheck, saveDigest } from './geocheck.js';
import { createPanelClient } from './panel.js';
import { bootBanner, runBox, fatalBox } from './format.js';
import { fetchGeo } from './geo.js';

const env = (k, d = '') => (process.env[k] ?? d).trim();
const num = (k, d) => {
  const v = Number(process.env[k] ?? d);
  return Number.isFinite(v) ? v : d;
};

const boot = logger('boot');

// ── env ─────────────────────────────────────────────────────────────────────
const token = env('TOKEN');
const panelUrl = env('PANEL_URL').replace(/\/+$/, '');
const heartbeatMs = Math.max(5_000, num('HEARTBEAT_MS', 30_000));

// Local API: loopback by default — the panel never reads it, the docker
// healthcheck and a curl on the node do.
const port = num('PORT', 9101);
const bind = env('BIND', '127.0.0.1');

const intervalMs = num('INTERVAL_MS', 30 * 60 * 1000);
const jitterPct = num('JITTER_PCT', 0.15);
const firstDelayMs = num('FIRST_DELAY_MS', 5_000);

// Economical defaults (5 s phases, 4 streams): a node pays for egress and the
// panel is not a lab. Per-request sizes are upstream's.
const speedtestOpts = {
  concurrency: num('CONCURRENCY', 4),
  downloadSec: num('DOWNLOAD_SEC', 5),
  uploadSec: num('UPLOAD_SEC', 5),
  latencySec: num('LATENCY_SEC', 2),
  probeIntervalMs: num('PROBE_INTERVAL_MS', 250),
  probeTimeoutMs: num('PROBE_TIMEOUT_MS', 2000),
  downloadBytesPerReq: num('DOWNLOAD_BYTES_PER_REQ', 10_000_000),
  uploadBytesPerReq: num('UPLOAD_BYTES_PER_REQ', 5_000_000),
};

const geocheckBinName = env('GEOCHECK_BIN', 'geocheck');
const geocheckIntervalRaw = num('GEOCHECK_INTERVAL_MS', 6 * 60 * 60 * 1000);
const geocheckIntervalMs = geocheckIntervalRaw === 0 ? 0 : Math.max(10 * 60 * 1000, geocheckIntervalRaw);
const geocheckArgs = env('GEOCHECK_ARGS', DEFAULT_ARGS.join(' ')).split(/\s+/).filter(Boolean);

const dataFile = env('DATA_FILE') || defaultDataFile();
const geocheckFile = join(dirname(dataFile), 'geocheck.json');
const maxEntries = num('MAX_HISTORY', 1500);

// ── fail-fast ───────────────────────────────────────────────────────────────
if (!token) {
  console.error(fatalBox([
    '  ✗ TOKEN is not set — refusing to start.',
    '    generate one for this node on the panel (/nodes) and put it in .env',
  ]));
  process.exit(1);
}
if (panelUrl && !/^https?:\/\//.test(panelUrl)) {
  console.error(fatalBox([
    `  ✗ PANEL_URL must start with http:// or https://  (got "${panelUrl}")`,
  ]));
  process.exit(1);
}

// ── state ───────────────────────────────────────────────────────────────────
const store = new HistoryStore({ file: dataFile, maxEntries });
await store.init();

// Self-identify by public IP + location. Best-effort, once per process.
const node = await fetchGeo();
if (node.error) boot.warn('ip/geo lookup failed — identity reads as unknown', { err: node.error });

const startedAt = new Date().toISOString();
let lastRunError = null;
let geocheckDigest = null;
let panel = null;

// ── speedtest loop ──────────────────────────────────────────────────────────
const stLog = logger('speedtest');
const speedtest = new Scheduler({
  name: 'speedtest',
  intervalMs,
  minIntervalMs: 60_000,
  jitterPct,
  firstDelayMs,
  run: ({ n }) => {
    stLog.info(`run #${n} started`);
    return runSpeedtest(speedtestOpts);
  },
  onDone: async (r, { n, elapsedMs }) => {
    lastRunError = null;
    await store.append(r);
    stLog.info(`run #${n} done`, {
      dl: r.download.mbps,
      ul: r.upload.mbps,
      lat: r.latency.median,
      jitter: r.latency.jitter,
      bloat: r.quality.bufferbloatGrade,
      stability: r.quality.stabilityGrade,
      colo: r.meta.colo,
      elapsed: `${(elapsedMs / 1000).toFixed(1)}s`,
    });
    if (r.download.errors || r.upload.errors) {
      stLog.warn(`run #${n} had failed requests`, { download: r.download.errors, upload: r.upload.errors });
    }
    if (!logConfig.json) console.log(runBox({ n, elapsedMs, result: r }));
    void panel?.beat();
  },
  onError: (e, { n, elapsedMs }) => {
    lastRunError = e?.message || String(e);
    stLog.warn(`run #${n} failed`, { err: lastRunError, elapsed: `${(elapsedMs / 1000).toFixed(1)}s` });
    if (!logConfig.json) console.log(runBox({ n, elapsedMs, error: lastRunError }));
    void panel?.beat();
  },
});

// ── geocheck loop ───────────────────────────────────────────────────────────
const gcLog = logger('geocheck');
const geocheckBin = geocheckIntervalMs === 0 ? null : await resolveGeocheckBin(geocheckBinName);
// Reported after the banner, so the boot block reads top-down.
const afterBanner = [];
if (geocheckIntervalMs === 0) {
  afterBanner.push(() => gcLog.info('disabled by GEOCHECK_INTERVAL_MS=0'));
} else if (!geocheckBin) {
  afterBanner.push(() => gcLog.warn('binary not found — service availability checks disabled', {
    bin: geocheckBinName,
    hint: 'the docker image bundles it; for a bare install put geocheck on PATH or set GEOCHECK_BIN',
  }));
}
let geocheck = null;
if (geocheckBin) {
  geocheckDigest = await loadDigest(geocheckFile);
  if (geocheckDigest) {
    const d = geocheckDigest;
    afterBanner.push(() => gcLog.info('previous result restored', { ranAt: d.ranAt, ...d.summary }));
  }
  const scheduler = new Scheduler({
    name: 'geocheck',
    intervalMs: geocheckIntervalMs,
    minIntervalMs: 10 * 60 * 1000,
    jitterPct,
    firstDelayMs: 60_000,
    run: ({ n }) => {
      gcLog.info(`run #${n} started`, { bin: geocheckBin, args: geocheckArgs.join(' ') });
      return runGeocheck({ bin: geocheckBin, args: geocheckArgs });
    },
    onDone: async (d, { n, elapsedMs }) => {
      geocheckDigest = d;
      await saveDigest(geocheckFile, d);
      gcLog.info(`run #${n} done`, { ...d.summary, country: d.country?.code, reputation: d.reputation?.type, elapsed: `${(elapsedMs / 1000).toFixed(1)}s` });
      const blocked = d.services.filter((s) => s.state === 'blocked').map((s) => s.name);
      const restricted = d.services.filter((s) => s.state === 'restricted').map((s) => s.name);
      if (blocked.length) gcLog.warn(`blocked: ${blocked.join(', ')}`);
      if (restricted.length) gcLog.info(`restricted: ${restricted.join(', ')}`);
      if (d.schema !== SCHEMA) gcLog.warn('unexpected geocheck schema — digest is best-effort', { schema: d.schema, expected: SCHEMA });
      void panel?.beat();
    },
    onError: (e, { n }) => {
      gcLog.warn(`run #${n} failed`, { err: e?.message || String(e) });
    },
  });
  geocheck = { scheduler, last: () => geocheckDigest };
}

// ── panel heartbeat ─────────────────────────────────────────────────────────
if (panelUrl) {
  panel = createPanelClient({
    url: panelUrl,
    token,
    log: logger('panel'),
    heartbeatMs,
    state: () => ({
      agent: {
        version: VERSION,
        startedAt,
        heartbeatMs,
        intervalMs: speedtest.intervalMs,
        geocheckIntervalMs: geocheck ? geocheck.scheduler.intervalMs : 0,
        geocheck: !!geocheck,
      },
      node,
      running: speedtest.running,
      nextRunAt: speedtest.nextRunAt,
      lastRunAt: store.last()?.startedAt ?? null,
      lastRunError,
      last: store.last(),
      geocheck: geocheckDigest,
    }),
    onCommand: (cmd) => {
      if (cmd === 'speedtest') return speedtest.runOnce();
      if (cmd === 'geocheck') {
        if (!geocheck) throw new Error('geocheck is disabled on this agent');
        return geocheck.scheduler.runOnce();
      }
      throw new Error(`unknown command "${cmd}"`);
    },
  });
} else {
  afterBanner.push(() => boot.warn('PANEL_URL is empty — standalone mode: results are served on the local API only'));
}

// ── local API ───────────────────────────────────────────────────────────────
const agent = createAgent({
  port, bind, token, log: logger('http'), store, speedtest, geocheck, panel, node, version: VERSION,
});
await agent.listen();

if (!logConfig.json) {
  console.log(bootBanner({
    version: VERSION,
    node,
    bind,
    port,
    intervalMs: speedtest.intervalMs,
    jitterPct: speedtest.jitterPct,
    historyCount: store.entries.length,
    panelUrl,
    geocheck: geocheckBin,
    geocheckIntervalMs: geocheck ? geocheck.scheduler.intervalMs : 0,
  }));
}
boot.info(`aerio-agent ${VERSION} starting`, {
  node: process.version,
  logLevel: logConfig.level,
  panel: panelUrl || 'standalone',
  heartbeatMs,
  speedtestMs: speedtest.intervalMs,
  geocheck: geocheckBin ?? 'disabled',
  listen: `${bind}:${port}`,
  history: store.entries.length,
});
for (const say of afterBanner) say();

speedtest.start();
geocheck?.scheduler.start();
let heartbeatTimer = null;
if (panel) {
  void panel.beat(); // pair in seconds, not after the first speedtest
  heartbeatTimer = setInterval(() => void panel.beat(), heartbeatMs);
  heartbeatTimer.unref();
}

const shutdown = async (sig) => {
  boot.info('shutting down', { signal: sig });
  speedtest.stop();
  geocheck?.scheduler.stop();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try { await agent.close(); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
