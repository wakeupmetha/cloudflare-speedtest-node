// Pretty terminal output for the agent. Pure string builders that draw
// box frames so a local `docker compose logs -f` shows the boot state
// and each speedtest run at a glance — no panel needed to read results.
//
// Everything here is width-1 monospace glyphs (box-drawing + a few
// arrows). No colour, no emoji — renders identically in a TTY and in
// captured Docker logs.

const WIDTH = 59; // inner width, between the two vertical bars

const TL = '╭', TR = '╮', BL = '╰', BR = '╯', H = '─', V = '│';

function pad(s, w = WIDTH) {
  return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length);
}

function row(content) {
  return `${V}${pad(content)}${V}`;
}

function topPlain() {
  return TL + H.repeat(WIDTH) + TR;
}

function bottom() {
  return BL + H.repeat(WIDTH) + BR;
}

// Top border with a title flush-left and a value flush-right, e.g.
//   ╭─ run #48 ───────────────────────────────────── 13.0s ─╮
function topTitled(left, right) {
  const l = `${TL}${H} ${left} `;
  const r = ` ${right} ${H}${TR}`;
  const fill = WIDTH + 2 - l.length - r.length;
  return l + H.repeat(Math.max(1, fill)) + r;
}

function num(v, digits = 1) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '?';
}

function metricRow(symbol, label, value, unit, extra) {
  const head = `   ${symbol} ${label}`;
  return row(pad(head, 15) + pad(`${value} ${unit}`, 16) + extra);
}

export function bootBanner({ node, bind, port, intervalMs, jitterPct, historyCount }) {
  const sec = Math.round(intervalMs / 1000);
  const jit = Math.round(jitterPct * 100);
  return [
    topPlain(),
    row('  cloudflare-speedtest-node'),
    row(`  ip         ${node?.ip ?? 'unknown'}`),
    row(`  location   ${locationLine(node)}`),
    row(`  listen     ${bind}:${port}   ·   auth on`),
    row(`  interval   ${sec}s (±${jit}%)   ·   history ${historyCount} rows`),
    bottom(),
  ].join('\n');
}

function locationLine(node) {
  const place = [node?.city, node?.country].filter(Boolean).join(', ');
  if (!place) return node?.error ? `unknown (${node.error})` : 'unknown';
  return node?.countryCode ? `${place} (${node.countryCode})` : place;
}

export function runBox({ n, elapsedMs, result, error }) {
  const top = topTitled(`run #${n}`, `${(elapsedMs / 1000).toFixed(1)}s`);
  if (error) {
    return [top, row(`   ✗ failed     ${error}`), bottom()].join('\n');
  }
  const { download: dl, upload: ul, latency: lat } = result;
  return [
    top,
    metricRow('↓', 'download', num(dl?.median), 'mbps', `${num(dl?.min)}  ${H}${H}  ${num(dl?.max)}`),
    metricRow('↑', 'upload', num(ul?.median), 'mbps', `${num(ul?.min)}  ${H}${H}  ${num(ul?.max)}`),
    metricRow('~', 'latency', num(lat?.median), 'ms', `jitter ${num(lat?.jitter)} ms`),
    bottom(),
  ].join('\n');
}

export function fatalBox(lines) {
  return [topPlain(), ...lines.map((l) => row(l)), bottom()].join('\n');
}
