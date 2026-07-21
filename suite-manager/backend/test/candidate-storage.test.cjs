const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  activeCandidateDirs,
  candidateRoot,
  createCandidateDir,
  releaseCandidateDir,
  sweepCandidateRoot,
} = require('../src/apps/candidate-storage.cjs');

function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-candidates-'));
  return { root: candidateRoot(stateDir), stateDir };
}

// An abandoned download from a process that no longer exists: a directory in the
// root that nothing in this process owns.
function abandoned(root, name, ageMs = 0) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
  if (ageMs) {
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(dir, at, at);
  }
  return dir;
}

test('a sweep reclaims candidate downloads left behind by a killed process', () => {
  const { root, stateDir } = fixture();
  fs.mkdirSync(root, { recursive: true });
  const stale = abandoned(root, 'ext-stale', 2 * 60 * 60 * 1_000);
  const fresh = abandoned(root, 'ext-fresh');
  const removed = sweepCandidateRoot(stateDir);
  assert.deepEqual(removed, [stale]);
  assert.equal(fs.existsSync(stale), false);
  // A recent directory may belong to an operation that is still running in
  // another process, so age is what makes it collectable.
  assert.equal(fs.existsSync(fresh), true);
});

test('a sweep never reclaims a download this process is still using', () => {
  const { stateDir } = fixture();
  const active = createCandidateDir(stateDir, 'ext-');
  const at = new Date(Date.now() - (2 * 60 * 60 * 1_000));
  fs.utimesSync(active, at, at);
  try {
    assert.deepEqual(sweepCandidateRoot(stateDir), []);
    // The agent may still be reading this directory to stage a build.
    assert.equal(fs.existsSync(active), true);
  } finally {
    releaseCandidateDir(active);
  }
});

test('the candidate root stays bounded when downloads are abandoned faster than they age out', () => {
  const { root, stateDir } = fixture();
  fs.mkdirSync(root, { recursive: true });
  const dirs = [];
  for (let index = 0; index < 12; index += 1) dirs.push(abandoned(root, `ext-${index}`, (12 - index) * 1_000));
  sweepCandidateRoot(stateDir, { policy: { maxEntries: 4, staleAfterMs: 60 * 60 * 1_000 } });
  const survivors = fs.readdirSync(root);
  assert.equal(survivors.length, 4);
  // The newest survive: an old download is the one least likely to still matter.
  assert.deepEqual(survivors.sort(), ['ext-11', 'ext-8', 'ext-9', 'ext-10'].sort());
});

test('creating a candidate directory reclaims abandoned ones first', () => {
  const { root, stateDir } = fixture();
  fs.mkdirSync(root, { recursive: true });
  const stale = abandoned(root, 'immich-stale', 2 * 60 * 60 * 1_000);
  const dir = createCandidateDir(stateDir, 'immich-');
  try {
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(dir), true);
    assert.equal(path.dirname(dir), root);
  } finally {
    releaseCandidateDir(dir);
  }
});

test('releasing a candidate directory removes it and releases its claim', () => {
  const { stateDir } = fixture();
  const dir = createCandidateDir(stateDir, 'ext-');
  assert.equal(activeCandidateDirs.has(dir), true);
  releaseCandidateDir(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(activeCandidateDirs.has(dir), false);
});

test('sweeping a state directory that has never downloaded anything is not an error', () => {
  const { stateDir } = fixture();
  assert.deepEqual(sweepCandidateRoot(stateDir), []);
  assert.deepEqual(sweepCandidateRoot(path.join(stateDir, 'missing')), []);
});

test('the candidate root is not readable by other users on the host', () => {
  const { root, stateDir } = fixture();
  const dir = createCandidateDir(stateDir, 'ext-');
  try {
    if (process.platform === 'win32') return;
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  } finally {
    releaseCandidateDir(dir);
  }
});
