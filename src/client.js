// Cloudflare speedtest endpoints. Request shape follows cloudflare-speed-cli
// (src/engine/cloudflare.rs): every request carries a per-run `measId`, the
// Referer the web client sends, and an identifying User-Agent. Latency probes
// during a throughput phase send `during=download|upload` instead of measId,
// which is how the upstream tells the two apart.

import { VERSION } from './version.js';

const BASE = 'https://speed.cloudflare.com';

export const USER_AGENT = `cloudflare-speedtest-node/${VERSION}`;

export function headers() {
  return { referer: `${BASE}/`, 'user-agent': USER_AGENT };
}

/** 16-digit numeric id, one per run — same shape the web client generates. */
export function newMeasId() {
  return String(Math.floor(1e15 + Math.random() * 9e15));
}

export function downloadUrl(bytes, measId, during) {
  const u = new URL('/__down', BASE);
  u.searchParams.set('bytes', String(bytes));
  if (during) u.searchParams.set('during', during);
  else if (measId) u.searchParams.set('measId', measId);
  return u.toString();
}

export function uploadUrl(measId) {
  const u = new URL('/__up', BASE);
  if (measId) u.searchParams.set('measId', measId);
  return u.toString();
}

export async function fetchTrace(signal) {
  const res = await fetch(`${BASE}/cdn-cgi/trace`, { signal, cache: 'no-store', headers: headers() });
  if (!res.ok) throw new Error(`trace ${res.status}`);
  const text = await res.text();
  const out = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out;
}

export async function fetchMeta(signal) {
  const res = await fetch(`${BASE}/meta`, { signal, cache: 'no-store', headers: headers() });
  if (!res.ok) throw new Error(`meta ${res.status}`);
  return res.json();
}
