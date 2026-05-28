// One-shot lookup of this node's public IP + location via ip-api.com.
//
// Called once at boot: a VPN node's IP/location is static for the
// process lifetime, so we cache the result and stamp it onto every
// speedtest row and the /health payload — there's no manual SERVER_ID.
//
// ip-api.com free tier is HTTP-only and rate-limited (~45 req/min); we
// call it once per process, so that's well within budget. The lookup is
// best-effort: on any failure the node still runs and location reads as
// "unknown" — geo is informational, not load-bearing like TOKEN.

const ENDPOINT =
  'http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,isp';

const UNKNOWN = Object.freeze({
  ip: null,
  country: null,
  countryCode: null,
  region: null,
  city: null,
  isp: null,
});

export async function fetchGeo({ timeoutMs = 5000, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(ENDPOINT, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`ip-api ${res.status}`);
      const j = await res.json();
      if (j.status !== 'success') throw new Error(j.message || 'lookup failed');
      return {
        ip: j.query ?? null,
        country: j.country ?? null,
        countryCode: j.countryCode ?? null,
        region: j.regionName ?? null,
        city: j.city ?? null,
        isp: j.isp ?? null,
      };
    } catch (e) {
      if (attempt >= retries) return { ...UNKNOWN, error: e?.message || String(e) };
    } finally {
      clearTimeout(t);
    }
  }
}
