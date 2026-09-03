import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LOG_COLOR = '0';
const { formatLine } = await import('../src/log.js');

test('formatLine: columns and k=v fields', () => {
  const line = formatLine('info', 'panel', 'paired as "de-fra-1"', { ip: '1.2.3.4', rtt: 84 }, Date.UTC(2026, 0, 1, 12, 0, 1));
  assert.match(line, /^\d\d:\d\d:\d\d  INFO   panel       paired as "de-fra-1"  ip=1\.2\.3\.4 rtt=84$/);
});

test('formatLine: secret-looking keys print presence, never value', () => {
  const line = formatLine('warn', 'panel', 'x', { token: 'abc', other: 'v' }, 0);
  assert.match(line, /token=<set>/);
  assert.doesNotMatch(line, /abc/);
  assert.match(line, /other=v/);
});

test('formatLine: errors flatten to message + status, stack indented at error', () => {
  const e = Object.assign(new Error('boom'), { status: 401 });
  const line = formatLine('error', 'panel', 'x', { err: e }, 0);
  assert.match(line, /err=boom err\.status=401/);
  assert.match(line, /\n    at /);
  // no stack below error
  assert.doesNotMatch(formatLine('warn', 'panel', 'x', { err: e }, 0), /\n/);
});

test('formatLine: values with spaces are quoted, nested objects dotted', () => {
  const line = formatLine('info', 'geocheck', 'run done', { summary: { blocked: 2 }, note: 'a b' }, 0);
  assert.match(line, /summary\.blocked=2 note="a b"/);
});
