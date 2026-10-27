const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LastBackups } = require('./last-backups.cjs');

test('the newest backup per destination is kept for when the drive is away, and rewritten only when it moves on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-last-backups-'));
  const record = new LastBackups({ agentStateDir: dir });
  assert.equal(record.of('1A2B-3C4D'), null);
  record.note('1A2B-3C4D', '2026-10-01T03:00:00.000Z');
  const written = fs.statSync(path.join(dir, 'last-backups.json')).mtimeMs;
  record.note('1A2B-3C4D', '2026-10-01T03:00:00.000Z');
  assert.equal(fs.statSync(path.join(dir, 'last-backups.json')).mtimeMs, written);
  record.note('1A2B-3C4D', '2026-10-02T03:00:00.000Z');
  assert.equal(new LastBackups({ agentStateDir: dir }).of('1A2B-3C4D'), '2026-10-02T03:00:00.000Z');
});
