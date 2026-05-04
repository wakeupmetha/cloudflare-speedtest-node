// Persistent rolling history of speedtest results.
//
// Format: newline-delimited JSON (`history.ndjson`) inside DATA_DIR.
// Append-only on the hot path (single fs.appendFile per result, no
// rewrite), with an occasional compaction pass when the file grows past
// `maxEntries * 2` lines — the ring buffer in memory is the source of
// truth for reads, so stale lines on disk only matter for cold-start
// hydration.
//
// Why ndjson and not sqlite/leveldb: the agent runs once every 30 min,
// the dataset is bounded (<= maxEntries rows of ~1 KB JSON each), and
// the only query pattern is "give me the last N or rows since T". A
// flat file beats an embedded DB on operational footprint and matches
// the rest of the agent (zero deps).

import { mkdir, readFile, writeFile, appendFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class HistoryStore {
  /**
   * @param {object} opts
   * @param {string} opts.file       absolute path to history.ndjson
   * @param {number} opts.maxEntries soft cap on rows kept (defaults 1500)
   */
  constructor({ file, maxEntries = 1500 }) {
    this.file = file;
    this.maxEntries = maxEntries;
    /** @type {Array<object>} newest last */
    this.entries = [];
    this.ready = false;
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true });
    let text = '';
    try {
      text = await readFile(this.file, 'utf8');
    } catch (e) {
      if (e?.code !== 'ENOENT') throw e;
    }
    if (text) {
      const out = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        try { out.push(JSON.parse(line)); }
        catch { /* skip malformed line — partial write or truncation */ }
      }
      // Keep newest `maxEntries` if the file grew between processes.
      this.entries = out.slice(-this.maxEntries);
    }
    this.ready = true;
    // If hydration dropped lines, write a compacted file once on boot.
    if (text && this.entries.length < text.split('\n').filter(Boolean).length) {
      await this.compact();
    }
  }

  /** Append a new result to the ring + ndjson. */
  async append(result) {
    if (!this.ready) throw new Error('HistoryStore.init() not called');
    this.entries.push(result);
    let needsCompact = false;
    if (this.entries.length > this.maxEntries * 2) {
      this.entries = this.entries.slice(-this.maxEntries);
      needsCompact = true;
    }
    if (needsCompact) {
      await this.compact();
    } else {
      await appendFile(this.file, JSON.stringify(result) + '\n');
    }
  }

  /** Most recent result, or null if the store is empty. */
  last() {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  /**
   * Slice of history. `since` (epoch ms) and `limit` are both optional;
   * limit is applied to the tail (newest), so `limit=10` returns the 10
   * most recent rows in chronological order.
   */
  query({ since, limit } = {}) {
    let out = this.entries;
    if (typeof since === 'number') {
      out = out.filter((r) => Date.parse(r.startedAt) >= since);
    }
    if (typeof limit === 'number' && limit > 0 && out.length > limit) {
      out = out.slice(-limit);
    }
    return out;
  }

  /** Rewrite the ndjson file to match the in-memory ring. */
  async compact() {
    const tmp = this.file + '.tmp';
    const body = this.entries.map((e) => JSON.stringify(e)).join('\n');
    await writeFile(tmp, body ? body + '\n' : '');
    // fs.rename is atomic on POSIX + best-effort on Windows; matches the
    // robustness we need given a crash mid-compact would just lose the
    // last few results, never corrupt the file.
    await rename(tmp, this.file);
  }
}

export function defaultDataFile() {
  const dir = process.env.DATA_DIR || './data';
  return join(dir, 'history.ndjson');
}
