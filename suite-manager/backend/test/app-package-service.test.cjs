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

const v2Root = path.resolve(__dirname, '..', '..', '..');
const v2AppsDir = path.join(v2Root, 'apps');

function snapshotResult(input) {
  return { snapshotPath: path.join(v2AppsDir, input.packageId) };
}

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

// A downloaded external candidate shaped the way ExternalSourceClient returns
// one: a real package folder plus the namespaced identity and recorded source.
async function externalCandidate(root, overrides = {}, dirName = 'ext-abc') {
  const packageDir = path.join(root, 'app-candidates', dirName);
  await fsp.mkdir(packageDir, { recursive: true });
  const manifest = {
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
function externalUpdateAgent(root, calls = [], promotedSnapshotPath = null) {
  return {
    ...externalAgent(root),
    async activatePackageUpdate(input) { calls.push(['activate', input]); return { status: 'candidate-healthy' }; },
    async buildPackageUpdate(input) { calls.push(['build', input]); return { status: 'built' }; },
    async promotePackageUpdate(input) { calls.push(['promote', input]); return { snapshotPath: promotedSnapshotPath, status: 'snapshot-promoted' }; },
    async rollbackPackageUpdate(input) { calls.push(['rollback', input]); return { status: 'installed-restored' }; },
    async stagePackageUpdate(input) { calls.push(['stage', input]); return { snapshotPath: '/state/candidate', status: 'staged' }; },
    async status() {
      return {
        capabilities: [
          'apps.package.snapshot', 'apps.package.snapshot.external', 'apps.package.update.stage', 'apps.package.update.build',
          'apps.package.update.activate', 'apps.package.update.rollback', 'apps.package.update.promote',
        ],
        contractVersion: 7,
      };
    },
  };
}

// The external client as the package service uses it for updates: re-resolve the
// source's commit, then hand back the candidate that commit publishes.
function externalClientStub(candidate) {
  return {
    platformVersion: '0.1.0',
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
  assert.equal(listed.privacy.posture, 'review-required');
  assert.equal(listed.mosReviewed, false);
  store.close();
});

test('an external package cannot take a web address an installed app already serves', async () => {
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

  await assert.rejects(() => service.installExternalPackage({ candidate }), { code: 'APP_ROUTE_HOST_TAKEN' });
  assert.equal(store.getAppInstanceByPackageId('x-abcdef01-community-notes'), null);
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
  assert.deepEqual(comparison.permissions.installed, ['route:notes', 'volume:notes-data']);
  assert.deepEqual(comparison.permissions.added, ['route:notes-admin']);
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
  await service.installPackage('stirling-pdf');
  registerSource(store);
  const takenHost = store.getAppProjections(store.getAppInstanceByPackageId('stirling-pdf').id)
    .find((projection) => projection.kind === 'caddy').content.routes[0].host;
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
  assert.equal(installed.sourceRevision, installed.packageDigest);
  assert.equal(installed.sourceTrust, 'mos-reviewed');
  assert.equal(installed.snapshotPath, path.join(v2AppsDir, 'stirling-pdf'));
  assert.equal(installed.snapshotState, 'installed');
  assert.equal(installed.privacyStatus, 'review-required');
  assert.equal(installed.privacyPosture, 'review-required');

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
  assert.equal(installed.privacy.status, 'review-required');

  store.close();
});

test('confirmed app updates are re-compared and durably staged against exact identities', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, version: '0.2.0' }, null, 2)}\n`);
  const candidatePackage = readAppPackageManifest(candidateDir);
  const candidateDigest = digestAppPackage(candidateDir);
  const source = { kind: 'official-git', path: 'apps/stirling-pdf', repository: 'https://github.com/rpuls/my-own-suite', revision: 'b'.repeat(40), trust: 'mos-reviewed' };
  const stagedCalls = [];
  const builtCalls = [];
  const agent = {
    async buildPackageUpdate(input) { builtCalls.push(input); return { steps: ['candidate-built'] }; },
    async snapshotPackage(input) { return snapshotResult(input); },
    async stagePackageUpdate(input) { stagedCalls.push(input); return { snapshotPath: '/state/candidate', steps: ['staged'] }; },
    async status() { return { capabilities: ['apps.package.snapshot', 'apps.package.update.stage', 'apps.package.update.build'], contractVersion: 3 }; },
  };
  const catalogService = {
    platformVersion: '0.1.0',
    async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; },
  };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, catalogService, store });
  await service.installPackage('stirling-pdf');
  const comparison = await service.preparePackageUpdate('stirling-pdf');

  await assert.rejects(() => service.stagePackageUpdate('stirling-pdf', { confirmationToken: '0'.repeat(64) }), (error) => error.code === 'APP_UPDATE_IDENTITY_CHANGED');
  const result = await service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf'));

  assert.equal(result.operation.stage, 'candidate-built');
  assert.equal(result.operation.status, 'running');
  assert.equal(result.operation.candidateDigest, candidateDigest);
  assert.equal(stagedCalls.length, 1);
  assert.equal(stagedCalls[0].candidatePath, candidateDir);
  assert.equal(stagedCalls[0].expectedInstalledDigest, store.getAppInstanceByPackageId('stirling-pdf').packageDigest);
  assert.equal(builtCalls.length, 1);
  assert.equal(builtCalls[0].packageDigest, candidateDigest);
  assert.equal(builtCalls[0].expectedInstalledDigest, store.getAppInstanceByPackageId('stirling-pdf').packageDigest);
  assert.equal(builtCalls[0].publicUrl, 'https://stirling-pdf.example.test/');
  await assert.rejects(() => service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }), (error) => error.code === 'APP_UPDATE_ALREADY_RUNNING');
  store.close();
});

test('contract v6 app updates activate, promote, and commit candidate identity as one operation', async () => {
  const root = await tempStateDir();
  const candidateDir = path.join(root, 'candidate');
  await fsp.cp(path.join(v2AppsDir, 'stirling-pdf'), candidateDir, { recursive: true });
  const manifestPath = path.join(candidateDir, 'manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  await fsp.writeFile(manifestPath, `${JSON.stringify({ ...manifest, update: { ...manifest.update, rollback: 'safe' }, version: '0.2.0' }, null, 2)}\n`);
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
  const catalogService = { platformVersion: '0.1.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; } };
  const store = new SuiteManagerStore(path.join(root, 'state'));
  const service = new AppPackageService({ agent, appsDir: v2AppsDir, catalogService, store });
  await service.installPackage('stirling-pdf');
  const comparison = await service.preparePackageUpdate('stirling-pdf');
  const result = await service.stagePackageUpdate('stirling-pdf', { confirmationToken: comparison.confirmationToken }, requestContext().publicUrlFor('stirling-pdf'));
  assert.equal(result.operation.status, 'succeeded');
  assert.equal(result.operation.stage, 'completed');
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').packageVersion, '0.2.0');
  assert.equal(store.getAppInstanceByPackageId('stirling-pdf').packageDigest, candidateDigest);
  assert.equal(calls[0][0], 'activate');
  assert.equal(calls[1][0], 'promote');
  assert.equal(calls[1][1].rollbackSafe, true);
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
    version: '0.2.0',
  }, null, 2)}\n`);
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
    catalogService: { platformVersion: '0.1.0', async downloadCandidate() { return { ...candidatePackage, cleanup() {}, packageDigest: candidateDigest, source }; } },
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
    ['candidate-built', 'retry-safe'],
    ['candidate-healthy', 'rollback-required'],
    ['integrations-reconciled', 'rollback-required'],
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
    if (stage !== 'candidate-verified') store.advanceAppUpdate({ at: '2026-07-14T00:00:01.000Z', instanceId: instance.id, operationId, stage });

    const [recovery] = service.recoverInterruptedUpdates();
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
