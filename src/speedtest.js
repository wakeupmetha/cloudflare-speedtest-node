// One speedtest run, in cloudflare-speed-cli's order: connection meta, idle
// latency, download with loaded latency alongside, upload with loaded latency
// alongside, then the two quality grades the upstream derives from those
// (bufferbloat = latency increase under load; stability = CV of steady-state
// throughput). The result is one history row and what the heartbeat carries.

import { fetchTrace, fetchMeta, newMeasId } from './client.js';
import { measureLatency } from './latency.js';
import { measureDownload, measureUpload } from './throughput.js';
import { bufferbloatGrade, stabilityGrade, round } from './stats.js';

export async function runSpeedtest(opts = {}) {
  const startedAt = new Date().toISOString();
  const t0 = performance.now();
  const measId = newMeasId();

  const [trace, meta] = await Promise.all([
    fetchTrace().catch(() => ({})),
    fetchMeta().catch(() => ({})),
  ]);

  const probe = {
    intervalMs: opts.probeIntervalMs ?? 250,
    timeoutMs: opts.probeTimeoutMs ?? 2000,
    measId,
  };
  const concurrency = opts.concurrency ?? 4;
  const dlMs = (opts.downloadSec ?? 5) * 1000;
  const ulMs = (opts.uploadSec ?? 5) * 1000;

  const idle = await measureLatency({ ...probe, durationMs: (opts.latencySec ?? 2) * 1000 });

  const [download, loadedDownload] = await Promise.all([
    measureDownload({ concurrency, durationMs: dlMs, bytesPerRequest: opts.downloadBytesPerReq ?? 10_000_000, measId }),
    measureLatency({ ...probe, during: 'download', durationMs: dlMs }),
  ]);

  const [upload, loadedUpload] = await Promise.all([
    measureUpload({ concurrency, durationMs: ulMs, bytesPerRequest: opts.uploadBytesPerReq ?? 5_000_000, measId }),
    measureLatency({ ...probe, during: 'upload', durationMs: ulMs }),
  ]);

  // A row of zeros is a number nobody measured: if nothing moved in either
  // direction the edge was unreachable, and that is a failed run, not a
  // 0 Mbps result.
  if (download.totalBytes === 0 && upload.totalBytes === 0) {
    throw new Error(
      `no bytes transferred (download errors=${download.errors}, upload errors=${upload.errors}) — speed.cloudflare.com unreachable?`,
    );
  }

  // Bufferbloat: worst latency increase under load across the directions
  // that produced samples, clamped at 0.
  const loaded = [loadedDownload, loadedUpload].filter((l) => l.samples > 0);
  const bloat = idle.samples > 0 && loaded.length
    ? Math.max(0, ...loaded.map((l) => l.median - idle.median))
    : null;
  // Stability: worst-of CV across directions.
  const cvs = [download.cvPct, upload.cvPct].filter((v) => v != null);
  const cvWorst = cvs.length ? Math.max(...cvs) : null;

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - t0),
    measId,
    meta: {
      ip: trace.ip ?? meta.clientIp ?? null,
      colo: trace.colo ?? meta.colo ?? null,
      loc: trace.loc ?? null,
      http: trace.http ?? null,
      tls: trace.tls ?? null,
      asn: meta.asn ?? null,
      asOrganization: meta.asOrganization ?? null,
      city: meta.city ?? null,
      country: meta.country ?? trace.loc ?? null,
    },
    latency: { ...idle, loadedDownload, loadedUpload },
    download,
    upload,
    quality: {
      bufferbloatMs: bloat == null ? null : round(bloat),
      bufferbloatGrade: bloat == null ? null : bufferbloatGrade(bloat),
      stabilityCvPct: cvWorst,
      stabilityGrade: cvWorst == null ? null : stabilityGrade(cvWorst),
    },
  };
}
