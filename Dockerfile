# syntax=docker/dockerfile:1.6
#
# Cloudflare speedtest agent — single-process Node.js daemon.
# Runs an HTTP API gated by AUTH_TOKEN and a background scheduler that
# pings speed.cloudflare.com every INTERVAL_MS, persisting results to
# /data/history.ndjson. Designed to sit on every VPN node alongside
# xray/remnawave-node and be polled by the aerio CRM panel.
#
# Build:   docker build -t aerio/speedtest-agent:latest .
# Run:     docker run --rm -p 9101:9101 \
#            -e AUTH_TOKEN=$(openssl rand -hex 24) \
#            -e SERVER_ID=de-fra-1 \
#            -v speedtest-data:/data \
#            aerio/speedtest-agent:latest

FROM node:20-alpine

WORKDIR /app

# No third-party deps yet — `npm install` only writes a lockfile if one
# doesn't exist. We still copy package.json so future deps Just Work
# when added without rebuilding the layer above.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src

# Persistent ndjson lives here. Mount a named volume to keep history
# across container recreations (compose example: speedtest-data:/data).
ENV DATA_DIR=/data
RUN mkdir -p /data

# Default port — 9101, in the Prometheus exporter range (adjacent to
# node_exporter on 9100). Override only if 9101 is taken on the host;
# one agent per node, no need for per-instance port shifting.
ENV PORT=9101
EXPOSE 9101

# Cheap liveness probe — /health doesn't run a speedtest, just reports
# scheduler state. Same cadence Caddy uses for upstream checks.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health > /dev/null || exit 1

CMD ["node", "src/index.js"]
