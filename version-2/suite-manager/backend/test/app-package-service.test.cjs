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

test('public URL reconciliation reapplies installed app routes and Homepage app entries', async () => {
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(input);
      return { appHost: input.appHost, publicUrl: input.publicUrl, status: 'applied', steps: [] };
    },
    async checkHealth() {
      return { status: 'healthy' };
    },
  };
  const homepageCalls = [];
  const homepageService = {
    async add(body) {
      homepageCalls.push(['add', body.entry]);
      return { changed: true, revision: 'sha256:next' };
    },
    async read() {
      return { content: '[]', revision: 'sha256:current' };
    },
    async reconcileUrls(body) {
      homepageCalls.push(['reconcile', body.entries]);
      return { changed: true, revision: 'sha256:reconciled' };
    },
  };
  const store = new SuiteManagerStore(await tempStateDir());
  const service = new AppPackageService({ agent: appAgent, appsDir: v2AppsDir, store });

  service.installPackage('stirling-pdf');
  await service.applyPackageRuntime('stirling-pdf', {
    appHost: 'stirling-pdf.mos.home',
    baseHost: 'mos.home',
    publicUrl: 'http://stirling-pdf.mos.home/',
    scheme: 'http',
  });
  await service.addPackageToHomepage('stirling-pdf', homepageService, {
    appHost: 'stirling-pdf.mos.home',
    baseHost: 'mos.home',
    publicUrl: 'http://stirling-pdf.mos.home/',
    scheme: 'http',
  });

  await service.reconcilePublicUrls(homepageService, requestContext());

  assert.equal(calls.at(-1).appHost, 'stirling-pdf.example.test');
  assert.equal(calls.at(-1).publicUrl, 'https://stirling-pdf.example.test/');
  assert.deepEqual(homepageCalls.at(-1)[1], [{
    href: 'https://stirling-pdf.example.test/',
    id: store.getAppInstanceByPackageId('stirling-pdf').id,
  }]);

  store.close();
});

test('public URL reconciliation keeps Homepage regeneration separate from per-app runtime failures', async () => {
  const appAgent = {
    async apply(input) {
      if (input.packageId === 'vaultwarden' && input.publicUrl.startsWith('https://')) {
        throw Object.assign(new Error('missing secret'), { code: 'APP_SECRET_UNAVAILABLE' });
      }
      return { appHost: input.appHost, publicUrl: input.publicUrl, status: 'applied', steps: [] };
    },
    async checkHealth() {
      return { status: 'healthy' };
    },
  };
  const homepageCalls = [];
  const homepageService = {
    async add(body) {
      return { changed: true, revision: 'sha256:next', requestId: body.requestId };
    },
    async read() {
      return { content: '[]', revision: 'sha256:current' };
    },
    async reconcileUrls(body) {
      homepageCalls.push(body.entries);
      return { changed: true, revision: 'sha256:reconciled' };
    },
  };
  const store = new SuiteManagerStore(await tempStateDir());
  const service = new AppPackageService({ agent: appAgent, appsDir: v2AppsDir, store });

  for (const packageId of ['stirling-pdf', 'vaultwarden']) {
    service.installPackage(packageId);
    await service.applyPackageRuntime(packageId, {
      appHost: `${packageId}.mos.home`,
      baseHost: 'mos.home',
      publicUrl: `http://${packageId}.mos.home/`,
      scheme: 'http',
    });
    await service.addPackageToHomepage(packageId, homepageService, {
      appHost: `${packageId}.mos.home`,
      baseHost: 'mos.home',
      publicUrl: `http://${packageId}.mos.home/`,
      scheme: 'http',
    });
  }

  const result = await service.reconcilePublicUrls(homepageService, requestContext());

  assert.equal(result.status, 'partial');
  assert.deepEqual(homepageCalls.at(-1).map((entry) => entry.href).sort(), [
    'https://stirling-pdf.example.test/',
    'https://vaultwarden.example.test/',
  ]);
  assert.equal(result.runtime.find((item) => item.packageId === 'stirling-pdf').status, 'applied');
  assert.equal(result.runtime.find((item) => item.packageId === 'vaultwarden').status, 'failed');
  assert.equal(result.runtime.find((item) => item.packageId === 'vaultwarden').errorCode, 'APP_SECRET_UNAVAILABLE');

  store.close();
});

test('public URL reconciliation keeps disabled apps out of runtime reapply', async () => {
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(input);
      return { status: 'applied', steps: [] };
    },
    async stop() {
      return { status: 'stopped', steps: [] };
    },
  };
  const homepageService = {
    async read() {
      return { content: '[]', revision: 'sha256:current' };
    },
    async reconcileUrls(body) {
      return { changed: false, entries: body.entries };
    },
  };
  const store = new SuiteManagerStore(await tempStateDir());
  const service = new AppPackageService({ agent: appAgent, appsDir: v2AppsDir, store });

  service.installPackage('stirling-pdf');
  await service.disablePackage('stirling-pdf', homepageService);
  await service.reconcilePublicUrls(homepageService, requestContext());

  assert.equal(calls.length, 0);

  store.close();
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
