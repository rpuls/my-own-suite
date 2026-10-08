const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { OfficialCatalogError } = require('../src/apps/official-catalog-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

const URLS = { appHost: 'notes.home.test', baseHost: 'home.test', publicUrl: 'http://notes.home.test/', scheme: 'http' };
const resolver = () => URLS;
const appUrls = { hostFor: (id) => (id === 'notes' ? 'notes' : null), publicUrlOf: () => URLS, publicUrls: () => resolver };
const homepageConfig = { homepage: true };

// Every app package method the routes call, recording what it was handed.
function recordingPackages(calls) {
  return new Proxy({}, {
    get: (target, name) => target[name] ?? ((...args) => { calls.push([name, ...args]); return { called: name }; }),
  });
}

test('the app list carries each app its public URL and jobs, and checks sources only after answering', async () => {
  const order = [];
  const services = {
    appPackages: {
      hostFacts: async () => ({ architecture: 'amd64' }),
      listPackages: () => [{ id: 'notes' }, { id: 'vaultwarden' }],
    },
    appUrls,
    catalogService: { status: () => ({ state: 'fresh' }) },
    externalSourceService: { sweep: () => order.push('sweep') },
    installJobs: { get: (id) => (id === 'notes' ? { status: 'running' } : null) },
    updateJobs: { get: () => null },
  };

  await withRoutes(services, async (call) => {
    const listed = await call('GET', '/apps/packages');
    order.push('answered');

    assert.deepEqual(listed.json(), {
      catalog: { state: 'fresh' },
      packages: [
        { id: 'notes', installJob: { status: 'running' }, publicUrl: URLS.publicUrl, updateJob: null },
        { id: 'vaultwarden', installJob: null, publicUrl: '', updateJob: null },
      ],
    });
  });

  assert.deepEqual(order, ['sweep', 'answered']);
});

test('a catalog that cannot refresh answers 502 with the catalog state, and anything else is internal', async () => {
  let failure = null;
  const catalogService = {
    refresh: async () => { if (failure) throw failure; return { catalog: { revision: 'abc' } }; },
    status: () => ({ state: 'stale' }),
  };

  await withRoutes({ catalogService }, async (call) => {
    assert.deepEqual((await call('POST', '/apps/catalog/refresh')).json(), { catalog: { revision: 'abc' } });

    failure = new OfficialCatalogError('CATALOG_FETCH_FAILED', 'The official catalog could not be fetched.');
    const unreachable = await call('POST', '/apps/catalog/refresh');
    assert.equal(unreachable.status, 502);
    assert.deepEqual(unreachable.json(), { code: 'CATALOG_FETCH_FAILED', error: 'The official catalog could not be fetched.', status: { state: 'stale' } });

    failure = new Error('disk full');
    const broken = await call('POST', '/apps/catalog/refresh');
    assert.equal(broken.status, 500);
    assert.equal(broken.json().error, 'Internal server error.');
  });
});

test('App package icon and screenshot APIs serve the files the package service names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-app-icon-'));
  fs.writeFileSync(path.join(dir, 'icon.png'), 'png bytes');
  fs.writeFileSync(path.join(dir, 'screenshot-2.webp'), 'webp bytes');
  const asked = [];
  const appPackages = {
    iconPath: (id) => { asked.push(['icon', id]); return path.join(dir, 'icon.png'); },
    screenshotPath: (id, index) => { asked.push(['screenshot', id, index]); return path.join(dir, 'screenshot-2.webp'); },
  };

  await withRoutes({ appPackages }, async (call) => {
    const icon = await call('GET', '/apps/packages/stirling-pdf/icon');
    assert.equal(icon.status, 200);
    assert.equal(icon.headers['content-type'], 'image/png');
    assert.equal(icon.body, 'png bytes');

    const screenshot = await call('GET', '/apps/packages/stirling-pdf/screenshots/2');
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.body, 'webp bytes');
    assert.equal((await call('GET', '/apps/packages/stirling-pdf/screenshots/1000')).status, 404);
  });

  assert.deepEqual(asked, [['icon', 'stirling-pdf'], ['screenshot', 'stirling-pdf', 2]]);
});

test('each package action reaches the package service with the app URLs it needs', async () => {
  const calls = [];
  const appPackages = recordingPackages(calls);

  await withRoutes({ appPackages, appUrls, homepageConfig }, async (call) => {
    for (const action of ['prepare-update', 'recover-update', 'add-to-homepage', 'apply-runtime', 'stop', 'enable', 'restart', 'uninstall', 'refresh-runtime-status']) {
      assert.equal((await call('POST', `/apps/packages/notes/${action}`)).status, 200, action);
    }
    assert.equal((await call('POST', '/apps/packages/notes/install', { body: { config: { title: 'Notes' } } })).status, 200);
    assert.equal((await call('POST', '/apps/packages/notes/env', { body: { variables: [] } })).status, 200);
  });

  const runtime = { ...URLS, publicUrlFor: resolver };
  assert.deepEqual(calls, [
    ['preparePackageUpdate', 'notes'],
    ['recoverPackageUpdate', 'notes', runtime],
    ['addPackageToHomepage', 'notes', homepageConfig, URLS],
    ['startPackageRuntime', 'notes', runtime],
    ['disablePackage', 'notes'],
    ['enablePackage', 'notes', runtime],
    ['restartPackageRuntime', 'notes', runtime],
    ['uninstallPackage', 'notes', homepageConfig],
    ['refreshPackageRuntimeStatus', 'notes'],
    ['installPackage', 'notes', { config: { title: 'Notes' } }],
    ['savePackageEnvironment', 'notes', { variables: [] }, runtime],
  ]);
});

test('install and update jobs answer at once with what they were handed', async () => {
  const begun = [];
  const installJobs = { begin: (id, input) => { begun.push(['install', id, input]); return { status: 'running' }; } };
  const updateJobs = { begin: (id, input) => { begun.push(['update', id, input]); return { status: 'running' }; } };

  await withRoutes({ installJobs, updateJobs }, async (call) => {
    const install = await call('POST', '/apps/packages/notes/install-job', { body: { config: { title: 'Notes' }, showOnHomepage: 'yes' } });
    assert.equal(install.status, 202);
    assert.deepEqual(install.json(), { installJob: { status: 'running' } });
    assert.equal((await call('POST', '/apps/packages/notes/install-job', { body: {} })).status, 202);
    const update = await call('POST', '/apps/packages/notes/update-job', { body: { confirmationToken: 'token' } });
    assert.equal(update.status, 202);
    assert.deepEqual(update.json(), { updateJob: { status: 'running' } });
  });

  assert.deepEqual(begun, [
    ['install', 'notes', { config: { title: 'Notes' }, showOnHomepage: false }],
    ['install', 'notes', { config: {}, showOnHomepage: false }],
    ['update', 'notes', { confirmationToken: 'token' }],
  ]);
});

test('connecting two apps passes the slot field by field, and a guide takes only its three statuses', async () => {
  const calls = [];
  const appPackages = {
    connectPackages: async (input) => { calls.push(['connect', input]); return { connected: true }; },
    setPackageGuideStatus: (id, status) => { calls.push(['guide', id, status]); return { status }; },
  };

  await withRoutes({ appPackages, appUrls }, async (call) => {
    assert.equal((await call('POST', '/apps/integrations/connect', {
      body: { consumerPackageId: 'seafile', initiator: 'smuggled', providerCapabilityId: 'documents', providerPackageId: 'onlyoffice', slotId: 'editor' },
    })).status, 200);
    const refused = await call('POST', '/apps/packages/notes/guide', { body: { status: 'finished' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.json().code, 'INVALID_GUIDE_STATUS');
    assert.deepEqual((await call('POST', '/apps/packages/notes/guide', { body: { status: 'completed' } })).json(), { status: 'completed' });
  });

  assert.deepEqual(calls, [
    ['connect', { consumerPackageId: 'seafile', providerCapabilityId: 'documents', providerPackageId: 'onlyoffice', requestContext: { publicUrlFor: resolver }, slotId: 'editor' }],
    ['guide', 'notes', 'completed'],
  ]);
});
