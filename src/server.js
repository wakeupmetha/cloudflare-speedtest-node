import { createServer } from 'node:http';

// HTTP surface of the agent. The scheduler owns the run loop and the
// history store — this module only exposes them over a small REST API
// gated by a per-node bearer token.
//
//   GET /health                   liveness, no auth
//   GET /speedtest/last           last cached result
//   GET /speedtest/history        rolling history (?since=ms&limit=N)
//   GET /speedtest                force a fresh run (returns cached if
//                                 a scheduled run is in flight)
//
// Everything except /health requires `Authorization: Bearer <token>`.
// The token also doubles as the node's identity when the CRM panel
// pulls from many agents — there's exactly one valid token per agent
// and it's set via env at deploy time.
//
// Why not POST anywhere: the agent is read-only from the panel's
// perspective. The only side effect /speedtest can trigger is "run
// now"; we keep it on GET to make ad-hoc curl probes simple.

export function createAgent({ port, bind, authToken, scheduler, store, serverId }) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        const last = store.last();
        return send(res, 200, {
          ok: true,
          serverId,
          hasHistory: store.entries.length > 0,
          historyCount: store.entries.length,
          lastRunAt: last?.startedAt ?? null,
          nextRunAt: scheduler.nextRunAt,
          running: scheduler.running,
        });
      }

      if (!checkAuth(req, authToken)) {
        return send(res, 401, { error: 'unauthorized' });
      }

      if (req.method === 'GET' && url.pathname === '/speedtest/last') {
        const last = store.last();
        if (!last) return send(res, 404, { error: 'no result yet' });
        return send(res, 200, last);
      }

      if (req.method === 'GET' && url.pathname === '/speedtest/history') {
        const since = parseIntParam(url.searchParams.get('since'));
        const limit = parseIntParam(url.searchParams.get('limit'));
        const rows = store.query({ since, limit });
        return send(res, 200, {
          serverId,
          count: rows.length,
          rows,
        });
      }

      if (req.method === 'GET' && url.pathname === '/speedtest') {
        // On-demand run. Shares the in-flight promise with the scheduler
        // so concurrent callers don't kick off a second speedtest. The
        // caller waits for the actual result rather than returning the
        // cached one — they explicitly asked for a fresh measurement.
        const result = await scheduler.runOnce();
        return send(res, 200, result);
      }

      send(res, 404, { error: 'not found' });
    } catch (err) {
      send(res, 500, { error: String(err?.message || err) });
    }
  });

  return {
    listen: () => new Promise((resolve) => server.listen(port, bind, resolve)),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function checkAuth(req, token) {
  if (!token) return true;
  const h = req.headers['authorization'];
  return typeof h === 'string' && h === `Bearer ${token}`;
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
