import { createServer } from 'node:http';
import { runSpeedtest } from './speedtest.js';

export function createAgent({ port, bind, authToken, cacheTtlMs, speedtestOpts, serverId }) {
  let cached = null; // { result, at }
  let inflight = null;

  const runOnce = () => {
    if (inflight) return inflight;
    inflight = (async () => {
      const result = await runSpeedtest(speedtestOpts);
      const payload = { serverId, ...result };
      cached = { result: payload, at: Date.now() };
      return payload;
    })();
    inflight.finally(() => { inflight = null; });
    return inflight;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, serverId, hasCache: !!cached, running: !!inflight });
      }

      if (!checkAuth(req, authToken)) {
        return send(res, 401, { error: 'unauthorized' });
      }

      if (req.method === 'GET' && url.pathname === '/speedtest/last') {
        if (!cached) return send(res, 404, { error: 'no cached result' });
        return send(res, 200, { ...cached.result, cached: true, ageMs: Date.now() - cached.at });
      }

      if (req.method === 'GET' && url.pathname === '/speedtest') {
        if (cached && cacheTtlMs > 0 && Date.now() - cached.at < cacheTtlMs) {
          return send(res, 200, { ...cached.result, cached: true, ageMs: Date.now() - cached.at });
        }
        const result = await runOnce();
        return send(res, 200, { ...result, cached: false });
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: String(err?.message || err) });
    }
  });

  return {
    listen: () => new Promise((resolve) => server.listen(port, bind, resolve)),
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}

function checkAuth(req, token) {
  if (!token) return true;
  const h = req.headers['authorization'];
  return typeof h === 'string' && h === `Bearer ${token}`;
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json)
  });
  res.end(json);
}
