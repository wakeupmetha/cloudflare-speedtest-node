import { fetchTrace, fetchMeta } from './client.js';
import { measureLatency } from './latency.js';
import { measureDownload, measureUpload } from './throughput.js';

export async function runSpeedtest(opts = {}) {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();

  const [trace, meta] = await Promise.all([
    fetchTrace().catch(() => ({})),
    fetchMeta().catch(() => ({}))
  ]);

  const latency = await measureLatency({
    samples: opts.latencySamples ?? 20
  });

  const download = await measureDownload({
    concurrency: opts.concurrency ?? 8,
    durationMs: (opts.downloadSec ?? 10) * 1000
  });

  const upload = await measureUpload({
    concurrency: opts.concurrency ?? 8,
    durationMs: (opts.uploadSec ?? 10) * 1000
  });

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - t0),
    meta: {
      ip: trace.ip ?? meta.clientIp ?? null,
      colo: trace.colo ?? meta.colo ?? null,
      loc: trace.loc ?? null,
      http: trace.http ?? null,
      tls: trace.tls ?? null,
      asn: meta.asn ?? null,
      asOrganization: meta.asOrganization ?? null,
      city: meta.city ?? null,
      country: meta.country ?? trace.loc ?? null
    },
    latency,
    download,
    upload
  };
}
