'use strict';

// The email relay service over a real store and a fake transport. What it holds
// in place: the password lives in a secret file and never in the database; a
// relay that fails to verify is still saved and its failure recorded honestly; a
// recorded failure never carries the password; an edit that leaves the password
// blank keeps it; and removing the relay forgets the secret too.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');
const { SmtpSettingsService } = require('../src/settings/smtp-settings-service.cjs');

const PASSWORD = 'hunter2-relay-secret';

async function harness({ client } = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-smtp-svc-'));
  const store = new SuiteManagerStore(stateDir);
  store.createOwnerAndSession(
    { createdAt: '2026-09-01T00:00:00.000Z', email: 'owner@example.com', name: 'Owner', passwordHash: 'x' },
    { createdAt: '2026-09-01T00:00:00.000Z', tokenHash: 'y' },
  );
  const secretDir = path.join(stateDir, 'app-secrets');
  const service = new SmtpSettingsService({ client: client || okClient(), secretDir, store });
  return { secretDir, service, store };
}

function okClient() {
  return {
    seen: [],
    async sendTestMessage(relay, opts) { this.seen.push({ kind: 'send', opts, relay }); return { messageId: '<id@example.com>' }; },
    async verifyRelay(relay) { this.seen.push({ kind: 'verify', relay }); return { capabilities: ['STARTTLS'], secured: true }; },
  };
}

const goodInput = { fromAddress: 'me@example.com', fromName: 'My Suite', host: 'smtp.example.com', password: PASSWORD, port: '587', security: 'starttls', username: 'me@example.com' };

test('an unconfigured relay reports itself so', async () => {
  const { service, store } = await harness();
  const status = service.status();
  assert.equal(status.configured, false);
  assert.equal(status.lastVerify.status, 'never');
  assert.equal(status.ownerEmail, 'owner@example.com');
  store.close();
});

test('saving stores the relay, verifies it, and keeps the password only in a secret file', async () => {
  const { secretDir, service, store } = await harness();
  const result = await service.save(goodInput);

  assert.equal(result.verify.status, 'verified');
  assert.equal(result.status.configured, true);
  assert.equal(result.status.passwordConfigured, true);
  assert.equal(result.status.lastVerify.status, 'verified');

  const row = store.getSmtpSettings();
  assert.ok(row.passwordRef, 'a password reference is stored');
  assert.equal(fs.existsSync(row.passwordRef), true, 'the secret file exists');
  assert.equal(fs.readFileSync(row.passwordRef, 'utf8'), PASSWORD);
  assert.ok(!JSON.stringify(row).includes(PASSWORD), 'the database row does not contain the password');
  assert.ok(row.passwordRef.includes('_settings'), 'the secret is namespaced away from app instances');
  assert.ok(secretDir);
  store.close();
});

test('a relay that fails to verify is still saved, and the failure is recorded without the password', async () => {
  const failing = {
    async verifyRelay() { throw Object.assign(new Error(`relay refused login for ${PASSWORD}`), { code: 'SMTP_COMMAND_REJECTED' }); },
    async sendTestMessage() { throw new Error('unused'); },
  };
  const { service, store } = await harness({ client: failing });
  const result = await service.save(goodInput);

  assert.equal(result.status.configured, true, 'the relay is saved even though it did not verify');
  assert.equal(result.verify.status, 'failed');
  const row = store.getSmtpSettings();
  assert.equal(row.lastVerifyStatus, 'failed');
  assert.equal(row.lastVerifyErrorCode, 'SMTP_COMMAND_REJECTED');
  assert.ok(row.lastVerifyDiagnostics, 'a diagnostics string is recorded');
  assert.ok(!row.lastVerifyDiagnostics.includes(PASSWORD), 'the recorded failure does not leak the password');
  assert.match(row.lastVerifyDiagnostics, /\[redacted\]/u);
  store.close();
});

test('editing without a new password keeps the stored one', async () => {
  const { service, store } = await harness();
  await service.save(goodInput);
  const firstRef = store.getSmtpSettings().passwordRef;

  const result = await service.save({ ...goodInput, fromName: 'Renamed', password: '' });
  assert.equal(result.status.fromName, 'Renamed');
  assert.equal(result.status.passwordConfigured, true);
  assert.equal(store.getSmtpSettings().passwordRef, firstRef, 'the same secret file is kept');
  assert.equal(fs.readFileSync(firstRef, 'utf8'), PASSWORD);
  store.close();
});

test('a username with no password on a relay that never had one is refused', async () => {
  const { service, store } = await harness();
  // No relay is stored yet, so there is no password to keep: a username with a
  // blank password is the invalid half-credential, surfaced rather than saved.
  await assert.rejects(service.save({ ...goodInput, password: '', username: 'me@example.com' }), (error) => {
    assert.equal(error.code, 'INVALID_SMTP_CREDENTIALS');
    return true;
  });
  assert.equal(service.status().configured, false, 'nothing was stored');
  store.close();
});

test('a successful test send marks the relay verified and reports the recipient', async () => {
  const client = okClient();
  const { service, store } = await harness({ client });
  await service.save(goodInput);
  store.failSmtpVerify({ at: '2026-09-01T00:00:00.000Z', diagnostics: null, errorCode: 'X' });

  const sent = await service.sendTest({ to: 'friend@example.com' });
  assert.equal(sent.sentTo, 'friend@example.com');
  assert.equal(store.getSmtpSettings().lastVerifyStatus, 'verified');
  assert.equal(client.seen.at(-1).opts.to, 'friend@example.com');
  store.close();
});

test('a test send defaults to the owner address and rejects a bad one', async () => {
  const client = okClient();
  const { service, store } = await harness({ client });
  await service.save(goodInput);

  const sent = await service.sendTest({});
  assert.equal(sent.sentTo, 'owner@example.com');
  await assert.rejects(service.sendTest({ to: 'not-an-email' }), (error) => {
    assert.equal(error.code, 'INVALID_SMTP_TEST_RECIPIENT');
    return true;
  });
  store.close();
});

test('a failed test send throws and records the failure', async () => {
  const failing = {
    async verifyRelay() { return { secured: true }; },
    async sendTestMessage() { throw Object.assign(new Error('mailbox full'), { code: 'SMTP_COMMAND_REJECTED' }); },
  };
  const { service, store } = await harness({ client: failing });
  await service.save(goodInput);
  await assert.rejects(service.sendTest({ to: 'friend@example.com' }), (error) => {
    assert.equal(error.code, 'SMTP_COMMAND_REJECTED');
    return true;
  });
  assert.equal(store.getSmtpSettings().lastVerifyStatus, 'failed');
  store.close();
});

test('verifying an unconfigured relay is a clean 409, not a crash', async () => {
  const { service, store } = await harness();
  await assert.rejects(service.verify(), (error) => {
    assert.equal(error.code, 'SMTP_NOT_CONFIGURED');
    assert.equal(error.statusCode, 409);
    return true;
  });
  store.close();
});

test('removing the relay forgets the settings and deletes the secret', async () => {
  const { service, store } = await harness();
  await service.save(goodInput);
  const ref = store.getSmtpSettings().passwordRef;
  assert.equal(fs.existsSync(ref), true);

  const status = service.remove();
  assert.equal(status.configured, false);
  assert.equal(store.getSmtpSettings().passwordRef, null);
  assert.equal(fs.existsSync(ref), false, 'the secret file is deleted');
  store.close();
});
