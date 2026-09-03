// Local HTTP surface of the agent — for the docker healthcheck and for a
// person with a shell on the node. The panel does NOT read this: results
// travel outbound in the heartbeat (panel.js). It binds to 127.0.0.1 by
// default; set BIND=0.0.0.0 to expose it.
//
//   GET /health                   liveness + scheduler + pairing state, no auth
//   GET /speedtest/last           last cached result
//   GET /speedtest/history        rolling history (?since=ms&limit=N)
//   GET /speedtest                force a fresh run (shares an in-flight one)
//   GET /geocheck/last            last geocheck digest
//   GET /geocheck                 force a geocheck run
//
// Everything except /health requires `Authorization: Bearer <TOKEN>`.
// One access-log line per request; /health 2xx is silent (the healthcheck
// probes it every 30 s).

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export function createAgent({ port, bind, token, log, store, speedtest, geocheck, panel, node, version }) {
  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, 'http://localhost');
    let auth = 'n/a';
    const done = (status, body) => {
      send(res, status, body);
      if (url.pathname === '/health' && status < 300) return;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      log[level](`${req.method} ${url.pathname} ${status}`, { ms: Date.now() - t0, auth });
    };

    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        const last = store.last();
        return done(200, {
          ok: true,
          version,
          node,
          hasHistory: store.entries.length > 0,
          historyCount: store.entries.length,
          lastRunAt: last?.startedAt ?? null,
          nextRunAt: speedtest.nextRunAt,
          running: speedtest.running,
          panel: panel ? panel.status() : null,
          geocheck: geocheck
            ? { enabled: true, lastRunAt: geocheck.scheduler.lastRunAt, nextRunAt: geocheck.scheduler.nextRunAt, running: geocheck.scheduler.running, hasResult: !!geocheck.last() }
            : { enabled: false },
        });
      }

      auth = checkAuth(req, token) ? 'ok' : 'bad';
      if (auth === 'bad') return done(401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/speedtest/last') {
        const last = store.last();
        if (!last) return done(404, { error: 'no result yet' });
        return done(200, { node, ...last });
      }

      if (req.method === 'GET' && url.pathname === '/speedtest/history') {
        const since = parseIntParam(url.searchParams.get('since'));
        const limit = parseIntParam(url.searchParams.get('limit'));
        const rows = store.query({ since, limit });
        return done(200, { node, count: rows.length, rows });
      }

      if (req.method === 'GET' && url.pathname === '/speedtest') {
        const result = await speedtest.runOnce();
        return done(200, { node, ...result });
      }

      if (req.method === 'GET' && url.pathname === '/geocheck/last') {
        if (!geocheck) return done(404, { error: 'geocheck disabled on this agent' });
        const last = geocheck.last();
        if (!last) return done(404, { error: 'no result yet' });
        return done(200, last);
      }

      if (req.method === 'GET' && url.pathname === '/geocheck') {
        if (!geocheck) return done(404, { error: 'geocheck disabled on this agent' });
        return done(200, await geocheck.scheduler.runOnce());
      }

      done(404, { error: 'not found' });
    } catch (err) {
      done(500, { error: String(err?.message || err) });
    }
  });

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bind, () => { server.off('error', reject); resolve(); });
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function checkAuth(req, token) {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return false;
  const a = Buffer.from(h);
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseIntParam(v) {
  if (v == null) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}
