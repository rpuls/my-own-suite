const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SetupError, SetupService } = require('../src/setup/setup-service.cjs');

async function tempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mos-v2-state-'));
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

  const reloaded = new SetupService({ stateDir });
  assert.equal(reloaded.status().status, 'signed-out');
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
