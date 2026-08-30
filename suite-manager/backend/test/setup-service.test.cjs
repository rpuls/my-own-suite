const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { hashSessionToken } = require('../src/auth/sessions.cjs');
const { SetupError, SetupService, TERMS_VERSION } = require('../src/setup/setup-service.cjs');
const { DATABASE_FILENAME } = require('../src/state/suite-manager-store.cjs');

async function tempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mos-state-'));
}

test('empty state requires owner creation', async () => {
  const service = new SetupService({ stateDir: await tempStateDir() });

  assert.deepEqual(service.status(), {
    owner: null,
    status: 'needs-owner',
    terms: { accepted: false, acceptedAt: null, version: TERMS_VERSION },
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

test('terms acceptance persists across restart and only for the version shown', async () => {
  const stateDir = await tempStateDir();
  const service = new SetupService({ stateDir });
  service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });

  assert.equal(service.status().terms.accepted, false);
  assert.throws(
    () => service.acceptTerms({ version: '1999-01' }),
    (error) => error instanceof SetupError && error.code === 'TERMS_VERSION_MISMATCH',
  );

  const accepted = service.acceptTerms({ version: TERMS_VERSION });
  assert.equal(accepted.terms.accepted, true);
  assert.equal(typeof accepted.terms.acceptedAt, 'string');
  // Accepting twice is idempotent: the first acceptance is the record.
  const again = service.acceptTerms({ version: TERMS_VERSION });
  assert.equal(again.terms.acceptedAt, accepted.terms.acceptedAt);
  service.close();

  const reloaded = new SetupService({ stateDir });
  assert.equal(reloaded.status().terms.accepted, true);
  reloaded.close();
});

test('owner preferences default off, persist, and reach only a signed-in caller', async () => {
  const stateDir = await tempStateDir();
  const service = new SetupService({ stateDir });
  const created = service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });

  assert.deepEqual(service.status(created.sessionToken).preferences, { technicalControls: false });
  // A caller who is not signed in is told nothing about how the owner has set
  // up their own Suite Manager.
  assert.equal(service.status().preferences, undefined);
  assert.equal(service.status('not-a-session').preferences, undefined);

  assert.deepEqual(service.setPreference({ key: 'technicalControls', value: true }), { technicalControls: true });
  assert.deepEqual(service.status(created.sessionToken).preferences, { technicalControls: true });
  service.close();

  const reloaded = new SetupService({ stateDir });
  assert.deepEqual(reloaded.status(created.sessionToken).preferences, { technicalControls: true });
  assert.deepEqual(reloaded.setPreference({ key: 'technicalControls', value: false }), { technicalControls: false });
  reloaded.close();
});

test('only known preference keys with the right type are stored', async () => {
  const stateDir = await tempStateDir();
  const service = new SetupService({ stateDir });

  assert.throws(
    () => service.setPreference({ key: 'technicalControls', value: true }),
    (error) => error instanceof SetupError && error.code === 'OWNER_NOT_CREATED',
  );

  service.createOwner({ email: 'owner@example.com', name: 'Suite Owner', password: 'correct horse battery' });

  assert.throws(
    () => service.setPreference({ key: 'showEverything', value: true }),
    (error) => error instanceof SetupError && error.code === 'UNKNOWN_PREFERENCE',
  );
  for (const value of ['true', 1, null, undefined, { enabled: true }]) {
    assert.throws(
      () => service.setPreference({ key: 'technicalControls', value }),
      (error) => error instanceof SetupError && error.code === 'INVALID_PREFERENCE_VALUE',
    );
  }
  service.close();
});

test('changing the owner password ends every session and issues a fresh one', async () => {
  const stateDir = await tempStateDir();
  const service = new SetupService({ stateDir });
  const created = service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });
  const otherBrowser = service.login({ email: 'owner@example.com', password: 'correct horse battery' });

  const changed = service.changeOwnerPassword({
    currentPassword: 'correct horse battery',
    newPassword: 'a much better passphrase',
  });

  assert.equal(changed.status, 'signed-in');
  assert.equal(service.status(changed.sessionToken).status, 'signed-in');
  assert.equal(service.status(created.sessionToken).status, 'signed-out');
  assert.equal(service.status(otherBrowser.sessionToken).status, 'signed-out');
  assert.equal(service.login({ email: 'owner@example.com', password: 'a much better passphrase' }).status, 'signed-in');
  service.close();

  const reloaded = new SetupService({ stateDir });
  assert.throws(
    () => reloaded.login({ email: 'owner@example.com', password: 'correct horse battery' }),
    (error) => error instanceof SetupError && error.code === 'INVALID_LOGIN',
  );
  reloaded.close();
});

test('changing the owner password refuses a wrong current password, a short new one, and a reuse', async () => {
  const service = new SetupService({ stateDir: await tempStateDir() });
  service.createOwner({
    email: 'owner@example.com',
    name: 'Suite Owner',
    password: 'correct horse battery',
  });

  assert.throws(
    () => service.changeOwnerPassword({ currentPassword: 'nope', newPassword: 'a much better passphrase' }),
    (error) => error instanceof SetupError && error.code === 'INVALID_CURRENT_PASSWORD',
  );
  assert.throws(
    () => service.changeOwnerPassword({ currentPassword: 'correct horse battery', newPassword: 'short' }),
    (error) => error instanceof SetupError && error.code === 'WEAK_OWNER_PASSWORD',
  );
  assert.throws(
    () => service.changeOwnerPassword({ currentPassword: 'correct horse battery', newPassword: 'correct horse battery' }),
    (error) => error instanceof SetupError && error.code === 'PASSWORD_UNCHANGED',
  );
  service.close();
});
