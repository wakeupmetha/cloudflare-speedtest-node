// Background scheduler that runs the speedtest on a fixed interval and
// pushes each result into the history store. Self-rescheduling via
// setTimeout (not setInterval) so a slow run never overlaps the next
// tick — we only schedule the follow-up once the current call resolves.
//
// Behaviour:
//   - First run fires after `firstDelayMs` (default ~5 s). Lets the
//     container settle and the network come up before hammering it.
//   - Each subsequent run is `intervalMs ± jitterPct%`. Without jitter
//     a fleet of agents that all start in the same compose-up would
//     fire in lock-step every 30 min and create an unnecessary spike on
//     the upstream Cloudflare edge.
//   - Errors are logged but never thrown — the loop must stay alive
//     even if one run fails (transient network blip, dropped ssh, etc.).

import { runSpeedtest } from './speedtest.js';

const MIN_INTERVAL_MS = 60_000;          // safety floor: never run more than once a minute
const DEFAULT_FIRST_DELAY_MS = 5_000;

export class SpeedtestScheduler {
  /**
   * @param {object} opts
   * @param {number} opts.intervalMs        Cadence between runs.
   * @param {number} [opts.jitterPct]       0..1 — random offset added to interval. Default 0.15.
   * @param {number} [opts.firstDelayMs]    Delay before the very first run. Default 5 s.
   * @param {object} opts.speedtestOpts     Forwarded to runSpeedtest().
   * @param {string} opts.serverId          Tag stamped onto every result.
   * @param {import('./storage.js').HistoryStore} opts.store
   * @param {(msg: string, extra?: object) => void} [opts.log]
   */
  constructor({ intervalMs, jitterPct = 0.15, firstDelayMs = DEFAULT_FIRST_DELAY_MS, speedtestOpts, serverId, store, log = console.log }) {
    this.intervalMs = Math.max(MIN_INTERVAL_MS, intervalMs);
    this.jitterPct = Math.max(0, Math.min(1, jitterPct));
    this.firstDelayMs = firstDelayMs;
    this.speedtestOpts = speedtestOpts;
    this.serverId = serverId;
    this.store = store;
    this.log = log;
    this.timer = null;
    this.running = false;
    this.stopped = false;
    /** @type {Promise<object> | null} in-flight run shared with on-demand callers */
    this.inflight = null;
    /** ISO timestamp of when the next run is scheduled, for /health */
    this.nextRunAt = null;
  }

  start() {
    if (this.timer) return;
    this.scheduleNext(this.firstDelayMs);
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run the speedtest right now, sharing the result with any in-flight
   * scheduled run so on-demand callers don't double up.
   */
  runOnce() {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      this.running = true;
      try {
        const result = await runSpeedtest(this.speedtestOpts);
        const stamped = { serverId: this.serverId, ...result };
        await this.store.append(stamped);
        return stamped;
      } finally {
        this.running = false;
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  scheduleNext(delayOverride) {
    if (this.stopped) return;
    const delay = typeof delayOverride === 'number'
      ? delayOverride
      : this.intervalMs + Math.round((Math.random() * 2 - 1) * this.intervalMs * this.jitterPct);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => { void this.tick(); }, delay);
    // On Node, allow the process to exit if nothing else is keeping it
    // alive — otherwise the scheduled timer would block graceful shutdown.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async tick() {
    const start = Date.now();
    try {
      const r = await this.runOnce();
      this.log(`speedtest done in ${Date.now() - start}ms — dl ${r.download?.median ?? '?'} mbps · ul ${r.upload?.median ?? '?'} mbps · lat ${r.latency?.median ?? '?'} ms`);
    } catch (e) {
      this.log(`speedtest failed after ${Date.now() - start}ms: ${e?.message || e}`);
    } finally {
      this.scheduleNext();
    }
  }
}
