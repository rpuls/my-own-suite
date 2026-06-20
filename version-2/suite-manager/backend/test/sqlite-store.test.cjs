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

  assert.deepEqual(tables, ['owners', 'schema_migrations', 'sessions']);
  assert.deepEqual(migrations, MIGRATIONS.map(({ name, version }) => ({ name, version })));
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
