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
