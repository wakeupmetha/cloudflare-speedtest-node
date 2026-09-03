# syntax=docker/dockerfile:1.6
#
# aerio-agent — per-node speedtest + geocheck agent that pairs with the
# aerio panel. One process: two schedulers (Cloudflare speedtest every
# INTERVAL_MS, remnawave/geocheck every GEOCHECK_INTERVAL_MS), a heartbeat
# to PANEL_URL every 30 s carrying the latest results, and a loopback-only
# local API for the healthcheck and for `curl` on the node.
#
# Build:   docker build -t aerio-agent .
# Run:     docker run -d --name aerio-agent --restart unless-stopped \
#            -e PANEL_URL=https://console.aerio.my -e TOKEN=<from /nodes> \
#            -v aerio-agent-data:/data ghcr.io/wakeupmetha/cloudflare-speedtest-node:latest
#
# The geocheck binary is copied out of the official image rather than built
# here: it is a static Go binary, and pinning GEOCHECK_IMAGE is how you pin
# the geocheck version. No NET_RAW is needed — the agent runs it with
# --no-mtr, so it never opens a raw socket.

ARG GEOCHECK_IMAGE=remnawave/geocheck:latest
FROM ${GEOCHECK_IMAGE} AS geocheck

FROM node:20-alpine

WORKDIR /app

COPY --from=geocheck /usr/local/bin/geocheck /usr/local/bin/geocheck

# Zero third-party deps: no npm install layer at all.
COPY package.json ./
COPY src ./src

# Persistent history + last geocheck digest live here. Mount a named volume
# to keep them across container recreations.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data

# Local API: loopback only. The panel never reads it — results go OUT in the
# heartbeat — so nothing needs to be published. BIND=0.0.0.0 to expose it.
ENV PORT=9101
ENV BIND=127.0.0.1
ENV GEOCHECK_BIN=/usr/local/bin/geocheck
EXPOSE 9101

USER node

# Cheap liveness probe — /health reports scheduler + pairing state, never
# runs a speedtest.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health > /dev/null || exit 1

CMD ["node", "src/index.js"]
