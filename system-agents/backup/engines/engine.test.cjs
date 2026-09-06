// Coverage for the parts of the storage engine layer that are not exercised
// through BackupAgentCore: the machine-local repository key, the destination's
// repository description, and the pinned binary constants.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ensureRepositoryKey } = require('./engine-restic.cjs');
const { assertRepositoryEngine, createEngine, ENGINE_NAME, readRepositoryDescriptor, repositoryUsage, writeRepositoryDescriptor } = require('./engine.cjs');
const { assetFor, downloadUrl, ENGINE_RELEASES } = require('./engine-install.cjs');
const { managedStateTargets } = require('../../../infrastructure/persistent-state.cjs');

async function scratch() { return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-engine-')); }

// MOS has one storage engine and no way to ask for another: nothing reads an
// engine name from the environment, and the whole surface the agent core calls
// has to be present on the one engine there is.
test('the single engine exposes the whole surface under its own binary name', () => {
  const surface = ['forgetSnapshots', 'listSnapshots', 'maintainRepository', 'openOrCreateRepository', 'repositoryStats', 'restoreSnapshot', 'snapshotTree', 'verifyRepository', 'verifySnapshots'];
  const engine = createEngine({ agentStateDir: os.tmpdir() });
  assert.equal(engine.name, ENGINE_NAME);
  assert.equal(path.basename(engine.binaryPath), ENGINE_NAME);
  for (const method of surface) assert.equal(typeof engine[method], 'function', `${ENGINE_NAME}.${method}`);
});

// The password is what makes the repository readable at all, so it is
// generated once and reused; regenerating it would strand every earlier
// backup on the drive.
test('the repository key is generated once, kept private, and reused', async () => {
  const root = await scratch();
  const keyFile = path.join(root, 'agent-state', 'engine-key');
  const key = ensureRepositoryKey(keyFile);
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.equal(ensureRepositoryKey(keyFile), key);
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
});

// Restore points share the repository's deduplicated data, so the UI must be
// able to say what the store actually occupies — from the filesystem alone,
// with no engine invocation and no key.
test('repositoryUsage reports the store size and restore point count without an engine', async () => {
  const root = await scratch();
  assert.equal(repositoryUsage(root), null);

  writeRepositoryDescriptor(root, { engineName: 'restic', repositoryId: 'r1' });
  const repoDir = path.join(root, 'MOS-backups', 'repository', 'data');
  fs.mkdirSync(repoDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'pack-1'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(repoDir, 'pack-2'), Buffer.alloc(500));
  const pointsDir = path.join(root, 'MOS-backups', 'restore-points');
  fs.mkdirSync(pointsDir, { recursive: true });
  fs.writeFileSync(path.join(pointsDir, 'job-1.json'), '{}');
  fs.writeFileSync(path.join(pointsDir, 'job-1.json.sha256'), 'digest');
  // A manifest without its digest sidecar is incomplete and must not count.
  fs.writeFileSync(path.join(pointsDir, 'job-2.json'), '{}');

  assert.deepEqual(repositoryUsage(root), { engineName: 'restic', restorePoints: 1, storedBytes: 1500 });
});

// A key inside a backup would be circular: the backup could not be read
// without it. The classification is what keeps it out, so it is asserted
// rather than assumed.
test('the agent state directory holding the key is never backed up', () => {
  const target = managedStateTargets({ stateDir: '/var/lib/mos/suite-manager', stateRoot: '/var/lib/mos' }).find((entry) => entry.id === 'agent-state');
  assert.ok(target);
  assert.equal(target.backedUp, false);
  assert.equal(target.class, 'machine-local');
  assert.ok(target.path.includes('backup'));
});

// The descriptor outlives any one MOS version, so a drive written by a
// storage format this build does not speak is refused rather than written into.
test('a destination holding another storage format is refused, not overwritten', async () => {
  const root = await scratch();
  writeRepositoryDescriptor(root, { createdAt: new Date().toISOString(), engineName: 'kopia', repositoryId: 'abc' });
  assert.equal(readRepositoryDescriptor(root).engineName, 'kopia');
  assert.throws(() => assertRepositoryEngine(root, ENGINE_NAME), /different storage format \(kopia\)/u);
  // An untouched drive accepts this build's engine.
  assert.doesNotThrow(() => assertRepositoryEngine(path.join(root, 'empty'), ENGINE_NAME));
});

// A floating tag or an unpinned checksum would let the machine install
// something nobody reviewed, which is exactly what the CoreDNS precedent
// exists to prevent.
test('the engine build is pinned to an immutable version and checksum', () => {
  assert.deepEqual(Object.keys(ENGINE_RELEASES), [ENGINE_NAME]);
  const release = ENGINE_RELEASES[ENGINE_NAME];
  assert.match(release.version, /^\d+\.\d+\.\d+$/u);
  for (const arch of ['x64', 'arm64']) {
    const asset = assetFor(ENGINE_NAME, arch);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(asset.file.includes(release.version));
    const url = downloadUrl(ENGINE_NAME, asset);
    assert.ok(url.startsWith(`https://github.com/${release.repository}/releases/download/v${release.version}/`));
    assert.ok(!/latest|release\b/u.test(url.replace('/releases/', '/')));
  }
  assert.throws(() => assetFor(ENGINE_NAME, 'mips'), /No pinned/u);
});
