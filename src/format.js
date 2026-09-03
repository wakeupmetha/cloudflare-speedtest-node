// Framed terminal output — the two things a person reads in
// `docker logs aerio-agent`: the boot banner and each run's result. Every
// other event is a one-line log.js entry. Width-1 glyphs only, no colour,
// so it renders the same in a TTY and in captured Docker logs. Not printed
// at all under LOG_JSON (a shipper cannot parse a box).

const WIDTH = 61; // inner width, between the two vertical bars

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

export function bootBanner({ version, node, bind, port, intervalMs, jitterPct, historyCount, panelUrl, geocheck, geocheckIntervalMs }) {
  const sec = Math.round(intervalMs / 1000);
  const jit = Math.round(jitterPct * 100);
  return [
    topPlain(),
    row(`  aerio-agent ${version}`),
    row(`  ip         ${node?.ip ?? 'unknown'}`),
    row(`  location   ${locationLine(node)}`),
    row(`  panel      ${panelUrl || 'standalone (PANEL_URL empty)'}`),
    row(`  geocheck   ${geocheck ? `${geocheck} · every ${humanMs(geocheckIntervalMs)}` : 'disabled (binary not found)'}`),
    row(`  listen     ${bind}:${port}   ·   auth on`),
    row(`  speedtest  every ${sec}s (±${jit}%)   ·   history ${historyCount} rows`),
    bottom(),
  ].join('\n');
}

function humanMs(ms) {
  if (!ms) return 'never';
  if (ms >= 3_600_000) return `${Math.round(ms / 360_000) / 10}h`;
  return `${Math.round(ms / 60_000)}m`;
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
  const { download: dl, upload: ul, latency: lat, quality: q } = result;
  const lines = [
    top,
    metricRow('↓', 'download', num(dl?.mbps), 'mbps', `${num(dl?.min)}  ${H}${H}  ${num(dl?.max)}`),
    metricRow('↑', 'upload', num(ul?.mbps), 'mbps', `${num(ul?.min)}  ${H}${H}  ${num(ul?.max)}`),
    metricRow('~', 'latency', num(lat?.median), 'ms', `jitter ${num(lat?.jitter)}  loaded ${num(lat?.loadedDownload?.median, 0)}/${num(lat?.loadedUpload?.median, 0)} ms`),
  ];
  if (q) {
    lines.push(metricRow('*', 'quality', `bloat ${q.bufferbloatGrade ?? '-'}`, `+${num(q.bufferbloatMs, 0)}ms`, `stability ${q.stabilityGrade ?? '-'}  cv ${num(q.stabilityCvPct)}%`));
  }
  if (dl?.errors || ul?.errors) {
    lines.push(row(`   ! errors     download ${dl?.errors ?? 0}   ·   upload ${ul?.errors ?? 0}`));
  }
  lines.push(bottom());
  return lines.join('\n');
}

export function fatalBox(lines) {
  return [topPlain(), ...lines.map((l) => row(l)), bottom()].join('\n');
}
