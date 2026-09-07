const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectPackageFiles, digestAppPackage } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
const { isMountPoint, isWholeDiskFilesystem, mountBlockReason, reclaimUnmountedDestinations, sha256, validatePackagePayloads } = require('./agent.cjs');

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

// Regression: a drive formatted end to end (no partition table) was never
// offered for mounting, because candidacy was decided by "not a disk". That is
// also the shape a whole-disk drive comes back as after a restore drill, so such
// a drive could not be re-attached from the UI at all.
test('a whole-disk filesystem is a mount candidate, and a partitioned disk is not', () => {
  const wholeDisk = { fstype: 'ext4', label: 'MOS Backup', path: '/dev/sdb', size: 512 * 1024 ** 3, type: 'disk' };
  assert.equal(isWholeDiskFilesystem(wholeDisk), true);
  assert.equal(mountBlockReason(wholeDisk), null);

  const partitioned = { children: [{ fstype: 'ext4', path: '/dev/sdb1', type: 'part' }], path: '/dev/sdb', type: 'disk' };
  assert.equal(isWholeDiskFilesystem(partitioned), false);
  assert.match(mountBlockReason(partitioned), /not the whole device/u);

  const blankDisk = { fstype: null, path: '/dev/sdc', type: 'disk' };
  assert.equal(isWholeDiskFilesystem(blankDisk), false);
  assert.match(mountBlockReason(blankDisk), /not the whole device/u);
});

test('whole-disk candidacy does not weaken the existing partition rules', () => {
  assert.equal(mountBlockReason({ fstype: 'ext4', path: '/dev/sdb1', size: 512 * 1024 ** 3, type: 'part' }), null);
  assert.match(mountBlockReason({ fstype: '', path: '/dev/sdb1', type: 'part' }), /no detected filesystem/u);
  assert.match(mountBlockReason({ fstype: 'zfs_member', path: '/dev/sdb1', type: 'part' }), /not mounted automatically/u);
  assert.match(mountBlockReason({ fstype: 'ext4', path: null, type: 'part' }), /device path was not reported/u);
  assert.match(mountBlockReason({ fstype: 'squashfs', path: '/dev/loop0', type: 'loop' }), /not the whole device/u);
});

// A whole disk is now a candidate, so the system-drive guards have to hold for
// one too — the root filesystem is exactly a mounted disk with a filesystem.
test('a whole disk carrying the system is still refused', () => {
  assert.match(
    mountBlockReason({ fstype: 'ext4', mountpoints: ['/'], path: '/dev/sda', type: 'disk' }),
    /system partition/u,
  );
  assert.match(
    mountBlockReason({ fstype: 'vfat', label: 'EFI', path: '/dev/sda', size: 512 * 1024 * 1024, type: 'disk' }),
    /system partition/u,
  );
  assert.match(
    mountBlockReason({ fstype: 'ext4', mountpoints: ['/var/lib/docker/volumes'], path: '/dev/sda', type: 'disk' }),
    /system partition/u,
  );
});

// A drive pulled mid-backup leaves its mountpoint behind as a directory on the
// system disk holding whatever was written afterwards — 34 MB in the drills,
// invisible again the moment the drive is plugged back in.
test('an unmounted mountpoint left behind by an interrupted backup is reclaimed', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-mountroot-'));
  const leftover = path.join(root, 'backup-drive-sdb1');
  await fsp.mkdir(path.join(leftover, 'MOS-backups', 'repository', 'data'), { recursive: true });
  await fsp.writeFile(path.join(leftover, 'MOS-backups', 'repository', 'data', 'pack'), Buffer.alloc(4096, 3));
  await fsp.writeFile(path.join(leftover, 'MOS-backups', 'repository', 'config'), 'x'.repeat(120));

  const reclaimed = reclaimUnmountedDestinations(root);

  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0].path, leftover);
  assert.equal(reclaimed[0].bytes, 4096 + 120);
  assert.equal(fsSync.existsSync(leftover), false);
});

test('reclaiming touches nothing outside the mount root and leaves no empty directory behind', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-mountroot-'));
  const sibling = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-elsewhere-'));
  await fsp.writeFile(path.join(sibling, 'keep.txt'), 'untouched');
  const empty = path.join(root, 'empty-drive-sdc1');
  await fsp.mkdir(empty, { recursive: true });
  await fsp.writeFile(path.join(root, 'not-a-directory.txt'), 'ignored');

  const reclaimed = reclaimUnmountedDestinations(root);

  // An empty mountpoint holds nothing worth reporting, but is still cleared.
  assert.deepEqual(reclaimed, []);
  assert.equal(fsSync.existsSync(empty), false);
  assert.equal(fsSync.existsSync(path.join(root, 'not-a-directory.txt')), true);
  assert.equal(fsSync.readFileSync(path.join(sibling, 'keep.txt'), 'utf8'), 'untouched');
});

test('a missing mount root is not an error', async () => {
  const root = path.join(os.tmpdir(), `mos-mountroot-absent-${Date.now()}`);
  assert.deepEqual(reclaimUnmountedDestinations(root), []);
});

// The delete is gated on proving the path is NOT the drive, so every uncertain
// answer has to be "mounted" — otherwise a transient stat failure would delete
// the backups on an attached drive.
test('the mount test fails safe, answering mounted whenever it cannot tell', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-mounttest-'));
  const ordinary = path.join(root, 'ordinary');
  await fsp.mkdir(ordinary);

  assert.equal(isMountPoint(ordinary), false);
  assert.equal(isMountPoint(path.join(root, 'does-not-exist')), true);

  // A path proved to be a mount is skipped rather than deleted.
  const guarded = path.join(root, 'guarded');
  await fsp.mkdir(guarded);
  await fsp.writeFile(path.join(guarded, 'drive-data'), 'precious');
  const originalStat = fsSync.statSync;
  fsSync.statSync = (target, ...rest) => {
    const stat = originalStat(target, ...rest);
    if (String(target) === guarded) return { ...stat, dev: stat.dev + 1 };
    return stat;
  };
  try {
    assert.deepEqual(reclaimUnmountedDestinations(root), []);
  } finally {
    fsSync.statSync = originalStat;
  }
  assert.equal(fsSync.readFileSync(path.join(guarded, 'drive-data'), 'utf8'), 'precious');
});
