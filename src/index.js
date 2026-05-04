import { hostname } from 'node:os';
import { createAgent } from './server.js';
import { HistoryStore, defaultDataFile } from './storage.js';
import { SpeedtestScheduler } from './scheduler.js';

// 9101 = Prometheus exporter convention (adjacent to node_exporter on
// 9100). The speedtest agent is functionally a host-level metrics
// exporter, just measuring network capacity instead of CPU/RAM, so
// keeping it in that port family signals intent to anyone reading the
// docker-compose.
const port = Number(process.env.PORT ?? 9101);
const bind = process.env.BIND ?? '0.0.0.0';
const authToken = process.env.AUTH_TOKEN ?? '';
const serverId = process.env.SERVER_ID || hostname();

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

if (!authToken) {
  console.warn('[warn] AUTH_TOKEN is not set — agent will accept unauthenticated requests');
}

const store = new HistoryStore({ file: dataFile, maxEntries });
await store.init();

const scheduler = new SpeedtestScheduler({
  intervalMs,
  jitterPct,
  firstDelayMs,
  speedtestOpts,
  serverId,
  store,
  log: (msg) => console.log(`[scheduler] ${msg}`),
});

const agent = createAgent({ port, bind, authToken, scheduler, store, serverId });

await agent.listen();
console.log(`speedtest agent listening on http://${bind}:${port} (serverId=${serverId}, history=${store.entries.length} rows, interval=${Math.round(intervalMs / 1000)}s)`);

scheduler.start();

const shutdown = async (sig) => {
  console.log(`${sig} received, shutting down`);
  scheduler.stop();
  try { await agent.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
