import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { inspectLogSurface, normalizeShape } from '../e2e/support/log-surface-rules.mjs';

const require = createRequire(import.meta.url);
const { buildSupportBundle } = require('../../suite-manager/backend/src/diagnostics/support-bundle.cjs');

// These rules are the only thing standing between a leaked credential and a file
// an owner mails to a stranger, and they fail open: a regex that stops matching
// reports success. So every rule is tested from both sides — it fires on the bad
// input, and it stays quiet on the good one.

const env = {
  cloudflareApiToken: 'cf-token-abcdefghijklmnop',
  owner: { password: 'correct horse battery' },
  seafile: { adminPassword: 'seafile-test-password' },
  vaultwarden: { password: 'MOS-E2E-Master-Password-2026!' },
};

// Fixtures are rendered by the real bundle builder rather than hand-written. A
// rule that matches a hand-made approximation but not the actual artifact is a
// rule that silently never fires — which is exactly how the container check
// below was broken when it was first written, because every container block
// carries indented `image` and `package` lines that a naive text search finds.
function record(level, event, extra = {}) {
  return `2026-09-01T11:00:00+0000 mos-suite-manager[912]: ${JSON.stringify({ ts: '2026-09-01T11:00:00.000Z', level, event, ...extra })}`;
}

const HEALTHY_UNIT_LOG = [record('info', 'listening', { port: 3100 }), record('info', 'app-package-migrated')].join('\n');

function bundle({ containerLog = '[INFO] Rocket has launched from http://0.0.0.0:80', containers, unitLog = HEALTHY_UNIT_LOG } = {}) {
  return buildSupportBundle({
    apps: [{ displayName: 'Vaultwarden', installedAt: '2026-08-01T00:00:00.000Z', lastFailure: null, packageId: 'vaultwarden', packageVersion: '1.34.1', status: 'installed' }],
    collection: {
      collectedAt: '2026-09-01T12:00:00.000Z',
      containers: containers || [{
        image: 'mos-app-vaultwarden:1.34.1',
        labels: { 'mos.package': 'vaultwarden' },
        log: containerLog,
        name: 'mos-app-vaultwarden',
        state: 'running',
        status: 'Up 2 hours',
        troubled: false,
      }],
      host: { disk: 'Filesystem Size Used Avail Use% Mounted on\n/dev/sda2 58G 20G 35G 37% /' },
      incomplete: [],
      units: [{ active: 'active', enabled: 'enabled', log: unitLog, name: 'mos-suite-manager.service', sub: 'running', troubled: false }],
    },
    homeHost: 'home.mos.hyperv',
    platform: { version: '0.19.0' },
    secrets: ['an-app-secret-mos-holds'],
  }).text;
}

function withUnitLine(line) {
  return bundle({ unitLog: `${HEALTHY_UNIT_LOG}\n${line}` });
}

test('a clean bundle raises nothing', () => {
  assert.deepEqual(inspectLogSurface(bundle(), env).failures, []);
});

test('every known secret is caught wherever it appears, and never echoed in the message', () => {
  for (const [label, value] of [
    ['owner password', env.owner.password],
    ['Cloudflare API token', env.cloudflareApiToken],
    ['Vaultwarden master password', env.vaultwarden.password],
    ['Seafile admin password', env.seafile.adminPassword],
  ]) {
    const { failures } = inspectLogSurface(bundle({ containerLog: `[INFO] connecting with ${value}` }), env);
    const leak = failures.find((entry) => entry.startsWith('LEAK:'));

    assert.ok(leak, `${label} was not detected`);
    assert.ok(leak.includes(label), `the message should name which secret leaked, got: ${leak}`);
    // The failure text goes into CI output, where it would outlive the run.
    assert.ok(!leak.includes(value), `the failure message repeated the ${label} verbatim`);
  }
});

test('a secret too short to be distinctive is not probed for', () => {
  // A six-character password occurs inside ordinary words and would turn every
  // run red for no reason.
  const { failures } = inspectLogSurface(bundle({ containerLog: '[INFO] value is abc123' }), { owner: { password: 'abc123' } });

  assert.deepEqual(failures.filter((entry) => entry.startsWith('LEAK:')), []);
});

test('each catastrophe pattern fires on its own evidence', () => {
  const cases = [
    ['Go panic', 'panic: runtime error: invalid memory address\ngoroutine 1 [running]:'],
    ['Python traceback', 'Traceback (most recent call last):'],
    ['Node fatal error', 'FATAL ERROR: JavaScript heap out of memory'],
    ['segfault', 'kernel: caddy[1234]: segfault at 0 ip 000000 sp 000000 error 4'],
    ['disk full', 'write failed: No space left on device'],
    ['OOM killer', 'kernel: Out of memory: Killed process 4242 (immich-server)'],
    ['permission denied', 'EACCES: permission denied, open /var/lib/mos/suite-manager/state.db'],
    ['database corruption', 'Error: database disk image is malformed'],
    ['unit failure', 'Failed to start MOS narrow app runtime agent.'],
  ];

  for (const [label, line] of cases) {
    assert.ok(inspectLogSurface(bundle({ containerLog: line }), env).failures.length > 0, `${label} was not detected`);
  }
});

test('ordinary log noise does not trip the catastrophe patterns', () => {
  const ordinary = [
    '[INFO] GET /api/health 200 3ms',
    '[WARN] retrying connection to database in 2s',
    '[INFO] error rate over the last hour: 0%',
    '[INFO] panic button component mounted',
    '[INFO] no space configured for cache, using default',
    '[INFO] loaded 12 templates from disk',
  ].join('\n');

  assert.deepEqual(inspectLogSurface(bundle({ containerLog: ordinary }), env).failures, []);
});

test('an unmasked secret-shaped assignment is caught, and a masked one is not', () => {
  const leaked = inspectLogSurface(bundle({ containerLog: 'starting with ADMIN_TOKEN=s3cr3t-value-here' }), env);
  assert.ok(leaked.failures.some((entry) => entry.includes('ADMIN_TOKEN')), 'an unmasked ADMIN_TOKEN was not caught');

  const masked = inspectLogSurface(bundle({ containerLog: 'starting with ADMIN_TOKEN=[redacted]' }), env);
  assert.deepEqual(masked.failures, [], 'a correctly masked value should not be reported');
});

test('cleared and placeholder values are not treated as leaks', () => {
  const benign = [
    'DB_PASSWORD=',
    'API_TOKEN=null',
    'ADMIN_SECRET=""',
    'SMTP_PASSWORD=${smtp.password}',
    'SESSION_TOKEN=<unset>',
    'MAIL_PASSWORD=changeme',
  ].join('\n');

  assert.deepEqual(inspectLogSurface(bundle({ containerLog: benign }), env).failures, []);
});

test('a crash-shaped record fails even though nothing else looks wrong', () => {
  const { failures } = inspectLogSurface(withUnitLine(record('error', 'unhandled-rejection', { error: 'boom' })), env);

  assert.ok(failures.some((entry) => entry.includes('crash-shaped record: unhandled-rejection')));
});

test('any unexpected error record is a finding, and says how to accept it', () => {
  const { failures } = inspectLogSurface(withUnitLine(record('error', 'request-failed', { statusCode: 500 })), env);

  assert.ok(failures.some((entry) => entry.includes('request-failed')));
  assert.ok(failures.some((entry) => entry.includes('ALLOWED_ERROR_EVENTS')), 'the message must say how to accept a known-benign event');
});

test('a warning is not an error', () => {
  assert.deepEqual(inspectLogSurface(withUnitLine(record('warn', 'backup-agent-unavailable')), env).failures, []);
});

test('a logger that stopped emitting JSON is caught', () => {
  // Silent by nature: if TTY detection ever went wrong on an installed server
  // the logs would still read fine to a human and become unparseable to
  // everything else.
  const pretty = '2026-09-01T11:00:00+0000 mos-suite-manager[912]: 11:00:00 info  listening port=3100';
  const { failures } = inspectLogSurface(bundle({ unitLog: pretty }), env);

  assert.ok(failures.some((entry) => entry.includes('not writing JSON to the journal')));
});

test('a record missing its envelope is caught', () => {
  const line = '2026-09-01T11:01:00+0000 mos-suite-manager[912]: {"ts":"2026-09-01T11:01:00.000Z","level":"info"}';
  const { failures } = inspectLogSurface(withUnitLine(line), env);

  assert.ok(failures.some((entry) => entry.includes('malformed record')));
});

test('containers that all report no logs are caught', () => {
  const { failures } = inspectLogSurface(bundle({ containerLog: '' }), env);

  assert.ok(
    failures.some((entry) => entry.includes('container logging is not reaching the collector')),
    `expected a container-logging failure, got: ${JSON.stringify(failures)}`,
  );
});

test('one silent container among several is not a failure', () => {
  // A container that legitimately logs nothing is ordinary. Only every container
  // being silent means the collector itself is broken.
  const containers = [
    { image: 'a:1', labels: {}, log: '', name: 'mos-app-quiet', state: 'running', status: 'Up 2 hours', troubled: false },
    { image: 'b:1', labels: {}, log: '[INFO] serving', name: 'mos-app-chatty', state: 'running', status: 'Up 2 hours', troubled: false },
  ];

  assert.deepEqual(inspectLogSurface(bundle({ containers }), env).failures, []);
});

test('shape normalization collapses what varies and keeps what does not', () => {
  const first = normalizeShape('2026-09-01T11:00:00+0000 mos-app[912]: served 42 requests from a3f9e21b4c7d');
  const second = normalizeShape('2026-09-02T23:14:07+0000 mos-app[77]: served 9 requests from ff01ab99cd12');

  assert.equal(first, second, 'the same line at a different time must normalize identically');
  assert.ok(first.includes('served <n> requests from <hex>'));
});

test('the inventory reports what was seen so drift is visible between runs', () => {
  const { inventory } = inspectLogSurface(bundle(), env);

  assert.match(inventory, /records parsed: 2/u);
  assert.match(inventory, /info listening/u);
  assert.match(inventory, /distinct line shapes: \d+/u);
});
