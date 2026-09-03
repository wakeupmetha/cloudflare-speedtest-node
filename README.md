# aerio-agent (cloudflare-speedtest-node)

Per-node agent for the aerio panel. Runs a Cloudflare speedtest on a
schedule, checks which consumer services accept the node's IP with
[remnawave/geocheck](https://github.com/remnawave/geocheck), and reports
both to the panel over an outbound heartbeat. Zero dependencies, one Docker
image, one volume.

Measurement follows [cloudflare-speed-cli](https://github.com/kavehtehrani/cloudflare-speed-cli):
idle + loaded latency, steady-state throughput, bufferbloat and stability
grades.

## Install (from the panel)

On the panel's `/nodes` page, click the key icon on a node → **Generate
token**. The dialog shows the command with the panel URL and the token
filled in:

```bash
docker run -d --name aerio-agent --restart unless-stopped \
  -e PANEL_URL=https://console.aerio.my -e TOKEN=<token> \
  -v aerio-agent-data:/data ghcr.io/wakeupmetha/cloudflare-speedtest-node:latest
```

Then watch it pair:

```bash
docker logs -f aerio-agent
# 12:00:02  INFO   panel       paired as "de-fra-1"  url=https://console.aerio.my rtt=84
```

The agent connects **out** to the panel. No port to open, no TLS on the
node, no firewall rule. The card on `/nodes` shows the node within 30 s.

### With compose

```bash
cp .env.example .env     # set PANEL_URL + TOKEN
docker compose up -d
docker compose logs -f
```

### Without Docker

Node ≥ 20 and, for the service checks, the `geocheck` binary on `PATH`
(`go install github.com/remnawave/geocheck/cmd/geocheck@latest`, or a release
tarball). No `npm install` — there is nothing to install.

```bash
PANEL_URL=https://console.aerio.my TOKEN=<token> node src/index.js
```

## What the panel receives

Every 30 s (and right after each run) the agent POSTs to
`${PANEL_URL}/api/agent/heartbeat` with `Authorization: Bearer <TOKEN>`:
its version and public IP/geo, whether a run is in progress, the latest
speedtest row, the reason of the last failed run, and the latest geocheck
digest. The panel answers with the node name it resolved the token to and
any queued commands (`speedtest`, `geocheck` — the "Run now" buttons).

## Reading the logs

One line per event, same format as the panel:

```
12:00:01  INFO   boot        aerio-agent 0.2.0 starting  panel=https://console.aerio.my geocheck=/usr/local/bin/geocheck listen=127.0.0.1:9101
12:00:02  INFO   panel       paired as "de-fra-1"  url=https://console.aerio.my rtt=84
12:00:07  INFO   speedtest   run #1 started
12:00:21  INFO   speedtest   run #1 done  dl=918.5 ul=482 lat=11.8 jitter=1.6 bloat=A stability=A colo=ARN elapsed=14.1s
12:01:02  INFO   geocheck    run #1 done  available=11 restricted=1 blocked=2 country=DE reputation=hosting elapsed=21.4s
12:01:02  WARN   geocheck    blocked: Google Search captcha, TikTok
```

The lines to look for when a node does not show up:

| Line | Meaning | Fix |
|---|---|---|
| `ERROR  panel  token rejected by panel — regenerate it on /nodes and restart the agent` | The panel does not know this TOKEN | Generate a token for this node on `/nodes`, put it in `.env`, restart |
| `WARN   panel  unreachable  err="fetch failed: ECONNREFUSED"` | `PANEL_URL` is wrong or the panel is down | Check the URL; the agent retries every 30 s and logs `paired as …` when it recovers |
| `WARN   panel  node address mismatch — is this token for this node?` | The token belongs to a different Remnawave node | You pasted another node's command |
| `WARN   geocheck  binary not found` | Bare install without `geocheck` on `PATH` | Install it or set `GEOCHECK_BIN`; speedtests still run |
| `WARN   speedtest  run #N failed  err="no bytes transferred …"` | `speed.cloudflare.com` unreachable from the node | Network / egress problem on the node |

Each speedtest also prints a framed result box. `LOG_JSON=1` switches to one
JSON object per line (no boxes); `LOG_LEVEL=debug` shows every heartbeat.

## Local API

Loopback-only by default (`BIND=127.0.0.1`); the panel never reads it.

| Route | Auth | Returns |
|---|---|---|
| `GET /health` | none | scheduler state, pairing state (`panel.paired`, `panel.lastError`), geocheck state |
| `GET /speedtest/last` | Bearer | last result (404 before the first run) |
| `GET /speedtest/history?since=<ms>&limit=<n>` | Bearer | rolling history |
| `GET /speedtest` | Bearer | force a run (shares an in-flight one) |
| `GET /geocheck/last` | Bearer | last geocheck digest |
| `GET /geocheck` | Bearer | force a geocheck run |

```bash
docker exec aerio-agent wget -qO- http://127.0.0.1:9101/health
```

## Environment

See `.env.example` for everything. The ones that matter:

| Var | Default | Meaning |
|---|---|---|
| `PANEL_URL` | (empty = standalone) | Panel origin, e.g. `https://console.aerio.my` |
| `TOKEN` | — | **Required.** Minted on `/nodes` |
| `HEARTBEAT_MS` | 30000 | Heartbeat cadence (floor 5 s) |
| `INTERVAL_MS` | 1800000 | Speedtest cadence (floor 60 s), ±`JITTER_PCT` |
| `GEOCHECK_INTERVAL_MS` | 21600000 | geocheck cadence (floor 10 min; 0 disables) |
| `CONCURRENCY` / `DOWNLOAD_SEC` / `UPLOAD_SEC` | 4 / 5 / 5 | Streams and phase lengths (≈50–250 MB per run) |
| `LOG_LEVEL` | info | `none` … `debug`; `LOG_JSON=1`, `LOG_COLOR=0` |

## Token rotation

Rotate on `/nodes` (the dialog shows the new install command), update `TOKEN`
in `.env`, `docker compose up -d`. Until the agent restarts with the new
value it logs `token rejected` every 10 minutes and keeps measuring.

## Development

```bash
npm test                                   # node --test, no framework
TOKEN=devtok PANEL_URL=http://localhost:3030 INTERVAL_MS=120000 node src/index.js
```
