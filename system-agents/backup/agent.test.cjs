const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectPackageFiles, digestAppPackage } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
const { sha256, validatePackagePayloads } = require('./agent.cjs');

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
