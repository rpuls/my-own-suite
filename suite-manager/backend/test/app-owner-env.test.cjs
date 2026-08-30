// Owner environment variables: the app-agnostic escape hatch for values a
// package never asked for. What these tests hold in place is the part that is
// easy to lose — that owner env is an input to the one render path, so it
// survives an update; that projections carry references and never values; that
// a name MOS manages is refused rather than silently dropped or silently won;
// and that a change which does not come back healthy is put back.

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AppPackageService } = require('../src/apps/app-package-service.cjs');
const { publicInstance } = require('../src/apps/app-package-internals.cjs');
const { validateAppPackageManifest } = require('../src/apps/package-manifest.cjs');
const { readAppPackageManifest } = require('../src/apps/package-manifest.cjs');
const { digestAppPackage } = require('../src/apps/package-contracts.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const v2AppsDir = path.join(repoRoot, 'apps');
const CANDIDATE_VERSION = '99.0.0';

async function tempStateDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-owner-env-'));
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

// An agent that records what it was last asked to run and answers the health
// probe from it, so a variable that would stop the app can be simulated without
// a container: an env value the test declares fatal makes checkHealth fail for
// as long as that runtime is the applied one.
function recordingAgent({ fatal = null } = {}) {
  const state = { applies: [], compose: null };
  return {
    state,
    async apply(input) {
      state.applies.push(input);
      state.compose = input.compose;
      return { status: 'applied', steps: [] };
    },
    async checkHealth() {
      const broken = (state.compose?.services || []).some((service) => (
        fatal && Object.entries(service.environment || {}).some(([key, value]) => key === fatal.name && value === fatal.value)
      ));
      if (broken) throw new Error('container exited');
      return { status: 'healthy' };
    },
    async connectNetwork() { return { status: 'connected' }; },
    async snapshotPackage(input) { return { snapshotPath: path.join(v2AppsDir, input.packageId) }; },
    async status() { return { capabilities: ['apps.package.snapshot'], contractVersion: 7 }; },
    async stop() { state.compose = null; return { status: 'stopped' }; },
  };
}

const PAPERLESS_SETUP = {
  adminPassword: 'not-a-real-secret',
  adminUsername: 'owner@example.test',
  ocrLanguage: 'eng',
  timeZone: 'Europe/Amsterdam',
};

async function installedPaperless(root, store, { agent = recordingAgent(), now } = {}) {
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, store, ...(now ? { now } : {}) });
  await service.installPackage('paperless-ngx', PAPERLESS_SETUP);
  await service.applyPackageRuntime('paperless-ngx', requestContext().publicUrlFor('paperless-ngx'));
  return { agent, service };
}

function composeEnv(store, packageId, serviceId) {
  const instance = store.getAppInstanceByPackageId(packageId);
  return store.getAppProjections(instance.id)
    .find((projection) => projection.kind === 'compose')
    .content.services.find((item) => item.id === serviceId).environment;
}

test('owner env reaches the container as a reference in the projection and a value only at apply time', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const { agent, service } = await installedPaperless(root, store);

  const saved = await service.savePackageEnvironment('paperless-ngx', {
    entries: [
      { name: 'PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID', secret: false, value: 'client-id-value' },
      { name: 'PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET', secret: true, value: 'client-secret-value' },
    ],
  }, requestContext().publicUrlFor('paperless-ngx'));

  assert.equal(saved.status, 'applied');

  // The stored projection carries references, never values — the same property
  // integration env has, and the reason a stored projection is safe to read.
  const projected = composeEnv(store, 'paperless-ngx', 'paperless');
  assert.equal(projected.PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID, '${ownerEnv.PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID}');
  assert.equal(projected.PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET, '${ownerEnv.PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET}');
  assert.equal(JSON.stringify(store.getAppProjections(store.getAppInstanceByPackageId('paperless-ngx').id)).includes('client-secret-value'), false);

  // The runtime the agent was handed has the resolved values.
  const applied = agent.state.compose.services.find((item) => item.id === 'paperless').environment;
  assert.equal(applied.PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID, 'client-id-value');
  assert.equal(applied.PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET, 'client-secret-value');

  // And the app's own settings are untouched beside them.
  assert.equal(applied.PAPERLESS_REDIS, 'redis://broker:6379');
});

test('owner env survives a restart and a stop-then-start, because every runtime is built from the same projections', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const { agent, service } = await installedPaperless(root, store);
  const applied = () => agent.state.compose.services.find((item) => item.id === 'paperless').environment;

  await service.savePackageEnvironment('paperless-ngx', {
    entries: [
      { name: 'PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID', secret: false, value: 'client-id-value' },
      { name: 'PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET', secret: true, value: 'client-secret-value' },
    ],
  }, requestContext().publicUrlFor('paperless-ngx'));

  await service.restartPackageRuntime('paperless-ngx', requestContext().publicUrlFor('paperless-ngx'));
  assert.equal(applied().PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID, 'client-id-value');
  assert.equal(applied().PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET, 'client-secret-value');

  await service.stopPackageRuntime('paperless-ngx');
  await service.enablePackage('paperless-ngx', requestContext().publicUrlFor('paperless-ngx'));
  assert.equal(applied().PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID, 'client-id-value');
  assert.equal(applied().PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET, 'client-secret-value');
});

test('a name the app package already sets is refused, and the refusal names it', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const { service } = await installedPaperless(root, store);

  await assert.rejects(
    () => service.savePackageEnvironment('paperless-ngx', {
      entries: [{ name: 'PAPERLESS_REDIS', secret: false, value: 'redis://elsewhere' }],
    }, requestContext().publicUrlFor('paperless-ngx')),
    (error) => error.code === 'APP_ENV_INVALID'
      && error.statusCode === 400
      && error.details.length === 1
      && error.details[0].name === 'PAPERLESS_REDIS'
      && /PAPERLESS_REDIS is set by MOS and cannot be overridden here\./u.test(error.details[0].message),
  );

  // Nothing was written, and the package's own value still stands.
  assert.deepEqual(store.getAppEnv(store.getAppInstanceByPackageId('paperless-ngx').id), []);
  assert.equal(composeEnv(store, 'paperless-ngx', 'paperless').PAPERLESS_REDIS, 'redis://broker:6379');
});

test('a name a connected integration contributes is refused too', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const service = new AppPackageService({ agent: recordingAgent(), appsDir: v2AppsDir, store });
  await service.installPackage('seafile', { adminEmail: 'owner@example.test', adminPassword: 'not-a-real-secret' });
  await service.installPackage('onlyoffice');
  await service.applyPackageRuntime('seafile', requestContext().publicUrlFor('seafile'));
  await service.applyPackageRuntime('onlyoffice', requestContext().publicUrlFor('onlyoffice'));
  await service.connectPackages({
    consumerPackageId: 'seafile',
    providerCapabilityId: 'documentEditor',
    providerPackageId: 'onlyoffice',
    requestContext: requestContext(),
    slotId: 'documentEditor',
  });

  // ONLYOFFICE_APIJS_URL is nowhere in seafile's manifest env: it exists on this
  // instance only because the owner connected OnlyOffice. The managed set is
  // computed from the live relationships, so it covers that too.
  await assert.rejects(
    () => service.savePackageEnvironment('seafile', {
      entries: [{ name: 'ONLYOFFICE_APIJS_URL', secret: false, value: 'https://elsewhere.test/api.js' }],
    }, requestContext().publicUrlFor('seafile')),
    (error) => error.code === 'APP_ENV_INVALID'
      && /ONLYOFFICE_APIJS_URL is set by MOS and cannot be overridden here\./u.test(error.details[0].message),
  );

  assert.equal(
    composeEnv(store, 'seafile', 'seafile').ONLYOFFICE_APIJS_URL,
    '${config.integrationDocumentEditorOnlyofficeApijsUrl}',
  );
});

test('saving a hidden value without retyping it keeps the stored secret', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const { agent, service } = await installedPaperless(root, store);
  const instanceId = store.getAppInstanceByPackageId('paperless-ngx').id;

  await service.savePackageEnvironment('paperless-ngx', {
    entries: [{ name: 'OAUTH_CLIENT_SECRET', secret: true, value: 'client-secret-value' }],
  }, requestContext().publicUrlFor('paperless-ngx'));
  const [stored] = store.getAppEnv(instanceId);

  // The dialog cannot show a stored secret, so it submits the row without a
  // value. Pressing Save must not destroy what the owner cannot retype.
  await service.savePackageEnvironment('paperless-ngx', {
    entries: [
      { name: 'OAUTH_CLIENT_SECRET', secret: true },
      { name: 'OAUTH_CLIENT_ID', secret: false, value: 'client-id-value' },
    ],
  }, requestContext().publicUrlFor('paperless-ngx'));

  const kept = store.getAppEnv(instanceId).find((row) => row.name === 'OAUTH_CLIENT_SECRET');
  assert.equal(kept.fingerprint, stored.fingerprint);
  assert.equal(kept.secretRef, stored.secretRef);
  assert.equal(agent.state.compose.services.find((item) => item.id === 'paperless').environment.OAUTH_CLIENT_SECRET, 'client-secret-value');
});

test('a hidden value submitted for the first time without one is refused rather than stored empty', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const { service } = await installedPaperless(root, store);

  await assert.rejects(
    () => service.savePackageEnvironment('paperless-ngx', {
      entries: [{ name: 'OAUTH_CLIENT_SECRET', secret: true }],
    }, requestContext().publicUrlFor('paperless-ngx')),
    (error) => error.code === 'APP_ENV_INVALID' && /needs a value the first time/u.test(error.details[0].message),
  );
});

test('an invalid or repeated name is refused per row, with every problem reported at once', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const { service } = await installedPaperless(root, store);

  await assert.rejects(
    () => service.savePackageEnvironment('paperless-ngx', {
      entries: [
        { name: '', secret: false, value: 'x' },
        { name: 'HAS SPACE', secret: false, value: 'x' },
        { name: 'REPEATED', secret: false, value: 'one' },
        { name: 'REPEATED', secret: false, value: 'two' },
      ],
    }, requestContext().publicUrlFor('paperless-ngx')),
    (error) => error.code === 'APP_ENV_INVALID'
      && error.details.length === 3
      && error.details.map((detail) => detail.index).join(',') === '0,1,3',
  );
});

test('a change that stops the app coming back healthy restores the previous environment and projections', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  // A clock that advances a minute per read, so the bounded health wait gives up
  // on its second look instead of sleeping through the real 90-second window.
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 7, 30) + (tick++ * 60_000));
  const agent = recordingAgent({ fatal: { name: 'BREAKS_STARTUP', value: 'yes' } });
  const { service } = await installedPaperless(root, store, { agent, now });
  const instanceId = store.getAppInstanceByPackageId('paperless-ngx').id;

  await service.savePackageEnvironment('paperless-ngx', {
    entries: [{ name: 'GOOD_ONE', secret: false, value: 'kept' }],
  }, requestContext().publicUrlFor('paperless-ngx'));
  const healthyProjection = composeEnv(store, 'paperless-ngx', 'paperless');

  const result = await service.savePackageEnvironment('paperless-ngx', {
    entries: [
      { name: 'GOOD_ONE', secret: false, value: 'kept' },
      { name: 'BREAKS_STARTUP', secret: false, value: 'yes' },
    ],
  }, requestContext().publicUrlFor('paperless-ngx'));

  assert.equal(result.status, 'rolled-back');
  assert.match(result.reason, /put the previous settings back/u);
  // The previous environment is what is stored, and the previous projection is
  // what a later restart would re-apply.
  assert.deepEqual(store.getAppEnv(instanceId).map((row) => row.name), ['GOOD_ONE']);
  assert.deepEqual(composeEnv(store, 'paperless-ngx', 'paperless'), healthyProjection);
  // And the runtime the agent is left running is the one without the bad value.
  const lastApply = agent.state.applies.at(-1);
  const restored = lastApply.compose.services.find((item) => item.id === 'paperless').environment;
  assert.equal(restored.GOOD_ONE, 'kept');
  assert.equal(restored.BREAKS_STARTUP, undefined);
});

test('a rolled-back change restores the secret value it overwrote', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 7, 30) + (tick++ * 60_000));
  const agent = recordingAgent({ fatal: { name: 'BREAKS_STARTUP', value: 'yes' } });
  const { service } = await installedPaperless(root, store, { agent, now });
  const instanceId = store.getAppInstanceByPackageId('paperless-ngx').id;

  await service.savePackageEnvironment('paperless-ngx', {
    entries: [{ name: 'OAUTH_CLIENT_SECRET', secret: true, value: 'first-secret' }],
  }, requestContext().publicUrlFor('paperless-ngx'));
  const [before] = store.getAppEnv(instanceId);

  await service.savePackageEnvironment('paperless-ngx', {
    entries: [
      { name: 'OAUTH_CLIENT_SECRET', secret: true, value: 'second-secret' },
      { name: 'BREAKS_STARTUP', secret: false, value: 'yes' },
    ],
  }, requestContext().publicUrlFor('paperless-ngx'));

  // A secret file is keyed by its name, so the failed save overwrote it on disk.
  // The rollback has to put the bytes back, not just the row.
  const [after] = store.getAppEnv(instanceId);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(
    agent.state.applies.at(-1).compose.services.find((item) => item.id === 'paperless').environment.OAUTH_CLIENT_SECRET,
    'first-secret',
  );
});

test('an app update re-renders the owner environment instead of dropping it', async (t) => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());

  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'paperless-ngx'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  await fsp.rm(path.join(candidateDir, 'privacy-review.json'), { force: true });
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/paperless-ngx', repository: 'https://github.com/rpuls/my-own-suite', revision: 'c'.repeat(40), trust: 'mos-reviewed' };

  const calls = [];
  const base = recordingAgent();
  const agent = {
    ...base,
    async activatePackageUpdate(input) { calls.push(['activate', input]); return { status: 'candidate-healthy' }; },
    async buildPackageUpdate(input) { calls.push(['build', input]); return { status: 'built' }; },
    async promotePackageUpdate() { return { snapshotPath: candidateDir, status: 'snapshot-promoted' }; },
    async rollbackPackageUpdate() { return { status: 'installed-restored' }; },
    async stagePackageUpdate() { return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() {
      return {
        capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'],
        contractVersion: 6,
      };
    },
  };
  const service = new AppPackageService({
    agent,
    appsDir: v2AppsDir,
    catalogService: { advisoriesFor: () => [], platformVersion: '0.18.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; }, updateFor: () => null },
    store,
  });
  await service.installPackage('paperless-ngx', PAPERLESS_SETUP);
  await service.applyPackageRuntime('paperless-ngx', requestContext().publicUrlFor('paperless-ngx'));
  await service.savePackageEnvironment('paperless-ngx', {
    entries: [
      { name: 'PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID', secret: false, value: 'client-id-value' },
      { name: 'PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET', secret: true, value: 'client-secret-value' },
    ],
  }, requestContext().publicUrlFor('paperless-ngx'));

  const comparison = await service.preparePackageUpdate('paperless-ngx');
  const result = await service.stagePackageUpdate('paperless-ngx', { confirmationToken: comparison.confirmationToken }, {
    ...requestContext().publicUrlFor('paperless-ngx'),
    publicUrlFor: requestContext().publicUrlFor,
  });
  assert.equal(result.operation.status, 'succeeded');

  // The candidate the agent was asked to activate already carried the owner's
  // variables, resolved — an update that silently drops them is the regression
  // this whole render path exists to prevent.
  const [, activate] = calls.find(([kind]) => kind === 'activate');
  const activated = activate.candidate.compose.services.find((item) => item.id === 'paperless').environment;
  assert.equal(activated.PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID, 'client-id-value');
  assert.equal(activated.PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET, 'client-secret-value');

  // And the committed projections still hold references, so any later restart
  // re-applies them.
  const projected = composeEnv(store, 'paperless-ngx', 'paperless');
  assert.equal(projected.PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID, '${ownerEnv.PAPERLESS_OUTLOOK_OAUTH_CLIENT_ID}');
  assert.equal(projected.PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET, '${ownerEnv.PAPERLESS_OUTLOOK_OAUTH_CLIENT_SECRET}');
});

test('the public instance shape exposes a hidden value only as a fingerprint', () => {
  const shape = publicInstance(
    { enabled: true, id: 'i1', installedAt: null, manifestDigest: 'd', packageId: 'p', packageVersion: '1.0.0', status: 'installed', updatedAt: null },
    [],
    [],
    [
      { fingerprint: 'sha256:abc', name: 'OAUTH_CLIENT_SECRET', secret: true, secretRef: '/state/secret', service: 'app', updatedAt: null, value: undefined },
      { fingerprint: null, name: 'OAUTH_CLIENT_ID', secret: false, secretRef: null, service: 'app', updatedAt: null, value: 'client-id-value' },
    ],
  );

  const secret = shape.env.find((row) => row.name === 'OAUTH_CLIENT_SECRET');
  assert.equal(Object.hasOwn(secret, 'value'), false);
  assert.equal(secret.fingerprint, 'sha256:abc');
  assert.equal(secret.redactedLabel, 'Hidden value');
  assert.equal(JSON.stringify(shape).includes('/state/secret'), false);
  assert.equal(shape.env.find((row) => row.name === 'OAUTH_CLIENT_ID').value, 'client-id-value');
});

// ownerEnv is MOS's own namespace for values MOS generates into projections. A
// package author must never be able to reference it, so it stays out of
// KNOWN_NAMESPACES and an authored manifest using it fails validation exactly
// as any other unknown namespace does.
test('an app package cannot reference the ownerEnv namespace', () => {
  const manifest = {
    manifestVersion: 1,
    category: 'tools',
    health: { type: 'http', url: 'http://example-app:8080/health' },
    homepage: { description: 'A useful example.', group: 'Tools', icon: 'example', name: 'Example App' },
    id: 'example-app',
    minimumMosVersion: '0.1.0',
    name: 'Example App',
    resources: { services: { 'example-app': { dockerfile: 'Dockerfile', env: { LEAK: '${ownerEnv.SOME_NAME}' }, internalPort: 8080, volumes: ['data:/data'] } } },
    routes: [{ host: 'example-app', service: 'example-app' }],
    setup: { fields: [] },
    summary: 'A small example app.',
    version: '0.1.0',
  };

  assert.deepEqual(validateAppPackageManifest(manifest), [
    'resources.services.example-app.env.LEAK references unknown template namespace "ownerEnv" in ${ownerEnv.SOME_NAME}. Known namespaces: app, config, export, import, owner, secret.',
  ]);
});
