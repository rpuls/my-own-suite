// Coverage for the one destination MOS writes to when it backs up on its own.
// The cases that matter are the ones that decide whether an unattended backup
// finds its destination at all: a drive back on a different mount path, and an
// empty drive that has no repository to be identified by yet.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { PrimaryDestination } = require('./primary.cjs');

function world({ repositories = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-primary-'));
  const state = { repositories };
  const primary = new PrimaryDestination({
    agentStateDir: dir,
    now: () => new Date('2026-09-09T12:00:00.000Z'),
    repositoryId: (destinationId) => state.repositories[destinationId] || null,
  });
  return { dir, primary, state };
}

test('choosing a destination records the name it had, so a drive in a drawer is still named', () => {
  const { primary } = world({ repositories: { '/media/backup': 'repo-1' } });
  primary.save({ destinationId: '/media/backup', label: 'Backup drive' });
  assert.deepEqual(primary.state(), { destinationId: '/media/backup', label: 'Backup drive', setAt: '2026-09-09T12:00:00.000Z' });
  assert.equal(primary.read().repositoryId, 'repo-1');
});

test('a reconnected drive is found by the repository on it, not by where Linux attached it', () => {
  const { primary, state } = world({ repositories: { '/media/backup': 'repo-1' } });
  primary.save({ destinationId: '/media/backup', label: 'Backup drive' });

  // Same drive, new mount path, and the old path is gone.
  state.repositories = { '/media/backup-2': 'repo-1' };
  const found = primary.resolve([{ id: '/media/backup-2', label: 'Backup drive', writable: true }]);
  assert.equal(found.id, '/media/backup-2');

  // Two drives carrying the same repository is ambiguous, and guessing which
  // one to write to is worse than waiting.
  assert.equal(primary.resolve([{ id: '/media/a' }, { id: '/media/b' }].map((entry) => ({ ...entry, writable: true }))), null);
});

test('an empty drive has no repository yet, so it is found by path until its first backup', () => {
  const { primary, state } = world();
  primary.save({ destinationId: '/media/backup', label: 'New drive' });
  assert.equal(primary.read().repositoryId, null);
  assert.equal(primary.resolve([{ id: '/media/backup', writable: true }]).id, '/media/backup');
  // Nothing identifies it once the path is gone, which is the honest answer.
  assert.equal(primary.resolve([{ id: '/media/other', writable: true }]), null);

  // The first backup writes one, and it is captured then.
  state.repositories = { '/media/backup': 'repo-9' };
  primary.rememberRepository('/media/backup');
  assert.equal(primary.read().repositoryId, 'repo-9');
});

test('remembering a repository never repoints the primary at another destination', () => {
  const { primary, state } = world();
  primary.save({ destinationId: '/media/backup', label: 'Backup drive' });
  state.repositories = { '/media/elsewhere': 'repo-2' };
  primary.rememberRepository('/media/elsewhere');
  assert.equal(primary.read().destinationId, '/media/backup');
  assert.equal(primary.read().repositoryId, null);
});

test('nothing is primary until one is chosen, and clearing it means nothing again', () => {
  const { primary } = world();
  assert.equal(primary.state(), null);
  assert.equal(primary.resolve([{ id: '/media/backup', writable: true }]), null);
  assert.throws(() => primary.save({ destinationId: '' }), /Choose the destination/u);

  primary.save({ destinationId: '/media/backup', label: 'Backup drive' });
  primary.clear();
  assert.equal(primary.state(), null);
});
