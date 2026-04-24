export function summary(samples) {
  if (!samples.length) return { mean: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    mean: round(mean(samples)),
    median: round(quantile(sorted, 0.5)),
    p25: round(quantile(sorted, 0.25)),
    p75: round(quantile(sorted, 0.75)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1])
  };
}

export function jitter(samples) {
  if (samples.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += Math.abs(samples[i] - samples[i - 1]);
  return round(sum / (samples.length - 1));
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function round(x) {
  return Math.round(x * 100) / 100;
}
