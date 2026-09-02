'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildSupportBundle,
  collectRedactionSecrets,
  fullFilesystems,
  summarizeTrouble,
} = require('../src/diagnostics/support-bundle.cjs');

const now = () => new Date('2026-09-01T12:00:00.000Z');

function healthyCollection() {
  return {
    collectedAt: '2026-09-01T12:00:00.000Z',
    containers: [{ image: 'mos-app-vaultwarden:1', labels: { 'mos.package': 'vaultwarden' }, log: 'started', name: 'mos-app-vaultwarden', state: 'running', status: 'Up 2 hours', troubled: false }],
    host: { disk: 'Filesystem Size Used Avail Use% Mounted\n/dev/sda2 60G 20G 38G 35% /', kernel: 'Linux mos 6.8.0' },
    incomplete: [],
    units: [{ active: 'active', enabled: 'enabled', log: 'ready', name: 'mos-suite-manager.service', sub: 'running', troubled: false }],
  };
}

test('a secret that reached a container log is masked, and the report counts it', () => {
  const secret = 'sup3r-secret-admin-token-value';
  const collection = healthyCollection();
  collection.containers[0].log = `starting with ADMIN_TOKEN=${secret}\nretrying with ${secret}`;

  const { text } = buildSupportBundle({ collection, now, secrets: [secret] });

  assert.ok(!text.includes(secret), 'the secret survived into the bundle');
  assert.ok(text.includes('ADMIN_TOKEN=[redacted]'));
  assert.match(text, /Values masked in this file {2}2/u);
  assert.match(text, /Known secrets checked for {3}1/u);
});

test('an export with no known secrets says so instead of implying it masked something', () => {
  const { text } = buildSupportBundle({ collection: healthyCollection(), now, secrets: [] });

  assert.match(text, /Values masked in this file {2}0/u);
  assert.ok(text.includes('WARNING: no secrets were known to this export'));
  assert.ok(text.includes('Treat this file as unredacted'));
});

test('the redaction report itself is never masked away', () => {
  // The report is appended after redaction on purpose: a secret that happened to
  // equal a digit string must not be able to eat the count that proves masking
  // ran.
  const { text } = buildSupportBundle({ collection: healthyCollection(), now, secrets: ['123456'] });

  assert.match(text, /Known secrets checked for {3}1/u);
});

test('the file leads with what looks wrong', () => {
  const collection = healthyCollection();
  collection.units.push({ active: 'failed', enabled: 'enabled', log: 'exited', name: 'mos-app-agent.service', sub: 'failed', troubled: true });
  collection.containers.push({ image: 'mos-app-immich:1', labels: {}, log: 'killed', name: 'mos-app-immich', state: 'exited', status: 'Exited (137) 5 minutes ago', troubled: true });

  const { text } = buildSupportBundle({
    apps: [{ displayName: 'Immich', installedAt: '2026-08-01T00:00:00.000Z', lastFailure: { completedAt: '2026-09-01T11:42:03.000Z', diagnostics: 'container exited with 137', errorCode: 'APP_HEALTH_FAILED', kind: 'apply' }, packageId: 'immich', packageVersion: '1.0.0', status: 'installed' }],
    collection,
    now,
    secrets: ['unused-secret-value'],
  });

  const summary = text.slice(text.indexOf('WHAT LOOKS WRONG'), text.indexOf('PLATFORM'));
  assert.ok(summary.includes('mos-app-agent.service is failed'));
  assert.ok(summary.includes('mos-app-immich is Exited (137) 5 minutes ago'));
  assert.ok(summary.includes('Immich last failed: APP_HEALTH_FAILED'));
  // The persisted reason from the failed apply is carried through in full.
  assert.ok(text.includes('container exited with 137'));
});

test('a machine with nothing wrong says so without claiming the problem is not there', () => {
  const { text } = buildSupportBundle({ collection: healthyCollection(), now, secrets: ['x'] });

  assert.ok(text.includes('Nothing obviously wrong was detected'));
  assert.ok(text.includes('the problem may still be in it'));
});

test('an unreachable diagnostics agent becomes a finding rather than an empty file', () => {
  const { text } = buildSupportBundle({
    collection: { containers: [], host: {}, incomplete: ['diagnostics agent unreachable (DIAGNOSTICS_AGENT_UNAVAILABLE)'], units: [] },
    now,
    secrets: ['x'],
  });

  assert.ok(text.includes('Some information could not be collected: diagnostics agent unreachable'));
  assert.ok(text.includes('MY OWN SUITE — DIAGNOSTICS'));
});

test('the filename is stable enough to ask an owner for by name', () => {
  const { filename } = buildSupportBundle({ collection: healthyCollection(), now });

  assert.equal(filename, 'mos-diagnostics-2026-09-01-12-00-00.txt');
});

test('nearly-full filesystems are found, and roomy ones are not', () => {
  const df = [
    'Filesystem      Size  Used Avail Use% Mounted on',
    '/dev/sda2        60G   56G  1.2G  98% /',
    '/dev/sda3       100G   10G   85G  11% /var/lib/docker',
  ].join('\n');

  assert.deepEqual(fullFilesystems(df).length, 1);
  assert.ok(fullFilesystems(df)[0].includes('98%'));
  assert.deepEqual(fullFilesystems(''), []);
  assert.deepEqual(fullFilesystems(undefined), []);
});

test('the summary reports a full disk, which is the cause an owner never checks', () => {
  const collection = healthyCollection();
  collection.host.disk = 'Filesystem Size Used Avail Use% Mounted\n/dev/sda2 60G 59G 0.5G 99% /';

  assert.ok(summarizeTrouble({ collection }).some((line) => line.startsWith('Filesystem is nearly full')));
});

test('secrets are gathered from the files on disk, including orphaned ones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-secrets-'));
  fs.mkdirSync(path.join(root, 'instance-a'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instance-gone'), { recursive: true });
  fs.writeFileSync(path.join(root, 'instance-a', 'ADMIN_TOKEN.secret'), 'live-secret-value\n');
  fs.writeFileSync(path.join(root, 'instance-gone', 'OLD_TOKEN.secret'), 'orphaned-secret-value');
  fs.writeFileSync(path.join(root, 'instance-a', 'notes.txt'), 'not a secret');

  const secrets = collectRedactionSecrets({ httpsSecretPath: path.join(root, 'nonexistent.env'), secretDir: root });

  assert.ok(secrets.includes('live-secret-value'), 'trailing newline was not trimmed');
  // An instance whose rows were deleted still has secrets on disk, and a stale
  // log line is exactly where one of those would surface.
  assert.ok(secrets.includes('orphaned-secret-value'));
  assert.ok(!secrets.includes('not a secret'));
  fs.rmSync(root, { force: true, recursive: true });
});

test('a missing secret directory yields no secrets rather than throwing', () => {
  assert.deepEqual(collectRedactionSecrets({ httpsSecretPath: '/nope', secretDir: '/does/not/exist' }), []);
  assert.deepEqual(collectRedactionSecrets({}), []);
});

test('a failed platform update and a failed HTTPS apply lead the summary, with their reasons in PLATFORM', () => {
  const { text } = buildSupportBundle({
    collection: healthyCollection(),
    now,
    platform: {
      lastHttpsApply: { at: '2026-08-30T09:00:00.000Z', diagnostics: 'Caddy rejected the new configuration.\n\nDetails:\n- caddy validate for the new configuration exited with code 1.', errorCode: 'HTTPS_CADDY_VALIDATION_FAILED', status: 'failed' },
      lastUpdate: { at: '2026-09-01T11:00:00.000Z', error: 'npm run build:client exited with code 3.', output: 'vite: JavaScript heap out of memory', stage: 'failed', status: 'failed' },
      version: '0.17.0',
    },
    secrets: ['x'],
  });

  const summary = text.slice(text.indexOf('WHAT LOOKS WRONG'), text.indexOf('PLATFORM'));
  assert.ok(summary.includes('The last platform update failed at 2026-09-01T11:00:00.000Z: npm run build:client exited with code 3.'));
  assert.ok(summary.includes('The last HTTPS apply failed: HTTPS_CADDY_VALIDATION_FAILED at 2026-08-30T09:00:00.000Z.'));
  const platform = text.slice(text.indexOf('PLATFORM'), text.indexOf('HOST'));
  assert.ok(platform.includes('Last update        failed at 2026-09-01T11:00:00.000Z\n  npm run build:client exited with code 3.\n    vite: JavaScript heap out of memory'));
  assert.ok(platform.includes('Last HTTPS apply   failed (HTTPS_CADDY_VALIDATION_FAILED) at 2026-08-30T09:00:00.000Z\n  Caddy rejected the new configuration.'));
});

test('an update that worked and HTTPS that was never applied are one line each, and not trouble', () => {
  const { text } = buildSupportBundle({
    collection: healthyCollection(),
    now,
    platform: { lastHttpsApply: { status: null }, lastUpdate: { at: '2026-09-01T11:00:00.000Z', stage: 'succeeded', status: 'succeeded' } },
    secrets: ['x'],
  });

  assert.ok(text.includes('Nothing obviously wrong was detected'));
  assert.ok(text.includes('Last update        succeeded at 2026-09-01T11:00:00.000Z\nLast HTTPS apply   never\n'));
});
