import { hostname } from 'node:os';
import { createAgent } from './server.js';

const port = Number(process.env.PORT ?? 8080);
const bind = process.env.BIND ?? '0.0.0.0';
const authToken = process.env.AUTH_TOKEN ?? '';
const cacheTtlMs = Number(process.env.CACHE_TTL_MS ?? 0);
const serverId = process.env.SERVER_ID || hostname();

const speedtestOpts = {
  concurrency: Number(process.env.CONCURRENCY ?? 8),
  downloadSec: Number(process.env.DOWNLOAD_SEC ?? 10),
  uploadSec: Number(process.env.UPLOAD_SEC ?? 10),
  latencySamples: Number(process.env.LATENCY_SAMPLES ?? 20)
};

if (!authToken) {
  console.warn('[warn] AUTH_TOKEN is not set — agent will accept unauthenticated requests');
}

const agent = createAgent({ port, bind, authToken, cacheTtlMs, speedtestOpts, serverId });

agent.listen().then(() => {
  console.log(`speedtest agent listening on http://${bind}:${port} (serverId=${serverId})`);
});

const shutdown = async (sig) => {
  console.log(`${sig} received, shutting down`);
  await agent.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
