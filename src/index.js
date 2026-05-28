import { createAgent } from './server.js';
import { HistoryStore, defaultDataFile } from './storage.js';
import { SpeedtestScheduler } from './scheduler.js';
import { bootBanner, fatalBox } from './format.js';
import { fetchGeo } from './geo.js';

// 9101 = Prometheus exporter convention (adjacent to node_exporter on
// 9100). The speedtest agent is functionally a host-level metrics
// exporter, just measuring network capacity instead of CPU/RAM, so
// keeping it in that port family signals intent to anyone reading the
// docker-compose.
const port = Number(process.env.PORT ?? 9101);
const bind = process.env.BIND ?? '0.0.0.0';
const token = process.env.TOKEN ?? '';

// Cadence — defaults to 30 min, matches what the CRM panel expects.
// Floor enforced by the scheduler at 60 s so a misconfigured env can't
// melt the upstream Cloudflare edge.
const intervalMs = Number(process.env.INTERVAL_MS ?? 30 * 60 * 1000);
const jitterPct = Number(process.env.JITTER_PCT ?? 0.15);
const firstDelayMs = Number(process.env.FIRST_DELAY_MS ?? 5_000);

// Lighter defaults than the upstream lib — we run unattended every
// 30 min, so a 5 s window with 4 streams is enough for a stable median
// without burning ~1 GB of egress per run. Override via env when you
// need higher fidelity (e.g. a one-off capacity audit).
const speedtestOpts = {
  concurrency: Number(process.env.CONCURRENCY ?? 4),
  downloadSec: Number(process.env.DOWNLOAD_SEC ?? 5),
  uploadSec: Number(process.env.UPLOAD_SEC ?? 5),
  latencySamples: Number(process.env.LATENCY_SAMPLES ?? 20),
};

const dataFile = process.env.DATA_FILE || defaultDataFile();
const maxEntries = Number(process.env.MAX_HISTORY ?? 1500);

// The agent is a standalone daemon listening on an external port — a
// missing token would mean an open API to anyone who can reach it.
// Fail fast rather than silently booting unauthenticated.
if (!token) {
  console.error(fatalBox([
    '  ✗ TOKEN is not set — refusing to start.',
    '    set TOKEN in .env   (openssl rand -hex 24)',
  ]));
  process.exit(1);
}

const store = new HistoryStore({ file: dataFile, maxEntries });
await store.init();

// Self-identify by public IP + location instead of a manual SERVER_ID.
// Best-effort, once per process — the node runs even if this fails.
const node = await fetchGeo();

const scheduler = new SpeedtestScheduler({
  intervalMs,
  jitterPct,
  firstDelayMs,
  speedtestOpts,
  node,
  store,
});

const agent = createAgent({ port, bind, token, scheduler, store, node });

await agent.listen();
console.log(bootBanner({
  node,
  bind,
  port,
  intervalMs: scheduler.intervalMs,
  jitterPct: scheduler.jitterPct,
  historyCount: store.entries.length,
}));

scheduler.start();

const shutdown = async (sig) => {
  console.log(`${sig} received, shutting down`);
  scheduler.stop();
  try { await agent.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
