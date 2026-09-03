// One-line logger, a port of aerio-crm's src/server/log.ts so the agent and
// the panel read identically in an aggregated `docker compose logs`:
//
//   12:00:02  INFO   panel       paired as "de-fra-1"  ip=203.0.113.10 rtt=84
//   12:30:00  WARN   panel       unreachable  err="fetch failed" next=30s
//
// Same LOG_LEVEL vocabulary (aerio-v2's), same palette, same LOG_JSON /
// LOG_COLOR / NO_COLOR knobs, same rule that a field whose NAME looks like a
// credential prints <set>/<unset> and never its value. The boot banner and the
// per-run result box (format.js) are the exception to "one line per event":
// they are the part a person reads, and they keep their frames.

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, crit: 60 };

const LEVEL_ALIAS = {
  none: 999,
  debug: LEVELS.debug,
  info: LEVELS.info,
  warn: LEVELS.warn,
  warning: LEVELS.warn,
  error: LEVELS.error,
  crit: LEVELS.crit,
  critical: LEVELS.crit,
  fatal: LEVELS.crit,
};
const MIN = LEVEL_ALIAS[(process.env.LOG_LEVEL ?? 'info').trim().toLowerCase()] ?? LEVELS.info;

const truthy = (v) => ['1', 'true', 'yes'].includes((v ?? '').trim().toLowerCase());

// Pretty is the default everywhere; JSON is opt-in for a shipper.
const JSON_MODE = truthy(process.env.LOG_JSON);

// Colour keys off NO_COLOR / LOG_COLOR, never isTTY: under docker the stream is
// a pipe, yet `docker compose logs` renders ANSI. A TTY gate means the operator
// never sees colour in the one place they read these.
const COLOR = ['0', 'false', 'no'].includes((process.env.LOG_COLOR ?? '').trim().toLowerCase())
  ? false
  : truthy(process.env.LOG_COLOR) || !process.env.NO_COLOR;

// Widest real tag is "speedtest" / "geocheck" (9).
const MODULE_W = 10;

const SERVICE = process.env.LOG_SERVICE ?? 'aerio-agent';

const DIM = COLOR ? '\x1b[2m' : '';
const RESET = COLOR ? '\x1b[0m' : '';
const LEVEL_COLOR = COLOR
  ? { debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m', crit: '\x1b[1;97;41m' }
  : { debug: '', info: '', warn: '', error: '', crit: '' };
const LEVEL_LABEL = { debug: 'DEBUG', info: 'INFO', warn: 'WARN', error: 'ERROR', crit: 'CRIT' };

// Over-matching is deliberate: a redacted non-secret costs nothing, a leaked
// bearer token costs an incident. Rename the field, never the pattern.
const SECRET_RE = /(token|secret|password|passwd|credential|authorization|key)/i;

function isErrorLike(v) {
  return v instanceof Error
    || (typeof v === 'object' && v !== null && typeof v.message === 'string' && typeof v.stack === 'string');
}

function quote(v) {
  const s = typeof v === 'string' ? v : String(v);
  return /[\s"=]/.test(s) || s === '' ? JSON.stringify(s) : s;
}

// Flatten fields to printable key=value pairs. Nested objects become dotted
// keys; Errors become err="msg" plus status/code when they carry one.
function flatten(fields, out, stacks, prefix = '') {
  for (const [k, v] of Object.entries(fields ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v === undefined) continue;
    if (SECRET_RE.test(key)) {
      out.push([key, v ? '<set>' : '<unset>']);
      continue;
    }
    if (isErrorLike(v)) {
      out.push([key, v.message.trim()]);
      for (const extra of ['status', 'code']) {
        if (v[extra] !== undefined) out.push([`${key}.${extra}`, v[extra]]);
      }
      if (v.stack) stacks.push(v.stack);
      continue;
    }
    if (typeof v === 'object' && v !== null) {
      flatten(v, out, stacks, key);
      continue;
    }
    out.push([key, v]);
  }
}

/** Build one formatted line (no trailing newline). Exported for tests and for
 *  callers that want the string rather than the side effect. */
export function formatLine(level, module, msg, fields, timeMs = Date.now()) {
  const pairs = [];
  const stacks = [];
  flatten(fields, pairs, stacks);

  if (JSON_MODE) {
    return JSON.stringify({
      ts: new Date(timeMs).toISOString(),
      level: LEVEL_LABEL[level],
      service: SERVICE,
      logger: module,
      msg,
      ...Object.fromEntries(pairs),
      ...(stacks.length
        ? { exc: stacks.map((x) => x.split('\n').map((l) => l.trimEnd()).filter(Boolean).join('\n')).join('\n') }
        : {}),
    });
  }

  const t = new Date(timeMs).toTimeString().slice(0, 8);
  const c = LEVEL_COLOR[level];
  const lvl = LEVEL_LABEL[level].padEnd(5);
  const mod = (module.length > MODULE_W ? module.slice(0, MODULE_W) : module).padEnd(MODULE_W);
  const kv = pairs.map(([k, v]) => `${k}=${quote(v)}`).join(' ');
  // At error and above the MESSAGE carries the colour: a red word is what the
  // eye finds scrolling a wall of INFO.
  const body = LEVELS[level] >= LEVELS.error ? `${c}${msg}${RESET}` : msg;

  let line = `${DIM}${t}${RESET}  ${c}${lvl}${RESET}  ${DIM}${mod}${RESET}  ${body}`;
  if (kv) line += `  ${DIM}${kv}${RESET}`;
  // Stack only at error and above, on indented following lines.
  if (LEVELS[level] >= LEVELS.error) {
    for (const s of stacks) {
      for (const l of s.split('\n').slice(1)) {
        const tt = l.trim();
        if (tt) line += `\n    ${DIM}${tt}${RESET}`;
      }
    }
  }
  return line;
}

function emit(level, module, msg, fields) {
  if (LEVELS[level] < MIN) return;
  process.stdout.write(formatLine(level, module, msg, fields) + '\n');
}

/** @returns {{debug: Function, info: Function, warn: Function, error: Function, crit: Function}} */
export function logger(module) {
  return {
    debug: (m, f) => emit('debug', module, m, f),
    info: (m, f) => emit('info', module, m, f),
    warn: (m, f) => emit('warn', module, m, f),
    error: (m, f) => emit('error', module, m, f),
    crit: (m, f) => emit('crit', module, m, f),
  };
}

export const logConfig = Object.freeze({ level: process.env.LOG_LEVEL ?? 'info', json: JSON_MODE, color: COLOR });
