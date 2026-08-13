const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AppPackageService,
  digestFor,
  renderDryRunProjections,
} = require('../src/apps/app-package-service.cjs');
const { readAppPackageManifest } = require('../src/apps/package-manifest.cjs');
const { digestAppPackage } = require('../src/apps/package-contracts.cjs');
const { buildSourceRecord, withRevision, withStatus } = require('../src/apps/external-source-registry.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const v2AppsDir = path.join(repoRoot, 'apps');

// These tests build update candidates out of the real apps/ packages, so a
// literal candidate version silently stops being an upgrade the moment a real
// package reaches it â€” which is exactly what a catalog-wide version bump did.
// Kept deliberately above any version a shipped package will plausibly reach.
const CANDIDATE_VERSION = '99.0.0';

function snapshotResult(input) {
  return { snapshotPath: path.join(v2AppsDir, input.packageId) };
}

async function tempStateDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mos-app-service-'));
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

// A downloaded external candidate shaped the way ExternalSourceClient returns
// one: a real package folder plus the namespaced identity and recorded source.
async function externalCandidate(root, overrides = {}, dirName = 'ext-abc') {
  const packageDir = path.join(root, 'app-candidates', dirName);
  await fsp.mkdir(packageDir, { recursive: true });
  const manifest = {
    manifestVersion: 1,
    category: 'test', health: { type: 'http', url: 'http://notes:8080/health' }, id: 'community-notes',
    minimumMosVersion: '0.1.0', name: 'Community Notes',
    resources: { services: { notes: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['notes-data:/data'] } } },
    routes: [{ host: 'notes', port: 8080, service: 'notes' }], setup: { fields: [] }, summary: 'Notes.', version: '1.0.0',
    ...overrides,
  };
  await fsp.writeFile(path.join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fsp.writeFile(path.join(packageDir, 'Dockerfile'), 'FROM scratch\n');
  const source = { kind: 'external-git', path: '.mos', repository: 'https://github.com/community/notes', revision: 'b'.repeat(40), trust: 'unverified' };
  return {
    manifest: readAppPackageManifest(packageDir).manifest,
    namespacedPackageId: `x-abcdef01-${manifest.id}`,
    packageDigest: digestAppPackage(packageDir),
    packageDir,
    packageId: manifest.id,
    permissions: ['route:notes', 'volume:notes-data'],
    source,
    trust: 'unverified',
  };
}

function externalAgent(root, calls = []) {
  return {
    async snapshotExternalPackage(input) {
      calls.push(input);
      const snapshotPath = path.join(root, 'snapshots', input.instanceId, 'installed');
      await fsp.cp(input.candidatePath, snapshotPath, { recursive: true });
      return { snapshotPath };
    },
    async status() {
      return { capabilities: ['apps.package.snapshot', 'apps.package.snapshot.external'], contractVersion: 7 };
    },
  };
}

// An app agent that can run the whole update transaction for an external app:
// the external snapshot its install needed, plus the same update capabilities
// official packages go through.
function externalUpdateAgent(root, calls = [], promotedSnapshotPath = null, { reclaims = false } = {}) {
  return {
    ...externalAgent(root),
    async activatePackageUpdate(input) { calls.push(['activate', input]); return { status: 'candidate-healthy' }; },
    async buildPackageUpdate(input) { calls.push(['build', input]); return { status: 'built' }; },
    async promotePackageUpdate(input) { calls.push(['promote', input]); return { snapshotPath: promotedSnapshotPath, status: 'snapshot-promoted' }; },
    async remove(input) { calls.push(['remove', input]); return { status: 'removed' }; },
    async rollbackPackageUpdate(input) { calls.push(['rollback', input]); return { status: 'installed-restored' }; },
    async stagePackageUpdate(input) { calls.push(['stage', input]); return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() {
      return {
        capabilities: [
          'apps.package.snapshot', 'apps.package.snapshot.external', 'apps.package.update.stage', 'apps.package.update.build',
          'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote',
          ...(reclaims ? ['apps.package.update.reclaim', 'apps.package.remove.reclaim'] : []),
        ],
        contractVersion: reclaims ? 9 : 7,
      };
    },
  };
}

// An installed external app and the newer package its source now offers, with
// the update ready to apply.
async function updatableExternalApp(root, store, calls, { reclaims = false } = {}) {
  const installedPackage = await externalCandidate(root);
  const next = await externalCandidate(root, { version: '1.1.0' }, 'ext-next');
  // The update is published from a later commit than the one running, so a
  // promotion told the candidate's revision cannot pass as telling the truth.
  next.source = { ...next.source, revision: 'c'.repeat(40) };
  const service = new AppPackageService({
    agent: externalUpdateAgent(root, calls, next.packageDir, { reclaims }),
    appsDir: v2AppsDir,
    externalClient: externalClientStub(next),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);
  return { comparison: await service.preparePackageUpdate('x-abcdef01-community-notes'), service };
}

// The external client as the package service uses it for updates: re-resolve the
// source's commit, then hand back the candidate that commit publishes.
function externalClientStub(candidate) {
  return {
    platformVersion: '0.18.0',
    async downloadCandidate() { return { ...candidate, cleanup() {} }; },
    async resolveRevision(source) { return withRevision(source, candidate.source.revision); },
  };
}

function registerSource(store, repository = 'https://github.com/community/notes', revision = 'b'.repeat(40)) {
  return store.insertAppSource(withRevision(buildSourceRecord({ repository }), revision));
}

test('an external package installs through the shared snapshot pipeline under its namespaced, unverified identity', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const calls = [];
  const candidate = await externalCandidate(root);
  const service = new AppPackageService({ agent: externalAgent(root, calls), appsDir: v2AppsDir, store });

  const instance = await service.installExternalPackage({ candidate });

  const installed = store.getAppInstanceByPackageId('x-abcdef01-community-notes');
  assert.equal(instance.packageId, 'x-abcdef01-community-notes');
  assert.equal(installed.status, 'installed');
  assert.equal(installed.packageDigest, candidate.packageDigest);
  assert.equal(installed.sourceKind, 'external-git');
  assert.equal(installed.sourceRepository, 'https://github.com/community/notes');
  assert.equal(installed.sourceRevision, 'b'.repeat(40));
  assert.equal(installed.sourceTrust, 'unverified');
  assert.equal(installed.snapshotState, 'installed');
  // MOS has not reviewed it, and the package cannot talk itself into a review.
  assert.equal(installed.privacyStatus, 'review-required');

  // The agent is asked to snapshot from the confined candidate path, never a repo folder.
  assert.deepEqual(calls.map((call) => [call.candidatePath, call.packageId]), [[candidate.packageDir, 'x-abcdef01-community-notes']]);

  // Runtime identity is namespaced, so it cannot collide with an official package.
  const compose = store.getAppProjections(installed.id).find((projection) => projection.kind === 'compose');
  assert.deepEqual(compose.content.services.map((item) => item.build.context), ['apps/x-abcdef01-community-notes']);

  const listed = service.listPackages().find((item) => item.id === 'x-abcdef01-community-notes');
  assert.equal(listed.external, true);
  assert.equal(listed.mosReviewed, false);
  assert.equal(listed.trust, 'unverified');
  assert.equal(listed.name, 'Community Notes');
  assert.equal(listed.privacy.status, 'review-required');
  store.close();
});

test('an external package cannot present its own privacy review as a MOS review', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const candidate = await externalCandidate(root);
  await fsp.writeFile(path.join(candidate.packageDir, 'privacy-review.json'), `${JSON.stringify({
    appId: 'community-notes', posture: 'excellent', reviewedAt: '2026-07-01T00:00:00.000Z',
    provenance: { humanReviewed: true, method: 'self' }, schemaVersion: 1, scope: { packageVersion: '1.0.0' },
  }, null, 2)}\n`);
  const republished = { ...candidate, manifest: readAppPackageManifest(candidate.packageDir).manifest, packageDigest: digestAppPackage(candidate.packageDir) };
  const service = new AppPackageService({ agent: externalAgent(root), appsDir: v2AppsDir, store });

  await service.installExternalPackage({ candidate: republished });

  const listed = service.listPackages().find((item) => item.id === 'x-abcdef01-community-notes');
  assert.equal(listed.privacy.status, 'review-required');
  assert.equal(listed.privacy.posture, null);
  assert.equal(listed.mosReviewed, false);
  store.close();
});

test('an external package asking for an official app web address is served under the reserved prefix instead', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent: {
      ...externalAgent(root),
      async snapshotPackage(input) { return snapshotResult(input); },
    },
    appsDir: v2AppsDir,
    store,
  });
  await service.installPackage('stirling-pdf');
  const installedHost = store.getAppProjections(store.getAppInstanceByPackageId('stirling-pdf').id)
    .find((projection) => projection.kind === 'caddy').content.routes[0].host;
  const candidate = await externalCandidate(root, { routes: [{ host: installedHost, port: 8080, service: 'notes' }] });

  // The package asks for the exact address an official app answers on. It does
  // not need to be refused, because it cannot be given it: external route hosts
  // are placed under `ext-`, which no official app may use.
  await service.installExternalPackage({ candidate });

  const hostFor = (packageId) => store.getAppProjections(store.getAppInstanceByPackageId(packageId).id)
    .find((projection) => projection.kind === 'caddy').content.routes[0].host;
  assert.equal(hostFor('x-abcdef01-community-notes'), `ext-${installedHost}`);
  assert.equal(hostFor('stirling-pdf'), installedHost);
  store.close();
});

test('two external packages cannot serve the same web address', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent: {
      ...externalAgent(root),
      async snapshotPackage(input) { return snapshotResult(input); },
    },
    appsDir: v2AppsDir,
    store,
  });
  await service.installExternalPackage({ candidate: await externalCandidate(root) });

  // The reserved prefix keeps external packages away from official addresses; it
  // does not hand out the same one twice. Route hosts stay global.
  const rival = await externalCandidate(root, { id: 'rival-notes' }, 'ext-rival');
  await assert.rejects(() => service.installExternalPackage({ candidate: rival }), { code: 'APP_ROUTE_HOST_TAKEN' });
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-rival-notes'), null);
  store.close();
});

test('an external install is refused when the app agent cannot snapshot external packages', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const candidate = await externalCandidate(root);
  const service = new AppPackageService({
    agent: {
      async snapshotExternalPackage() { throw new Error('should not be called'); },
      async status() { return { capabilities: ['apps.package.snapshot'], contractVersion: 6 }; },
    },
    appsDir: v2AppsDir,
    store,
  });

  await assert.rejects(() => service.installExternalPackage({ candidate }), { code: 'APP_EXTERNAL_INSTALL_UNAVAILABLE' });
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes'), null);
  store.close();
});

// A package's base images are pinned by digest, so one that names an
// architecture this host is not cannot pull them: the install would get as far
// as `docker build` and die there, having already snapshotted and taken an
// instance row. Nothing is left behind because nothing was started.
test('an app that does not run on this host is refused before anything is installed', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const candidate = await externalCandidate(root, { architectures: ['amd64'] });
  const service = new AppPackageService({
    agent: {
      ...externalAgent(root),
      async snapshotExternalPackage() { throw new Error('should not be called'); },
      async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.snapshot.external'], contractVersion: 9, hostArchitecture: 'arm64' }; },
    },
    appsDir: v2AppsDir,
    store,
  });

  await assert.rejects(() => service.installExternalPackage({ candidate }), (error) => error.code === 'APP_ARCHITECTURE_UNSUPPORTED'
    && error.statusCode === 409
    && /amd64.*arm64/u.test(error.message));
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes'), null);
  store.close();
});

// This check exists to explain a build failure that was already coming, so it
// must never invent one. An agent too old to name its host, one that does not
// recognise the host it is on, and one that cannot be asked at all are the same
// answer: no constraint is enforced and the install behaves as it always did.
test('an app is installed as before when nothing can say what this host is', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const agent = externalAgent(root);
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, store });

  await service.installExternalPackage({ candidate: await externalCandidate(root, { architectures: ['amd64'] }) });
  assert.ok(store.getAppInstanceByPackageId('x-abcdef01-community-notes'));

  const unrecognised = new AppPackageService({
    agent: { ...agent, async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.snapshot.external'], contractVersion: 9, hostArchitecture: 'sparc' }; } },
    appsDir: v2AppsDir,
    store: new SuiteManagerStore(path.join(root, 'state-2')),
  });
  await unrecognised.installExternalPackage({ candidate: await externalCandidate(root, { architectures: ['amd64'] }, 'ext-two') });
  assert.ok(unrecognised.store.getAppInstanceByPackageId('x-abcdef01-community-notes'));
  unrecognised.store.close();
  store.close();
});

// The one package in the repo that actually declares this. Its base images are
// pinned to amd64 manifests, so an arm64 host could never have built it; before
// the declaration the only thing that said so was a sentence in its README.
test('the amd64-only package in the catalog is refused on an arm64 host', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent: {
      async snapshotPackage() { throw new Error('should not be called'); },
      async status() { return { capabilities: ['apps.package.snapshot'], contractVersion: 9, hostArchitecture: 'arm64' }; },
    },
    appsDir: v2AppsDir,
    store,
  });

  await assert.rejects(() => service.installPackage('immich'), { code: 'APP_ARCHITECTURE_UNSUPPORTED' });
  assert.equal(store.getAppInstanceByPackageId('immich'), null);
  store.close();
});

test('an external app updates from its own source through the same update transaction, and its access increase needs consent', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  // The published update wants a second web address it does not have today.
  const next = await externalCandidate(root, {
    routes: [{ host: 'notes', port: 8080, service: 'notes' }, { host: 'notes-admin', port: 8081, service: 'notes' }],
    version: '1.1.0',
  }, 'ext-next');
  const calls = [];
  const service = new AppPackageService({
    // Promotion leaves the candidate's contents as the installed snapshot.
    agent: externalUpdateAgent(root, calls, next.packageDir),
    appsDir: v2AppsDir,
    externalClient: externalClientStub(next),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);

  const comparison = await service.preparePackageUpdate('x-abcdef01-community-notes');

  assert.equal(comparison.updateStatus, 'update-available');
  assert.deepEqual(comparison.permissions.installed, ['route:ext-notes', 'volume:notes-data']);
  assert.deepEqual(comparison.permissions.added, ['route:ext-notes-admin']);
  // MOS did not review this widening, so it cannot be applied as routine.
  assert.equal(comparison.compatibility, 'owner-action-required');
  assert.equal(comparison.changes.find((change) => change.area === 'permissions').classification, 'operator-action-required');
  // Previewing an external update stays side-effect-free.
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').packageVersion, '1.0.0');

  const result = await service.stagePackageUpdate(
    'x-abcdef01-community-notes',
    { confirmationToken: comparison.confirmationToken },
    requestContext().publicUrlFor('notes'),
  );

  assert.equal(result.operation.status, 'succeeded');
  const updated = store.getAppInstanceByPackageId('x-abcdef01-community-notes');
  assert.equal(updated.packageVersion, '1.1.0');
  assert.equal(updated.packageDigest, next.packageDigest);
  // Updating never launders trust: the app stays external and unreviewed.
  assert.equal(updated.sourceTrust, 'unverified');
  assert.equal(updated.sourceRevision, 'b'.repeat(40));
  assert.equal(updated.privacyStatus, 'review-required');
  assert.equal(service.listPackages().find((item) => item.id === 'x-abcdef01-community-notes').mosReviewed, false);
  // Every agent stage addresses the app by its namespaced identity, never by the
  // bare id the package's manifest declares.
  const addressed = calls.filter(([kind]) => ['stage', 'build', 'promote'].includes(kind)).map(([, input]) => input.packageId);
  assert.deepEqual([...new Set(addressed)], ['x-abcdef01-community-notes']);
  assert.equal(addressed.length, 3);
  store.close();
});

test('an external app whose source is gone or compromised keeps running and refuses to update', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  const next = await externalCandidate(root, { version: '1.1.0' }, 'ext-next');
  const service = new AppPackageService({
    agent: externalUpdateAgent(root),
    appsDir: v2AppsDir,
    externalClient: externalClientStub(next),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });

  // No source record at all: the app was installed, then the source was removed.
  await assert.rejects(() => service.preparePackageUpdate('x-abcdef01-community-notes'), { code: 'APP_SOURCE_UNAVAILABLE' });

  const record = registerSource(store);
  store.updateAppSourceStatus({ at: new Date().toISOString(), id: record.id, ...withStatus(record, 'compromised', 'Reported compromised.') });
  await assert.rejects(() => service.preparePackageUpdate('x-abcdef01-community-notes'), { code: 'APP_SOURCE_NOT_INSTALLABLE' });

  // Neither refusal touches the installed app.
  const instance = store.getAppInstanceByPackageId('x-abcdef01-community-notes');
  assert.equal(instance.status, 'installed');
  assert.equal(instance.packageVersion, '1.0.0');
  assert.equal(instance.snapshotState, 'installed');
  store.close();
});

test('an external repository that starts publishing a different package cannot update the installed app', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  // Same repository, same source record, but the package it publishes is now a
  // different app entirely.
  const impostor = await externalCandidate(root, { id: 'community-tasks', name: 'Community Tasks', version: '2.0.0' }, 'ext-next');
  const service = new AppPackageService({
    agent: externalUpdateAgent(root),
    appsDir: v2AppsDir,
    externalClient: externalClientStub({ ...impostor, namespacedPackageId: 'x-abcdef01-community-tasks' }),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);

  await assert.rejects(() => service.preparePackageUpdate('x-abcdef01-community-notes'), { code: 'APP_SOURCE_PACKAGE_CHANGED' });

  const instance = store.getAppInstanceByPackageId('x-abcdef01-community-notes');
  assert.equal(instance.packageVersion, '1.0.0');
  assert.equal(instance.status, 'installed');
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-tasks'), null);
  store.close();
});

test('an external update cannot take a web address another installed app already serves', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  const service = new AppPackageService({
    agent: { ...externalUpdateAgent(root), async snapshotPackage(input) { return snapshotResult(input); } },
    appsDir: v2AppsDir,
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  // Another external app, because an external package can only ever contend for
  // an address with something else under the `ext-` prefix.
  await service.installExternalPackage({
    candidate: await externalCandidate(root, { id: 'rival-notes', routes: [{ host: 'rival', port: 8080, service: 'notes' }] }, 'ext-rival'),
  });
  registerSource(store);
  const takenHost = 'rival';
  const next = await externalCandidate(root, { routes: [{ host: takenHost, port: 8080, service: 'notes' }], version: '1.1.0' }, 'ext-next');
  service.externalClient = externalClientStub(next);

  const comparison = await service.preparePackageUpdate('x-abcdef01-community-notes');
  await assert.rejects(
    () => service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes')),
    { code: 'APP_ROUTE_HOST_TAKEN' },
  );
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').packageVersion, '1.0.0');
  store.close();
});

// An app running a newer package than its source now offers, which is what a
// force-push, a reverted tag, or a repository takeover looks like from here.
async function rolledBackSource(root, store, calls = []) {
  const installedPackage = await externalCandidate(root, { version: '2.0.0' }, 'ext-installed');
  const older = await externalCandidate(root, { version: '1.0.0' }, 'ext-older');
  const service = new AppPackageService({
    agent: externalUpdateAgent(root, calls, older.packageDir),
    appsDir: v2AppsDir,
    externalClient: externalClientStub(older),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);
  return { comparison: await service.preparePackageUpdate('x-abcdef01-community-notes'), older, service };
}

test('a source that offers an older package than the one running cannot update it', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const calls = [];
  const { comparison, service } = await rolledBackSource(root, store, calls);

  assert.equal(comparison.updateStatus, 'installed-newer');
  await assert.rejects(
    () => service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes')),
    (error) => error.code === 'APP_UPDATE_DOWNGRADE_BLOCKED' && error.statusCode === 409,
  );
  // The installed version keeps running, and the downgrade never reached the
  // agent: nothing was staged, built, or promoted.
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').packageVersion, '2.0.0');
  assert.deepEqual(calls.filter(([kind]) => ['stage', 'build', 'promote'].includes(kind)), []);
  store.close();
});

test('an update tells an agent that can reclaim which images the outgoing package was built into', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const calls = [];
  const { comparison, service } = await updatableExternalApp(root, store, calls, { reclaims: true });
  const outgoing = store.getAppInstanceByPackageId('x-abcdef01-community-notes');

  const result = await service.stagePackageUpdate(
    'x-abcdef01-community-notes',
    { confirmationToken: comparison.confirmationToken },
    requestContext().publicUrlFor('notes'),
  );

  assert.equal(result.operation.status, 'succeeded');
  const [, promote] = calls.find(([kind]) => kind === 'promote');
  // The revision of the package being replaced, not the one replacing it: it is
  // what names the images that are now unreachable.
  assert.equal(promote.installedSourceRevision, outgoing.sourceRevision);
  assert.equal(promote.expectedInstalledDigest, outgoing.packageDigest);
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').sourceRevision, 'c'.repeat(40));
  store.close();
});

test('an uninstall tells an agent that can reclaim what the app leaves behind before the row naming it is gone', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const calls = [];
  const { service } = await updatableExternalApp(root, store, calls, { reclaims: true });
  const installed = store.getAppInstanceByPackageId('x-abcdef01-community-notes');

  const result = await service.uninstallPackage('x-abcdef01-community-notes');

  assert.equal(result.instance, null);
  const [, remove] = calls.find(([kind]) => kind === 'remove');
  // Both halves of the only reference to this app's disk footprint: the instance
  // directory, and the revision naming the images built from it.
  assert.equal(remove.instanceId, installed.id);
  assert.equal(remove.installedSourceRevision, installed.sourceRevision);
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes'), null);
  store.close();
});

test('an uninstall never sends a removal field an older agent would refuse', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const calls = [];
  const { service } = await updatableExternalApp(root, store, calls);

  const result = await service.uninstallPackage('x-abcdef01-community-notes');

  assert.equal(result.instance, null);
  const [, remove] = calls.find(([kind]) => kind === 'remove');
  assert.equal(Object.hasOwn(remove, 'instanceId'), false);
  assert.equal(Object.hasOwn(remove, 'installedSourceRevision'), false);
  store.close();
});

test('an update never sends a promotion field an older agent would refuse', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const calls = [];
  const { comparison, service } = await updatableExternalApp(root, store, calls);

  const result = await service.stagePackageUpdate(
    'x-abcdef01-community-notes',
    { confirmationToken: comparison.confirmationToken },
    requestContext().publicUrlFor('notes'),
  );

  // An agent without the capability rejects unknown promotion fields outright,
  // and a promotion refused here would strand an update whose candidate is
  // already serving traffic. Leaving an image behind is the lesser outcome.
  assert.equal(result.operation.status, 'succeeded');
  const [, promote] = calls.find(([kind]) => kind === 'promote');
  assert.equal(Object.hasOwn(promote, 'installedSourceRevision'), false);
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').packageVersion, '1.1.0');
  store.close();
});

test('an owner can still recover deliberately by confirming an explicit downgrade', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const { comparison, older, service } = await rolledBackSource(root, store);

  const result = await service.stagePackageUpdate(
    'x-abcdef01-community-notes',
    { allowDowngrade: true, confirmationToken: comparison.confirmationToken },
    requestContext().publicUrlFor('notes'),
  );

  assert.equal(result.operation.status, 'succeeded');
  const updated = store.getAppInstanceByPackageId('x-abcdef01-community-notes');
  assert.equal(updated.packageVersion, '1.0.0');
  assert.equal(updated.packageDigest, older.packageDigest);
  store.close();
});

test('consenting to a downgrade does not consent to whatever the source offers next', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const { comparison, service } = await rolledBackSource(root, store);
  // The owner reviewed one downgrade; the source then swaps in a different
  // older package. The token is bound to the exact pair that was reviewed, so
  // consent cannot carry over to a package nobody looked at.
  const swapped = await externalCandidate(root, { summary: 'Different notes.', version: '1.0.0' }, 'ext-swapped');
  service.externalClient = externalClientStub(swapped);

  await assert.rejects(
    () => service.stagePackageUpdate(
      'x-abcdef01-community-notes',
      { allowDowngrade: true, confirmationToken: comparison.confirmationToken },
      requestContext().publicUrlFor('notes'),
    ),
    { code: 'APP_UPDATE_IDENTITY_CHANGED' },
  );
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').packageVersion, '2.0.0');
  store.close();
});

test('an app whose source offers exactly what it already runs has nothing to update', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  const calls = [];
  const service = new AppPackageService({
    agent: externalUpdateAgent(root, calls, installedPackage.packageDir),
    appsDir: v2AppsDir,
    externalClient: externalClientStub(installedPackage),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);

  const comparison = await service.preparePackageUpdate('x-abcdef01-community-notes');
  assert.equal(comparison.updateStatus, 'current');
  // Re-running the whole transaction to arrive back where it started is a
  // needless swap of a healthy runtime, so it is refused rather than performed.
  await assert.rejects(
    () => service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes')),
    (error) => error.code === 'APP_UPDATE_NOT_AVAILABLE' && error.statusCode === 409,
  );
  assert.deepEqual(calls.filter(([kind]) => ['stage', 'build', 'promote'].includes(kind)), []);
  store.close();
});

test('an app cannot run two update transactions at once', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  const next = await externalCandidate(root, { version: '1.1.0' }, 'ext-next');
  const calls = [];
  let releaseStage;
  const staging = new Promise((resolve) => { releaseStage = resolve; });
  const agent = externalUpdateAgent(root, calls, next.packageDir);
  const service = new AppPackageService({
    agent: {
      ...agent,
      // Hold the first update inside the agent, where a real one spends its time.
      async stagePackageUpdate(input) { calls.push(['stage', input]); await staging; return { snapshotPath: '/state/candidate', status: 'staged' }; },
    },
    appsDir: v2AppsDir,
    externalClient: externalClientStub(next),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);
  const comparison = await service.preparePackageUpdate('x-abcdef01-community-notes');

  const first = service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes'));
  // The owner double-clicks Update. The second attempt must not download and
  // build the same candidate again alongside the first.
  await assert.rejects(
    () => service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes')),
    (error) => error.code === 'APP_OPERATION_IN_PROGRESS' && error.statusCode === 409,
  );

  releaseStage();
  assert.equal((await first).operation.status, 'succeeded');
  assert.equal(calls.filter(([kind]) => kind === 'stage').length, 1);
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').packageVersion, '1.1.0');
  // The app is updatable again once the first transaction has finished.
  await assert.rejects(
    () => service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes')),
    (error) => error.code !== 'APP_OPERATION_IN_PROGRESS',
  );
  store.close();
});

test('lifecycle operations are refused while an update transaction holds the app', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  const next = await externalCandidate(root, { version: '1.1.0' }, 'ext-next');
  const calls = [];
  let releaseStage;
  const staging = new Promise((resolve) => { releaseStage = resolve; });
  const agent = externalUpdateAgent(root, calls, next.packageDir);
  const service = new AppPackageService({
    agent: {
      ...agent,
      async stagePackageUpdate(input) { calls.push(['stage', input]); await staging; return { snapshotPath: '/state/candidate', status: 'staged' }; },
    },
    appsDir: v2AppsDir,
    externalClient: externalClientStub(next),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);
  const comparison = await service.preparePackageUpdate('x-abcdef01-community-notes');

  const update = service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes'));
  // A restart mid-update would re-apply the old stored projections over the
  // candidate runtime; an uninstall would delete the instance row out from
  // under the transaction. They hold the same per-app key as the update, so
  // they are refused instead of interleaved.
  for (const blocked of [
    () => service.restartPackageRuntime('x-abcdef01-community-notes', requestContext().publicUrlFor('notes')),
    () => service.enablePackage('x-abcdef01-community-notes', requestContext().publicUrlFor('notes')),
    () => service.disablePackage('x-abcdef01-community-notes', null),
    () => service.uninstallPackage('x-abcdef01-community-notes', null),
  ]) {
    await assert.rejects(blocked, (error) => error.code === 'APP_OPERATION_IN_PROGRESS' && error.statusCode === 409);
  }

  releaseStage();
  assert.equal((await update).operation.status, 'succeeded');
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').status, 'installed');
  store.close();
});

test('a stopped app refuses updates instead of being started by one', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  const next = await externalCandidate(root, { version: '1.1.0' }, 'ext-next');
  const calls = [];
  const service = new AppPackageService({
    agent: { ...externalUpdateAgent(root, calls, next.packageDir), async stop() { return { status: 'stopped', steps: [] }; } },
    appsDir: v2AppsDir,
    externalClient: externalClientStub(next),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);
  const comparison = await service.preparePackageUpdate('x-abcdef01-community-notes');
  await service.disablePackage('x-abcdef01-community-notes', null);

  // Activation starts the candidate's containers, so updating a disabled app
  // would end with containers running while the store says disabled.
  await assert.rejects(
    () => service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes')),
    (error) => error.code === 'APP_UPDATE_APP_DISABLED' && error.statusCode === 409,
  );
  assert.deepEqual(calls.filter(([kind]) => ['stage', 'build', 'activate', 'promote'].includes(kind)), []);
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes').status, 'disabled');
  store.close();
});

// A failure while the candidate is already serving traffic (activation itself
// rolls back inside the agent; this is the window after `candidate-healthy`).
test('a failure after activation rolls the old runtime back and closes the update operation', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const installedPackage = await externalCandidate(root);
  const next = await externalCandidate(root, { version: '1.1.0' }, 'ext-next');
  const calls = [];
  const service = new AppPackageService({
    agent: {
      ...externalUpdateAgent(root, calls, next.packageDir),
      async promotePackageUpdate(input) {
        calls.push(['promote', input]);
        throw Object.assign(new Error('The app package snapshot could not be promoted.'), { code: 'APP_UPDATE_PROMOTION_FAILED', statusCode: 502 });
      },
    },
    appsDir: v2AppsDir,
    externalClient: externalClientStub(next),
    store,
  });
  await service.installExternalPackage({ candidate: installedPackage });
  registerSource(store);
  const installed = store.getAppInstanceByPackageId('x-abcdef01-community-notes');
  const comparison = await service.preparePackageUpdate('x-abcdef01-community-notes');

  await assert.rejects(
    () => service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes')),
    (error) => error.code === 'APP_UPDATE_PROMOTION_FAILED',
  );

  // The agent was asked to restore exactly the runtime that was serving before.
  const [, rollback] = calls.find(([kind]) => kind === 'rollback');
  assert.equal(rollback.installed.packageDigest, installed.packageDigest);
  assert.equal(rollback.candidate.packageDigest, next.packageDigest);
  // Identity never moved to the candidate, and no recovery flag is left behind
  // because the rollback restored the old runtime.
  const after = store.getAppInstanceByPackageId('x-abcdef01-community-notes');
  assert.equal(after.packageVersion, '1.0.0');
  assert.equal(after.packageDigest, installed.packageDigest);
  assert.ok(!after.updateRecoveryState || after.updateRecoveryState === 'none');
  // The failed operation is closed: a retry runs a fresh transaction instead of
  // hitting "already running".
  await assert.rejects(
    () => service.stagePackageUpdate('x-abcdef01-community-notes', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('notes')),
    (error) => error.code === 'APP_UPDATE_PROMOTION_FAILED',
  );
  assert.equal(calls.filter(([kind]) => kind === 'stage').length, 2);
  store.close();
});

// The S1 regression pin: integration env is rendered into projections, never
// patched into them, so an update of the consumer activates a candidate that
// already carries the env, and the post-commit reconcile re-applies the NEW
// runtime instead of painting the old compose back over it.
test('updating an integration consumer keeps its integration env and reconciles the new runtime', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'seafile'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  await fsp.rm(path.join(candidateDir, 'privacy-review.json'), { force: true });
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/seafile', repository: 'https://github.com/rpuls/my-own-suite', revision: 'c'.repeat(40), trust: 'mos-reviewed' };
  const calls = [];
  const agent = {
    async activatePackageUpdate(input) { calls.push(['activate', input]); return { status: 'candidate-healthy' }; },
    async apply(input) { calls.push(['apply', input]); return { status: 'applied', steps: [] }; },
    async buildPackageUpdate(input) { calls.push(['build', input]); return { status: 'built' }; },
    async checkHealth() { return { status: 'healthy' }; },
    async connectNetwork(input) { calls.push(['connectNetwork', input]); return { status: 'connected' }; },
    async promotePackageUpdate(input) { calls.push(['promote', input]); return { snapshotPath: candidateDir, status: 'snapshot-promoted' }; },
    async rollbackPackageUpdate(input) { calls.push(['rollback', input]); return { status: 'installed-restored' }; },
    async snapshotPackage(input) { return snapshotResult(input); },
    async stagePackageUpdate(input) { calls.push(['stage', input]); return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent,
    appsDir: v2AppsDir,
    catalogService: { platformVersion: '0.18.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; } },
    store,
  });
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
  const seafile = store.getAppInstanceByPackageId('seafile');
  const envReference = '${config.integrationDocumentEditorOnlyofficeApijsUrl}';
  const composeEnv = (projections) => projections.find((projection) => projection.kind === 'compose')
    .content.services.find((item) => item.id === 'seafile').environment;
  assert.equal(composeEnv(store.getAppProjections(seafile.id)).ONLYOFFICE_APIJS_URL, envReference);

  const comparison = await service.preparePackageUpdate('seafile');
  const result = await service.stagePackageUpdate('seafile', { confirmationToken: comparison.confirmationToken }, {
    ...requestContext().publicUrlFor('seafile'),
    publicUrlFor: requestContext().publicUrlFor,
  });

  assert.equal(result.operation.status, 'succeeded');
  // The candidate the agent activated already carried the integration env,
  // resolved against the provider the app is actually connected to.
  const [, activate] = calls.find(([kind]) => kind === 'activate');
  const activatedEnv = activate.candidate.compose.services.find((item) => item.id === 'seafile').environment;
  assert.match(String(activatedEnv.ONLYOFFICE_APIJS_URL), /onlyoffice\.example\.test/u);
  assert.equal(activatedEnv.ONLYOFFICE_FORCE_SAVE, 'true');
  // The committed projections still render the env as config references, so
  // any later restart re-applies it.
  assert.equal(composeEnv(store.getAppProjections(seafile.id)).ONLYOFFICE_APIJS_URL, envReference);
  // The relationship was reconciled after the commit against the new runtime,
  // not before it against the old one.
  assert.equal(store.getAppIntegrations()[0].status, 'active');
  assert.equal(result.integrations.every((item) => item.status === 'active'), true);
  const applyCalls = calls.filter(([kind]) => kind === 'apply');
  const [, reconciledApply] = applyCalls[applyCalls.length - 1];
  assert.equal(reconciledApply.packageId, 'seafile');
  assert.equal(reconciledApply.packageVersion, CANDIDATE_VERSION);
  assert.equal(reconciledApply.packageDigest, candidateDigest);
  assert.ok(calls.findIndex(([kind]) => kind === 'promote') < calls.lastIndexOf(applyCalls[applyCalls.length - 1]));
  assert.match(String(reconciledApply.compose.services.find((item) => item.id === 'seafile').environment.ONLYOFFICE_APIJS_URL), /onlyoffice\.example\.test/u);
  store.close();
});

// A commit only writes bookkeeping, so recovering a promoted provider update at
// startup used to leave every app integrated with it still running the runtime
// the superseded provider produced. The owner-clicked recovery reconciled and
// the ordinary update path reconciled; only the one a restart performs did not,
// which made an integration surviving an update depend on who noticed first.
test('a provider update recovered at startup re-applies its integration consumers', async (t) => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'onlyoffice'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  await fsp.rm(path.join(candidateDir, 'privacy-review.json'), { force: true });
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/onlyoffice', repository: 'https://github.com/rpuls/my-own-suite', revision: 'c'.repeat(40), trust: 'mos-reviewed' };
  // Production-shaped snapshots: a stable installed directory per app whose
  // CONTENT the promote swaps, exactly like the system adapter.
  const snapshotDirFor = (packageId) => path.join(root, 'snapshots', packageId);
  const calls = [];
  const agent = {
    async activatePackageUpdate() { return { status: 'candidate-healthy' }; },
    async apply(input) { calls.push(['apply', input]); return { status: 'applied', steps: [] }; },
    async buildPackageUpdate() { return { status: 'built' }; },
    async checkHealth() { return { status: 'healthy' }; },
    async connectNetwork(input) { calls.push(['connectNetwork', input]); return { status: 'connected' }; },
    async promotePackageUpdate() {
      const snapshotDir = snapshotDirFor('onlyoffice');
      await fsp.rm(snapshotDir, { force: true, recursive: true });
      await fsp.cp(candidateDir, snapshotDir, { recursive: true });
      return { snapshotPath: snapshotDir, status: 'snapshot-promoted' };
    },
    async rollbackPackageUpdate() { throw new Error('rollback must never run for a promoted snapshot'); },
    async snapshotPackage(input) {
      const snapshotDir = snapshotDirFor(input.packageId);
      await fsp.cp(path.join(v2AppsDir, input.packageId), snapshotDir, { recursive: true });
      return { snapshotPath: snapshotDir };
    },
    async stagePackageUpdate() { return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const service = new AppPackageService({
    agent,
    appsDir: v2AppsDir,
    catalogService: { advisoriesFor: () => [], platformVersion: '0.18.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; }, updateFor: () => null },
    store,
  });
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

  // Suite Manager "dies" at the durable commit of the provider's update: the
  // promote has happened on disk, the store write never does.
  const comparison = await service.preparePackageUpdate('onlyoffice');
  const realComplete = store.completeAppUpdate.bind(store);
  store.completeAppUpdate = () => { throw new Error('suite manager terminated'); };
  await assert.rejects(
    () => service.stagePackageUpdate('onlyoffice', { confirmationToken: comparison.confirmationToken }, {
      ...requestContext().publicUrlFor('onlyoffice'),
      publicUrlFor: requestContext().publicUrlFor,
    }),
    (error) => error.code === 'APP_UPDATE_STAGE_FAILED',
  );
  store.completeAppUpdate = realComplete;
  assert.equal(store.getAppInstanceByPackageId('onlyoffice').updateRecoveryState, 'commit-required');

  // The restart: recovery commits the promoted provider AND puts the consumer
  // back on a runtime rendered against it.
  calls.length = 0;
  const [recovery] = await service.recoverInterruptedUpdates({ publicUrlFor: requestContext().publicUrlFor });

  assert.equal(recovery.status, 'committed');
  assert.equal(store.getAppInstanceByPackageId('onlyoffice').packageVersion, CANDIDATE_VERSION);
  assert.deepEqual(recovery.integrations.map((item) => item.status), ['active']);
  assert.equal(store.getAppIntegrations()[0].status, 'active');
  const consumerApplies = calls.filter(([kind, input]) => kind === 'apply' && input.packageId === 'seafile');
  assert.equal(consumerApplies.length, 1, 'the dependent consumer runtime is re-applied by startup recovery');
  assert.match(
    String(consumerApplies[0][1].compose.services.find((item) => item.id === 'seafile').environment.ONLYOFFICE_APIJS_URL),
    /onlyoffice\.example\.test/u,
  );
});

// The S2 pin: a snapshot promotion whose durable commit never happened is
// finished by startup recovery â€” the disk proves the promote, the operation row
// carries what the commit needs â€” and one wedged app never takes the Apps API
// down while it waits.
test('a crash between snapshot promotion and the durable commit is committed by startup recovery', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  await fsp.rm(path.join(candidateDir, 'privacy-review.json'), { force: true });
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'c'.repeat(40), trust: 'mos-reviewed' };
  // Production-shaped snapshots: install snapshots into a stable installed
  // directory whose CONTENT the promote swaps, exactly like the system adapter.
  const snapshotDir = path.join(root, 'snapshots', 'installed');
  const agent = {
    async activatePackageUpdate() { return { status: 'candidate-healthy' }; },
    async buildPackageUpdate() { return { status: 'built' }; },
    async promotePackageUpdate() {
      await fsp.rm(snapshotDir, { force: true, recursive: true });
      await fsp.cp(candidateDir, snapshotDir, { recursive: true });
      return { snapshotPath: snapshotDir, status: 'snapshot-promoted' };
    },
    async rollbackPackageUpdate() { throw new Error('rollback must never run for a promoted snapshot'); },
    async snapshotPackage() {
      await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), snapshotDir, { recursive: true });
      return { snapshotPath: snapshotDir };
    },
    async stagePackageUpdate() { return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
  };
  const entries = [];
  const homepageService = {
    async add(body) { entries.push(body.entry); return { revision: `revision-${entries.length}` }; },
    async read() { return { revision: `revision-${entries.length}` }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent,
    appsDir: v2AppsDir,
    catalogService: { advisoriesFor: () => [], platformVersion: '0.18.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; }, updateFor: () => null },
    store,
  });
  await service.installPackage('stirling-pdf');
  const installed = store.getAppInstanceByPackageId('stirling-pdf');
  store.applyAppProjection({ at: new Date().toISOString(), instanceId: installed.id, kind: 'homepage', operationId: 'homepage-applied' });
  const comparison = await service.preparePackageUpdate('stirling-pdf');

  // Suite Manager "dies" at the durable commit: the promote has happened on
  // disk, the store write never does.
  const realComplete = store.completeAppUpdate.bind(store);
  store.completeAppUpdate = () => { throw new Error('suite manager terminated'); };
  await assert.rejects(
    () => service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, { ...requestContext().publicUrlFor('stirling-pdf'), homepageService }),
    (error) => error.code === 'APP_UPDATE_STAGE_FAILED',
  );
  store.completeAppUpdate = realComplete;

  const wedged = store.getAppInstanceByPackageId('stirling-pdf');
  assert.equal(wedged.updateRecoveryState, 'commit-required');
  assert.equal(wedged.packageVersion, manifest.version);
  // The promoted candidate keeps its Homepage entry: no rollback re-add ran.
  assert.equal(entries.length, 1);
  // One wedged app degrades to its own recovery card instead of failing the list.
  const listed = service.listPackages().find((item) => item.id === 'stirling-pdf');
  assert.equal(listed.instance.updateRecovery.state, 'commit-required');
  assert.equal(listed.validation.valid, false);
  // A new update is refused while the pending commit exists.
  await assert.rejects(
    () => service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf')),
    (error) => error.code === 'APP_UPDATE_RECOVERY_REQUIRED',
  );

  // Startup recovery finishes the commit from the operation row and the disk.
  const recoveries = await service.recoverInterruptedUpdates();
  assert.deepEqual(recoveries, [{ instanceId: installed.id, integrations: [], recoveryState: 'none', status: 'committed' }]);
  const committed = store.getAppInstanceByPackageId('stirling-pdf');
  assert.equal(committed.packageVersion, CANDIDATE_VERSION);
  assert.equal(committed.packageDigest, candidateDigest);
  assert.equal(committed.sourceRevision, 'c'.repeat(40));
  assert.equal(committed.updateRecoveryState, 'none');
  assert.equal(committed.snapshotPath, snapshotDir);
  assert.equal(store.latestAppUpdateOperation(installed.id).status, 'succeeded');
  const healthy = service.listPackages().find((item) => item.id === 'stirling-pdf');
  assert.equal(healthy.instance.updateRecovery, null);
  assert.equal(healthy.version, CANDIDATE_VERSION);
  store.close();
});

// The M1 pin: rollback-required is an action, not a badge. The recovery action
// rebuilds the candidate runtime from what the failed operation stashed, asks
// the agent to restore the recorded runtime, and reopens the road to a retry.
test('the recovery action restores the recorded runtime after a failed rollback', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  await fsp.rm(path.join(candidateDir, 'privacy-review.json'), { force: true });
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'c'.repeat(40), trust: 'mos-reviewed' };
  const calls = [];
  let promoteAttempts = 0;
  let rollbackAttempts = 0;
  const agent = {
    async activatePackageUpdate(input) { calls.push(['activate', input]); return { status: 'candidate-healthy' }; },
    async apply(input) { calls.push(['apply', input]); return { status: 'applied', steps: [] }; },
    async buildPackageUpdate() { return { status: 'built' }; },
    async promotePackageUpdate() {
      promoteAttempts += 1;
      if (promoteAttempts === 1) throw Object.assign(new Error('The app package snapshot could not be promoted.'), { code: 'APP_UPDATE_PROMOTION_FAILED', statusCode: 502 });
      return { snapshotPath: candidateDir, status: 'snapshot-promoted' };
    },
    async rollbackPackageUpdate(input) {
      rollbackAttempts += 1;
      calls.push(['rollback', input]);
      if (rollbackAttempts === 1) throw Object.assign(new Error('The previous runtime could not be restored.'), { code: 'APP_UPDATE_ROLLBACK_FAILED', statusCode: 502 });
      return { status: 'installed-restored' };
    },
    async snapshotPackage(input) { return snapshotResult(input); },
    async stagePackageUpdate() { return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent,
    appsDir: v2AppsDir,
    catalogService: { platformVersion: '0.18.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; } },
    store,
  });
  await service.installPackage('stirling-pdf');
  const installed = store.getAppInstanceByPackageId('stirling-pdf');
  const comparison = await service.preparePackageUpdate('stirling-pdf');

  await assert.rejects(
    () => service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf')),
    (error) => error.code === 'APP_UPDATE_ROLLBACK_FAILED',
  );
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').updateRecoveryState, 'rollback-required');
  await assert.rejects(
    () => service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf')),
    (error) => error.code === 'APP_UPDATE_RECOVERY_REQUIRED',
  );
  // Startup does not restart containers on its own; the snapshot on disk is
  // still the recorded one, so this stays an owner action.
  assert.deepEqual(await service.recoverInterruptedUpdates(), []);
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').updateRecoveryState, 'rollback-required');

  const recovered = await service.recoverPackageUpdate('stirling-pdf', {
    ...requestContext().publicUrlFor('stirling-pdf'),
    publicUrlFor: requestContext().publicUrlFor,
  });

  assert.equal(recovered.action, 'rolled-back');
  // The runtimes the agent was asked to swap carry the exact recorded
  // identities, with the candidate rebuilt from the operation's stash.
  const [, rollback] = calls.filter(([kind]) => kind === 'rollback')[1];
  assert.equal(rollback.installed.packageDigest, installed.packageDigest);
  assert.equal(rollback.installed.packageVersion, manifest.version);
  assert.equal(rollback.candidate.packageDigest, candidateDigest);
  assert.equal(rollback.candidate.packageVersion, CANDIDATE_VERSION);
  assert.ok(rollback.candidate.compose.services.length >= 1);
  const after = store.getAppInstanceByPackageId('stirling-pdf');
  assert.equal(after.updateRecoveryState, 'none');
  assert.equal(after.packageVersion, manifest.version);
  assert.equal(after.packageDigest, installed.packageDigest);

  // The road is open again: the same update now runs to completion.
  const retried = await service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf'));
  assert.equal(retried.operation.status, 'succeeded');
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').packageVersion, CANDIDATE_VERSION);
  store.close();
});

test('packages without Homepage metadata render no Homepage projection', () => {
  const { manifest } = readAppPackageManifest(path.join(v2AppsDir, 'onlyoffice'));
  const projections = renderDryRunProjections(manifest, []);

  assert.equal(manifest.role, 'capability-provider');
  assert.equal(manifest.homepage, undefined);
  assert.deepEqual(projections.map((projection) => projection.kind).sort(), ['caddy', 'compose', 'health']);
});

test('new installs snapshot package contents before persisting configuration and identity', async () => {
  const stateDir = await tempStateDir();
  const store = new SuiteManagerStore(stateDir);
  const calls = [];
  const agent = {
    async snapshotPackage(input) {
      calls.push(['snapshot', store.getAppInstanceByPackageId(input.packageId)]);
      return snapshotResult(input);
    },
  };
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, store });

  await service.installPackage('stirling-pdf');

  const installed = store.getAppInstanceByPackageId('stirling-pdf');
  assert.deepEqual(calls, [['snapshot', null]]);
  assert.match(installed.packageDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(installed.sourceKind, 'official-git');
  assert.equal(installed.sourcePath, 'apps/stirling-pdf');
  assert.equal(installed.sourceRevision, 'ef5027cc1528b516edbd03c6a7e65349adbcc4b4');
  assert.equal(installed.sourceTrust, 'mos-reviewed');
  assert.equal(installed.snapshotPath, path.join(v2AppsDir, 'stirling-pdf'));
  assert.equal(installed.snapshotState, 'installed');
  assert.equal(installed.privacyStatus, 'reviewed');
  assert.equal(installed.privacyPosture, 'privacy-configured');

  store.close();
});

test('installed package details and icons remain bound to the snapshot when the candidate changes or disappears', async () => {
  const root = await tempStateDir();
  const appsDir = path.join(root, 'apps');
  const candidateDir = path.join(appsDir, 'stirling-pdf');
  const snapshotDir = path.join(root, 'snapshots', 'stirling-pdf');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent: {
      async snapshotPackage() {
        await fsp.cp(candidateDir, snapshotDir, { recursive: true });
        return { snapshotPath: snapshotDir };
      },
    },
    appsDir,
    store,
  });

  await service.installPackage('stirling-pdf');
  const installedBefore = service.listPackages().find((item) => item.id === 'stirling-pdf');
  const installedIcon = await fsp.readFile(service.iconPath('stirling-pdf'));
  const candidateManifestPath = path.join(candidateDir, 'manifest.json');
  const candidateManifest = JSON.parse(await fsp.readFile(candidateManifestPath, 'utf8'));
  await fsp.writeFile(candidateManifestPath, `${JSON.stringify({ ...candidateManifest, name: 'Moving candidate', version: '99.0.0' }, null, 2)}\n`);
  await fsp.rm(candidateDir, { recursive: true });

  const installedAfter = service.listPackages().find((item) => item.id === 'stirling-pdf');
  assert.equal(installedAfter.name, installedBefore.name);
  assert.equal(installedAfter.version, installedBefore.version);
  assert.deepEqual(await fsp.readFile(service.iconPath('stirling-pdf')), installedIcon);

  store.close();
});

test('listPackages exposes privacy from the installed snapshot rather than the moving repo candidate', async () => {
  const root = await tempStateDir();
  const appsDir = path.join(root, 'apps');
  const candidateDir = path.join(appsDir, 'stirling-pdf');
  const snapshotDir = path.join(root, 'snapshots', 'stirling-pdf');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifest = JSON.parse(await fsp.readFile(path.join(candidateDir, 'manifest.json'), 'utf8'));
  // Two-pass authoring: the review participates in the package digest with
  // its scope.packageDigest normalized to a placeholder, so write the review
  // first, digest the package, then bind the real digest without changing it.
  const review = {
    appId: manifest.id,
    dimensions: { accountDependency: 'local-only', confidence: 'verified', dataProcessing: 'local', externalServices: 'none-required', policyExposure: 'self-hosted-software-only', telemetry: 'none-observed' },
    evidence: [],
    openQuestions: [],
    policies: [],
    posture: 'private-by-default',
    provenance: { humanReviewed: true, method: 'human', model: 'manual-review', modelIdentifierSource: 'user-supplied', repositoryCommit: 'test-commit', skill: 'assess-app-privacy', skillRevision: '1' },
    reviewedAt: '2026-07-01T00:00:00.000Z',
    schemaVersion: 1,
    scope: {
      components: [{ artifact: 'docker.io/stirling-tools/stirling-pdf:test', name: 'stirling-pdf', version: manifest.version }],
      packageDigest: 'sha256:<package-digest>',
      packageVersion: manifest.version,
      source: { kind: 'official-git', path: `apps/${manifest.id}`, repository: 'https://github.com/rpuls/my-own-suite', revision: 'test-commit', trust: 'mos-reviewed' },
    },
  };
  const reviewPath = path.join(candidateDir, 'privacy-review.json');
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  review.scope.packageDigest = digestAppPackage(candidateDir);
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent: {
      async snapshotPackage() {
        await fsp.cp(candidateDir, snapshotDir, { recursive: true });
        return { snapshotPath: snapshotDir };
      },
    },
    appsDir,
    store,
  });

  const available = service.listPackages().find((item) => item.id === 'stirling-pdf');
  assert.equal(available.privacy.status, 'reviewed');
  assert.equal(available.privacy.posture, 'private-by-default');
  assert.equal(available.privacy.dimensions.telemetry, 'none-observed');

  await service.installPackage('stirling-pdf');
  const installed = service.listPackages().find((item) => item.id === 'stirling-pdf');
  assert.equal(installed.privacy.status, 'reviewed');
  assert.equal(installed.privacy.dimensions.dataProcessing, 'local');
  // Installed assessment provenance travels from the snapshot review.
  assert.equal(installed.privacy.provenance.method, 'human');
  assert.equal(installed.privacy.provenance.humanReviewed, true);
  assert.equal(installed.privacy.provenance.sourceRevision, 'test-commit');
  // No catalog service wired in this test, so there are no current advisories.
  assert.deepEqual(installed.advisories, []);

  await fsp.rm(candidateDir, { recursive: true });
  const afterRemoval = service.listPackages().find((item) => item.id === 'stirling-pdf');
  assert.equal(afterRemoval.privacy.status, 'reviewed');
  assert.equal(afterRemoval.privacy.posture, 'private-by-default');
  assert.equal(afterRemoval.privacy.dimensions.telemetry, 'none-observed');

  store.close();
});

test('listPackages surfaces current advisories for the installed version separately from the stored review', async () => {
  const root = await tempStateDir();
  const appsDir = path.join(root, 'apps');
  const candidateDir = path.join(appsDir, 'stirling-pdf');
  const snapshotDir = path.join(root, 'snapshots', 'stirling-pdf');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifest = JSON.parse(await fsp.readFile(path.join(candidateDir, 'manifest.json'), 'utf8'));
  const advisory = { affectedVersions: '*', id: 'MOS-PRIV-1', packageId: 'stirling-pdf', publishedAt: '2026-07-10T00:00:00Z', remediation: 'Update the app.', schemaVersion: 1, severity: 'medium', summary: 'New evidence invalidates the installed review.', type: 'privacy-review-invalidated' };
  // Advisories are keyed to the version an owner actually runs, so the stub
  // only returns the advisory for the installed manifest version.
  const catalogService = {
    advisoriesFor: (packageId, version) => (packageId === 'stirling-pdf' && version === manifest.version ? [advisory] : []),
    updateFor: () => null,
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent: {
      async snapshotPackage() {
        await fsp.cp(candidateDir, snapshotDir, { recursive: true });
        return { snapshotPath: snapshotDir };
      },
    },
    appsDir,
    catalogService,
    store,
  });

  await service.installPackage('stirling-pdf');
  const installed = service.listPackages().find((item) => item.id === 'stirling-pdf');
  assert.deepEqual(installed.advisories.map((entry) => entry.id), ['MOS-PRIV-1']);
  // The advisory does not mutate the stored installed review state.
  assert.equal(installed.privacy.status, 'reviewed');

  store.close();
});

// Regression: the candidate review was read raw while staging, and was only
// safe because the candidate's digest happens to parse the same file first. A
// candidate directory is host state that outlives that digest, so a review that
// becomes unreadable afterwards must fail the update as a classified conflict
// rather than an unclassified 500. The preview must degrade instead of
// aborting, or nothing downstream ever gets to classify it.
test('a candidate whose privacy review is unreadable fails the update as a classified conflict', async (t) => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  const candidatePackage = readAppPackageManifest(candidateDir);
  // The digest is taken while the review still parses, exactly as the download
  // path takes it, and only then does the on-disk file go bad.
  const candidateDigest = digestAppPackage(candidateDir);
  await fsp.writeFile(path.join(candidateDir, 'privacy-review.json'), '{ not json');
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'b'.repeat(40), trust: 'mos-reviewed' };
  const agent = {
    async activatePackageUpdate() { return { status: 'candidate-healthy' }; },
    async buildPackageUpdate() { return { steps: ['candidate-built'] }; },
    async promotePackageUpdate() { return { snapshotPath: candidateDir, status: 'snapshot-promoted' }; },
    async rollbackPackageUpdate() { return { status: 'installed-restored' }; },
    async snapshotPackage(input) { return snapshotResult(input); },
    async stagePackageUpdate() { return { snapshotPath: '/state/candidate', steps: ['staged'] }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
  };
  const catalogService = {
    platformVersion: '0.18.0',
    async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, catalogService, store });
  await service.installPackage('stirling-pdf');

  // The preview survives an unreadable review and reports it, rather than
  // throwing a raw SyntaxError out of the comparison.
  const comparison = await service.preparePackageUpdate('stirling-pdf');
  assert.equal(comparison.candidate.privacy.status, 'invalid');
  assert.deepEqual(comparison.candidate.privacy.errors, ['privacy review is not valid JSON.']);

  await assert.rejects(
    () => service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext()),
    (error) => error.code === 'APP_PRIVACY_REVIEW_INVALID' && error.statusCode === 409,
  );
  // The refusal lands before any durable update work begins.
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').packageVersion, manifest.version);
});

test('confirmed app updates are re-compared and durably staged against exact identities', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  await fsp.rm(path.join(candidateDir, 'privacy-review.json'), { force: true });
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'b'.repeat(40), trust: 'mos-reviewed' };
  const stagedCalls = [];
  const builtCalls = [];
  const agent = {
    async activatePackageUpdate() { return { status: 'candidate-healthy' }; },
    async buildPackageUpdate(input) { builtCalls.push(input); return { steps: ['candidate-built'] }; },
    async promotePackageUpdate() { return { snapshotPath: candidateDir, status: 'snapshot-promoted' }; },
    async rollbackPackageUpdate() { return { status: 'installed-restored' }; },
    async snapshotPackage(input) { return snapshotResult(input); },
    async stagePackageUpdate(input) { stagedCalls.push(input); return { snapshotPath: '/state/candidate', steps: ['staged'] }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
  };
  const catalogService = {
    platformVersion: '0.18.0',
    async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, catalogService, store });
  await service.installPackage('stirling-pdf');
  const installedDigest = store.getAppInstanceByPackageId('stirling-pdf').packageDigest;
  const comparison = await service.preparePackageUpdate('stirling-pdf');

  await assert.rejects(() => service.stagePackageUpdate('stirling-pdf', { confirmationToken: '0'.repeat(64) }), (error) => error.code === 'APP_UPDATE_IDENTITY_CHANGED');
  const result = await service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf'));

  assert.equal(result.operation.stage, 'completed');
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.candidateDigest, candidateDigest);
  assert.equal(stagedCalls.length, 1);
  assert.equal(stagedCalls[0].candidatePath, candidateDir);
  assert.equal(stagedCalls[0].expectedInstalledDigest, installedDigest);
  assert.equal(builtCalls.length, 1);
  assert.equal(builtCalls[0].packageDigest, candidateDigest);
  assert.equal(builtCalls[0].expectedInstalledDigest, installedDigest);
  assert.equal(builtCalls[0].publicUrl, 'https://stirling-pdf.example.test/');
  store.close();
});

// An agent that could stage and build but not activate/rollback/promote used to
// be accepted and then abandoned mid-transaction, leaving the operation row
// running forever and every later update refused until restart. That tier
// cannot legitimately exist under the managed-update rule, so it is refused
// before any durable update work begins.
test('an agent that cannot apply updates end to end is refused before any update work begins', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'b'.repeat(40), trust: 'mos-reviewed' };
  const stagedCalls = [];
  // The client methods exist (a current Suite Manager), but the agent on the
  // host only declares the stage/build half of the update contract.
  const agent = {
    async activatePackageUpdate() { throw new Error('should not be called'); },
    async buildPackageUpdate() { throw new Error('should not be called'); },
    async promotePackageUpdate() { throw new Error('should not be called'); },
    async rollbackPackageUpdate() { throw new Error('should not be called'); },
    async snapshotPackage(input) { return snapshotResult(input); },
    async stagePackageUpdate(input) { stagedCalls.push(input); return { snapshotPath: '/state/candidate', steps: ['staged'] }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build'], contractVersion: 3 }; },
  };
  const catalogService = {
    platformVersion: '0.18.0',
    async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, catalogService, store });
  await service.installPackage('stirling-pdf');
  const comparison = await service.preparePackageUpdate('stirling-pdf');

  await assert.rejects(
    () => service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf')),
    (error) => error.code === 'APP_UPDATE_STAGING_UNAVAILABLE' && error.statusCode === 503,
  );
  assert.equal(stagedCalls.length, 0);
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').packageVersion, manifest.version);
  // No operation row was left running: retrying reports the same refusal, not a
  // permanently "already running" update.
  await assert.rejects(
    () => service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf')),
    (error) => error.code === 'APP_UPDATE_STAGING_UNAVAILABLE',
  );
  store.close();
});

test('contract v6 app updates activate, promote, and commit candidate identity as one operation', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, update: { ...manifest.update, rollback: 'safe' }, version: CANDIDATE_VERSION }, null, 2)}\n`);
  await fsp.rm(path.join(candidateDir, 'privacy-review.json'), { force: true });
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'b'.repeat(40), trust: 'mos-reviewed' };
  const calls = [];
  const agent = {
    async activatePackageUpdate(input) { calls.push(['activate', input]); return { status: 'candidate-healthy' }; },
    async buildPackageUpdate() { return { status: 'built' }; },
    async promotePackageUpdate(input) { calls.push(['promote', input]); return { snapshotPath: candidateDir, status: 'snapshot-promoted' }; },
    async rollbackPackageUpdate(input) { calls.push(['rollback', input]); return { status: 'installed-restored' }; },
    async snapshotPackage(input) { return snapshotResult(input); },
    async stagePackageUpdate() { return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
  };
  const catalogService = { platformVersion: '0.18.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; } };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, catalogService, store });
  await service.installPackage('stirling-pdf');
  const comparison = await service.preparePackageUpdate('stirling-pdf');
  const result = await service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf'));
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.stage, 'completed');
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').packageVersion, CANDIDATE_VERSION);
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').packageDigest, candidateDigest);
  assert.equal(calls[0][0], 'activate');
  assert.equal(calls[1][0], 'promote');
  assert.equal(calls[1][1].rollbackSafe, true);
  store.close();
});

// Every other update test in this file deletes the candidate's privacy review
// before updating, which is exactly what hid this: a reviewed official candidate
// could never be staged. The review names the commit it was authored against,
// while the update path resolves the catalog branch for real, and the binding
// required the two to be equal â€” impossible for a file that lives inside the
// commit it would have to name. This keeps the review, and gives the candidate a
// source revision that differs from the one the review declares, which is the
// only shape the catalog can ever produce.
test('an official candidate that ships a privacy review updates and keeps its reviewed posture', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: CANDIDATE_VERSION }, null, 2)}\n`);
  // Re-stamp the review the way publishing a package does: packageVersion is
  // hashed, packageDigest is placeholdered before hashing and so settles in one
  // pass. The declared revision is left alone on purpose.
  const reviewPath = path.join(candidateDir, 'privacy-review.json');
  const review = JSON.parse(await fsp.readFile(reviewPath, 'utf8'));
  review.scope.packageVersion = CANDIDATE_VERSION;
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  review.scope.packageDigest = digestAppPackage(candidateDir);
  await fsp.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  assert.notEqual(review.scope.source.revision, 'c'.repeat(40));
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'c'.repeat(40), trust: 'mos-reviewed' };
  const snapshotDir = path.join(root, 'snapshots', 'installed');
  const agent = {
    async activatePackageUpdate() { return { status: 'candidate-healthy' }; },
    async buildPackageUpdate() { return { status: 'built' }; },
    async promotePackageUpdate() {
      await fsp.rm(snapshotDir, { force: true, recursive: true });
      await fsp.cp(candidateDir, snapshotDir, { recursive: true });
      return { snapshotPath: snapshotDir, status: 'snapshot-promoted' };
    },
    async rollbackPackageUpdate() { throw new Error('rollback must not run for a healthy candidate'); },
    async snapshotPackage() {
      await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), snapshotDir, { recursive: true });
      return { snapshotPath: snapshotDir };
    },
    async stagePackageUpdate() { return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent,
    appsDir: v2AppsDir,
    catalogService: { advisoriesFor: () => [], platformVersion: '0.18.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; }, updateFor: () => null },
    store,
  });
  await service.installPackage('stirling-pdf');

  const comparison = await service.preparePackageUpdate('stirling-pdf');
  assert.equal(comparison.updateStatus, 'update-available');
  // The candidate's posture is read from its own shipped review, not degraded to
  // review-required because the revision differs.
  assert.equal(comparison.candidate.privacy.status, 'reviewed');
  assert.equal(comparison.candidate.privacy.posture, review.posture);

  const result = await service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf'));
  assert.equal(result.operation.status, 'succeeded');
  const updated = store.getAppInstanceByPackageId('stirling-pdf');
  assert.equal(updated.packageVersion, CANDIDATE_VERSION);
  assert.equal(updated.packageDigest, candidateDigest);
  assert.equal(updated.privacyStatus, 'reviewed');
  assert.equal(updated.privacyPosture, review.posture);
  store.close();
});

test('app updates replace an applied Homepage entry and retain its applied projection state', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({
    ...manifest,
    homepage: { ...manifest.homepage, name: 'Updated PDF' },
    name: 'Updated PDF',
    version: CANDIDATE_VERSION,
  }, null, 2)}\n`);
  await fsp.rm(path.join(candidateDir, 'privacy-review.json'), { force: true });
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'c'.repeat(40), trust: 'mos-reviewed' };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({
    agent: {
      async activatePackageUpdate() { return { status: 'candidate-healthy' }; },
      async buildPackageUpdate() { return { status: 'built' }; },
      async promotePackageUpdate() { return { snapshotPath: candidateDir, status: 'snapshot-promoted' }; },
      async rollbackPackageUpdate() { return { status: 'installed-restored' }; },
      async snapshotPackage(input) { return snapshotResult(input); },
      async stagePackageUpdate() { return { snapshotPath: '/state/candidate', status: 'staged' }; },
      async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build', 'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote'], contractVersion: 6 }; },
    },
    appsDir: v2AppsDir,
    catalogService: { platformVersion: '0.18.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; } },
    store,
  });
  await service.installPackage('stirling-pdf');
  const installed = store.getAppInstanceByPackageId('stirling-pdf');
  store.applyAppProjection({ at: new Date().toISOString(), instanceId: installed.id, kind: 'homepage', operationId: 'homepage-applied' });
  const entries = [];
  const homepageService = {
    async add(body) { entries.push(body.entry); return { revision: `revision-${entries.length}` }; },
    async read() { return { revision: `revision-${entries.length}` }; },
  };
  const comparison = await service.preparePackageUpdate('stirling-pdf');
  const result = await service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, {
    ...requestContext().publicUrlFor('stirling-pdf'), homepageService,
  });

  assert.equal(result.homepage.revision, 'revision-1');
  assert.equal(entries[0].name, 'Updated PDF');
  const homepageProjection = store.getAppProjections(installed.id).find((projection) => projection.kind === 'homepage');
  assert.equal(homepageProjection.status, 'applied');
  assert.equal(homepageProjection.appliedDigest, homepageProjection.digest);
  store.close();
});

test('startup classifies every interrupted update boundary into an actionable recovery state', async () => {
  const cases = [
    ['candidate-verified', 'retry-safe'],
    ['candidate-staged', 'retry-safe'],
    // The runtime swap happens between the candidate-built and candidate-healthy
    // writes, so a crash at candidate-built may already have the candidate
    // serving. Restoring the recorded runtime is safe in either case; calling it
    // retry-safe was only sometimes true.
    ['candidate-built', 'rollback-required'],
    ['candidate-healthy', 'rollback-required'],
    ['homepage-reconciled', 'rollback-required'],
    ['snapshot-promoted', 'commit-required'],
  ];
  for (const [stage, expectedState] of cases) {
    const root = await tempStateDir();
    const store = new SuiteManagerStore(root);
    const service = new AppPackageService({ agent: { async snapshotPackage(input) { return snapshotResult(input); } }, appsDir: v2AppsDir, store });
    await service.installPackage('stirling-pdf');
    const instance = store.getAppInstanceByPackageId('stirling-pdf');
    const operationId = `interrupted-${stage}`;
    store.beginAppUpdate({
      at: '2026-07-14T00:00:00.000Z',
      candidateDigest: `sha256:${'b'.repeat(64)}`,
      expectedInstalledDigest: instance.packageDigest,
      instanceId: instance.id,
      operationId,
    });
    if (stage !== 'candidate-verified') store.advanceAppUpdate({ instanceId: instance.id, operationId, stage });

    const [recovery] = await service.recoverInterruptedUpdates();
    assert.equal(recovery.recoveryState, expectedState);
    assert.equal(store.getAppOperation(operationId).status, 'failed');
    assert.equal(store.getAppInstanceByPackageId('stirling-pdf').updateRecoveryState, expectedState);
    store.close();
  }
});

test('legacy instances migrate only from an exactly matching validated package', async () => {
  const root = await tempStateDir();
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const matching = readAppPackageManifest(path.join(v2AppsDir, 'stirling-pdf')).manifest;
  const mismatched = readAppPackageManifest(path.join(v2AppsDir, 'onlyoffice')).manifest;
  const installLegacy = (id, manifest, manifestDigest) => store.installAppInstance({
    at: '2026-07-14T00:00:00.000Z',
    config: [],
    instance: {
      categorySnapshot: manifest.category,
      displayNameSnapshot: manifest.name,
      id,
      manifestDigest,
      packageId: manifest.id,
      packageVersion: manifest.version,
    },
    operationId: `${id}-operation`,
    projections: renderDryRunProjections(manifest, []),
  });
  installLegacy('legacy-matching', matching, digestFor(matching));
  installLegacy('legacy-mismatch', mismatched, 'sha256:not-the-current-manifest');
  const service = new AppPackageService({
    agent: {
      async snapshotPackage(input) {
        const snapshotPath = path.join(root, 'snapshots', input.instanceId);
        await fsp.cp(path.join(v2AppsDir, input.packageId), snapshotPath, { recursive: true });
        return { snapshotPath };
      },
    },
    appsDir: v2AppsDir,
    store,
  });

  const results = await service.migrateLegacyPackages();
  assert.deepEqual(results.map(({ packageId, status }) => ({ packageId, status })), [
    { packageId: 'onlyoffice', status: 'needs-package-recovery' },
    { packageId: 'stirling-pdf', status: 'migrated' },
  ]);
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').snapshotState, 'installed');
  assert.equal(store.getAppInstanceByPackageId('onlyoffice').snapshotState, 'needs-package-recovery');

  store.close();
});

// Regression: an unguarded privacy-review.json parse in the startup migration
// aborted migrateLegacyPackages, and start.cjs exits on that â€” one malformed
// file in one package prevented Suite Manager from booting at all.
test('a malformed privacy review degrades to recovery at migration and a 409 at install', async (t) => {
  const root = await tempStateDir();
  const appsDir = path.join(root, 'apps');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), path.join(appsDir, 'stirling-pdf'), { recursive: true });
  await fsp.writeFile(path.join(appsDir, 'stirling-pdf', 'privacy-review.json'), '{ not json');
  const manifest = readAppPackageManifest(path.join(appsDir, 'stirling-pdf')).manifest;
  const store = new SuiteManagerStore(path.join(root, 'state'));
  t.after(() => store.close());
  store.installAppInstance({
    at: '2026-07-14T00:00:00.000Z',
    config: [],
    instance: {
      categorySnapshot: manifest.category,
      displayNameSnapshot: manifest.name,
      id: 'legacy-malformed-review',
      manifestDigest: digestFor(manifest),
      packageId: manifest.id,
      packageVersion: manifest.version,
    },
    operationId: 'legacy-malformed-review-operation',
    projections: renderDryRunProjections(manifest, []),
  });
  const service = new AppPackageService({ agent: { async snapshotPackage(input) { return snapshotResult(input); } }, appsDir, store });

  const results = await service.migrateLegacyPackages();
  assert.deepEqual(results, [{ packageId: 'stirling-pdf', status: 'needs-package-recovery' }]);
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').snapshotState, 'needs-package-recovery');

  const freshStore = new SuiteManagerStore(path.join(root, 'fresh-state'));
  t.after(() => freshStore.close());
  const freshService = new AppPackageService({ agent: { async snapshotPackage(input) { return snapshotResult(input); } }, appsDir, store: freshStore });
  await assert.rejects(
    () => freshService.installPackage('stirling-pdf'),
    (error) => error.code === 'APP_PACKAGE_INVALID' && error.statusCode === 409,
  );
});

test('snapshot failure leaves no app configuration or install record', async () => {
  const stateDir = await tempStateDir();
  const store = new SuiteManagerStore(stateDir);
  const service = new AppPackageService({
    agent: {
      async snapshotPackage() {
        throw Object.assign(new Error('digest mismatch'), { code: 'APP_PACKAGE_DIGEST_MISMATCH' });
      },
    },
    appsDir: v2AppsDir,
    store,
  });

  await assert.rejects(service.installPackage('seafile', {
    adminEmail: 'owner@example.test',
    adminPassword: 'not-a-real-secret',
  }), { code: 'APP_PACKAGE_DIGEST_MISMATCH' });
  assert.equal(store.getAppInstanceByPackageId('seafile'), null);
  assert.deepEqual(await fsp.readdir(path.join(stateDir, 'app-secrets')).catch(() => []), []);

  store.close();
});

test('public URL reconciliation reapplies installed app routes and Homepage app entries', async () => {
  const calls = [];
  const appAgent = {
    async snapshotPackage(input) { return snapshotResult(input); },
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

  await service.installPackage('stirling-pdf');
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
    async snapshotPackage(input) { return snapshotResult(input); },
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
    await service.installPackage(packageId);
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
    async snapshotPackage(input) { return snapshotResult(input); },
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

  await service.installPackage('stirling-pdf');
  await service.disablePackage('stirling-pdf', homepageService);
  await service.reconcilePublicUrls(homepageService, requestContext());

  assert.equal(calls.length, 0);

  store.close();
});

test('integration lifecycle recovers provider restart and reports disabled/uninstalled relationships truthfully', async () => {
  const calls = [];
  const appAgent = {
    async snapshotPackage(input) { return snapshotResult(input); },
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

  await service.installPackage('seafile', {
    adminEmail: 'owner@example.test',
    adminPassword: 'not-a-real-secret',
  });
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

  const uninstalled = await service.uninstallPackage('onlyoffice', homepageService);
  assert.equal(uninstalled.homepage.skipped, true);
  assert.equal(uninstalled.instance, null);
  assert.equal(store.getAppIntegrations().length, 0);
  assert.equal(store.getAppInstanceByPackageId('onlyoffice'), null);
  assert.equal(store.getAppInstanceByPackageId('seafile').status, 'installed');
  assert.doesNotMatch(JSON.stringify(store.getAppIntegrations()), /not-a-real-secret/u);

  store.close();
});
