#!/usr/bin/env bash
#
# aerio-agent installer — puts the per-node speedtest + geocheck agent on a
# Linux server as a systemd service. The panel prints a ready-to-paste
# invocation on /nodes → key icon → Generate token:
#
#   curl -sL https://raw.githubusercontent.com/wakeupmetha/cloudflare-speedtest-node/main/install.sh -o /tmp/aerio-agent-install.sh \
#     && chmod +x /tmp/aerio-agent-install.sh \
#     && sudo /tmp/aerio-agent-install.sh -t "<token>" -url "https://console.aerio.my"
#
# The agent connects OUT to the panel, so nothing listens publicly: no port to
# open, no address to register anywhere. Re-run the same line to upgrade or to
# rotate the token — it replaces the app and restarts the unit, keeping data.
#
# Node is not a prerequisite. If the host has no node >= 20 the script fetches
# the official tarball into the install prefix and leaves the system node
# alone. geocheck is fetched from its own releases, exactly as the Docker
# image bundles it. Both downloads are checksum-verified.

set -euo pipefail

# Bump to move the bundled runtime. Any Node >= 20 works; this one is only
# used when the host has nothing suitable.
NODE_VERSION="${NODE_VERSION:-22.11.0}"

REPO="${AERIO_AGENT_REPO:-wakeupmetha/cloudflare-speedtest-node}"
REF="${AERIO_AGENT_REF:-main}"
GEOCHECK_REPO="${GEOCHECK_REPO:-remnawave/geocheck}"

PREFIX="${PREFIX:-/opt/aerio-agent}"
ENV_FILE="/etc/aerio-agent.env"
UNIT="/etc/systemd/system/aerio-agent.service"
SERVICE_USER="aerio-agent"
SERVICE_NAME="aerio-agent"

TOKEN=""
PANEL_URL=""
INTERVAL_MS=""
GEOCHECK_INTERVAL_MS=""
WANT_GEOCHECK=1
ACTION="install"
PURGE=0

say()  { printf '\033[2m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
aerio-agent installer

  install.sh -t <token> -url <panel-url> [options]
  install.sh --uninstall [--purge]

Required for an install (both are printed by the panel on /nodes):
  -t,  --token TOKEN        per-node secret minted by the panel
  -u,  -url, --url URL      panel origin, e.g. https://console.aerio.my

Options:
       --interval SEC       speedtest cadence in seconds (default 1800, floor 60)
       --geocheck-interval SEC
                            service-check cadence in seconds (default 21600, 0 = off)
       --no-geocheck        do not install the geocheck binary
       --uninstall          stop and remove the service (keeps measurement data)
       --purge              with --uninstall, also delete the data directory
  -h,  --help               this text

Environment overrides: NODE_VERSION, PREFIX, AERIO_AGENT_REPO, AERIO_AGENT_REF.

After install:
  systemctl status aerio-agent
  journalctl -u aerio-agent -f      # look for: paired as "<node>"
EOF
}

secs_to_ms() {
  case "$1" in
    ''|*[!0-9]*) die "$2 expects whole seconds, got \"$1\"" ;;
  esac
  echo $(( $1 * 1000 ))
}

while [ $# -gt 0 ]; do
  case "$1" in
    -t|--token)             TOKEN="${2:-}"; shift 2 ;;
    -u|-url|--url)          PANEL_URL="${2:-}"; shift 2 ;;
    --interval)             INTERVAL_MS="$(secs_to_ms "${2:-}" --interval)"; shift 2 ;;
    --geocheck-interval)    GEOCHECK_INTERVAL_MS="$(secs_to_ms "${2:-}" --geocheck-interval)"; shift 2 ;;
    --no-geocheck)          WANT_GEOCHECK=0; shift ;;
    --uninstall)            ACTION="uninstall"; shift ;;
    --purge)                PURGE=1; shift ;;
    -h|--help)              usage; exit 0 ;;
    *) die "unknown option: $1  (--help for usage)" ;;
  esac
done

need_root() {
  [ "$(id -u)" -eq 0 ] || die "must run as root — prefix the command with sudo"
}

need_systemd() {
  [ "$(uname -s)" = "Linux" ] || die "this installer is Linux + systemd only; on macOS run the agent from a checkout (see README)"
  command -v systemctl >/dev/null 2>&1 || die "systemctl not found — this installer targets systemd hosts"
}

# ── uninstall ──────────────────────────────────────────────────────────────

if [ "$ACTION" = "uninstall" ]; then
  need_root
  say "stopping $SERVICE_NAME"
  systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
  rm -f "$UNIT" "$ENV_FILE"
  systemctl daemon-reload 2>/dev/null || true
  if [ "$PURGE" -eq 1 ]; then
    rm -rf "$PREFIX"
    ok "removed $PREFIX including measurement data"
  else
    rm -rf "${PREFIX:?}/app" "${PREFIX:?}/node" "${PREFIX:?}/bin"
    ok "removed the service; ${PREFIX}/data kept (--purge to delete it too)"
  fi
  exit 0
fi

# ── preflight ──────────────────────────────────────────────────────────────

[ -n "$TOKEN" ] || die "missing -t <token> — generate one on the panel: /nodes → key icon → Generate token"
[ -n "$PANEL_URL" ] || die "missing -url <panel-url>, e.g. -url https://console.aerio.my"
case "$PANEL_URL" in
  http://*|https://*) ;;
  *) die "-url must start with http:// or https://  (got \"$PANEL_URL\")" ;;
esac
PANEL_URL="${PANEL_URL%/}"

need_root
need_systemd
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"
command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required (coreutils)"

case "$(uname -m)" in
  x86_64|amd64)  NODE_ARCH=x64;   GC_ARCH=amd64 ;;
  aarch64|arm64) NODE_ARCH=arm64; GC_ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m) (need x86_64 or aarch64)" ;;
esac

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx aerio-agent; then
  warn "a Docker container named aerio-agent is already running on this host."
  warn "Two agents sharing one token both report as this node — stop one:  docker rm -f aerio-agent"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── runtime ────────────────────────────────────────────────────────────────

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$major" -ge 20 ] 2>/dev/null
}

install_node() {
  local name="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
  local base="https://nodejs.org/dist/v${NODE_VERSION}"
  say "downloading Node ${NODE_VERSION} (${NODE_ARCH})"
  curl -fsSL "${base}/${name}.tar.gz" -o "$TMP/node.tar.gz" \
    || die "could not download Node from ${base}/${name}.tar.gz"
  if curl -fsSL "${base}/SHASUMS256.txt" -o "$TMP/node.sha" 2>/dev/null; then
    local want got
    want="$(grep " ${name}.tar.gz\$" "$TMP/node.sha" | awk '{print $1}')"
    got="$(sha256sum "$TMP/node.tar.gz" | awk '{print $1}')"
    if [ -z "$want" ]; then
      warn "no checksum line for ${name}.tar.gz — installing Node unverified"
    elif [ "$want" != "$got" ]; then
      die "Node checksum mismatch — refusing to install"
    else
      say "Node checksum verified"
    fi
  else
    warn "could not fetch SHASUMS256.txt — installing Node without checksum verification"
  fi
  rm -rf "$PREFIX/node"
  mkdir -p "$PREFIX/node"
  tar -xzf "$TMP/node.tar.gz" -C "$PREFIX/node" --strip-components=1
  NODE_BIN="$PREFIX/node/bin/node"
}

mkdir -p "$PREFIX"
if node_ok; then
  NODE_BIN="$(command -v node)"
  say "using the host's node ($("$NODE_BIN" -v))"
  rm -rf "$PREFIX/node"
else
  install_node
fi

# ── agent ──────────────────────────────────────────────────────────────────

say "downloading the agent (${REPO}@${REF})"
curl -fsSL "https://github.com/${REPO}/archive/${REF}.tar.gz" -o "$TMP/agent.tar.gz" \
  || die "could not download the agent from github.com/${REPO} — is the repository public?"
rm -rf "$PREFIX/app"
mkdir -p "$PREFIX/app"
tar -xzf "$TMP/agent.tar.gz" -C "$PREFIX/app" --strip-components=1
[ -f "$PREFIX/app/src/index.js" ] || die "the archive does not look like the agent (no src/index.js)"
AGENT_VERSION="$("$NODE_BIN" -p "require('$PREFIX/app/package.json').version" 2>/dev/null || echo '?')"

# ── geocheck ───────────────────────────────────────────────────────────────

GEOCHECK_BIN=""
if [ "$WANT_GEOCHECK" -eq 1 ]; then
  asset="geocheck_linux_${GC_ARCH}.tar.gz"
  base="https://github.com/${GEOCHECK_REPO}/releases/latest/download"
  say "downloading geocheck (${GC_ARCH})"
  if curl -fsSL "${base}/${asset}" -o "$TMP/geocheck.tar.gz"; then
    if curl -fsSL "${base}/checksums.txt" -o "$TMP/gc.sha" 2>/dev/null; then
      want="$(grep " ${asset}\$" "$TMP/gc.sha" | awk '{print $1}')"
      got="$(sha256sum "$TMP/geocheck.tar.gz" | awk '{print $1}')"
      if [ -n "$want" ] && [ "$want" != "$got" ]; then
        die "geocheck checksum mismatch — refusing to install it"
      fi
      say "geocheck checksum verified"
    fi
    mkdir -p "$PREFIX/bin"
    tar -xzf "$TMP/geocheck.tar.gz" -C "$TMP" geocheck 2>/dev/null || tar -xzf "$TMP/geocheck.tar.gz" -C "$TMP"
    if [ -f "$TMP/geocheck" ]; then
      install -m 0755 "$TMP/geocheck" "$PREFIX/bin/geocheck"
      GEOCHECK_BIN="$PREFIX/bin/geocheck"
    else
      warn "the geocheck archive had no binary inside — service checks disabled"
    fi
  else
    warn "could not download geocheck — speedtests will run, service checks will not"
  fi
fi

# ── service user + layout ──────────────────────────────────────────────────

if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --no-create-home "$SERVICE_USER" \
    || die "could not create the $SERVICE_USER system user"
  say "created system user $SERVICE_USER"
fi
mkdir -p "$PREFIX/data"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$PREFIX/data"

# ── env + unit ─────────────────────────────────────────────────────────────
#
# The token lives in a root-owned 0600 file, not in the unit: `systemctl cat`
# and `systemd-analyze` print the unit to anyone, EnvironmentFile is read by
# systemd itself before privileges are dropped.

umask 077
{
  echo "PANEL_URL=$PANEL_URL"
  echo "TOKEN=$TOKEN"
  echo "DATA_DIR=$PREFIX/data"
  if [ -n "$GEOCHECK_BIN" ]; then
    echo "GEOCHECK_BIN=$GEOCHECK_BIN"
  else
    echo "GEOCHECK_INTERVAL_MS=0"
  fi
  if [ -n "$INTERVAL_MS" ]; then echo "INTERVAL_MS=$INTERVAL_MS"; fi
  if [ -n "$GEOCHECK_INTERVAL_MS" ]; then echo "GEOCHECK_INTERVAL_MS=$GEOCHECK_INTERVAL_MS"; fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"
chown root:root "$ENV_FILE"
umask 022

cat > "$UNIT" <<EOF
[Unit]
Description=aerio-agent — per-node speedtest + service availability
Documentation=https://github.com/${REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${PREFIX}/app/src/index.js
Restart=always
RestartSec=10
# The agent reads nothing outside its own prefix and writes only its data dir.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=${PREFIX}/data

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

ok "aerio-agent ${AGENT_VERSION} installed"
say "panel     ${PANEL_URL}"
say "runtime   ${NODE_BIN}"
say "geocheck  ${GEOCHECK_BIN:-disabled}"
say "data      ${PREFIX}/data"
echo
echo "Watch it pair with the panel:"
echo "    journalctl -u ${SERVICE_NAME} -f"
echo "    # INFO  panel  paired as \"<node name>\""
echo
echo "Rotate the token or upgrade: re-run this same command with the new value."
echo "Remove: sudo $0 --uninstall"
