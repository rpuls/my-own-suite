const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AppPackageService,
  renderDryRunProjections,
} = require('../src/apps/app-package-service.cjs');
const { readAppPackageManifest } = require('../src/apps/package-manifest.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const v2Root = path.resolve(__dirname, '..', '..', '..');
const v2AppsDir = path.join(v2Root, 'apps');

async function tempStateDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-v2-app-service-'));
}

function requestContext() {
  return {
    publicUrlFor(packageId) {
      return {
        appHost: `${packageId}.example.test`,
        baseHost: 'example.test',
        publicUrl: `https://${packageId}.example.test/`,
        scheme: 'https',
      };
    },
  };
}

test('packages without Homepage metadata render no Homepage projection', () => {
  const { manifest } = readAppPackageManifest(path.join(v2AppsDir, 'onlyoffice'));
  const projections = renderDryRunProjections(manifest, []);

  assert.equal(manifest.role, 'capability-provider');
  assert.equal(manifest.homepage, undefined);
  assert.deepEqual(projections.map((projection) => projection.kind).sort(), ['caddy', 'compose', 'health']);
});

test('integration lifecycle recovers provider restart and reports disabled/uninstalled relationships truthfully', async () => {
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(['apply', input.packageId]);
      return { status: 'applied', steps: [] };
    },
    async checkHealth() {
      return { status: 'healthy' };
    },
    async connectNetwork(input) {
      calls.push(['connectNetwork', input.consumerPackageId, input.providerPackageId, input.providerServices]);
      return { status: 'connected' };
    },
    async remove(input) {
      calls.push(['remove', input.packageId]);
      return { status: 'removed', steps: [] };
    },
    async stop(input) {
      calls.push(['stop', input.packageId]);
      return { status: 'stopped', steps: [] };
    },
  };
  const homepageService = {
    async read() {
      return { content: '[]', revision: 'sha256:current' };
    },
    async removeLink() {
      throw new Error('OnlyOffice should not have a Homepage shortcut to remove.');
    },
  };

  const store = new SuiteManagerStore(await tempStateDir());
  const service = new AppPackageService({ agent: appAgent, appsDir: v2AppsDir, store });

  service.installPackage('seafile', {
    adminEmail: 'owner@example.test',
    adminPassword: 'not-a-real-secret',
  });
  service.installPackage('onlyoffice');
  await service.applyPackageRuntime('seafile', requestContext().publicUrlFor('seafile'));
  await service.applyPackageRuntime('onlyoffice', requestContext().publicUrlFor('onlyoffice'));
  await service.connectPackages({
    consumerPackageId: 'seafile',
    providerCapabilityId: 'documentEditor',
    providerPackageId: 'onlyoffice',
    requestContext: requestContext(),
    slotId: 'documentEditor',
  });

  assert.equal(store.getAppIntegrations()[0].status, 'active');
  assert.equal(calls.filter((call) => call[0] === 'connectNetwork').length, 1);

  await service.restartPackageRuntime('onlyoffice', requestContext());
  assert.equal(store.getAppIntegrations()[0].status, 'active');
  assert.equal(calls.filter((call) => call[0] === 'connectNetwork').length, 2);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'apply').map((call) => call[1]).slice(-2),
    ['onlyoffice', 'seafile'],
  );

  await service.disablePackage('onlyoffice', homepageService);
  assert.equal(store.getAppIntegrations()[0].status, 'degraded');
  assert.equal(store.getAppIntegrations()[0].lastErrorCode, 'APP_INTEGRATION_APP_DISABLED');
  assert.equal(store.getAppInstanceByPackageId('seafile').status, 'installed');

  await service.enablePackage('onlyoffice', requestContext());
  assert.equal(store.getAppIntegrations()[0].status, 'active');

  const uninstalled = await service.uninstallPackagePreserveData('onlyoffice', homepageService);
  assert.equal(uninstalled.homepage.skipped, true);
  assert.equal(store.getAppIntegrations()[0].status, 'removed');
  assert.equal(store.getAppInstanceByPackageId('seafile').status, 'installed');
  assert.doesNotMatch(JSON.stringify(store.getAppIntegrations()), /not-a-real-secret/u);

  store.close();
});
