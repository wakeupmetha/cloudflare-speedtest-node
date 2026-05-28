# CLAUDE.md

This file is the single source of truth for everything currently implemented in `cloudflare-speedtest-node`. It supersedes `README.md` for technical content.

> **Status: IN-DEV / NOT YET TESTED IN PRODUCTION (as of 2026-05-19).** Code is written end-to-end and compiles, but no agent has been deployed to a real VPN node, no panel has successfully polled this service, and the `aerio-crm` consumer side has been validated only against mock data. Treat every claim about "what happens at runtime" as a design contract, not a verified fact. The repo is referenced from `aerio-crm` and `aerio-v2` documentation as the per-node speedtest agent — that integration is **planned, not live**.

There are no separate spec files for this repo. When in-dev sections become tested-in-prod, update this file (clear the "Status" banner from each section).

---

## 0. Documentation maintenance protocol

**This file is the canonical reference for current implementation state.** Any code change that affects what is described here must update this file in the same PR. No exceptions, no parallel TODO lists.

### When you must touch CLAUDE.md in the same commit

- Adding/changing an HTTP endpoint → §4
- Changing the scheduler cadence, jitter logic, or in-flight sharing → §5
- Changing the storage format, compaction, or hydration → §6
- Adding/changing an env var → §7
- Changing the Dockerfile, docker-compose service, or healthcheck → §8
- Changing the auth model (token format, header name) → §1 + §4
- A section currently marked "in-dev" graduates to "tested" → clear the banner from that section and update §9

If your change doesn't fit cleanly into an existing section, the section needs restructuring — flag it in the PR description.

### What this protocol explicitly forbids

- Scattered `*.md` files describing implemented behavior (delete and absorb here).
- `TODO.md`. If the work is real, write a section in §9 (Known gaps) until done; if it's a one-line tweak, do it.
- Comments like `// TODO: refactor` without a referenced reason in §9.

The same protocol applies in sibling repos (`aerio-crm`, `aerio-v2`, `aerio-web`). Cross-repo features touch two CLAUDE.md files in the same atomic change.

---

## 1. Project at a glance

| Property | Value |
|---|---|
| Purpose | Per-node Cloudflare speedtest daemon. Runs scheduled throughput/latency probes, persists rolling history locally, exposes results over a token-gated HTTP API for the aerio CRM panel to poll. |
| Status | **in-dev, not deployed** |
| Language | Node.js (ES modules, no third-party dependencies) |
| Runtime | Node ≥ 18 (Dockerfile pins `node:20-alpine`) |
| Source size | 790 LOC across 11 modules ([src/](src/)) |
| HTTP port | **9101** (Prometheus exporter range — adjacent to `node_exporter` on 9100; signals "host-level metrics exporter" intent to anyone reading compose) |
| Storage | One ndjson file per node, ring-buffer-capped (default 1500 rows ≈ 31 days at 30-min cadence) |
| Outbound traffic | `speed.cloudflare.com` (every run) + `ip-api.com` (once at boot, for IP/geo identity). **Never initiates calls to a consumer** — consumers pull. |
| Deployment model | One agent per VPN node, alongside `xray` / `remnawave-node` containers |
| Sibling projects | `aerio-crm` (consumer, see §10), `aerio-v2` (panel; one possible consumer of this agent's API) |

### Integration contract with the aerio CRM (planned)

The agent exposes 4 routes on port 9101. The CRM's local Fastify service ([aerio-crm/services/api/src/pollers/speedtest.ts](../aerio-crm/services/api/src/pollers/speedtest.ts)) is expected to poll one specific route on a 60s cadence:

```
GET https://<node-host>:9101/speedtest/last
Authorization: Bearer <TOKEN>
```

Returns the most recent cached run as JSON, or `404 {"error": "no result yet"}` until the first scheduled run completes (default first delay 5s + 5s download + 5s upload + serialization ≈ 15s after boot).

The agent's `TOKEN` is a **shared secret set by the operator** in this node's `.env` — the agent owns its own token; nothing issues it. The agent runs fully standalone: clone the repo, set `PORT` + `TOKEN`, `docker compose up`, and it schedules runs and serves results on its own. A consumer (the CRM panel, a curl probe, any poller) authenticates by presenting the same `TOKEN`. Flow:

1. Operator generates a secret (`openssl rand -hex 24`) and sets `TOKEN` in `.env`
2. `docker compose up -d` — the agent starts and begins serving
3. Operator gives the same value to whatever will poll this node (e.g. the CRM panel's per-node config)

**Empty token is fatal:** the agent refuses to start with an empty `TOKEN` (fail-fast, `exit 1`) so it can never come up as an open API on a public port. See §4.

**Status:** the CRM panel still has per-node token storage on its side ([aerio-crm/src/server/repos/speedtest-tokens.ts](../aerio-crm/src/server/repos/speedtest-tokens.ts), [aerio-crm/src/server/actions/speedtest.ts](../aerio-crm/src/server/actions/speedtest.ts)), but that is now just the panel remembering the operator-set secret — the agent does not depend on it and is never told about it out of band. Never validated against a real agent. Token storage is scheduled to migrate to `aerio-v2/services/web-api` per the [drop-direct-db spec](../aerio-crm/docs/superpowers/specs/2026-05-19-crm-drop-direct-db-design.md); the agent-side contract is unaffected.

---

## 2. Local development

### Without Docker

```bash
npm install   # writes lockfile only — there are no third-party deps to install
TOKEN=devtok INTERVAL_MS=120000 npm start
```

The 2-minute interval is friendly for iteration. Floor enforced by the scheduler at 60s — anything below is silently raised.

```bash
curl http://localhost:9101/health
curl -H "Authorization: Bearer devtok" http://localhost:9101/speedtest/last
curl -H "Authorization: Bearer devtok" http://localhost:9101/speedtest
```

The agent will not boot without `TOKEN` set — an empty value is fatal (fail-fast, `exit 1`), printed as a framed error box.

### With Docker (matches production deployment)

```bash
cp .env.example .env
# Edit .env: set TOKEN (your own shared secret, openssl rand -hex 24).
# No SERVER_ID — the node self-identifies by IP/geo. See §1.
docker compose up -d --build
docker compose logs -f speedtest
```

The Docker image lives at `aerio/speedtest-agent:latest` (built locally by compose). The healthcheck inside the container hits `http://127.0.0.1:9101/health` every 30s.

### Scripts ([package.json](package.json))

| Script | Command | Purpose |
|---|---|---|
| `start` | `node src/index.js` | The only script — there's no test or build step today |

No tests, no linter, no formatter configured. Adding any of these is fair game; flag it in §9 if it stays unfinished across PRs.

---

## 3. Architecture — single Node process, three concerns

```
┌─────────────────────────────────────────────────────────────────┐
│  Node.js process (src/index.js)                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ HTTP server  ([src/server.js])                              │ │
│  │  • GET /health (no auth, returns scheduler state)           │ │
│  │  • GET /speedtest/last       (Bearer)                       │ │
│  │  • GET /speedtest/history    (Bearer)                       │ │
│  │  • GET /speedtest            (Bearer — force a fresh run)   │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ Scheduler ([src/scheduler.js])                              │ │
│  │  • setTimeout-based (NOT setInterval — no overlapping runs) │ │
│  │  • interval ± jitter %                                      │ │
│  │  • shares in-flight runs with on-demand callers             │ │
│  └────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ History store ([src/storage.js])                            │ │
│  │  • In-memory ring buffer (newest last)                      │ │
│  │  • Append-only ndjson on disk                               │ │
│  │  • Compacts when file grows past maxEntries × 2             │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
       │                                          ▲
       │ HTTPS to speed.cloudflare.com            │ HTTPS poll from panel
       ▼                                          │ (Bearer TOKEN)
   Cloudflare edge                            aerio-crm services/api
```

The three concerns share state through the `store` and `scheduler` objects, both constructed in [src/index.js](src/index.js) and passed by reference. Nothing is global; nothing reaches across processes.

Modules in [src/](src/):

| File | LOC | Responsibility |
|---|---|---|
| `index.js` | 85 | Boot — reads env, fail-fast on empty `TOKEN`, looks up IP/geo identity, constructs scheduler + store + HTTP server, prints the boot banner, wires SIGINT/SIGTERM |
| `throughput.js` | 116 | Multi-stream download + upload measurement |
| `storage.js` | 110 | ndjson read/write, ring buffer, compaction |
| `scheduler.js` | 109 | Run-loop, jitter, in-flight sharing, per-run pretty logging |
| `server.js` | 102 | HTTP routes and auth check |
| `format.js` | 84 | Pretty box-drawing terminal output — boot banner, per-run result/failure boxes, fatal box |
| `geo.js` | 47 | One-shot IP/location lookup via ip-api.com — the node's identity, in place of a manual SERVER_ID |
| `speedtest.js` | 47 | Orchestrates one run — calls latency + throughput, normalizes the result |
| `stats.js` | 37 | Mean / median / quartile helpers |
| `client.js` | 27 | Bare HTTP client for Cloudflare endpoints |
| `latency.js` | 26 | Latency + jitter samples (small HEAD requests to Cloudflare) |

**No third-party deps.** Everything uses Node's built-in `node:http`, `node:fs/promises`, `node:os`, `node:url`, `node:crypto`.

### Logging

The agent logs to stdout/stderr only (no log file; `docker compose logs` collects it). Output is framed with box-drawing characters so a local operator can read run results without the panel:

- **Boot banner** (`format.bootBanner`) — public IP + location (city, country), listen address, auth state, interval, history size.
- **Per-run box** (`format.runBox`, emitted by the scheduler) — run number, elapsed, download/upload median + min──max, latency median + jitter. Failures render a one-line `✗ failed <reason>` box.
- **Fatal box** (`format.fatalBox`) — printed to stderr when `TOKEN` is empty, immediately before `exit 1`.

There is **no HTTP access log** — requests (401/404/200) are silent. See §9 if that becomes a debugging need.

---

## 4. HTTP API

All routes return JSON. Everything except `/health` requires `Authorization: Bearer <TOKEN>` — exact, timing-unsafe string compare against the env value. The token is an opaque operator-set shared secret (not a JWT, nothing parses it). The agent refuses to start if `TOKEN` is empty, so there is no "open" code path: a missing token kills the process at boot rather than disabling auth.

> **Status:** endpoints are implemented and respond to requests in dev (verified: boot banner, `/health`, 401 on missing/bad token, 404 before first run, clean SIGTERM). **Not validated** against the CRM's actual poller code. The `aerio-crm` consumer ([repos/speedtest.ts](../aerio-crm/src/server/repos/speedtest.ts), [services/api/src/pollers/speedtest.ts](../aerio-crm/services/api/src/pollers/speedtest.ts)) expects the shapes below; deviation will break the integration silently.

### `GET /health` (no auth)

Liveness + scheduler state. The Docker HEALTHCHECK and a consumer's "is this agent alive" probe both hit this.

```json
{
  "ok": true,
  "node": { "ip": "104.28.193.219", "country": "Sweden", "countryCode": "SE", "region": "Stockholm County", "city": "Stockholm", "isp": "Cloudflare, Inc." },
  "hasHistory": true,
  "historyCount": 47,
  "lastRunAt": "2026-05-19T01:23:45.000Z",
  "nextRunAt": "2026-05-19T01:53:12.000Z",
  "running": false
}
```

`lastRunAt` is `null` until the first scheduled run completes. `running` is `true` while a speedtest is in flight. `node` is the IP/geo identity looked up once at boot via ip-api.com; if the lookup failed every field is `null` (plus an `error` string) — the agent still serves.

### `GET /speedtest/last` (Bearer)

Most-recent cached result. Returns `404 {"error": "no result yet"}` before the first run completes.

```json
{
  "node": { "ip": "104.28.193.219", "country": "Sweden", "countryCode": "SE", "region": "Stockholm County", "city": "Stockholm", "isp": "Cloudflare, Inc." },
  "startedAt": "2026-05-19T01:23:45.000Z",
  "finishedAt": "2026-05-19T01:23:58.000Z",
  "elapsedMs": 13002,
  "meta": { "ip": "104.28.193.219", "colo": "ARN", "loc": "SE", "http": "http/1.1", "tls": "TLSv1.3", "asn": null, "asOrganization": null, "city": null, "country": "SE" },
  "latency": { "mean": 12.4, "median": 11.8, "p25": 10.2, "p75": 13.9, "min": 9.7, "max": 18.4, "jitter": 1.6 },
  "download": { "mean": 920.1, "median": 918.5, "p25": 905.0, "p75": 935.4, "min": 880.2, "max": 950.8 },
  "upload":   { "mean": 480.3, "median": 482.0, "p25": 470.0, "p75": 490.1, "min": 455.0, "max": 502.0 }
}
```

All bandwidth fields are megabits per second. Latency is milliseconds. `node` is the IP/geo identity (ip-api.com, fixed for the process); `meta` is Cloudflare's per-run view of the connection (edge PoP `colo`, TLS/HTTP version, country code) — overlapping but distinct from `node`.

### `GET /speedtest/history?since=<epoch_ms>&limit=<N>` (Bearer)

Rolling history. Both query params are optional.

- `since` — return only rows where `Date.parse(startedAt) >= since`
- `limit` — return only the most recent N rows (after `since` filter)

```json
{
  "node": { "ip": "104.28.193.219", "country": "Sweden", "countryCode": "SE", "region": "Stockholm County", "city": "Stockholm", "isp": "Cloudflare, Inc." },
  "count": 12,
  "rows": [ /* same shape as /speedtest/last, newest LAST */ ]
}
```

Order is chronological (oldest first within the returned slice). Consumers that want only the freshest sample should sort by `startedAt` or read `/speedtest/last` instead.

### `GET /speedtest` (Bearer)

Force a fresh run. The scheduler's `runOnce()` shares in-flight runs — if a scheduled run is currently happening, the on-demand caller waits for the same Promise rather than starting a parallel test. Avoids two simultaneous speedtests slugging it out for the same upstream pipe.

Returns the result row (same shape as `/speedtest/last`).

**Warning:** a fresh run costs ~50–250 MB of bandwidth. Don't make this a hot path. The CRM panel reserves it for an explicit "Run now" button.

---

## 5. Scheduler ([src/scheduler.js](src/scheduler.js))

### Run loop

`setTimeout`-based, NOT `setInterval`. Each tick re-schedules itself only after the current run resolves, so a slow run can't overlap the next one. The pattern at [scheduler.js:75–92](src/scheduler.js):

```
start() → scheduleNext(firstDelayMs)
       └─ setTimeout(tick, delay)
              └─ tick(): await runOnce()
                     └─ runOnce(): runSpeedtest() → store.append(result)
                            └─ scheduleNext()   ← always; even on error
```

### Cadence

- **Default**: 30 min (`INTERVAL_MS=1800000`)
- **Floor**: 60s — any `INTERVAL_MS < 60_000` is silently raised in the constructor. Protects upstream Cloudflare edge from a misconfigured env.
- **First delay**: 5s (`FIRST_DELAY_MS`) — lets the container settle and the network come up before the first probe.
- **Jitter**: ±`JITTER_PCT` (default 0.15, i.e. ±15%) applied to every interval. A fleet of agents that boot at the same `docker compose up` doesn't all fire at the same second.

### In-flight sharing

`scheduler.runOnce()` caches the current Promise in `this.inflight`. Both the scheduled tick AND on-demand calls (`GET /speedtest`) await the same Promise — no parallel speedtests. The cache clears in the `finally` block after the run resolves.

### Error handling

Errors in `tick()` are caught and logged but never thrown — the loop must stay alive even if one run fails. Common failure modes:

- Transient network blip → next scheduled run usually succeeds
- Cloudflare rate-limit (rare with 30-min cadence) → propagates as an error, logged, next run after the regular interval
- Speedtest timeout → upstream lib enforces its own timeout; we just see a rejected Promise

History is unaffected by failed runs — only successful results land in the store. Each tick (success or failure) prints a framed result box via `format.runBox` — see §3 Logging.

---

## 6. Storage ([src/storage.js](src/storage.js))

### Format

Newline-delimited JSON (`history.ndjson`) inside `DATA_DIR` (default `./data` / `/data` in Docker). One result per line. Append-only on the hot path — `fs.appendFile()` after each speedtest.

### Ring buffer

In-memory `entries[]` array, newest last. Soft cap `maxEntries` (default 1500 rows). When the in-memory ring exceeds `maxEntries * 2`, the file is **compacted** (rewritten to match the ring), trimming the persistent file too.

Default 1500 rows × 30 min cadence ≈ **31 days of history**.

### Compaction (atomic rewrite)

[storage.js:104–112](src/storage.js):

1. Serialize the in-memory ring to `<file>.tmp`
2. `fs.rename(tmp, file)` — atomic on POSIX, best-effort on Windows

A crash mid-compact loses at most the last few runs — never corrupts the file. The next boot's `init()` re-hydrates from whatever ndjson exists, parses line-by-line, **skips malformed lines** (partial writes from a kill -9 mid-append).

### Cold start

On boot, [storage.js:42–63](src/storage.js):

1. `mkdir -p` the directory
2. Read the file (treat ENOENT as empty)
3. Parse each line, skip malformed ones, keep the newest `maxEntries`
4. If hydration dropped lines (malformed / truncation), compact once

### Read patterns

- `store.last()` — O(1), returns the newest entry or null
- `store.query({since, limit})` — O(n) on the in-memory ring (n ≤ 1500 by default). Fast enough; no indexing needed.

---

## 7. Environment variables

All read from `process.env` in [src/index.js](src/index.js). The Dockerfile sets `PORT=9101` and `DATA_DIR=/data`; compose passes the rest through.

There is **no `SERVER_ID`** — the node self-identifies by its public IP + location, looked up once at boot via `ip-api.com` (see [geo.js](src/geo.js)). If the lookup fails the node still runs; `node` reads as all-`null` with an `error` string. No env var controls this.

| Variable | Default | Required | Purpose |
|---|---|---|---|
| `TOKEN` | `""` | **required** | Operator-set shared secret, checked on every non-`/health` request (`Authorization: Bearer <TOKEN>`). An empty value is **fatal**: the agent prints a framed error box and exits 1 rather than booting as an open API. |
| `PORT` | `9101` | no | HTTP listen port. Sits in Prometheus exporter range. |
| `BIND` | `0.0.0.0` | no | Listen address. |
| `INTERVAL_MS` | `1800000` (30 min) | no | Scheduler cadence. Floor 60s enforced. |
| `JITTER_PCT` | `0.15` | no | ±N% spread on each interval. |
| `FIRST_DELAY_MS` | `5000` | no | Delay before the very first run. |
| `CONCURRENCY` | `4` | no | Parallel streams for download/upload. |
| `DOWNLOAD_SEC` | `5` | no | Download phase duration. |
| `UPLOAD_SEC` | `5` | no | Upload phase duration. |
| `LATENCY_SAMPLES` | `20` | no | Latency probes per run. |
| `DATA_DIR` | `./data` (Docker: `/data`) | no | Where `history.ndjson` lives. |
| `DATA_FILE` | `${DATA_DIR}/history.ndjson` | no | Override the full path. |
| `MAX_HISTORY` | `1500` | no | Soft cap on rows kept. |

### Bandwidth budget

Default settings (4 streams × 5s download + 5s upload) cost roughly **50–250 MB per run** depending on the link's actual capacity. At the default 30-minute cadence that's **~2–12 GB/day per node**.

- Increase `CONCURRENCY` / `DOWNLOAD_SEC` for higher fidelity → more bandwidth per run.
- Increase `INTERVAL_MS` to spend less → less timely data on the panel.

The defaults are tuned to be economical; raise them only when investigating capacity issues.

---

## 8. Build & deploy

### Dockerfile ([Dockerfile](Dockerfile))

Single-stage `node:20-alpine` image. ~30 lines:

1. `WORKDIR /app`
2. Copy `package.json`, run `npm install --omit=dev --no-audit --no-fund` (writes lockfile only — no real deps)
3. Copy `src/`
4. Set `DATA_DIR=/data`, `PORT=9101`, `EXPOSE 9101`
5. `HEALTHCHECK` hits `/health` every 30s
6. `CMD ["node", "src/index.js"]`

### docker-compose ([docker-compose.yml](docker-compose.yml))

One service `speedtest`, container name `aerio-speedtest`. Key bits:

- `build: .` — local build (no registry push today)
- `restart: unless-stopped`
- Env from `.env` (see §7)
- `ports: "${PUBLIC_PORT:-9101}:9101"`
- Named volume `speedtest-data:/data` for persistent history
- Healthcheck: `wget -qO- http://127.0.0.1:9101/health` every 30s

### Deployment topology (planned)

One container per VPN node, dropped alongside the existing `remnawave-node` + `xray-node` compose on each host. The agent itself doesn't know about siblings — it just listens and waits to be polled.

External access path (planned):

```
console.aerio.my (CRM Fastify)
       │ 60s poll
       ▼ Bearer <token>
https://<node-host>:9101/speedtest/last
```

The CRM's [services/api/src/pollers/speedtest.ts](../aerio-crm/services/api/src/pollers/speedtest.ts) iterates all known agents (from `speedtest_tokens` table joined with Remnawave node list), fetches `/speedtest/last`, and caches the result in-process for the panel UI. On 404 (agent not yet run), the existing cache row is kept but flagged stale.

---

## 9. Known gaps & in-dev status

What's NOT verified end-to-end as of 2026-05-19:

| Item | Current state | What needs to happen |
|---|---|---|
| **Live deployment on a real VPN node** | Never deployed. Compose tested only on a dev workstation. | Pick one node (e.g. `de-fra-1`), drop the compose alongside its existing `remnawave-node` stack, run for 24h, verify `history.ndjson` accumulates rows and the panel can poll. |
| **Token model** | **Resolved.** `TOKEN` is an opaque operator-set shared secret; empty is fatal at boot. No JWT parsing, no panel dependency. | Nothing — documented in §1/§4. If a future requirement needs signature validation, that's a new design. |
| **CRM → agent integration tested** | CRM poller code exists in [aerio-crm/services/api/src/pollers/speedtest.ts](../aerio-crm/services/api/src/pollers/speedtest.ts); never run against this agent. | First-node deploy is the integration test. Watch for shape mismatches between `/speedtest/last` response and what the poller parses. |
| **Token rotation flow** | Agent side is just an `.env` edit + `docker compose up -d` restart. Consumer must be updated with the same secret. | Walk through one rotation end-to-end. Document any rough edges here. |
| **Migration of token storage to web-api** | Planned per the [drop-direct-db spec](../aerio-crm/docs/superpowers/specs/2026-05-19-crm-drop-direct-db-design.md). | Consumer-side only — the agent contract is unaffected. Update §1/§10 to reflect the new owner once it ships. |
| **TLS termination** | Compose binds to `0.0.0.0:9101` plain HTTP. Consumers are expected to poll over HTTPS. | Either front the agent with Caddy on the node (recommended), or accept plain HTTP inside an internal network. Document the choice. |
| **Cloudflare API drift** | Uses `speed.cloudflare.com` endpoints; no version pinning. | If Cloudflare changes the API, the speedtest run breaks silently (logged, but history just stops growing). Worth a synthetic alert from the panel side once we know what "normal cadence" looks like. |
| **HTTP access log** | None — only the boot banner and per-run boxes are logged. Incoming requests (401/404/200) are silent. | When debugging the CRM integration, add a one-line request log in `server.js` (method, path, status, whether auth passed) so you can see whether the poller's calls arrive. |
| **Tests** | None. | Decide if `vitest` or `node:test` is worth adding — given ~730 LOC and the small surface, manual smoke after each behavioral change may be enough. |
| **Linter / formatter** | None. | Optional. Add or accept the current style. |
| **Bandwidth dashboard** | The panel renders speedtest snapshots but there's no "agents are eating X GB/day total" view. | If a node operator complains about traffic bills, build this. |

When an item ships → move it out of this table and into the relevant section above (clearing any "in-dev" banner there too).

---

## 10. Sibling repositories (orientation only)

This repo is a **leaf** in the Aerio architecture — it produces data, doesn't consume from anyone else (except `speed.cloudflare.com`).

| Repo | Relationship |
|---|---|
| [`aerio-crm`](../aerio-crm) | **Consumer** — its [services/api](../aerio-crm/services/api/) Fastify polls `/speedtest/last` on every registered node; its [src/server/actions/speedtest.ts](../aerio-crm/src/server/actions/speedtest.ts) handles `AUTH_TOKEN` rotation. Detail: [aerio-crm/CLAUDE.md §4](../aerio-crm/CLAUDE.md). |
| [`aerio-v2`](../aerio-v2) | **Future owner of the token registry** — per drop-direct-db spec, `speedtest_tokens` table writes move from CRM to `aerio-v2/services/web-api`. Detail: [aerio-v2/CLAUDE.md §4](../aerio-v2/CLAUDE.md). |
| Remnawave node | **Co-located** — same host, parallel container. No direct communication. Pairing is by public IP / geo (this agent self-reports it); a consumer correlates the two by host/IP rather than a shared name. |
| `aerio-web` | No interaction. Customer cabinet never touches the speedtest layer. |
| Cloudflare | **Upstream** — `speed.cloudflare.com` is where this agent measures against. No auth required for the speedtest endpoints; public. |

For any change that affects the wire format (`/speedtest/*` response shape, `Authorization` header semantics, port number), the CRM-side consumer must be updated in the same coordinated change. The CRM CLAUDE.md §4 + this file together are the contract.
