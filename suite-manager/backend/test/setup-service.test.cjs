const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { hashSessionToken } = require('../src/auth/sessions.cjs');
const { SetupError, SetupService } = require('../src/setup/setup-service.cjs');
const { DATABASE_FILENAME } = require('../src/state/suite-manager-store.cjs');

async function tempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mos-state-'));
}

test('empty state requires owner creation', async () => {
  const service = new SetupService({ stateDir: await tempStateDir() });

  assert.deepEqual(service.status(), {
    owner: null,
    status: 'needs-owner',
  });
});

test('owner creation persists owner and creates a session', async () => {
  const stateDir = await tempStateDir();
  const service = new SetupService({ stateDir });

  const result = service.createOwner({
    email: 'OWNER@Example.COM',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });

  assert.equal(result.status, 'signed-in');
  assert.equal(result.owner.email, 'owner@example.com');
  assert.equal(result.owner.name, 'Suite Owner');
  assert.equal(typeof result.sessionToken, 'string');
  assert.equal(service.status(result.sessionToken).status, 'signed-in');
  service.close();

  const reloaded = new SetupService({ stateDir });
  assert.equal(reloaded.status().status, 'signed-out');
  assert.equal(reloaded.status(result.sessionToken).status, 'signed-in');
  reloaded.close();
});

test('password hash and hashed session persist without plaintext secrets', async () => {
  const stateDir = await tempStateDir();
  const password = 'correct horse battery';
  const service = new SetupService({ stateDir });
  const created = service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password,
  });
  service.close();

  const databasePath = path.join(stateDir, DATABASE_FILENAME);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const storedOwner = database.prepare('SELECT password_hash AS passwordHash FROM owners').get();
  const storedSession = database.prepare('SELECT token_hash AS tokenHash FROM sessions').get();
  database.close();

  assert.match(storedOwner.passwordHash, /^scrypt\$/);
  assert.notEqual(storedOwner.passwordHash, password);
  assert.equal(storedSession.tokenHash, hashSessionToken(created.sessionToken));
  assert.notEqual(storedSession.tokenHash, created.sessionToken);
  const databaseBytes = fsSync.readFileSync(databasePath).toString('latin1');
  assert.doesNotMatch(databaseBytes, new RegExp(password));
  assert.doesNotMatch(databaseBytes, new RegExp(created.sessionToken));
});

test('owner creation rejects duplicate owner', async () => {
  const service = new SetupService({ stateDir: await tempStateDir() });
  service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });

  assert.throws(
    () =>
      service.createOwner({
        email: 'other@example.com',
        name: 'Other Owner',
        password: 'correct horse battery',
      }),
    (error) => error instanceof SetupError && error.code === 'OWNER_ALREADY_EXISTS',
  );
});

test('login creates a new session for the existing owner', async () => {
  const service = new SetupService({ stateDir: await tempStateDir() });
  service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });

  const login = service.login({
    email: 'owner@example.com',
    password: 'correct horse battery',
  });

  assert.equal(login.status, 'signed-in');
  assert.equal(service.status(login.sessionToken).status, 'signed-in');
});

test('login rejects the wrong password', async () => {
  const service = new SetupService({ stateDir: await tempStateDir() });
  service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });

  assert.throws(
    () =>
      service.login({
        email: 'owner@example.com',
        password: 'definitely wrong',
      }),
    (error) => error instanceof SetupError && error.code === 'INVALID_LOGIN',
  );
});

test('logout invalidates a persisted session across restart', async () => {
  const stateDir = await tempStateDir();
  const service = new SetupService({ stateDir });
  const created = service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });
  service.close();

  const reloaded = new SetupService({ stateDir });
  assert.equal(reloaded.status(created.sessionToken).status, 'signed-in');
  assert.equal(reloaded.logout(created.sessionToken).status, 'signed-out');
  reloaded.close();

  const afterLogout = new SetupService({ stateDir });
  assert.equal(afterLogout.status(created.sessionToken).status, 'signed-out');
  afterLogout.close();
});
