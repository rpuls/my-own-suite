const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { hashSessionToken } = require('../src/auth/sessions.cjs');
const {
  DATABASE_FILENAME,
  MIGRATIONS,
  SuiteManagerStore,
} = require('../src/state/suite-manager-store.cjs');

async function tempStateDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-sqlite-'));
}

function owner() {
  return {
    createdAt: '2026-06-20T10:00:00.000Z',
    email: 'owner@example.com',
    name: 'Suite Owner',
    passwordHash: 'scrypt$N=16384$stored-salt$stored-password-hash',
  };
}

function session(tokenHash = 'stored-session-hash') {
  return {
    createdAt: '2026-06-20T10:00:00.000Z',
    tokenHash,
  };
}

test('fresh state creates the SQLite schema and records every migration', async () => {
  const stateDir = await tempStateDir();
  const store = new SuiteManagerStore(stateDir);
  store.close();

  const databasePath = path.join(stateDir, DATABASE_FILENAME);
  assert.equal(fs.existsSync(databasePath), true);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const tables = database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
  `).all().map((row) => row.name);
  const migrations = database.prepare(`
    SELECT version, name FROM schema_migrations ORDER BY version
  `).all().map(({ name, version }) => ({ name, version }));
  database.close();

  assert.deepEqual(tables, [
    'app_instance_config',
    'app_instance_guides',
    'app_instance_projections',
    'app_instances',
    'app_integrations',
    'app_operations',
    'app_sources',
    'homepage_operations',
    'homepage_revisions',
    'https_settings',
    'owner_terms_acceptances',
    'owners',
    'schema_migrations',
    'security_events',
    'sessions',
  ]);
  assert.deepEqual(migrations, MIGRATIONS.map(({ name, version }) => ({ name, version })));
});

test('HTTPS settings keep pending state separate and never persist the Cloudflare token', async () => {
  const stateDir = await tempStateDir();
  const store = new SuiteManagerStore(stateDir);
  store.beginHttpsApply({
    acmeEmail: 'owner@example.com',
    at: '2026-06-20T11:00:00.000Z',
    baseDomain: 'mos.example.com',
  });
  assert.equal(store.getHttpsSettings().baseDomain, null);
  assert.equal(store.getHttpsSettings().pendingBaseDomain, 'mos.example.com');
  store.completeHttpsApply('2026-06-20T11:01:00.000Z');
  assert.equal(store.getHttpsSettings().baseDomain, 'mos.example.com');
  assert.equal(store.getHttpsSettings().tlsMode, 'cloudflare-dns01');
  store.close();

  const database = new DatabaseSync(path.join(stateDir, DATABASE_FILENAME), { readOnly: true });
  const columns = database.prepare('PRAGMA table_info(https_settings)').all().map(({ name }) => name);
  database.close();
  assert.equal(columns.some((name) => /token|caddy/u.test(name)), false);
});

test('security events aggregate, persist, expire, and stay hard-capped', async () => {
  const stateDir = await tempStateDir();
  let store = new SuiteManagerStore(stateDir);
  store.recordSecurityEvent({
    at: '2026-07-13T10:05:00.000Z',
    eventType: 'login-throttled',
    retryAfterSeconds: 2,
    subject: 'client-a',
  });
  store.recordSecurityEvent({
    at: '2026-07-13T10:55:00.000Z',
    eventType: 'login-throttled',
    retryAfterSeconds: 8,
    subject: 'client-a',
  });
  assert.deepEqual(store.getSecurityEventSummary({ since: '2026-07-13T00:00:00.000Z' }), {
    byType: [{ eventCount: 2, eventType: 'login-throttled', lastSeenAt: '2026-07-13T10:55:00.000Z', subjectCount: 1 }],
    eventCount: 2,
    lastSeenAt: '2026-07-13T10:55:00.000Z',
  });
  let rows = store.database.prepare('SELECT * FROM security_events').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_count, 2);
  assert.equal(rows[0].max_retry_seconds, 8);
  store.close();

  store = new SuiteManagerStore(stateDir);
  assert.equal(store.getSecurityEventSummary({ since: '2026-07-13T00:00:00.000Z' }).eventCount, 2);
  store.recordSecurityEvent({
    at: '2026-05-01T10:00:00.000Z',
    eventType: 'login-throttled',
    retryAfterSeconds: 1,
    subject: 'expired-client',
  });
  store.recordSecurityEvent({
    at: '2026-07-13T11:00:00.000Z',
    eventType: 'login-throttled',
    maxRows: 2,
    retryAfterSeconds: 1,
    subject: 'client-b',
  });
  store.recordSecurityEvent({
    at: '2026-07-13T12:00:00.000Z',
    eventType: 'login-throttled',
    maxRows: 2,
    retryAfterSeconds: 1,
    subject: 'client-c',
  });
  rows = store.database.prepare('SELECT subject FROM security_events ORDER BY last_seen_at').all();
  assert.deepEqual(rows.map((row) => row.subject), ['client-b', 'client-c']);
  store.close();
});

// A package source has no client and no retry delay, and a summary that added it
// to a throttled sign-in would report a number that means nothing.
test('app source events count alongside sign-in throttling without borrowing its shape', async () => {
  const stateDir = await tempStateDir();
  const store = new SuiteManagerStore(stateDir);
  store.recordSecurityEvent({ at: '2026-07-13T10:05:00.000Z', eventType: 'login-throttled', retryAfterSeconds: 2, subject: 'client-a' });
  store.recordSecurityEvent({ at: '2026-07-13T10:10:00.000Z', eventType: 'app-source-candidate-rejected', subject: 'src-abcdef012345' });
  store.recordSecurityEvent({ at: '2026-07-13T10:40:00.000Z', eventType: 'app-source-candidate-rejected', subject: 'src-abcdef012345' });
  store.recordSecurityEvent({ at: '2026-07-13T10:45:00.000Z', eventType: 'app-catalog-refresh-failed', subject: 'fedcba098765' });

  assert.deepEqual(store.getSecurityEventSummary({ since: '2026-07-13T00:00:00.000Z' }), {
    byType: [
      { eventCount: 1, eventType: 'app-catalog-refresh-failed', lastSeenAt: '2026-07-13T10:45:00.000Z', subjectCount: 1 },
      { eventCount: 2, eventType: 'app-source-candidate-rejected', lastSeenAt: '2026-07-13T10:40:00.000Z', subjectCount: 1 },
      { eventCount: 1, eventType: 'login-throttled', lastSeenAt: '2026-07-13T10:05:00.000Z', subjectCount: 1 },
    ],
    eventCount: 4,
    lastSeenAt: '2026-07-13T10:45:00.000Z',
  });
  const rejected = store.database.prepare("SELECT * FROM security_events WHERE event_type = 'app-source-candidate-rejected'").all();
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].event_count, 2);
  assert.equal(rejected[0].max_retry_seconds, null);
  store.close();
});

// The enum could only grow by rebuilding the table, and a rebuild that loses the
// rows it was widening for would quietly discard the record of every sign-in
// anyone was throttled on.
test('rebuilding the security event table keeps the events recorded before it', async () => {
  const stateDir = await tempStateDir();
  const database = new DatabaseSync(path.join(stateDir, DATABASE_FILENAME));
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of MIGRATIONS.filter(({ version }) => version < 12)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, '2026-07-13T00:00:00.000Z');
  }
  database.prepare(`
    INSERT INTO security_events (
      bucket_start, event_type, client_fingerprint, event_count, max_retry_seconds, first_seen_at, last_seen_at
    ) VALUES ('2026-07-13T10:00:00.000Z', 'login-throttled', 'client-a', 4, 8, '2026-07-13T10:05:00.000Z', '2026-07-13T10:55:00.000Z')
  `).run();
  database.close();

  const upgraded = new SuiteManagerStore(stateDir);
  const rows = upgraded.database.prepare('SELECT * FROM security_events').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'client-a');
  assert.equal(rows[0].event_count, 4);
  assert.equal(rows[0].max_retry_seconds, 8);
  // The counter keeps counting into the row the rebuild carried over.
  upgraded.recordSecurityEvent({ at: '2026-07-13T10:58:00.000Z', eventType: 'login-throttled', retryAfterSeconds: 2, subject: 'client-a' });
  assert.equal(upgraded.database.prepare('SELECT event_count FROM security_events').get().event_count, 5);
  upgraded.close();
});

test('an existing version-one database receives the named HTTPS migration', async () => {
  const stateDir = await tempStateDir();
  const databasePath = path.join(stateDir, DATABASE_FILENAME);
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
    ${MIGRATIONS[0].sql}
  `);
  database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)')
    .run(MIGRATIONS[0].name, '2026-06-20T00:00:00.000Z');
  database.close();

  const upgraded = new SuiteManagerStore(stateDir);
  assert.equal(upgraded.getHttpsSettings().tlsMode, 'off');
  const migrations = upgraded.database.prepare('SELECT name FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(migrations.map(({ name }) => name), [
    'owner-and-sessions',
    'https-settings',
    'homepage-revisions-and-operations',
    'app-package-instances',
    'app-instance-guides',
    'app-integrations',
    'security-event-buckets',
    'installed-app-package-identity',
    'app-update-operation-stages',
    'app-update-recovery-state',
    'external-app-sources',
    'security-event-subjects',
    'owner-terms-acceptance',
  ]);
  upgraded.close();
});

test('existing app rows migrate without inventing package source identity', async () => {
  const stateDir = await tempStateDir();
  const database = new DatabaseSync(path.join(stateDir, DATABASE_FILENAME));
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of MIGRATIONS.filter(({ version }) => version < 8)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, '2026-07-13T00:00:00.000Z');
  }
  database.prepare(`
    INSERT INTO app_instances (
      id, package_id, package_version, manifest_digest, status, enabled,
      display_name_snapshot, category_snapshot, created_at, updated_at, installed_at
    ) VALUES (?, ?, ?, ?, 'installed', 1, ?, ?, ?, ?, ?)
  `).run('legacy-instance', 'example-app', '0.1.0', 'sha256:legacy-manifest', 'Example App', 'tools', 'one', 'one', 'one');
  database.close();

  const upgraded = new SuiteManagerStore(stateDir);
  const instance = upgraded.getAppInstanceByPackageId('example-app');
  assert.equal(instance.snapshotState, 'legacy-unmigrated');
  assert.equal(instance.packageDigest, null);
  assert.equal(instance.snapshotPath, null);
  assert.equal(instance.updateRecoveryState, 'none');
  assert.equal(instance.sourceKind, null);
  assert.equal(instance.sourceRevision, null);
  assert.equal(instance.privacyStatus, null);
  upgraded.close();
});

test('app instance state stays package-generic and stores projection digests', async () => {
  const store = new SuiteManagerStore(await tempStateDir());
  const at = '2026-06-27T10:00:00.000Z';
  store.installAppInstance({
    at,
    instance: {
      categorySnapshot: 'tools',
      displayNameSnapshot: 'Example App',
      id: 'instance-one',
      manifestDigest: 'sha256:manifest',
      packageDigest: `sha256:${'a'.repeat(64)}`,
      packageId: 'example-app',
      packageVersion: '0.1.0',
      privacy: { posture: 'privacy-configured', reviewedAt: '2026-06-26T10:00:00.000Z', status: 'reviewed' },
      snapshotPath: '/var/lib/mos/app-packages/instance-one/installed',
      snapshotState: 'installed',
      source: {
        kind: 'official-git',
        path: 'apps/example-app',
        repository: 'https://github.com/rpuls/my-own-suite',
        revision: '0123456789abcdef0123456789abcdef01234567',
        trust: 'mos-reviewed',
      },
    },
    operationId: 'operation-one',
    projections: [
      {
        contentJson: '{"services":[]}',
        digest: 'sha256:compose',
        kind: 'compose',
      },
      {
        contentJson: '{"routes":[]}',
        digest: 'sha256:caddy',
        kind: 'caddy',
      },
    ],
    request: { dryRunOnly: true },
  });

  const instance = store.getAppInstanceByPackageId('example-app');
  assert.equal(instance.status, 'installed');
  assert.equal(instance.enabled, true);
  assert.equal(instance.manifestDigest, 'sha256:manifest');
  assert.equal(instance.packageDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(instance.packageVersion, '0.1.0');
  assert.equal(instance.snapshotState, 'installed');
  assert.equal(instance.snapshotPath, '/var/lib/mos/app-packages/instance-one/installed');
  assert.equal(instance.sourceKind, 'official-git');
  assert.equal(instance.sourceTrust, 'mos-reviewed');
  assert.equal(instance.sourceRevision, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(instance.privacyStatus, 'reviewed');
  assert.equal(instance.privacyPosture, 'privacy-configured');

  const projections = store.getAppProjections(instance.id);
  assert.deepEqual(projections.map(({ digest, kind, status }) => ({ digest, kind, status })), [
    { digest: 'sha256:caddy', kind: 'caddy', status: 'rendered' },
    { digest: 'sha256:compose', kind: 'compose', status: 'rendered' },
  ]);

  store.applyAppProjections({
    at: '2026-06-27T10:05:00.000Z',
    instanceId: instance.id,
    kinds: ['compose', 'caddy'],
    operationId: 'operation-two',
    request: { target: 'runtime' },
  });
  assert.deepEqual(store.getAppProjections(instance.id).map(({ appliedDigest, digest, kind, status }) => ({
    applied: appliedDigest === digest,
    kind,
    status,
  })), [
    { applied: true, kind: 'caddy', status: 'applied' },
    { applied: true, kind: 'compose', status: 'applied' },
  ]);

  const columns = store.database.prepare('PRAGMA table_info(app_instances)').all().map(({ name }) => name);
  assert.equal(columns.some((name) => /stirling|seafile|immich|vaultwarden/u.test(name)), false);
  store.close();
});

test('app update operations persist digest-bound stages and reject overlap', async () => {
  const store = new SuiteManagerStore(await tempStateDir());
  const at = '2026-07-14T10:00:00.000Z';
  store.installAppInstance({
    at,
    instance: {
      categorySnapshot: 'tools', displayNameSnapshot: 'Example', id: 'update-instance',
      manifestDigest: 'sha256:manifest', packageDigest: `sha256:${'a'.repeat(64)}`,
      packageId: 'update-example', packageVersion: '1.0.0', privacy: { posture: 'review-required', reviewedAt: null, status: 'review-required' },
      snapshotPath: '/var/lib/mos/app-packages/update-instance/installed', snapshotState: 'installed',
      source: { kind: 'official-git', path: 'apps/update-example', repository: 'https://github.com/rpuls/my-own-suite', revision: 'a'.repeat(40), trust: 'mos-reviewed' },
    },
    operationId: 'install-update-instance', projections: [],
  });
  store.beginAppUpdate({ at, candidateDigest: `sha256:${'b'.repeat(64)}`, expectedInstalledDigest: `sha256:${'a'.repeat(64)}`, instanceId: 'update-instance', operationId: 'update-one' });
  assert.throws(() => store.beginAppUpdate({ at, candidateDigest: `sha256:${'c'.repeat(64)}`, expectedInstalledDigest: `sha256:${'a'.repeat(64)}`, instanceId: 'update-instance', operationId: 'update-two' }), /APP_UPDATE_ALREADY_RUNNING/u);
  assert.equal(store.advanceAppUpdate({ instanceId: 'update-instance', operationId: 'update-one', stage: 'candidate-staged' }).stage, 'candidate-staged');
  store.close();

  const reopened = new SuiteManagerStore(store.stateDir);
  const operation = reopened.getAppOperation('update-one');
  assert.equal(operation.status, 'running');
  assert.equal(operation.stage, 'candidate-staged');
  assert.equal(operation.expectedInstalledDigest, `sha256:${'a'.repeat(64)}`);
  assert.equal(operation.candidateDigest, `sha256:${'b'.repeat(64)}`);
  reopened.failAppUpdate({ at, errorCode: 'APP_UPDATE_INTERRUPTED', instanceId: 'update-instance', operationId: 'update-one', stage: 'recovery-required' });
  assert.equal(reopened.getAppOperation('update-one').status, 'failed');
  reopened.close();
});

test('app health refresh records validation operations and projection truth', async () => {
  const store = new SuiteManagerStore(await tempStateDir());
  const at = '2026-06-27T10:00:00.000Z';
  store.installAppInstance({
    at,
    instance: {
      categorySnapshot: 'tools',
      displayNameSnapshot: 'Example App',
      id: 'instance-one',
      manifestDigest: 'sha256:manifest',
      packageId: 'example-app',
      packageVersion: '0.1.0',
    },
    operationId: 'operation-one',
    projections: [
      { contentJson: '{"target":"http://127.0.0.1:18123/health","type":"http"}', digest: 'sha256:health', kind: 'health' },
    ],
    request: { dryRunOnly: true },
  });

  store.recordAppHealthCheck({
    at: '2026-06-27T10:05:00.000Z',
    errorCode: 'APP_HEALTH_FAILED',
    healthy: false,
    instanceId: 'instance-one',
    operationId: 'operation-two',
    request: { target: 'health' },
  });
  assert.deepEqual(store.getAppProjections('instance-one').map(({ appliedDigest, kind, status }) => ({ appliedDigest, kind, status })), [
    { appliedDigest: null, kind: 'health', status: 'failed' },
  ]);

  store.recordAppHealthCheck({
    at: '2026-06-27T10:06:00.000Z',
    healthy: true,
    instanceId: 'instance-one',
    operationId: 'operation-three',
    request: { target: 'health' },
  });
  assert.deepEqual(store.getAppProjections('instance-one').map(({ appliedDigest, digest, kind, status }) => ({
    applied: appliedDigest === digest,
    kind,
    status,
  })), [
    { applied: true, kind: 'health', status: 'applied' },
  ]);

  const operations = store.database.prepare(`
    SELECT error_code AS errorCode, kind, status FROM app_operations WHERE kind = 'validate' ORDER BY started_at
  `).all().map((row) => ({ errorCode: row.errorCode, kind: row.kind, status: row.status }));
  assert.deepEqual(operations, [
    { errorCode: 'APP_HEALTH_FAILED', kind: 'validate', status: 'failed' },
    { errorCode: null, kind: 'validate', status: 'succeeded' },
  ]);
  store.close();
});

test('app lifecycle transitions preserve stopped app metadata and delete state on uninstall', async () => {
  const store = new SuiteManagerStore(await tempStateDir());
  const at = '2026-06-27T10:00:00.000Z';
  store.installAppInstance({
    at,
    config: [
      {
        fingerprint: 'sha256:secret',
        key: 'adminToken',
        redactedLabel: 'Generated token',
        secretRef: '/state/app-secrets/instance-one/adminToken.secret',
        source: 'generated',
      },
    ],
    instance: {
      categorySnapshot: 'tools',
      displayNameSnapshot: 'Example App',
      id: 'instance-one',
      manifestDigest: 'sha256:manifest',
      packageId: 'example-app',
      packageVersion: '0.1.0',
    },
    operationId: 'operation-one',
    projections: [
      { contentJson: '{"services":[]}', digest: 'sha256:compose', kind: 'compose' },
      { contentJson: '{"routes":[]}', digest: 'sha256:caddy', kind: 'caddy' },
      { contentJson: '{"target":"http://127.0.0.1:18123/health","type":"http"}', digest: 'sha256:health', kind: 'health' },
      { contentJson: '{"name":"Example App"}', digest: 'sha256:homepage', kind: 'homepage' },
    ],
    request: { dryRunOnly: true },
  });
  store.applyAppProjections({
    at: '2026-06-27T10:01:00.000Z',
    instanceId: 'instance-one',
    kinds: ['compose', 'caddy', 'health'],
    operationId: 'operation-two',
    request: { target: 'runtime' },
  });
  store.applyAppProjection({
    at: '2026-06-27T10:02:00.000Z',
    instanceId: 'instance-one',
    kind: 'homepage',
    operationId: 'operation-three',
    request: { target: 'homepage' },
  });

  store.markAppDisabled({
    at: '2026-06-27T10:03:00.000Z',
    instanceId: 'instance-one',
    operationId: 'operation-four',
    request: { preserveData: true },
  });
  let instance = store.getAppInstanceByPackageId('example-app');
  assert.equal(instance.status, 'disabled');
  assert.equal(instance.enabled, false);
  assert.deepEqual(store.getAppConfig('instance-one').map(({ fingerprint, key, secret, secretRef }) => ({ fingerprint, key, secret, secretRef })), [
    { fingerprint: 'sha256:secret', key: 'adminToken', secret: true, secretRef: '/state/app-secrets/instance-one/adminToken.secret' },
  ]);
  assert.deepEqual(store.getAppProjections('instance-one').map(({ appliedDigest, digest, kind, status }) => ({
    applied: appliedDigest === digest,
    digest,
    kind,
    status,
  })), [
    { applied: true, digest: 'sha256:caddy', kind: 'caddy', status: 'applied' },
    { applied: false, digest: 'sha256:compose', kind: 'compose', status: 'rendered' },
    { applied: false, digest: 'sha256:health', kind: 'health', status: 'rendered' },
    { applied: true, digest: 'sha256:homepage', kind: 'homepage', status: 'applied' },
  ]);

  store.markAppEnabled({
    at: '2026-06-27T10:04:00.000Z',
    instanceId: 'instance-one',
    operationId: 'operation-five',
    request: { target: 'runtime' },
  });
  instance = store.getAppInstanceByPackageId('example-app');
  assert.equal(instance.status, 'installed');
  assert.equal(instance.enabled, true);

  store.deleteAppInstance({
    instanceId: 'instance-one',
  });
  instance = store.getAppInstanceByPackageId('example-app');
  assert.equal(instance, null);
  assert.equal(store.getAppConfig('instance-one').length, 0);
  assert.equal(store.getAppProjections('instance-one').length, 0);

  const operations = store.database.prepare(`
    SELECT kind, status FROM app_operations WHERE kind IN ('disable', 'enable', 'uninstall') ORDER BY started_at
  `).all().map((row) => ({ kind: row.kind, status: row.status }));
  assert.deepEqual(operations, []);
  store.close();
});

test('app guide state is persisted per app instance', async () => {
  const store = new SuiteManagerStore(await tempStateDir());
  const at = '2026-06-27T10:00:00.000Z';
  store.installAppInstance({
    at,
    instance: {
      categorySnapshot: 'office',
      displayNameSnapshot: 'Example App',
      id: 'instance-one',
      manifestDigest: 'sha256:manifest',
      packageId: 'example-app',
      packageVersion: '0.1.0',
    },
    operationId: 'operation-one',
    projections: [],
    request: { dryRunOnly: true },
  });

  assert.equal(store.getAppGuideState('instance-one'), null);
  let guide = store.setAppGuideStatus({
    at: '2026-06-27T10:01:00.000Z',
    instanceId: 'instance-one',
    status: 'viewed',
  });
  assert.equal(guide.status, 'viewed');
  assert.equal(guide.firstViewedAt, '2026-06-27T10:01:00.000Z');
  assert.equal(guide.completedAt, null);

  guide = store.setAppGuideStatus({
    at: '2026-06-27T10:02:00.000Z',
    instanceId: 'instance-one',
    status: 'completed',
  });
  assert.equal(guide.status, 'completed');
  assert.equal(guide.firstViewedAt, '2026-06-27T10:01:00.000Z');
  assert.equal(guide.completedAt, '2026-06-27T10:02:00.000Z');
  assert.equal(guide.manifestDigest, 'sha256:manifest');
  store.close();
});

test('failed HTTPS apply retains the previously active configuration', async () => {
  const store = new SuiteManagerStore(await tempStateDir());
  store.beginHttpsApply({ acmeEmail: 'first@example.com', at: 'one', baseDomain: 'first.example.com' });
  store.completeHttpsApply('two');
  store.beginHttpsApply({ acmeEmail: 'second@example.com', at: 'three', baseDomain: 'second.example.com' });
  store.failHttpsApply({ at: 'four', errorCode: 'HTTPS_APPLY_FAILED' });

  const settings = store.getHttpsSettings();
  assert.equal(settings.baseDomain, 'first.example.com');
  assert.equal(settings.pendingBaseDomain, null);
  assert.equal(settings.lastApplyStatus, 'failed');
  store.close();
});

test('owner and initial session creation rolls back as one atomic operation', async () => {
  const store = new SuiteManagerStore(await tempStateDir());

  assert.throws(() => store.createOwnerAndSession(owner(), session(null)), /NOT NULL constraint failed/);
  assert.equal(store.getOwner(), null);
  store.close();
});

test('database constraints enforce one owner account', async () => {
  const store = new SuiteManagerStore(await tempStateDir());
  store.createOwnerAndSession(owner(), session());

  assert.throws(
    () => store.database.prepare(`
      INSERT INTO owners (id, name, email, password_hash, created_at)
      VALUES (2, 'Other', 'other@example.com', 'hash', 'now')
    `).run(),
    /CHECK constraint failed/,
  );
  store.close();
});

test('legacy JSON imports once and is retained with a migrated suffix', async () => {
  const stateDir = await tempStateDir();
  const rawToken = 'legacy-raw-session-token';
  const legacyPath = path.join(stateDir, 'platform-state.json');
  await fsp.writeFile(legacyPath, `${JSON.stringify({
    owner: owner(),
    sessions: [session(hashSessionToken(rawToken))],
    version: 1,
  }, null, 2)}\n`);

  const store = new SuiteManagerStore(stateDir);
  assert.equal(store.getOwner().email, 'owner@example.com');
  assert.equal(store.hasSession(hashSessionToken(rawToken)), true);
  store.close();

  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.existsSync(`${legacyPath}.migrated`), true);

  const reopened = new SuiteManagerStore(stateDir);
  assert.equal(reopened.getOwner().email, 'owner@example.com');
  reopened.close();
});

test('an existing SQLite database is never overwritten by legacy JSON', async () => {
  const stateDir = await tempStateDir();
  const store = new SuiteManagerStore(stateDir);
  store.close();

  const legacyPath = path.join(stateDir, 'platform-state.json');
  await fsp.writeFile(legacyPath, JSON.stringify({ owner: owner(), sessions: [] }));

  const reopened = new SuiteManagerStore(stateDir);
  assert.equal(reopened.getOwner(), null);
  reopened.close();
  assert.equal(fs.existsSync(legacyPath), true);
});

test('external sources persist separately and removing one never uninstalls its snapshot', async () => {
  const store = new SuiteManagerStore(await tempStateDir());
  const record = {
    addedAt: '2026-07-15T10:00:00.000Z',
    catalogPath: 'apps',
    id: 'src-abc123def456',
    kind: 'external-git',
    publisher: 'community',
    repository: 'https://code.example/community/apps',
    revision: null,
    signature: null,
    status: 'active',
    statusReason: null,
    trust: 'unverified',
    updatedAt: '2026-07-15T10:00:00.000Z',
  };
  store.insertAppSource(record);
  assert.deepEqual(store.listAppSources().map((source) => source.id), ['src-abc123def456']);

  store.installAppInstance({
    at: '2026-07-15T10:05:00.000Z',
    instance: {
      categorySnapshot: 'tools',
      displayNameSnapshot: 'Community Notes',
      id: 'x-abc123de-community-notes',
      manifestDigest: 'sha256:manifest',
      packageDigest: `sha256:${'c'.repeat(64)}`,
      packageId: 'community-notes',
      packageVersion: '1.0.0',
      snapshotPath: '/var/lib/mos/app-packages/x-abc123de-community-notes/installed',
      snapshotState: 'installed',
      source: { kind: 'external-git', path: 'apps/community-notes', repository: 'https://code.example/community/apps', revision: '89abcdef0123456789abcdef0123456789abcdef', trust: 'unverified' },
    },
    operationId: 'operation-external-one',
    projections: [{ contentJson: '{"services":[]}', digest: 'sha256:compose', kind: 'compose' }],
    request: { dryRunOnly: true },
  });

  const resolved = store.updateAppSourceRevision({ at: '2026-07-15T10:06:00.000Z', id: record.id, revision: '89abcdef0123456789abcdef0123456789abcdef' });
  assert.equal(resolved.revision, '89abcdef0123456789abcdef0123456789abcdef');

  const removed = store.updateAppSourceStatus({ at: '2026-07-15T10:10:00.000Z', id: record.id, status: 'removed', statusReason: 'Removed by owner.' });
  assert.equal(removed.status, 'removed');
  assert.equal(store.getAppSource(record.id).statusReason, 'Removed by owner.');

  const instance = store.getAppInstanceByPackageId('community-notes');
  assert.equal(instance.status, 'installed');
  assert.equal(instance.snapshotState, 'installed');
  assert.equal(instance.sourceTrust, 'unverified');
  store.close();
});
