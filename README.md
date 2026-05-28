# cloudflare-speedtest-node

Lightweight Node.js daemon that runs Cloudflare speedtests on a fixed
schedule, persists the rolling history locally, and exposes it over a
small token-gated HTTP API. Standalone — it sits on a VPN node alongside
`xray` / `remnawave-node` and serves results to whoever polls it (the
aerio CRM panel is one such consumer, but the agent needs no panel to
run).

No third-party dependencies. Single Docker image, one persistent volume
for history. Clone, set `PORT` + `TOKEN` in `.env`, start — it runs on
its own.

## How it works

1. On boot, `src/index.js` loads `data/history.ndjson` into a ring
   buffer, looks up the node's public IP + location once via ip-api.com
   (this is its identity — no manual `SERVER_ID`), and starts a
   background scheduler. The IP and city/country are printed in the
   startup banner.
2. The scheduler runs a Cloudflare speedtest every `INTERVAL_MS`
   (default 30 min) with ±15 % jitter, stamps the node identity onto
   each result, appends it to the ndjson file, and trims the ring to
   `MAX_HISTORY` rows.
3. Any consumer pulls fresh data over HTTP using the node's `TOKEN`.
   The agent only makes outbound calls to `speed.cloudflare.com` (and
   ip-api.com once at boot) — it never initiates traffic to a consumer,
   it just waits to be polled.

## Endpoints

All routes return JSON. Everything except `/health` requires
`Authorization: Bearer <TOKEN>`.

| Route                     | Method | Notes                                                  |
| ------------------------- | ------ | ------------------------------------------------------ |
| `/health`                 | GET    | No auth. Returns scheduler state + history size.       |
| `/speedtest/last`         | GET    | Most recent cached result. 404 until the first run.    |
| `/speedtest/history`      | GET    | Rolling history. Query: `?since=<epoch_ms>&limit=<N>`. |
| `/speedtest`              | GET    | Force a fresh run. Shares in-flight scheduled runs.    |

## Quick start

```bash
cp .env.example .env
# edit .env:
#   TOKEN — your own shared secret:  openssl rand -hex 24
# (the node self-identifies by public IP + location — nothing else to set)
docker compose up -d --build

# probe from the host
curl http://localhost:9101/health
curl -H "Authorization: Bearer $TOKEN" http://localhost:9101/speedtest/last
```

The agent refuses to start if `TOKEN` is empty, so it can't accidentally
come up as an open API on a public port.

## Token rotation

The token is just a shared secret in this node's `.env`. To rotate:

1. Generate a new value (`openssl rand -hex 24`) and update `TOKEN`.
2. `docker compose up -d` to restart with it.
3. Update the same value in whatever consumer polls this node.

Until step 3 lands, that consumer will get 401s. Tokens never expire on
the agent side — rotate only when you want to.

## Bandwidth budget

Defaults (4 streams × 5 s download + 5 s upload) cost roughly
50–250 MB per run depending on the link's actual capacity. At the
default 30-minute cadence that's ~2–12 GB/day per node. Increase
`CONCURRENCY` / `DOWNLOAD_SEC` for higher fidelity, increase
`INTERVAL_MS` to spend less.

## Environment

See `.env.example` for the full list. The most common knobs:

| Var           | Default | Meaning                              |
| ------------- | ------- | ------------------------------------ |
| `TOKEN`       | (empty) | Shared bearer secret. **Required — agent won't start without it.** |
| `INTERVAL_MS` | 1800000 | Scheduler cadence (30 min).          |
| `JITTER_PCT`  | 0.15    | ±N % spread on each interval.        |
| `PORT`        | 9101    | Listening port (Prometheus exporter range, next to node_exporter on 9100). |
| `DATA_DIR`    | ./data  | History ndjson lives here.           |
| `MAX_HISTORY` | 1500    | Rows kept on disk + in memory.       |

## Local dev (no Docker)

```bash
npm install   # writes lockfile if missing; no deps to install
TOKEN=devtok INTERVAL_MS=120000 npm start
```
