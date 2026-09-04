# aerio-agent (cloudflare-speedtest-node)

Per-node agent for the aerio panel. Runs a Cloudflare speedtest on a
schedule, checks which consumer services accept the node's IP with
[remnawave/geocheck](https://github.com/remnawave/geocheck), and reports
both to the panel over an outbound heartbeat. Zero dependencies, one Docker
image, one volume. Node ≥ 20 for a bare install.

Measurement follows [cloudflare-speed-cli](https://github.com/kavehtehrani/cloudflare-speed-cli):
idle + loaded latency, steady-state throughput, bufferbloat and stability
grades.

## Install (from the panel)

On the panel's `/nodes` page, click the key icon on a node → **Generate
token**. The dialog prints a ready command with the panel URL and the token
already in it, in two flavours — pick whichever the node runs.

**Docker:**

```bash
docker run -d --name aerio-agent --restart unless-stopped \
  -e PANEL_URL=https://console.aerio.my -e TOKEN=<token> \
  -v aerio-agent-data:/data ghcr.io/wakeupmetha/cloudflare-speedtest-node:latest
```

**systemd, no Docker:**

```bash
curl -sL https://raw.githubusercontent.com/wakeupmetha/cloudflare-speedtest-node/main/install.sh -o /tmp/aerio-agent-install.sh \
  && chmod +x /tmp/aerio-agent-install.sh \
  && sudo /tmp/aerio-agent-install.sh -t "<token>" -url "https://console.aerio.my"
```

[install.sh](install.sh) puts the agent under `/opt/aerio-agent` as a
systemd unit running under its own system user. Node is **not** a
prerequisite: if the host has nothing newer than 20 the script fetches the
official tarball into the prefix and leaves the system Node alone.
`geocheck` comes from its own releases. Both downloads are checksum-verified,
and the token is written to a root-only `0600` env file rather than into the
unit, which `systemctl cat` shows to anyone.

Then watch it pair, either way:

```bash
docker logs -f aerio-agent        # or: journalctl -u aerio-agent -f
# 12:00:02  INFO   panel       paired as "de-fra-1"  url=https://console.aerio.my rtt=84
```

The agent connects **out** to the panel. No port to open, no TLS on the
node, no firewall rule, and nothing to register on the panel side — the
token is the addressing. The card on `/nodes` fills in within 30 s.

Both paths need this repository to be **public**: the Docker one pulls from
GHCR, the systemd one curls the script and the source from GitHub. A private
repo makes the first need `docker login ghcr.io` and the second fail outright.

### Upgrading, rotating, removing

Re-run the same install command with the new token — both paths replace the
agent in place and keep the measurement history (`aerio-agent-data` volume,
or `/opt/aerio-agent/data`). To remove the systemd install:
`sudo /tmp/aerio-agent-install.sh --uninstall` (add `--purge` to drop the
data too); for Docker, `docker rm -f aerio-agent`.

`install.sh --help` lists the rest: `--interval`, `--geocheck-interval`,
`--no-geocheck`, and the `NODE_VERSION` / `PREFIX` env overrides.

### With compose

```bash
cp .env.example .env     # set PANEL_URL + TOKEN
docker compose up -d
docker compose logs -f
```

`.env` is loaded into the container as a whole (`env_file`), so every knob
in `.env.example` works from there. No image on GHCR, or want your own
build? `docker compose build` builds the same tag locally, and
`docker compose up -d` builds automatically when the image is missing.

### From a checkout (development, or a host `install.sh` does not cover)

Node ≥ 20 and, for the service checks, the `geocheck` binary on `PATH`
(`go install github.com/remnawave/geocheck/cmd/geocheck@latest`, or a release
tarball). No `npm install` — there is nothing to install.

```bash
PANEL_URL=https://console.aerio.my TOKEN=<token> node src/index.js
```

History and the last geocheck digest are written to `./data/` relative to
the current directory; set `DATA_DIR` to move them. This is the path for
macOS and for anything without systemd — `install.sh` refuses to run there
rather than half-installing.

## What the panel receives

Every 30 s, right after each speedtest run, and after each successful
geocheck run, the agent POSTs to `${PANEL_URL}/api/agent/heartbeat` with
`Authorization: Bearer <TOKEN>`: its version and public IP/geo, whether a
run is in progress, the latest speedtest row, the reason of the last failed
speedtest, and the latest geocheck digest. The panel answers with the node
name it resolved the token to and any queued commands (`speedtest`,
`geocheck` — the "Run now" buttons).

## Reading the logs

One line per event, same format as the panel:

```
12:00:01  INFO   boot        aerio-agent 0.2.0 starting  node=v20.19.0 logLevel=info panel=https://console.aerio.my heartbeatMs=30000 speedtestMs=1800000 geocheck=/usr/local/bin/geocheck listen=127.0.0.1:9101 history=0
12:00:02  INFO   panel       paired as "de-fra-1"  url=https://console.aerio.my rtt=84
12:00:07  INFO   speedtest   run #1 started
12:00:21  INFO   speedtest   run #1 done  dl=918.5 ul=482 lat=11.8 jitter=1.6 bloat=A stability=A colo=ARN elapsed=14.1s
12:01:02  INFO   geocheck    run #1 done  available=11 restricted=1 blocked=2 error=0 country=DE reputation=hosting elapsed=21.4s
12:01:02  WARN   geocheck    blocked: Google Search captcha, TikTok
```

The lines to look for when a node does not show up:

| Line | Meaning | Fix |
|---|---|---|
| `ERROR  panel  token rejected by panel — regenerate it on /nodes and restart the agent` | The panel does not know this TOKEN | Generate a token for this node on `/nodes` and re-run the install command (see *Token rotation*) |
| `WARN   panel  unreachable  err="fetch failed: ECONNREFUSED"` | `PANEL_URL` is wrong or the panel is down | Check the URL; the agent retries every 30 s and logs `paired as …` when it recovers |
| `WARN   panel  node address mismatch — is this token for this node?` | The token belongs to a different Remnawave node | You pasted another node's command |
| `WARN   geocheck  binary not found` | Bare install without `geocheck` on `PATH` | Install it or set `GEOCHECK_BIN`; speedtests still run |
| `WARN   speedtest  run #N failed  err="no bytes transferred …"` | `speed.cloudflare.com` unreachable from the node | Network / egress problem on the node |

Each speedtest also prints a framed result box. A healthy heartbeat is
silent at every level — check `/health` → `panel.lastOkAt` instead.
`LOG_LEVEL=debug` shows every failed heartbeat while a failure persists
(WARN/ERROR is printed on the transition only). `LOG_JSON=1` switches to
one JSON object per line and drops the boxes.

## Local API

Loopback-only by default (`BIND=127.0.0.1`); the panel never reads it.
Bearer is the same `TOKEN`.

| Route | Auth | Returns |
|---|---|---|
| `GET /health` | none | scheduler state, pairing state (`panel.paired`, `panel.lastError`), geocheck state |
| `GET /speedtest/last` | Bearer | last result (404 before the first run) |
| `GET /speedtest/history?since=<ms>&limit=<n>` | Bearer | rolling history |
| `GET /speedtest` | Bearer | force a run (shares an in-flight one) |
| `GET /geocheck/last` | Bearer | last geocheck digest |
| `GET /geocheck` | Bearer | force a geocheck run |

The image is Alpine with `wget`, no `curl`:

```bash
docker exec aerio-agent wget -qO- http://127.0.0.1:9101/health
docker exec aerio-agent wget -qO- --header="Authorization: Bearer $TOKEN" http://127.0.0.1:9101/speedtest/last
```

## Environment

`.env.example` lists every variable, commented where the default is fine.
The ones that matter:

| Var | Default | Meaning |
|---|---|---|
| `PANEL_URL` | (empty = standalone) | Panel origin, e.g. `https://console.aerio.my` |
| `TOKEN` | — | **Required.** Minted on `/nodes` |
| `HEARTBEAT_MS` | 30000 | Heartbeat cadence (floor 5 s) |
| `INTERVAL_MS` | 1800000 | Speedtest cadence (floor 60 s), ±`JITTER_PCT` |
| `GEOCHECK_INTERVAL_MS` | 21600000 | geocheck cadence (floor 10 min; 0 disables) |
| `CONCURRENCY` / `DOWNLOAD_SEC` / `UPLOAD_SEC` | 4 / 5 / 5 | Streams and phase lengths. The phases are timed, not sized: a run moves whatever the link carries for 10 s — ~650 MB measured on a 500 Mbit link, ~31 GB/day at the 30 min default |
| `LOG_LEVEL` | info | `none` … `debug`; `LOG_JSON=1`, `LOG_COLOR=0` |

## Token rotation

Rotate on `/nodes`; the dialog shows a new install command.

- **systemd**: re-run the new command as-is — it rewrites the env file and
  restarts the unit.
- **`docker run`**: `docker rm -f aerio-agent`, then paste the new command.
  The `aerio-agent-data` volume keeps history and the last geocheck result.
- **compose**: update `TOKEN` in `.env`, `docker compose up -d`.

Until the agent restarts with the new value it logs `token rejected` every
10 minutes and keeps measuring.

## Development

```bash
npm test                                   # node --test, no framework
TOKEN=devtok node src/index.js             # standalone, no panel
```

Against a local panel, the panel must be up (`npm run dev` +
`npm run dev:api` in `aerio-crm`); mint a token on
`http://localhost:3030/nodes` and use it as `TOKEN` — a made-up value gets
`token rejected` every 10 minutes:

```bash
TOKEN=<from /nodes> PANEL_URL=http://localhost:3030 INTERVAL_MS=120000 node src/index.js
```
