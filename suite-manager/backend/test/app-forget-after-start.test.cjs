'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { APP_AGENT_CONTRACT_VERSION } = require('../../../shared/app-agent-contract.cjs');
const { AppPackageService } = require('../src/apps/app-package-service.cjs');
const { secretFilePath } = require('../src/apps/app-package-internals.cjs');
const { validateManifestSemantics } = require('../src/apps/manifest-semantics.cjs');
const { digestAppPackage } = require('../src/apps/package-contracts.cjs');
const { readAppPackageManifest } = require('../src/apps/package-manifest.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const repoApps = path.resolve(__dirname, '..', '..', '..', 'apps');
const PASSWORD = 'owner-paperless-password';

// Paperless as the fixture: its admin password is one setup secret read by one env var.
async function paperlessCopy(dir, { forget, version }) {
  await fsp.cp(path.join(repoApps, 'paperless-ngx'), dir, { recursive: true });
  await fsp.rm(path.join(dir, 'privacy-review.json'), { force: true });
  const file = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
  manifest.setup.fields = manifest.setup.fields.map(({ forgetAfterStart, ...field }) => (
    field.id === 'adminPassword' && forget ? { ...field, forgetAfterStart: true } : field
  ));
  await fsp.writeFile(file, `${JSON.stringify({ ...manifest, ...(version ? { version } : {}) }, null, 2)}\n`);
}

function recordingAgent(calls, candidate, appsDir) {
  return {
    async activatePackageUpdate(input) { calls.push(['activate', input]); return { status: 'candidate-healthy' }; },
    async apply(input) { calls.push(['apply', input]); return { publicUrl: input.publicUrl, status: 'applied', steps: [] }; },
    async buildPackageUpdate() { return { status: 'built' }; },
    async checkHealth() { return { status: 'healthy' }; },
    async promotePackageUpdate() { return { snapshotPath: candidate.dir, status: 'snapshot-promoted' }; },
    async rollbackPackageUpdate() { return { status: 'installed-restored' }; },
    async snapshotPackage(input) { return { snapshotPath: path.join(appsDir, input.packageId) }; },
    async stagePackageUpdate() { return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() { return { contractVersion: APP_AGENT_CONTRACT_VERSION }; },
  };
}

const appliedPasswords = (calls) => calls.filter(([kind]) => kind === 'apply' || kind === 'activate')
  .map(([, input]) => (input.candidate || input).compose.services.find((service) => service.id === 'paperless').environment.PAPERLESS_ADMIN_PASSWORD ?? null);

async function harness({ forget }) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-forget-'));
  const appsDir = path.join(root, 'apps');
  await paperlessCopy(path.join(appsDir, 'paperless-ngx'), { forget });
  const calls = [];
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const candidate = { dir: path.join(root, 'candidate-1') };
  const service = new AppPackageService({
    agent: recordingAgent(calls, candidate, appsDir),
    appsDir,
    catalogService: {
      platformVersion: '99.0.0',
      async downloadCandidate() {
        const read = readAppPackageManifest(candidate.dir);
        const source = { kind: 'official-git', path: 'apps/paperless-ngx', repository: 'https://github.com/rpuls/my-own-suite', revision: 'c'.repeat(40), trust: 'mos-reviewed' };
        return { ...read, cleanup() {}, packageDigest: digestAppPackage(candidate.dir), source };
      },
    },
    secretDir: path.join(root, 'secrets'),
    store,
  });
  const context = { appHost: 'paperless.example.test', baseHost: 'example.test', publicUrl: 'https://paperless.example.test/', scheme: 'https' };
  await service.installPackage('paperless-ngx', { adminPassword: PASSWORD, adminUsername: 'owner@example.test' });
  const instance = store.getAppInstanceByPackageId('paperless-ngx');
  const held = () => store.getAppConfig(instance.id).some((row) => row.key === 'adminPassword');
  const onDisk = () => fs.existsSync(secretFilePath(path.join(root, 'secrets'), instance.id, 'adminPassword'));
  return { calls, candidate, context, held, onDisk, root, service };
}

test('a secret the package forgets after the first start is gone once the app started healthy, and the app starts again without it', async () => {
  const h = await harness({ forget: true });
  await h.service.startPackageRuntime('paperless-ngx', h.context);

  assert.deepEqual(appliedPasswords(h.calls), [PASSWORD, null]);
  assert.equal(h.held(), false);
  assert.equal(h.onDisk(), false);

  await h.service.restartPackageRuntime('paperless-ngx', h.context);
  assert.deepEqual(appliedPasswords(h.calls), [PASSWORD, null, null]);
});

test('a secret without the flag is kept and reaches every start', async () => {
  const h = await harness({ forget: false });
  await h.service.startPackageRuntime('paperless-ngx', h.context);
  assert.deepEqual(appliedPasswords(h.calls), [PASSWORD]);
  assert.equal(h.held(), true);
});

test('an app updating to a package that forgets the secret drops it after the update, and the next update never asks for it', async () => {
  const h = await harness({ forget: false });
  await h.service.startPackageRuntime('paperless-ngx', h.context);
  await paperlessCopy(h.candidate.dir, { forget: true, version: '99.0.0' });

  const update = async () => {
    const comparison = await h.service.preparePackageUpdate('paperless-ngx');
    assert.deepEqual(comparison.requiredInput, []);
    return h.service.stagePackageUpdate('paperless-ngx', { confirmationToken: comparison.confirmationToken }, h.context);
  };
  assert.equal((await update()).operation.status, 'succeeded');
  assert.deepEqual(appliedPasswords(h.calls), [PASSWORD, PASSWORD, null]);
  assert.equal(h.held(), false);
  assert.equal(h.onDisk(), false);

  h.candidate.dir = path.join(h.root, 'candidate-2');
  await paperlessCopy(h.candidate.dir, { forget: true, version: '99.0.1' });
  assert.equal((await update()).operation.status, 'succeeded');
  assert.equal(appliedPasswords(h.calls).at(-1), null);
});

function manifestWith(change) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoApps, 'paperless-ngx', 'manifest.json'), 'utf8'));
  change(manifest);
  return validateManifestSemantics(manifest, { packageDir: path.join(repoApps, 'paperless-ngx') });
}

const flag = (manifest, id, value = true) => {
  manifest.setup.fields = manifest.setup.fields.map((field) => (field.id === id ? { ...field, forgetAfterStart: value } : field));
};

test('only a secret can be forgotten, and only a service env may read it', () => {
  assert.deepEqual(manifestWith((manifest) => flag(manifest, 'adminPassword')), []);
  assert.match(manifestWith((manifest) => flag(manifest, 'adminUsername')).join('\n'), /only a secret field can be forgotten/u);
  assert.match(manifestWith((manifest) => flag(manifest, 'adminPassword', 'yes')).join('\n'), /forgetAfterStart is true or false/u);
  assert.match(manifestWith((manifest) => {
    flag(manifest, 'adminPassword');
    manifest.homepage.widget = { type: 'paperlessngx', password: '${secret.adminPassword}' };
  }).join('\n'), /forgets after the first start/u);
});
