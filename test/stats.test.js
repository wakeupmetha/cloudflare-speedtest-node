import test from 'node:test';
import assert from 'node:assert/strict';
import { summary, stddev, cvPct, bufferbloatGrade, stabilityGrade } from '../src/stats.js';

test('summary: even-length median interpolates (upstream metrics.rs case)', () => {
  const s = summary([1, 2, 3, 4]);
  assert.equal(s.median, 2.5);
  assert.equal(s.p25, 1.75);
  assert.equal(s.p75, 3.25);
  assert.equal(s.min, 1);
  assert.equal(s.max, 4);
  assert.deepEqual(summary([]), { mean: 0, median: 0, p25: 0, p75: 0, min: 0, max: 0 });
});

test('stddev is the sample (n-1) standard deviation', () => {
  assert.equal(stddev([2, 4, 4, 4, 5, 5, 7, 9]), 2.14);
  assert.equal(stddev([5]), 0);
});

test('cvPct needs 3 samples and a non-zero mean', () => {
  assert.equal(cvPct([1, 2]), null);
  assert.equal(cvPct([0, 0, 0]), null);
  assert.equal(cvPct([10, 10, 10]), 0);
  assert.ok(cvPct([8, 10, 12]) > 0);
});

test('grades follow upstream constants.rs thresholds', () => {
  assert.equal(bufferbloatGrade(-3), 'A+');
  assert.equal(bufferbloatGrade(5), 'A+');
  assert.equal(bufferbloatGrade(30), 'A');
  assert.equal(bufferbloatGrade(60), 'B');
  assert.equal(bufferbloatGrade(200), 'C');
  assert.equal(bufferbloatGrade(400), 'D');
  assert.equal(bufferbloatGrade(401), 'F');
  assert.equal(stabilityGrade(5), 'A');
  assert.equal(stabilityGrade(10), 'B');
  assert.equal(stabilityGrade(20), 'C');
  assert.equal(stabilityGrade(35), 'D');
  assert.equal(stabilityGrade(36), 'F');
});
