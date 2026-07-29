const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SERVER_LOGIN_FILE_NAME,
  renderServerLoginFile,
  writeServerLoginFile,
} = require('../../scripts/selfhost-build-installer-iso.cjs');

const sample = {
  generatedAt: '2026-07-29',
  home: 'http://home.mos.home/',
  password: 'quiet-otter-lantern-42',
  username: 'mos',
};

test('the server login file carries the credentials it exists to preserve', () => {
  const contents = renderServerLoginFile(sample);

  assert.match(contents, /quiet-otter-lantern-42/u);
  assert.match(contents, /\bmos\b/u);
  assert.match(contents, /http:\/\/home\.mos\.home\//u);
  // The file's whole purpose is to be copied out and deleted, so it has to say so.
  assert.match(contents, /password manager/iu);
  assert.match(contents, /delete this file/iu);
  // Owners confuse the machine login with their MOS account; the file must not.
  assert.match(contents, /NOT your My Own Suite owner account/u);
});

test('writing the login file replaces a previous build and stays owner-readable', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-login-'));
  context.after(() => fs.rmSync(directory, { force: true, recursive: true }));

  const stale = writeServerLoginFile(directory, renderServerLoginFile({ ...sample, password: 'previous-build-password' }));
  const target = writeServerLoginFile(directory, renderServerLoginFile(sample));

  assert.equal(target, stale);
  assert.equal(path.basename(target), SERVER_LOGIN_FILE_NAME);

  // A stale password left beside the ISO would be worse than no file at all:
  // it sends the owner to a login that no longer exists on the machine.
  const written = fs.readFileSync(target, 'utf8');
  assert.match(written, /quiet-otter-lantern-42/u);
  assert.doesNotMatch(written, /previous-build-password/u);

  // Modes are advisory on Windows, so this only asserts where they mean something.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
});
