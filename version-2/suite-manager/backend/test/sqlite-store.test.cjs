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
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-v2-sqlite-'));
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
    'app_instance_projections',
    'app_instances',
    'app_operations',
    'homepage_operations',
    'homepage_revisions',
    'https_settings',
    'owners',
    'schema_migrations',
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
  ]);
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
      packageId: 'example-app',
      packageVersion: '0.1.0',
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
  assert.equal(instance.packageVersion, '0.1.0');

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
