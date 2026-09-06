// Coverage for the parts of the storage engine layer that are not exercised
// through BackupAgentCore: the machine-local repository key, the destination's
// repository description, and the pinned binary constants.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ensureRepositoryKey, maskSecrets, repositoryProbeCause, repositoryProbeVerdict } = require('./engine-restic.cjs');
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

// Verbatim output captured from restic 0.19.1 against MinIO on the lab VM.
// These four answers differ by a word or two and mean entirely different
// things to an owner, so they are pinned rather than paraphrased: the second
// and third were both read as "connected, no backups here yet" before this,
// which told someone who had mistyped a bucket name that they were set up.
const RESTIC_S3_OUTPUT = Object.freeze({
  missingBucket: [
    'Stat(<config/>) returned error, retrying after 21.053409241s: Stat: The specified bucket does not exist',
    'signal terminated received, cleaning up ',
    'Fatal: unable to open config file: context canceled',
  ].join('\n'),
  noRepositoryYet: [
    'Fatal: repository does not exist: unable to open config file: Stat: The specified key does not exist.',
    'Is there a repository at the following location?',
    's3:http://127.0.0.1:9100/mos-lab-backups/probe-a/MOS-backups/repository',
  ].join('\n'),
  refused: [
    'Stat(<config/>) returned error, retrying after 13.430741892s: Stat: The request signature we calculated does not match the signature you provided. Check your key and signing method.',
    'signal terminated received, cleaning up ',
    'Fatal: unable to open config file: context canceled',
  ].join('\n'),
  unreachable: [
    'Stat(<config/>) returned error, retrying after 20.909085174s: Stat: Get "http://127.0.0.1:9399/mos-lab-backups/?location=": dial tcp 127.0.0.1:9399: connect: connection refused',
    'signal terminated received, cleaning up ',
    'Fatal: unable to open config file: context canceled',
  ].join('\n'),
});

test('only an empty destination is read as one MOS may create a repository in', () => {
  assert.equal(repositoryProbeVerdict(RESTIC_S3_OUTPUT.noRepositoryYet), 'absent');
  assert.equal(repositoryProbeCause(RESTIC_S3_OUTPUT.noRepositoryYet).cause, 'absent');
  // Everything else must refuse, because creating a repository is a write and
  // MOS must never answer "I could not get in" by trying to write.
  for (const key of ['missingBucket', 'refused', 'unreachable']) {
    assert.equal(repositoryProbeVerdict(RESTIC_S3_OUTPUT[key]), 'unreachable', key);
  }
  assert.equal(repositoryProbeCause(RESTIC_S3_OUTPUT.missingBucket).cause, 'missing-bucket');
  assert.equal(repositoryProbeCause(RESTIC_S3_OUTPUT.refused).cause, 'rejected-key');
  assert.equal(repositoryProbeCause(RESTIC_S3_OUTPUT.unreachable).cause, 'unreachable-host');
});

test('each storage failure carries a sentence naming what to fix', () => {
  assert.match(repositoryProbeCause(RESTIC_S3_OUTPUT.missingBucket).message, /no bucket with that name/iu);
  assert.match(repositoryProbeCause(RESTIC_S3_OUTPUT.refused).message, /rejected the access key/iu);
  assert.match(repositoryProbeCause(RESTIC_S3_OUTPUT.unreachable).message, /could not reach that endpoint/iu);
  assert.equal(repositoryProbeCause(RESTIC_S3_OUTPUT.noRepositoryYet).message, null);
  assert.equal(repositoryProbeCause('something nobody predicted').cause, 'unknown');
});

// A rejected request quotes the key it was signed with, so masking is what
// stands between an owner's secret and a diagnostics file they email to
// someone.
test('storage credentials are masked out of captured output by exact value', () => {
  const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const masked = maskSecrets(`AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE signature for ${secret} rejected`, [secret, 'AKIAIOSFODNN7EXAMPLE']);
  assert.equal(masked.includes(secret), false);
  assert.equal(masked.includes('AKIAIOSFODNN7EXAMPLE'), false);
  assert.match(masked, /signature for •+ rejected/u);
  // A short or empty value is left alone: blanking it would hide the failure
  // rather than the secret.
  assert.equal(maskSecrets('exit status 2', ['2', '']), 'exit status 2');
});
