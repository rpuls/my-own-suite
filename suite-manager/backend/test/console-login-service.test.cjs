const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  ACKNOWLEDGED_FILE,
  ConsoleLoginError,
  ConsoleLoginService,
  HANDOVER_FILE,
} = require('../src/settings/console-login-service.cjs');

function freshStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mos-console-login-'));
}

function withHandover(stateDir, handover = { password: 'abcde-fghij-klmno', username: 'mos', version: 1 }) {
  fs.writeFileSync(path.join(stateDir, HANDOVER_FILE), JSON.stringify(handover), 'utf8');
  return handover;
}

test('an install with no generated console login reports nothing pending', () => {
  const service = new ConsoleLoginService({ stateDir: freshStateDir() });
  assert.deepEqual(service.status(), { acknowledged: false, pending: false, username: '' });
  assert.throws(() => service.reveal(), (error) => error instanceof ConsoleLoginError && error.code === 'CONSOLE_LOGIN_NOT_PENDING');
});

test('status names the account but never carries the password', () => {
  const stateDir = freshStateDir();
  withHandover(stateDir);
  const status = new ConsoleLoginService({ stateDir }).status();

  assert.deepEqual(status, { acknowledged: false, pending: true, username: 'mos' });
  // The dashboard reads this on every load; the password must only ever travel
  // in the response to an explicit reveal.
  assert.doesNotMatch(JSON.stringify(status), /abcde-fghij-klmno/u);
});

test('reveal returns the password the machine generated', () => {
  const stateDir = freshStateDir();
  withHandover(stateDir);
  assert.deepEqual(new ConsoleLoginService({ stateDir }).reveal(), { password: 'abcde-fghij-klmno', username: 'mos' });
});

test('acknowledging destroys the password and leaves the sentinel the installer watches', () => {
  const stateDir = freshStateDir();
  withHandover(stateDir);
  const service = new ConsoleLoginService({ stateDir });

  assert.deepEqual(service.acknowledge(), { acknowledged: true, pending: false });
  assert.equal(fs.existsSync(path.join(stateDir, HANDOVER_FILE)), false);
  // The installer's path unit fires on this file and clears the console banner.
  assert.equal(fs.existsSync(path.join(stateDir, ACKNOWLEDGED_FILE)), true);
  assert.deepEqual(service.status(), { acknowledged: true, pending: false, username: '' });
  assert.throws(() => service.reveal(), (error) => error.code === 'CONSOLE_LOGIN_NOT_PENDING');
});

test('acknowledging twice is a success, so a retried request is not an error', () => {
  const stateDir = freshStateDir();
  withHandover(stateDir);
  const service = new ConsoleLoginService({ stateDir });
  service.acknowledge();
  assert.deepEqual(service.acknowledge(), { acknowledged: true, pending: false });
});

test('a handover file left half-written by an interrupted first boot reports nothing pending', () => {
  const stateDir = freshStateDir();
  fs.writeFileSync(path.join(stateDir, HANDOVER_FILE), '{ "username": "mos", "passwo', 'utf8');
  // The console banner is the owner's remaining path; claiming a password is
  // waiting here would send them to a panel that cannot show one.
  assert.equal(new ConsoleLoginService({ stateDir }).status().pending, false);
});

test('a handover file missing either field is not treated as a login', () => {
  for (const handover of [{ username: 'mos' }, { password: 'abcde-fghij-klmno' }, { password: '', username: 'mos' }]) {
    const stateDir = freshStateDir();
    withHandover(stateDir, handover);
    assert.equal(new ConsoleLoginService({ stateDir }).status().pending, false);
  }
});
