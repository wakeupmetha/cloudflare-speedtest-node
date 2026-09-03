// Sample statistics, matching cloudflare-speed-cli's metrics.rs / quality.rs
// so a number here means what the same number means upstream:
//   - percentiles use the (n-1)·p linear-interpolation method
//   - jitter is the SAMPLE standard deviation of RTTs (not mean |Δ|)
//   - stability is the coefficient of variation of steady-state throughput
//   - grades use upstream's constants.rs thresholds verbatim

export function summary(samples) {
  if (!samples.length) return { mean: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    mean: round(mean(samples)),
    median: round(percentile(sorted, 0.5)),
    p25: round(percentile(sorted, 0.25)),
    p75: round(percentile(sorted, 0.75)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}

/** Sample standard deviation (n-1). 0 for fewer than two samples. */
export function stddev(samples) {
  if (samples.length < 2) return 0;
  const m = mean(samples);
  const v = samples.reduce((s, x) => s + (x - m) ** 2, 0) / (samples.length - 1);
  return round(Math.sqrt(v));
}

/** Coefficient of variation in percent. null below 3 samples or at mean 0. */
export function cvPct(samples) {
  if (samples.length < 3) return null;
  const m = mean(samples);
  if (Math.abs(m) < Number.EPSILON) return null;
  return round((stddev(samples) / m) * 100);
}

// Waveform-style bufferbloat thresholds: max latency increase under load.
const BUFFERBLOAT = [[5, 'A+'], [30, 'A'], [60, 'B'], [200, 'C'], [400, 'D'], [Infinity, 'F']];
// Stability thresholds on CV %: wired fiber ~2-4%, decent Wi-Fi ~8-15%.
const STABILITY = [[5, 'A'], [10, 'B'], [20, 'C'], [35, 'D'], [Infinity, 'F']];

export function bufferbloatGrade(bloatMs) {
  const v = Math.max(0, bloatMs);
  return BUFFERBLOAT.find(([t]) => v <= t)[1];
}

export function stabilityGrade(cv) {
  return STABILITY.find(([t]) => cv <= t)[1];
}

export function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** Linear-interpolation percentile on a SORTED array. */
export function percentile(sorted, p) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const pos = Math.min(1, Math.max(0, p)) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
}

export function round(x) {
  return Math.round(x * 100) / 100;
}
