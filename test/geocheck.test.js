import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestGeocheck, runGeocheck, loadDigest, saveDigest, resolveGeocheckBin } from '../src/geocheck.js';

const fixtureText = await readFile(new URL('./fixtures/geocheck.json', import.meta.url), 'utf8');
const fixture = JSON.parse(fixtureText);

test('digestGeocheck: services = stash ∪ ai ∪ yes/no geo kinds, states mapped', () => {
  const d = digestGeocheck(fixture, { durationMs: 100 });
  assert.equal(d.schema, 1);
  assert.equal(d.ip, '203.0.113.10');
  assert.equal(d.asn, 24940);
  assert.deepEqual(d.country, { code: 'DE', name: 'Germany', percent: 92.5 });
  assert.equal(d.reputation.type, 'hosting');
  assert.equal(d.reputation.hosting, true);
  assert.deepEqual(d.reputation.flags, ['hosting']);
  // 8 stash + 8 ai + 4 geo (country-kind "google" dropped)
  assert.equal(d.services.length, 20);
  const by = Object.fromEntries(d.services.map((s) => [s.id, s]));
  assert.equal(by.claude_access.state, 'blocked');
  assert.equal(by.claude_access.detail, 'Disallowed ISP');
  assert.equal(by.youtube_premium_access.state, 'restricted');
  assert.equal(by.netflix_access.region, 'DE');
  assert.equal(by.anthropic.state, 'available');     // reachable → available
  assert.equal(by.deepseek.state, 'blocked');
  assert.equal(by.google_captcha.state, 'blocked');  // blocked-kind yes → blocked
  assert.equal(by.spotify_signup.state, 'available'); // availability yes → available
  assert.equal(by.reddit_guest.state, 'blocked');     // availability no → blocked
  assert.equal(by.youtube_premium.state, 'error');    // error field → error
  assert.equal(by.google, undefined);
  assert.deepEqual(d.summary, { available: 14, restricted: 1, blocked: 4, error: 1 });
  assert.equal(d.findings.length, 1);
  assert.equal(d.findings[0].severity, 'warn');
  assert.equal(d.durationMs, 100);
});

test('digestGeocheck: tolerates an unknown schema and missing sections', () => {
  const d = digestGeocheck({ schema: 2, identity: {} });
  assert.equal(d.schema, 2);
  assert.deepEqual(d.services, []);
  assert.equal(d.country, null);
  assert.equal(d.reputation, null);
  assert.deepEqual(d.summary, { available: 0, restricted: 0, blocked: 0, error: 0 });
});

test('runGeocheck: parses stdout, surfaces exit code + stderr, names a timeout', async () => {
  const ok = await runGeocheck({ bin: 'geocheck', exec: async (bin, args) => {
    assert.equal(bin, 'geocheck');
    assert.deepEqual(args.slice(0, 2), ['--json', '--quiet']);
    return { stdout: fixtureText };
  } });
  assert.equal(ok.services.length, 20);

  await assert.rejects(
    runGeocheck({ bin: 'geocheck', exec: async () => { throw Object.assign(new Error('x'), { code: 1, stderr: 'no route to host\nsecond line' }); } }),
    /geocheck exited 1: no route to host \| second line/,
  );
  await assert.rejects(
    runGeocheck({ bin: 'geocheck', timeoutMs: 5000, exec: async () => { throw Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }); } }),
    /timed out after 5s/,
  );
  await assert.rejects(
    runGeocheck({ bin: 'geocheck', exec: async () => ({ stdout: 'not json' }) }),
    /not JSON/,
  );
});

test('digest round-trips through disk; missing file is null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'geocheck-'));
  const file = join(dir, 'geocheck.json');
  assert.equal(await loadDigest(file), null);
  const d = digestGeocheck(fixture);
  await saveDigest(file, d);
  assert.deepEqual(await loadDigest(file), d);
});

test('resolveGeocheckBin: PATH search and absolute paths', async () => {
  assert.ok(await resolveGeocheckBin('node'));
  assert.equal(await resolveGeocheckBin('definitely-not-a-binary-xyz'), null);
  assert.equal(await resolveGeocheckBin('/nope/geocheck'), null);
  assert.equal(await resolveGeocheckBin(''), null);
});
