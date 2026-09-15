const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { GuestKeyStore } = require('./guest-keys.cjs');
const { generate } = require('./recovery-key.cjs');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-guest-keys-'));
  return new GuestKeyStore({ agentStateDir: dir });
}

test('a borrowed key is kept against the destination it opens and handed back on demand', () => {
  const keys = store();
  const key = generate().key;
  assert.equal(keys.keyFor('/media/mos-backup/other'), null);
  keys.save('/media/mos-backup/other', key);
  assert.equal(keys.keyFor('/media/mos-backup/other'), key);
  assert.equal(keys.keyFor('/media/mos-backup/mine'), null);
  assert.equal(keys.forget('/media/mos-backup/other'), true);
  assert.equal(keys.keyFor('/media/mos-backup/other'), null);
  assert.equal(keys.forget('/media/mos-backup/other'), false);
});

test('the summary says which places use a borrowed key without handing out the keys', () => {
  const keys = store();
  keys.save('object:one', generate().key);
  const [summary] = keys.summaries();
  assert.equal(summary.destinationId, 'object:one');
  assert.ok(summary.fingerprint);
  assert.ok(summary.savedAt);
  assert.ok(!('key' in summary));
});

test('the record is readable only by root', { skip: process.platform === 'win32' }, () => {
  const keys = store();
  keys.save('object:one', generate().key);
  assert.equal(fs.statSync(keys.recordPath).mode & 0o777, 0o600);
});
