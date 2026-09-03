// Service-availability probe via remnawave/geocheck (github.com/remnawave/geocheck).
//
// geocheck is a Go binary; the Docker image copies it out of the official
// image and points GEOCHECK_BIN at it. We run it with --json and reduce the
// report to the one question the panel asks — "which services accept or
// refuse this IP" — plus the address reputation and the country consensus.
// The DIGEST is the contract with the panel; this file is the only place
// that knows geocheck's own schema, so a geocheck upgrade is handled here.
//
// Path analysis (mtr) and tunnel detection are left out on purpose: they
// need NET_RAW, take minutes, and answer a different question.

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { access, readFile, writeFile, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

const execFile = promisify(execFileCb);

export const DEFAULT_ARGS = ['--no-mtr', '--no-detect', '-4', '-t', '8'];
export const SCHEMA = 1;

/** Absolute path of an executable, or null. A bare name is searched on PATH. */
export async function resolveGeocheckBin(bin) {
  if (!bin) return null;
  const candidates = bin.includes('/')
    ? [bin]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, bin));
  for (const c of candidates) {
    try {
      await access(c, constants.X_OK);
      return c;
    } catch { /* next */ }
  }
  return null;
}

/** Run the binary and return the digest. Throws with a readable reason. */
export async function runGeocheck({ bin, args = DEFAULT_ARGS, timeoutMs = 180_000, exec = execFile } = {}) {
  const t0 = performance.now();
  let stdout;
  try {
    ({ stdout } = await exec(bin, ['--json', '--quiet', ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }));
  } catch (e) {
    if (e?.killed) throw new Error(`geocheck timed out after ${Math.round(timeoutMs / 1000)}s`);
    const head = String(e?.stderr || e?.message || e).trim().split('\n').slice(0, 3).join(' | ').slice(0, 200);
    throw new Error(`geocheck exited ${e?.code ?? '?'}: ${head}`);
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`geocheck output is not JSON: ${String(stdout).slice(0, 120)}`);
  }
  return digestGeocheck(report, { durationMs: Math.round(performance.now() - t0) });
}

const STATES = new Set(['available', 'restricted', 'blocked', 'error']);
const normState = (s) => (STATES.has(s) ? s : 'error');

function svc(id, name, state, region, detail) {
  const out = { id, name, state };
  if (region) out.region = region;
  if (detail) out.detail = detail;
  return out;
}

/**
 * Reduce a geocheck --json report (internal/render/json.go, schema 1) to the
 * panel's digest. Pure; tolerant of missing sections.
 */
export function digestGeocheck(r, { durationMs } = {}) {
  const services = [];

  // stash_checks: Netflix, YouTube Premium, ChatGPT, Claude, TikTok, Gemini, …
  for (const x of r.stash_checks ?? []) {
    services.push(svc(x.id, x.name, x.error ? 'error' : normState(x.state), x.region, x.detail || x.error));
  }
  // ai_endpoints: reachable|blocked|error → available|blocked|error
  for (const x of r.ai_endpoints ?? []) {
    const state = x.error ? 'error' : x.state === 'reachable' ? 'available' : normState(x.state);
    services.push(svc(x.id, x.name, state, undefined, x.detail || x.error));
  }
  // geo.services: only the yes/no kinds are services; country-kind rows say
  // "where does X think you are", not "does X serve you".
  for (const x of r.geo?.services ?? []) {
    if (x.kind !== 'availability' && x.kind !== 'blocked') continue;
    const v = x.ipv4 ?? x.ipv6;
    if (!v) continue;
    let state = 'error';
    if (!v.error) {
      const yes = v.value === 'yes';
      const no = v.value === 'no';
      if (x.kind === 'availability') state = yes ? 'available' : no ? 'blocked' : 'error';
      else state = yes ? 'blocked' : no ? 'available' : 'error';
    }
    services.push(svc(x.id, x.name, state, undefined, v.error));
  }

  const summary = { available: 0, restricted: 0, blocked: 0, error: 0 };
  for (const s of services) summary[s.state]++;

  const cons = r.consensus?.ipv4?.[0] ?? r.consensus?.ipv6?.[0] ?? null;
  const rep = r.reputation && !r.reputation.error
    ? {
      type: r.reputation.type ?? null,
      risk: Number(r.reputation.risk ?? 0),
      vpn: !!r.reputation.vpn,
      proxy: !!r.reputation.proxy,
      tor: !!r.reputation.tor,
      hosting: !!r.reputation.hosting,
      flags: Array.isArray(r.reputation.flags) ? r.reputation.flags : [],
    }
    : null;

  return {
    ranAt: r.timestamp ?? new Date().toISOString(),
    durationMs: durationMs ?? Number(r.duration_ms ?? 0),
    tool: r.tool ?? 'geocheck',
    schema: Number(r.schema ?? 0),
    ip: r.identity?.ipv4 ?? r.identity?.ipv6 ?? null,
    asn: r.identity?.asn ?? null,
    asName: r.identity?.as_name ?? null,
    country: cons ? { code: cons.code, name: cons.country, percent: Number(cons.percent ?? 0) } : null,
    reputation: rep,
    services,
    findings: (r.findings ?? []).map((f) => ({
      id: f.id, title: f.title, severity: f.severity, detail: f.detail ?? '',
    })),
    summary,
  };
}

// The last digest survives a restart so the panel is not blank for up to
// GEOCHECK_INTERVAL_MS after every container recreate.
export async function loadDigest(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveDigest(file, digest) {
  const tmp = file + '.tmp';
  await writeFile(tmp, JSON.stringify(digest));
  await rename(tmp, file);
}
