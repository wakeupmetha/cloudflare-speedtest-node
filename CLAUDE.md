# CLAUDE.md

This file is the single source of truth for everything currently implemented in `cloudflare-speedtest-node` (the container is called `aerio-agent`). It supersedes `README.md` for technical content.

> **Status (2026-09-03): v2, push model. Wire contract validated by tests and by a local end-to-end run against the panel, not yet by a production node.** Every module has `node --test` coverage and the measurement path has been run live against `speed.cloudflare.com`. What has NOT happened: a real VPN node running the published image for a day. Clear this banner when that has.

There are no separate spec files in this repo. The cross-repo design that produced v2 is folded into the panel's docs: [aerio-crm/CLAUDE.md §4](../aerio-crm/CLAUDE.md) (registry, wire contract) and §8 (`/nodes` block); the implementation plan is kept at `aerio-crm/docs/superpowers/plans/2026-09-03-speedtest-agent-v2.md`.

---

## 0. Documentation maintenance protocol

**This file is the canonical reference for current implementation state.** Any code change that affects what is described here must update this file in the same PR. No exceptions, no parallel TODO lists.

### When you must touch CLAUDE.md in the same commit

- Changing the heartbeat body / response, or the local HTTP routes → §4
- Changing a scheduler's cadence, floor, jitter or in-flight rule → §5
- Changing the storage format, compaction, or the geocheck digest file → §6
- Adding/changing an env var → §7
- Changing the Dockerfile, compose, `install.sh`, the workflow or the healthcheck → §8
- Changing a log line an operator is told to grep for → §9
- Changing how a number is measured → §10 (and say which upstream behaviour it now matches or departs from)
- A "not yet" in §11 becomes "done" → move it into the section that owns it

### What this protocol forbids

- Scattered `*.md` files describing implemented behaviour (delete and absorb here).
- `TODO.md`, or `// TODO` comments without a §11 entry.

The same protocol applies in `aerio-crm`; the heartbeat contract is documented on BOTH sides (§4 here, §4/§6.2 there) and changes in one atomic cross-repo change.

---

## 1. Project at a glance

| Property | Value |
|---|---|
| Purpose | Per-node agent: Cloudflare speedtest on a schedule + service-availability checks via `remnawave/geocheck`, reported to the aerio panel over an **outbound** heartbeat. Beszel-style install: the panel mints a token and shows the `docker run` line. |
| Language | Node.js ≥ 20, ES modules, **no third-party dependencies** (`node:*` only) |
| Source | ~1 650 LOC in [src/](src/), 15 modules; tests in [test/](test/) (`node --test`, no framework) |
| Image | `ghcr.io/wakeupmetha/cloudflare-speedtest-node:latest` (multi-arch, built by [.github/workflows/docker.yml](.github/workflows/docker.yml)); bundles the `geocheck` binary copied from `remnawave/geocheck` |
| Install | Two commands, both printed by the panel with the token in them: `docker run …`, or [install.sh](install.sh) for a systemd unit under `/opt/aerio-agent`. Both need this repo **public** (§11). |
| Local port | **9101**, **loopback only** by default — the panel never reads it |
| Storage | `/data/history.ndjson` (ring, 1500 rows ≈ 31 days) + `/data/geocheck.json` (last digest) |
| Outbound traffic | `speed.cloudflare.com` (each run), `ip-api.com` (once at boot), `PANEL_URL` (every 30 s), the ~40 hosts geocheck probes (every 6 h) |
| Consumer | `aerio-crm` — `services/api` ingests `POST /agent/heartbeat`; `/nodes` renders it. Detail: [aerio-crm/CLAUDE.md §4](../aerio-crm/CLAUDE.md) |

### Pairing in one paragraph

The panel stores one opaque secret per Remnawave node name (`admin.speedtest.tokens` in aerio-v2's `global_settings`). The agent presents that secret as `Authorization: Bearer` on every heartbeat; the panel resolves **token → node name** with a constant-time compare, so the agent never states its own name and cannot claim another node's. The agent's self-reported public IP is cross-checked against the Remnawave node address; a mismatch is a warning on both ends, not a rejection.

---

## 2. Local development

```bash
npm test                                            # 25 tests, ~3 s
TOKEN=devtok node src/index.js                      # standalone: no push, local API only
TOKEN=devtok PANEL_URL=http://localhost:3030 INTERVAL_MS=120000 node src/index.js   # against a local panel
```

The panel side for the last line: `npm run dev` + `npm run dev:api` in `aerio-crm`, then generate a token on `http://localhost:3030/nodes` for a Remnawave node and use it as `TOKEN`. Within 30 s the card shows `agent v0.2.0 · seen just now`.

`geocheck` is not on a dev machine's PATH unless you put it there (`go install github.com/remnawave/geocheck/cmd/geocheck@latest`); without it the agent logs one WARN and runs speedtests only.

Probing the local API:

```bash
curl -s localhost:9101/health | jq .panel          # {url, paired, node, lastOkAt, lastError}
curl -s -H "Authorization: Bearer devtok" localhost:9101/speedtest/last
```

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ node process (src/index.js — composition only)               │
│                                                              │
│  Scheduler "speedtest"  ── runSpeedtest() ──▶ HistoryStore   │
│     every INTERVAL_MS ± jitter                    (ndjson)   │
│  Scheduler "geocheck"   ── runGeocheck()  ──▶ geocheck.json  │
│     every GEOCHECK_INTERVAL_MS ± jitter                      │
│  panel client ── POST PANEL_URL/api/agent/heartbeat ─────────┼──▶ aerio-crm
│     every HEARTBEAT_MS + after every run    ◀── {commands}   │
│  http server (127.0.0.1:9101) — healthcheck + curl           │
└──────────────────────────────────────────────────────────────┘
```

| File | Responsibility |
|---|---|
| `index.js` | env → fail-fast → store → geo identity → the two schedulers → panel client → local API → banner → signals |
| `scheduler.js` | Generic jittered `setTimeout` loop; `runOnce()` shares the in-flight promise; `onDone`/`onError` hooks are contained |
| `speedtest.js` | One run: meta → idle latency → download ∥ loaded latency → upload ∥ loaded latency → quality grades |
| `throughput.js` | N-stream download/upload with 200 ms rate sampling, ramp-up exclusion, backoff, 429 halving, upload rollback |
| `latency.js` | Duration-based RTT probe loop (`/__down?bytes=0`), warm-up excluded, injectable `probe` for tests |
| `client.js` | Cloudflare URLs + headers (`measId`, `during=`, Referer, User-Agent), `/cdn-cgi/trace`, `/meta` |
| `stats.js` | summary / stddev / CV / percentiles / bufferbloat + stability grades (upstream constants) |
| `geocheck.js` | `execFile` the binary with `--json --quiet …`, **digest** the report, persist |
| `panel.js` | Heartbeat client: transition logging, command dispatch, `status()` for `/health` |
| `server.js` | Local routes, Bearer check (timing-safe), one access-log line per request |
| `storage.js` | ndjson ring buffer with compaction (unchanged from v1) |
| `geo.js` | One-shot ip-api.com identity lookup (unchanged) |
| `log.js` | Line logger — port of aerio-crm `src/server/log.ts` |
| `format.js` | Boot banner + per-run result box (the two framed outputs) |
| `version.js` | `VERSION` from package.json |
| `install.sh` | Not part of the running agent: the systemd installer the panel hands out (§8) |

---

## 4. Wire contract

### Heartbeat — `POST ${PANEL_URL}/api/agent/heartbeat`

Headers: `Authorization: Bearer <TOKEN>`, `Content-Type: application/json`, `User-Agent: cloudflare-speedtest-node/<ver>`. 10 s timeout. Sent every `HEARTBEAT_MS`, immediately at boot, right after every speedtest run (success or failure — the failure travels as `lastRunError`), and after every **successful** geocheck run. A failed geocheck run only logs: the body has no field for it, and the previous digest stays valid.

```jsonc
{
  "agent": { "version": "0.2.0", "startedAt": "…", "heartbeatMs": 30000, "intervalMs": 1800000, "geocheckIntervalMs": 21600000, "geocheck": true },
  "node": { "ip": "203.0.113.10", "country": "Germany", "countryCode": "DE", "region": "Hesse", "city": "Frankfurt", "isp": "Hetzner" },
  "running": false, "nextRunAt": "…", "lastRunAt": "…",
  "lastRunError": null,                 // reason of the newest FAILED run; null after a success
  "last": { …speedtest row, §4 below… } | null,
  "geocheck": { …digest, §4 below… } | null
}
```

Response `200`:

```jsonc
{ "ok": true, "node": "de-fra-1", "commands": ["speedtest"], "expectedIp": "203.0.113.10" | null }
```

- `commands` — each is run once through the matching scheduler's `runOnce()` (in-flight shared), **not awaited** by the heartbeat: the run's completion pushes its own heartbeat.
- `expectedIp` — the Remnawave node address when it is an IP literal; a mismatch with `node.ip` logs one WARN per distinct value.
- `401 {error:"unknown_token", hint}` — logged at ERROR once and every 10 min while it persists.
- any other failure — WARN on transition, DEBUG while it persists, INFO `paired as` on recovery with `after=<seconds>`.

### Speedtest row (one history line; `last` in the heartbeat)

```jsonc
{
  "startedAt": "…", "finishedAt": "…", "elapsedMs": 14120, "measId": "8391027364512830",
  "meta": { "ip", "colo", "loc", "http", "tls", "asn", "asOrganization", "city", "country" },
  "latency": { "mean", "median", "p25", "p75", "min", "max", "jitter", "samples", "sent", "lost",
               "loadedDownload": { …same summary… }, "loadedUpload": { …same summary… } },
  "download": { "mbps", "mean", "median", "p25", "p75", "min", "max", "cvPct", "samples", "totalBytes", "durationMs", "errors" },
  "upload":   { …same… },
  "quality":  { "bufferbloatMs", "bufferbloatGrade", "stabilityCvPct", "stabilityGrade" }
}
```

`mbps` is the steady-state **mean** (the panel's headline); `median`/quartiles ride along. Bandwidth in Mbit/s, latency in ms. `node` is NOT stamped on rows any more (it is per-process and travels in the heartbeat); the local `/speedtest/last` still returns `{node, …row}`.

### geocheck digest (`geocheck` in the heartbeat)

```jsonc
{
  "ranAt": "…", "durationMs": 21450, "tool": "geocheck 0.3.0", "schema": 1,
  "ip": "203.0.113.10", "asn": 24940, "asName": "Hetzner Online GmbH",
  "country": { "code": "DE", "name": "Germany", "percent": 92.5 } | null,      // consensus.ipv4[0]
  "reputation": { "type": "hosting", "risk": 33, "vpn": false, "proxy": false, "tor": false, "hosting": true, "flags": ["hosting"] } | null,
  "services": [ { "id": "netflix_access", "name": "Netflix", "state": "available|restricted|blocked|error", "region"?: "DE", "detail"?: "…" } ],
  "findings": [ { "id", "title", "severity", "detail" } ],
  "summary": { "available": 11, "restricted": 1, "blocked": 2, "error": 0 }
}
```

`services` = `stash_checks` ∪ `ai_endpoints` (`reachable`→`available`) ∪ `geo.services` rows of kind `availability` (`yes`→available, `no`→blocked) or `blocked` (`yes`→blocked, `no`→available); an `error` field → `error`; country-kind rows are dropped. [geocheck.js](src/geocheck.js) is the only place that knows geocheck's schema (`internal/render/json.go`, schema 1); a different `schema` is digested best-effort and logged.

### Local HTTP API (loopback)

| Route | Auth | Returns |
|---|---|---|
| `GET /health` | none | `{ok, version, node, hasHistory, historyCount, lastRunAt, nextRunAt, running, panel: {url, paired, node, lastOkAt, lastError} \| null, geocheck: {enabled, lastRunAt, nextRunAt, running, hasResult} \| {enabled:false}}` |
| `GET /speedtest/last` | Bearer | `{node, …row}` · 404 before the first run |
| `GET /speedtest/history?since=<ms>&limit=<n>` | Bearer | `{node, count, rows[]}` oldest-first |
| `GET /speedtest` | Bearer | force a run; shares an in-flight one; 500 with the reason on failure |
| `GET /geocheck/last` | Bearer | digest · 404 when none / disabled |
| `GET /geocheck` | Bearer | force a geocheck run |

Bearer is compared with `crypto.timingSafeEqual`. One access-log line per request (`GET /speedtest/last 401  ms=1 auth=bad`); `/health` 2xx is silent.

---

## 5. Schedulers ([src/scheduler.js](src/scheduler.js))

One class, two instances. `setTimeout`-based: the follow-up is scheduled only after the current run resolves, so runs never overlap. `intervalMs ± jitterPct`. `runOnce()` returns the in-flight promise when one exists — a tick, an on-demand HTTP call and a panel command that coincide share one run. `onDone` / `onError` are hooks; their own exceptions are logged and never break the loop. `intervalMs = 0` disables `start()` (used by `GEOCHECK_INTERVAL_MS=0`); `runOnce()` still works.

| Instance | Cadence | Floor | First run | On done | On error |
|---|---|---|---|---|---|
| `speedtest` | `INTERVAL_MS` (30 min) | 60 s | `FIRST_DELAY_MS` (5 s) | append to history, INFO line + result box, heartbeat | `lastRunError`, WARN + failed box, heartbeat |
| `geocheck` | `GEOCHECK_INTERVAL_MS` (6 h) | 10 min | 60 s | save digest, INFO line, WARN listing blocked names, heartbeat | WARN with stderr head; previous digest kept |

A speedtest and a geocheck may overlap: geocheck is ~40 small HTTPS requests and does not move the throughput number.

---

## 6. Storage ([src/storage.js](src/storage.js), [src/geocheck.js](src/geocheck.js))

`history.ndjson` in `DATA_DIR` — append-only ring, `MAX_HISTORY` rows, compacted (tmp + atomic rename) when the file exceeds 2×; malformed lines skipped on hydration. Unchanged from v1.

`geocheck.json` next to it — the last digest, written tmp + rename after every successful geocheck run and restored at boot so the panel is not blank for up to `GEOCHECK_INTERVAL_MS` after a container recreate.

---

## 7. Environment variables

| Variable | Default | Notes |
|---|---|---|
| `TOKEN` | — | **required**; empty is fatal (framed error, exit 1) |
| `PANEL_URL` | `""` | panel origin; must start with `http(s)://`; empty ⇒ standalone (WARN at boot, no push) |
| `HEARTBEAT_MS` | `30000` | floor 5 s |
| `INTERVAL_MS` · `JITTER_PCT` · `FIRST_DELAY_MS` | `1800000` · `0.15` · `5000` | speedtest cadence (floor 60 s) |
| `CONCURRENCY` · `DOWNLOAD_SEC` · `UPLOAD_SEC` | `4` · `5` · `5` | upstream defaults are 6 · 10 · 10 |
| `LATENCY_SEC` · `PROBE_INTERVAL_MS` · `PROBE_TIMEOUT_MS` | `2` · `250` · `2000` | idle-latency window and probe cadence (upstream values). **`LATENCY_SAMPLES` is gone.** |
| `DOWNLOAD_BYTES_PER_REQ` · `UPLOAD_BYTES_PER_REQ` | `10000000` · `5000000` | upstream values (v1 used 25 MB / 10 MB) |
| `GEOCHECK_BIN` | `geocheck` | bare name is searched on PATH; docker sets `/usr/local/bin/geocheck`; not found ⇒ one WARN, feature off |
| `GEOCHECK_INTERVAL_MS` | `21600000` | floor 10 min; `0` disables |
| `GEOCHECK_ARGS` | `--no-mtr --no-detect -4 -t 8` | appended after `--json --quiet` |
| `PORT` · `BIND` | `9101` · `127.0.0.1` | **BIND changed from `0.0.0.0` in v2** |
| `DATA_DIR` · `DATA_FILE` · `MAX_HISTORY` | `./data` (docker `/data`) · `${DATA_DIR}/history.ndjson` · `1500` | |
| `LOG_LEVEL` · `LOG_JSON` · `LOG_COLOR` · `NO_COLOR` · `LOG_SERVICE` | `info` · unset · unset · unset · `aerio-agent` | same semantics as aerio-crm §12 |

Bandwidth: **a run moves whatever the link can carry for 10 s** — the phases are
timed, not sized, so the cost scales with the node's speed rather than being
capped. Measured 2026-09-03 on a 400–570 Mbit link: **591 MB and 711 MB** for two
consecutive runs (avg 651 MB), i.e. **~31 GB/day/node** at the 30 min default and
~940 GB/month. A gigabit node costs about double that. This paragraph claimed
“~50–250 MB per run ⇒ 2–12 GB/day” until that measurement; the estimate was
3–15× low. Cut it with `INTERVAL_MS` first (capacity does not change every
30 min), then `DOWNLOAD_SEC`/`UPLOAD_SEC`/`CONCURRENCY`. geocheck is a few MB per
run and the heartbeat is ~1 KB every 30 s — neither is worth tuning.

---

## 8. Build & deploy

- [Dockerfile](Dockerfile): `FROM ${GEOCHECK_IMAGE:-remnawave/geocheck:latest} AS geocheck` → `node:20-alpine`, copies `/usr/local/bin/geocheck`, `USER node`, `BIND=127.0.0.1`, no `npm install` layer (zero deps). Healthcheck `wget /health` every 30 s.
- [docker-compose.yml](docker-compose.yml): one service `agent` (container `aerio-agent`), image from GHCR with `build: .` for local builds, `env_file: .env` (so every knob in `.env.example` reaches the container; the `environment:` block only carries defaults), **no `ports:`**, named volume `agent-data:/data`.
### `install.sh` — the no-Docker path

The panel's dialog offers a second install line, shaped like Beszel's, with
the same two values in it (`-t <token>`, `-url <panel>`):

```bash
curl -sL https://raw.githubusercontent.com/wakeupmetha/cloudflare-speedtest-node/main/install.sh -o /tmp/aerio-agent-install.sh \
  && chmod +x /tmp/aerio-agent-install.sh \
  && sudo /tmp/aerio-agent-install.sh -t "<token>" -url "https://console.aerio.my"
```

What it does, in order: validate the token/URL, refuse anything that is not
Linux+systemd or not root, pick the arch, **reuse the host's node when it is
≥ 20** and otherwise download the pinned official tarball into
`$PREFIX/node` (checksum-verified against `SHASUMS256.txt`), fetch the agent
source from the repo archive, fetch `geocheck` from its own releases
(checksum-verified against `checksums.txt`), create the `aerio-agent` system
user, write `/etc/aerio-agent.env` at `0600 root:root`, write the unit, and
`enable --now`.

- **The token is in the env file, not the unit.** `systemctl cat` and
  `systemd-analyze` print the unit to any user; `EnvironmentFile` is read by
  systemd itself before privileges are dropped, so `0600 root:root` is both
  safe and sufficient.
- **The unit is hardened** — `NoNewPrivileges`, `PrivateTmp`,
  `ProtectSystem=strict`, `ProtectHome`, and `ReadWritePaths=$PREFIX/data`,
  which is the only path the agent writes.
- **Re-running is the upgrade and the rotation.** It replaces `app/`,
  rewrites the env file and restarts; `data/` is untouched.
- **`--uninstall`** stops and removes the unit, the env file and the code,
  keeping `data/` unless `--purge`. Flags: `--interval`, `--geocheck-interval`,
  `--no-geocheck`; env overrides `NODE_VERSION` (pinned, one line to bump),
  `PREFIX`, `AERIO_AGENT_REPO`, `AERIO_AGENT_REF`.
- It warns when a Docker `aerio-agent` is already running on the host: two
  agents sharing one token both report as the same node.

Validated on macOS only — every argument and error path, plus a live
download+checksum+extract of the real `geocheck_linux_amd64` asset. The
systemd half has never run (§11).

- [.github/workflows/docker.yml](.github/workflows/docker.yml): `npm test` on every push/PR (also `workflow_dispatch`); on `main` and `v*` tags builds `linux/amd64,linux/arm64` and pushes `ghcr.io/wakeupmetha/cloudflare-speedtest-node:{latest, X.Y.Z, X.Y}` — no per-commit tags, the `revision` label carries the sha. First run on 2026-09-03 (run 33735983736) was green; the package is created **private** by GitHub's default and must be flipped to public once in the package settings, or every node needs `docker login ghcr.io`.
- The install line the panel shows (needs the image published — first push to `main` does that):

```bash
docker run -d --name aerio-agent --restart unless-stopped \
  -e PANEL_URL=https://console.aerio.my -e TOKEN=<token> \
  -v aerio-agent-data:/data ghcr.io/wakeupmetha/cloudflare-speedtest-node:latest
```

No inbound port, no TLS on the node: the agent only connects out. Rotation: rotate on `/nodes`, edit `.env`, `docker compose up -d`.

---

## 9. Logs

Format is aerio-crm's ([src/log.js](src/log.js) is a port of its `src/server/log.ts`): `HH:MM:SS  LEVEL  module  message  k=v …`, module tags `boot speedtest geocheck panel http`, colour unless `NO_COLOR`/`LOG_COLOR=0`, `LOG_JSON=1` for one object per line (boxes are then suppressed). Fields whose name looks like a credential print `<set>`/`<unset>`.

The framed **boot banner** and the per-run **result box** ([src/format.js](src/format.js)) are the two exceptions to "one line per event".

Lines an operator is told to look for (README says the same):

| Line | When |
|---|---|
| `INFO   panel   paired as "<node>"  url=… rtt=…` | first accepted heartbeat, and again on recovery with `after=<s>` |
| `ERROR  panel   token rejected by panel — regenerate it on /nodes and restart the agent` | 401; once, then every 10 min |
| `WARN   panel   unreachable  err="fetch failed: ECONNREFUSED" next=30s` | on transition; DEBUG while it persists |
| `WARN   panel   node address mismatch — is this token for this node?  reported=… panelExpects=…` | once per distinct expected IP |
| `INFO   panel   command received  cmd=speedtest` | a "Run now" from the panel |
| `INFO   speedtest  run #N done  dl= ul= lat= jitter= bloat= stability= colo= elapsed=` · `WARN … had failed requests` · `WARN … failed  err=` | every run |
| `INFO   geocheck   run #N done  available= restricted= blocked= country= reputation=` · `WARN  blocked: <names>` · `WARN  binary not found` · `WARN  run #N failed  err=` | every geocheck run |
| `INFO/WARN  http  GET /path <status>  ms= auth=ok\|bad` | every local request except `/health` 2xx |

---

## 10. Measurement — parity with cloudflare-speed-cli

Read from the upstream's `src/engine/*.rs`, `metrics.rs`, `quality.rs`, `constants.rs`, `cli.rs` (2026-09-03). Each row states what the agent does now.

| Behaviour | Agent |
|---|---|
| Idle latency probed for a duration (2 s) at 250 ms, 2 s timeout, warm-up excluded | same (`latency.js`) |
| Jitter = sample stddev | same (`stats.stddev`) |
| Loaded latency during download and upload (`during=download\|upload`), reported separately | same (`latency.loadedDownload/loadedUpload`) |
| Bufferbloat = max(loaded median − idle median), grades A+/A/B/C/D/F at 5/30/60/200/400 ms | same (`quality.bufferbloat*`) |
| Stability = worst-of CV % of steady-state throughput, A/B/C/D/F at 5/10/20/35 %, ≥3 samples | same (`quality.stability*`, `download.cvPct`) |
| Steady state excludes max(20 %, 1 s) ramp-up; whole phase when no usable window | same |
| Headline mbps = steady-state mean | same (`download.mbps`) |
| `measId` per run, `Referer`, identifying User-Agent | same (`client.js`) |
| Failed request ⇒ 100 ms backoff; 429 ⇒ halve download request size (floor 100 KB) | same; failures counted in `errors` |
| Failed upload ⇒ bytes taken back out of the counter | same (not on the phase-end abort — those bytes went out) |
| Meta from `cf-meta-*` headers | **differs**: `/cdn-cgi/trace` + `/meta` (both still answer; same fields) |
| UDP packet loss via TURN | **not ported** (§11) |
| Defaults 10 s × 6 streams, 10 MB / 5 MB per request | **differs on purpose**: 5 s × 4 (egress budget); request sizes match |
| A run that moved no bytes | **stricter**: throws (`lastRunError`) instead of writing a row of zeros |

---

## 11. Not done / known gaps

| Item | State |
|---|---|
| **Run on a real VPN node** | Not yet. First deploy = pick one node, run the install line, watch `paired as`, leave it a day, then clear the §top banner. |
| **Published image** | Published 2026-09-03 (`latest` = `0b75260`, amd64 + arm64). **Still private** until the package visibility is switched to public in GitHub — until then the install line needs `docker login ghcr.io` first. |
| **Repository is private** | **Blocks both install paths.** The Docker line pulls from GHCR (package private too) and the systemd line curls `install.sh` plus the source archive from GitHub — anonymously, both 404. Make the repo and the GHCR package public, or neither command works as printed. |
| **`install.sh` on a real host** | Never run end to end: no Linux box and no Docker daemon here. Arg parsing, every error path and the geocheck download+checksum+extract are verified; the Node download, the systemd unit, the service user and `--uninstall` are not. |
| **Single-binary distribution** | Not planned, and no longer needed: `install.sh` gives the Beszel-style one-liner without one, fetching a runtime when the host lacks it. A true SEA build would only remove the nodejs.org dependency, at the cost of a per-arch release pipeline. |
| **History in the panel** | Not planned: the panel has no durable store; history stays on the agent (`/speedtest/history`, ndjson). |
| **geocheck path analysis / tunnel detection** | Deliberately off (`--no-mtr --no-detect`): needs NET_RAW, takes minutes, different question. `GEOCHECK_ARGS` can turn it on; the digest ignores those sections. |
| **UDP loss probe** (upstream TURN) | Not ported. |
| **TLS on the local API** | Not needed: loopback only. |

---

## 12. Sibling repositories

| Repo | Relationship |
|---|---|
| [`aerio-crm`](../aerio-crm) | **The consumer.** `services/api/src/routes/agent.ts` ingests heartbeats; `services/api/src/routes/speedtest.ts` serves `/nodes`; `src/components/nodes/speedtest-agent.tsx` is the install dialog. §4 here and its CLAUDE.md §4 are the contract. |
| `aerio-v2` | Stores the token map (`admin.speedtest.tokens`); no direct contact with the agent. |
| Remnawave node | Co-located container; no communication. Pairing is by the token the panel minted for that node's name. |
| [cloudflare-speed-cli](https://github.com/kavehtehrani/cloudflare-speed-cli) | Measurement reference — §10. |
| [remnawave/geocheck](https://github.com/remnawave/geocheck) | Bundled binary — §4 digest, §7 `GEOCHECK_*`. |
