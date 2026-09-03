// Heartbeat client — the agent's side of the pairing.
//
// Every HEARTBEAT_MS (and right after a speedtest or geocheck run) the agent
// POSTs its identity and latest results to the panel with its per-node
// TOKEN. The reply names the node the panel resolved the token to and carries
// any commands queued there ("speedtest", "geocheck"). Nothing is queued on
// this side when the panel is down: the next successful heartbeat carries the
// latest state anyway.
//
// Logging is on TRANSITIONS, so a dead panel is one WARN and one INFO on
// recovery — not a line every 30 s — while a rejected token, the one failure
// the operator has to act on, repeats every 10 minutes at ERROR.

import { USER_AGENT } from './client.js';

const REJECTED_REPEAT_MS = 10 * 60_000;

export function createPanelClient({
  url,
  token,
  log,
  state,
  onCommand,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  heartbeatMs: heartbeatMsHint = 30_000,
  now = Date.now,
}) {
  const endpoint = new URL('/api/agent/heartbeat', url).toString();

  let paired = false;
  let node = null;
  let lastOkAt = null;
  let lastError = null;
  let lastErrorKind = null;
  let lastErrorLoggedAt = 0;
  let failingSince = null;
  let mismatchWarnedFor = null;
  let inflight = false;

  async function beat() {
    // A slow heartbeat must not stack a second one behind it.
    if (inflight) return;
    inflight = true;
    const t0 = now();
    try {
      const body = state();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            'user-agent': USER_AGENT,
          },
          body: JSON.stringify(body),
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let reply = null;
      try { reply = JSON.parse(text); } catch { /* non-JSON reply */ }

      if (res.status === 401) {
        fail('rejected', 'token rejected by panel — regenerate it on /nodes and restart the agent', {
          status: 401, hint: reply?.hint,
        });
        return;
      }
      if (!res.ok || !reply?.ok) {
        fail('http', `panel answered ${res.status}`, { status: res.status, body: text.slice(0, 120) });
        return;
      }

      const rtt = now() - t0;
      lastOkAt = new Date(now()).toISOString();
      lastError = null;
      if (!paired || node !== reply.node) {
        log.info(`paired as "${reply.node}"`, {
          url,
          rtt,
          ...(failingSince ? { after: `${Math.round((now() - failingSince) / 1000)}s` } : {}),
        });
      }
      paired = true;
      node = reply.node;
      failingSince = null;
      lastErrorKind = null;

      const reportedIp = body.node?.ip ?? null;
      if (reply.expectedIp && reportedIp && reply.expectedIp !== reportedIp && mismatchWarnedFor !== reply.expectedIp) {
        log.warn('node address mismatch — is this token for this node?', {
          reported: reportedIp, panelExpects: reply.expectedIp,
        });
        mismatchWarnedFor = reply.expectedIp;
      }

      for (const cmd of reply.commands ?? []) {
        log.info('command received', { cmd });
        // Not awaited: a speedtest takes ~15 s and its completion pushes its
        // own heartbeat, which must not find this one still in flight.
        Promise.resolve().then(() => onCommand(cmd)).catch((e) => log.warn('command failed', { cmd, err: e }));
      }
    } catch (e) {
      // undici wraps the socket error: "fetch failed" with cause.code
      // ECONNREFUSED / ENOTFOUND / CERT_HAS_EXPIRED — the part worth reading.
      const msg = e?.name === 'AbortError'
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : [e?.message || String(e), e?.cause?.code].filter(Boolean).join(': ');
      fail('unreachable', 'unreachable', { err: msg, next: `${Math.round(heartbeatMsHint / 1000)}s` });
    } finally {
      inflight = false;
    }
  }

  function fail(kind, msg, fields) {
    const first = lastErrorKind !== kind;
    if (first) failingSince = now();
    lastError = fields?.err ? `${msg}: ${fields.err}` : msg;
    paired = false;
    const level = kind === 'rejected' ? 'error' : 'warn';
    const repeat = kind === 'rejected' && now() - lastErrorLoggedAt >= REJECTED_REPEAT_MS;
    if (first || repeat) {
      log[level](msg, fields);
      lastErrorLoggedAt = now();
    } else {
      log.debug(msg, fields);
    }
    lastErrorKind = kind;
  }

  return {
    beat,
    status: () => ({ url, paired, node, lastOkAt, lastError }),
  };
}
