# cloudflare-speedtest-node

Lightweight Node.js daemon that runs Cloudflare speedtests on a fixed
schedule, persists the rolling history locally, and exposes it over a
small token-gated HTTP API. Designed to sit on every aerio VPN node
alongside `xray` / `remnawave-node` and be polled by the aerio CRM.

No third-party dependencies. Single Docker image, one persistent volume
for history.

## How it works

1. On boot, `src/index.js` loads `data/history.ndjson` into a ring
   buffer and starts a background scheduler.
2. The scheduler runs a Cloudflare speedtest every `INTERVAL_MS`
   (default 30 min) with ±15 % jitter, appends each result to the
   ndjson file, and trims the ring to `MAX_HISTORY` rows.
3. The CRM panel pulls fresh data over HTTPS using the per-node
   `AUTH_TOKEN`. The agent never initiates outbound traffic to the CRM
   — it only talks to `speed.cloudflare.com`.

## Endpoints

All routes return JSON. Everything except `/health` requires
`Authorization: Bearer <AUTH_TOKEN>`.

| Route                     | Method | Notes                                                  |
| ------------------------- | ------ | ------------------------------------------------------ |
| `/health`                 | GET    | No auth. Returns scheduler state + history size.       |
| `/speedtest/last`         | GET    | Most recent cached result. 404 until the first run.    |
| `/speedtest/history`      | GET    | Rolling history. Query: `?since=<epoch_ms>&limit=<N>`. |
| `/speedtest`              | GET    | Force a fresh run. Shares in-flight scheduled runs.    |

## Quick start

```bash
cp .env.example .env
# edit .env: set SERVER_ID + AUTH_TOKEN
docker compose up -d --build

# probe from the host
curl http://localhost:9101/health
curl -H "Authorization: Bearer $AUTH_TOKEN" http://localhost:9101/speedtest/last
```

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
| `SERVER_ID`   | hostname | Stamped onto every result.           |
| `AUTH_TOKEN`  | (empty) | Bearer token. **Required in prod.**  |
| `INTERVAL_MS` | 1800000 | Scheduler cadence (30 min).          |
| `JITTER_PCT`  | 0.15    | ±N % spread on each interval.        |
| `PORT`        | 9101    | Listening port (Prometheus exporter range, next to node_exporter on 9100). |
| `DATA_DIR`    | ./data  | History ndjson lives here.           |
| `MAX_HISTORY` | 1500    | Rows kept on disk + in memory.       |

## Local dev (no Docker)

```bash
npm install   # writes lockfile if missing; no deps to install
AUTH_TOKEN=devtok SERVER_ID=local INTERVAL_MS=120000 npm start
```
