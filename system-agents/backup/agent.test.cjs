const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectPackageFiles, digestAppPackage } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');

// The agent reads its state roots at load, so they point at scratch before it is
// required; its app-agent socket does not exist here, which is the case under test.
const scratchRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'mos-backup-agent-'));
process.env.MOS_STATE_ROOT = scratchRoot;
process.env.MOS_BACKUP_AGENT_STATE_DIR = path.join(scratchRoot, 'backup-agent');
process.env.MOS_APP_AGENT_SOCKET = path.join(scratchRoot, 'no-such-agent.sock');
const { RECOVERY_KEY_GATED_ROUTES, RECOVERY_KEY_UNACKNOWLEDGED, sha256, survey, validatePackagePayloads } = require('./agent.cjs');

// The app agent restarts during every platform update. Its drives must not
// vanish from the Backups screen then, and the schedule must not call a drive
// "not connected" when the truth is that storage could not be read.
test('the drive destinations the agent knows stay listed as unreachable while the storage module cannot be asked', async () => {
  fsSync.mkdirSync(process.env.MOS_BACKUP_AGENT_STATE_DIR, { recursive: true });
  fsSync.writeFileSync(path.join(process.env.MOS_BACKUP_AGENT_STATE_DIR, 'last-backups.json'), JSON.stringify({ '1A2B-3C4D': '2026-10-20T03:00:00.000Z', 'object:0123456789ab': '2026-10-21T03:00:00.000Z' }));
  fsSync.writeFileSync(path.join(process.env.MOS_BACKUP_AGENT_STATE_DIR, 'primary-destination.json'), JSON.stringify({ destinationId: '1A2B-3C4D', label: 'Backup drive', setAt: '2026-10-01T00:00:00.000Z' }));

  const { archives, destinations } = await survey();
  assert.deepEqual(archives, []);
  assert.deepEqual(destinations.map((entry) => [entry.id, entry.kind, entry.state, entry.reason, entry.label, entry.lastBackupAt, entry.ownArchive]), [
    ['1A2B-3C4D', 'disk', 'unreachable', 'MOS could not read your storage right now.', 'Backup drive', '2026-10-20T03:00:00.000Z', null],
  ]);
});

// The gate exists so nobody ends up with backups only a machine they no longer
// have can open. It must not reach any further than that: a machine in the
// middle of recovering has no key to save yet, and blocking it from mounting a
// drive or restoring would be the gate causing the loss it exists to prevent.
test('an unsaved recovery key blocks only what would create unopenable backups', () => {
  assert.deepEqual([...RECOVERY_KEY_GATED_ROUTES].sort(), ['/v1/backups', '/v1/schedule']);
  // Connecting a bucket is deliberately open: a replacement machine has to
  // connect the surviving bucket before it can enter the key that opens it.
  for (const open of ['/v1/backups/validate', '/v1/destinations/object', '/v1/destinations/object/backups', '/v1/destinations/object/test', '/v1/archives/unlock', '/v1/recovery-key/reveal', '/v1/restores', '/v1/status']) {
    assert.equal(RECOVERY_KEY_GATED_ROUTES.includes(open), false, open);
  }
  assert.match(RECOVERY_KEY_UNACKNOWLEDGED, /recovery key/iu);
  assert.match(RECOVERY_KEY_UNACKNOWLEDGED, /replacement server/iu);
});

test('backup package preflight accepts exact snapshots and rejects corrupt payloads', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-backup-packages-'));
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const packageDir = path.join(root, 'var-lib-mos', 'app-packages', instanceId, 'installed');
  const source = path.resolve(__dirname, '..', '..', 'apps', 'stirling-pdf');
  await fsp.cp(source, packageDir, { recursive: true });
  const { manifest } = readAppPackageManifest(packageDir);
  const packages = [{
    instanceId,
    packageDigest: digestAppPackage(packageDir),
    packageId: manifest.id,
    packageVersion: manifest.version,
    payload: collectPackageFiles(packageDir, { manifest }).map((file) => ({ bytes: file.size, path: file.relativePath, sha256: sha256(file.absolutePath) })),
  }];

  assert.doesNotThrow(() => validatePackagePayloads(root, packages));
  await fsp.appendFile(path.join(packageDir, 'Dockerfile'), '\n# corrupt\n');
  assert.throws(() => validatePackagePayloads(root, packages), /identity is invalid|payload hash is invalid/u);
});

// Regression: the payload preflight compared the bare manifest id to the
// instance package id, so any external app (managed under a namespaced id)
// made its own backup unrestorable.
test('backup package preflight accepts an external app under its namespaced package id', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-backup-packages-'));
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const packageDir = path.join(root, 'var-lib-mos', 'app-packages', instanceId, 'installed');
  const source = path.resolve(__dirname, '..', '..', 'apps', 'stirling-pdf');
  await fsp.cp(source, packageDir, { recursive: true });
  const { manifest } = readAppPackageManifest(packageDir);
  const packages = [{
    instanceId,
    packageDigest: digestAppPackage(packageDir),
    packageId: `x-abcdef01-${manifest.id}`,
    packageVersion: manifest.version,
    payload: collectPackageFiles(packageDir, { manifest }).map((file) => ({ bytes: file.size, path: file.relativePath, sha256: sha256(file.absolutePath) })),
  }];

  assert.doesNotThrow(() => validatePackagePayloads(root, packages));
  assert.throws(() => validatePackagePayloads(root, [{ ...packages[0], packageId: 'x-abcdef01-other-app' }]), /identity is invalid/u);
});

// Regression: sha256 read whole files into one Buffer, which exhausts RAM or
// trips ERR_FS_FILE_TOO_LARGE on multi-gigabyte volume archives. The chunked
// implementation must match a one-shot hash across chunk boundaries.
test('backup sha256 hashes files larger than one read chunk correctly', async () => {
  const crypto = require('node:crypto');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-backup-hash-'));
  const file = path.join(root, 'archive.bin');
  const chunk = Buffer.alloc(3 * 1024 * 1024, 7);
  const handle = await fsp.open(file, 'w');
  for (let index = 0; index < 7; index += 1) await handle.write(Buffer.from(chunk.map((byte) => byte + index)));
  await handle.close();

  const expected = crypto.createHash('sha256').update(await fsp.readFile(file)).digest('hex');
  assert.equal(sha256(file), expected);
});

