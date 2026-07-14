const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { collectPackageFiles, digestAppPackage } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../../suite-manager/backend/src/apps/package-manifest.cjs');
const { sha256, validatePackagePayloads } = require('./agent.cjs');

test('backup package preflight accepts exact snapshots and rejects corrupt payloads', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-v2-backup-packages-'));
  const instanceId = '12345678-1234-4123-8123-123456789abc';
  const packageDir = path.join(root, 'var-lib-mos-v2', 'app-packages', instanceId, 'installed');
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
