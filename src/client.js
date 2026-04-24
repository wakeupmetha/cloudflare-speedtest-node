const BASE = 'https://speed.cloudflare.com';

export async function fetchTrace(signal) {
  const res = await fetch(`${BASE}/cdn-cgi/trace`, { signal, cache: 'no-store' });
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
  const res = await fetch(`${BASE}/meta`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`meta ${res.status}`);
  return res.json();
}

export function downloadUrl(bytes) {
  return `${BASE}/__down?bytes=${bytes}`;
}

export function uploadUrl() {
  return `${BASE}/__up`;
}
