const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-inventory-'));
const STATE_DIR = path.join(TEMP_ROOT, 'state');
const servicePath = require.resolve('../src/backups/backup-inventory-service.cjs');

const { BackupInventoryService, DEFAULT_CADDY_FILES, DEFAULT_HTTPS_SECRET_PATH, HOMEPAGE_CONFIG_FILES, uniqueVolumesFor } = require(servicePath);
const { digestAppPackage } = require('../src/apps/package-contracts.cjs');

test.after(() => {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});

// Writes a real package snapshot under TEMP_ROOT and returns its true digest, so
// the inventory exercises the real manifest reader and digest function rather
// than a stub. Defaults cover every field manifest validation requires; anything
// passed in overrides them, with `resources` replaced wholesale rather than
// merged so a caller declaring services does not inherit the default service.
function setupSnapshot(manifestObj) {
  const snapshotPath = fs.mkdtempSync(path.join(TEMP_ROOT, 'snap-'));

  const defaultManifest = {
    manifestVersion: 1,
    name: 'Test App',
    minimumMosVersion: '1.0.0',
    summary: 'A test app',
    category: 'utilities',
    health: { type: 'http', url: 'http://app/' },
    resources: { services: { main: { image: 'test-image' } } },
    version: '1.0.0',
  };

  const fullManifest = {
    ...defaultManifest,
    ...manifestObj,
    resources: manifestObj?.resources || defaultManifest.resources,
  };

  fs.writeFileSync(path.join(snapshotPath, 'manifest.json'), JSON.stringify(fullManifest));
  fs.writeFileSync(path.join(snapshotPath, 'Dockerfile'), ''); // an empty Dockerfile is enough for validation
  const digest = digestAppPackage(snapshotPath);
  return { snapshotPath, digest };
}

function makeInstance(overrides = {}) {
  return {
    id: 'instance-1',
    installedAt: '2025-01-01T00:00:00.000Z',
    manifestDigest: 'manifest-digest-1',
    packageDigest: 'package-digest-1',
    packageId: 'app-1',
    packageVersion: '1.0.0',
    snapshotPath: null,
    snapshotState: 'missing',
    sourceKind: 'github',
    sourcePath: 'https://github.com/acme/app',
    sourceRepository: 'acme/app',
    sourceRevision: 'abc123',
    sourceTrust: 'trusted',
    status: 'installed',
    ...overrides,
  };
}

function makeStore(instances, relationships = []) {
  return {
    getAppInstances: () => instances,
    getAppIntegrations: () => relationships,
  };
}

test('exports the expected default backup inventory constants', () => {
  assert.deepEqual(DEFAULT_CADDY_FILES, [
    '/etc/caddy/Caddyfile',
    '/etc/caddy/mos-homepage-routes.caddy',
    '/etc/caddy/mos-app-routes.caddy',
  ]);
  assert.equal(DEFAULT_HTTPS_SECRET_PATH, '/etc/mos/secrets/caddy-cloudflare.env');
  assert.deepEqual(HOMEPAGE_CONFIG_FILES, [
    'services.template.yaml',
    'bookmarks.yaml',
    'settings.yaml',
    'widgets.yaml',
    'custom.css',
    'custom.js',
    'images',
  ]);
});

test('uniqueVolumesFor deduplicates volumes and sorts by docker volume name', () => {
  const manifest = {
    id: 'pkg-a',
    resources: {
      services: {
        api: { volumes: ['data:/var/data', ' logs :/var/logs'] },
        worker: { volumes: ['data:/var/data', 'cache:/var/cache'] },
      },
    },
  };

  assert.deepEqual(uniqueVolumesFor(manifest), [
    { declaredName: 'cache', dockerVolume: 'mos-app-pkg-a-cache', backupClass: 'data', requiredOnRestore: true },
    { declaredName: 'data', dockerVolume: 'mos-app-pkg-a-data', backupClass: 'data', requiredOnRestore: true },
    { declaredName: 'logs', dockerVolume: 'mos-app-pkg-a-logs', backupClass: 'data', requiredOnRestore: true },
  ]);
});

test('uniqueVolumesFor ignores empty or malformed volume declarations', () => {
  const manifest = {
    id: 'pkg-empty',
    resources: { services: { app: { volumes: [null, '', ':', '   '] } } },
  };
  assert.deepEqual(uniqueVolumesFor(manifest), []);
});

test('uniqueVolumesFor handles manifests without services', () => {
  assert.deepEqual(uniqueVolumesFor({ id: 'no-services', resources: {} }), []);
});

test('constructor uses MOS_STATE_ROOT when present', () => {
  const previous = process.env.MOS_STATE_ROOT;
  const configuredRoot = path.join(TEMP_ROOT, 'mos-state');
  process.env.MOS_STATE_ROOT = configuredRoot;
  try {
    const service = new BackupInventoryService({
      stateDir: path.join(TEMP_ROOT, 'state', 'suite-manager'),
      store: {},
    });
    assert.equal(service.stateRoot, configuredRoot);
    assert.equal(
      service.homepageConfigRoot,
      path.join(configuredRoot, 'homepage', 'config'),
    );
  } finally {
    if (previous === undefined) delete process.env.MOS_STATE_ROOT;
    else process.env.MOS_STATE_ROOT = previous;
  }
});

test('constructor defaults stateRoot to parent when stateDir is suite-manager', () => {
  const previous = process.env.MOS_STATE_ROOT;
  delete process.env.MOS_STATE_ROOT;
  try {
    const service = new BackupInventoryService({
      stateDir: path.join(TEMP_ROOT, 'suite-manager'),
      store: {},
    });
    assert.equal(service.stateRoot, TEMP_ROOT);
  } finally {
    if (previous === undefined) delete process.env.MOS_STATE_ROOT;
    else process.env.MOS_STATE_ROOT = previous;
  }
});

test('constructor resolves stateRoot to parent for non-suite-manager state dirs', () => {
  const previous = process.env.MOS_STATE_ROOT;
  delete process.env.MOS_STATE_ROOT;
  try {
    const service = new BackupInventoryService({
      stateDir: path.join(TEMP_ROOT, 'state-dir'),
      store: {},
    });
    assert.equal(service.stateRoot, TEMP_ROOT);
  } finally {
    if (previous === undefined) delete process.env.MOS_STATE_ROOT;
    else process.env.MOS_STATE_ROOT = previous;
  }
});

test('constructor applies default caddy and secret paths', () => {
  const service = new BackupInventoryService({ stateDir: TEMP_ROOT, store: {} });
  assert.deepEqual(service.caddyFiles, DEFAULT_CADDY_FILES);
  assert.equal(service.httpsSecretPath, DEFAULT_HTTPS_SECRET_PATH);
});

test('inventory summarizes an empty store', () => {
  const service = new BackupInventoryService({
    stateDir: path.join(TEMP_ROOT, 'empty-state'),
    store: makeStore([]),
  });
  const result = service.inventory();

  assert.equal(result.summary.appCount, 0);
  assert.equal(result.summary.declaredVolumeCount, 0);
  assert.equal(result.summary.relationshipCount, 0);
  assert.equal(result.summary.warningCount, 0);
  assert.deepEqual(result.packages, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.relationships, { active: 0, count: 0, statuses: [] });
  assert.deepEqual(result.packageManifestDigests, []);
  assert.deepEqual(result.actions, {
    backupEnabled: false,
    backupLabel: 'Back up everything',
    backupReason: 'MOS backup inventory is ready, but archive and restore jobs wait for a MOS backup agent.',
    restoreEnabled: false,
  });
  assert.equal(typeof result.checkedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(result.checkedAt)), false);
});

test('inventory reports missing snapshot warnings for uninstalled snapshot states', () => {
  const instance = makeInstance({
    id: 'inst-1',
    packageId: 'app-1',
    snapshotState: 'missing',
    snapshotPath: '/does/not/exist',
  });

  const service = new BackupInventoryService({
    stateDir: STATE_DIR,
    store: makeStore([instance]),
  });
  const result = service.inventory();

  assert.equal(result.packages.length, 1);
  const pkg = result.packages[0];
  assert.equal(pkg.manifestPresent, false);
  assert.equal(pkg.snapshot.verified, false);
  assert.deepEqual(pkg.declaredVolumes, []);
  assert.deepEqual(pkg.warnings, [
    'Installed package snapshot is missing or invalid; restore compatibility cannot be guaranteed.',
  ]);
  assert.equal(result.summary.warningCount, 1);
  assert.deepEqual(result.packageManifestDigests, []);
});

test('inventory treats manifest read failures as invalid snapshots', () => {
  const instance = makeInstance({
    packageId: 'app-1',
    snapshotState: 'installed',
    snapshotPath: '/snap/app-1', // will fail to read since it doesn't exist
  });

  const service = new BackupInventoryService({
    stateDir: STATE_DIR,
    store: makeStore([instance]),
  });
  const result = service.inventory();

  assert.equal(result.packages[0].manifestPresent, false);
  assert.equal(result.packages[0].snapshot.verified, false);
  assert.deepEqual(result.packages[0].declaredVolumes, []);
  assert.equal(result.summary.warningCount, 1);
});

test('inventory maps a verified installed package and its declared volumes', () => {
  const { snapshotPath, digest } = setupSnapshot({
    id: 'app-1',
    resources: { services: { app: { dockerfile: 'Dockerfile', internalPort: 8080, volumes: ['data:/data'] } } },
    version: '1.0.0',
  });

  const instance = makeInstance({
    packageId: 'app-1',
    packageVersion: '1.0.0',
    manifestDigest: 'manifest-digest-1',
    packageDigest: digest,
    snapshotPath,
    snapshotState: 'installed',
  });

  const service = new BackupInventoryService({
    stateDir: STATE_DIR,
    store: makeStore([instance]),
  });
  const result = service.inventory();

  assert.equal(result.packages.length, 1);
  const pkg = result.packages[0];
  assert.equal(pkg.manifestPresent, true);
  assert.equal(pkg.snapshot.verified, true);
  assert.deepEqual(pkg.declaredVolumes, [
    { declaredName: 'data', dockerVolume: 'mos-app-app-1-data', backupClass: 'data', requiredOnRestore: true },
  ]);
  assert.deepEqual(pkg.warnings, [
    'Package declares volumes but no explicit backup metadata yet.',
  ]);
  assert.equal(result.summary.declaredVolumeCount, 1);
  assert.equal(result.summary.warningCount, 1);
  assert.deepEqual(result.packageManifestDigests, [
    { digest: 'manifest-digest-1', packageId: 'app-1', version: '1.0.0' },
  ]);
});

test('inventory marks snapshot unverified when manifest id does not match package id', () => {
  const { snapshotPath, digest } = setupSnapshot({ id: 'app-2', resources: { services: { app: { dockerfile: 'Dockerfile', internalPort: 8080 } } } });

  const instance = makeInstance({
    packageId: 'app-1',
    packageDigest: digest,
    snapshotState: 'installed',
    snapshotPath,
  });

  const service = new BackupInventoryService({
    stateDir: STATE_DIR,
    store: makeStore([instance]),
  });
  const pkg = service.inventory().packages[0];

  assert.equal(pkg.manifestPresent, true);
  assert.equal(pkg.snapshot.verified, false);
  assert.deepEqual(pkg.declaredVolumes, []);
  assert.deepEqual(pkg.warnings, [
    'Installed package snapshot is missing or invalid; restore compatibility cannot be guaranteed.',
  ]);
});

test('inventory marks snapshot unverified when package digest does not match', () => {
  const { snapshotPath } = setupSnapshot({ id: 'app-1', resources: { services: { app: { dockerfile: 'Dockerfile', internalPort: 8080 } } } });

  const instance = makeInstance({
    packageId: 'app-1',
    packageDigest: 'wrong-digest',
    snapshotState: 'installed',
    snapshotPath,
  });

  const service = new BackupInventoryService({
    stateDir: STATE_DIR,
    store: makeStore([instance]),
  });
  const pkg = service.inventory().packages[0];

  assert.equal(pkg.manifestPresent, true);
  assert.equal(pkg.snapshot.verified, false);
  assert.deepEqual(pkg.warnings, [
    'Installed package snapshot is missing or invalid; restore compatibility cannot be guaranteed.',
  ]);
});

test('inventory aggregates relationship statuses', () => {
  const relationships = [
    { status: 'active' },
    { status: 'active' },
    { status: 'disabled' },
  ];

  const service = new BackupInventoryService({
    stateDir: STATE_DIR,
    store: makeStore([], relationships),
  });
  const result = service.inventory();

  assert.deepEqual(result.relationships, {
    active: 2,
    count: 3,
    statuses: [
      { count: 2, status: 'active' },
      { count: 1, status: 'disabled' },
    ],
  });
  assert.equal(result.summary.relationshipCount, 3);
});

test('inventory reports filesystem path states for contents', () => {
  const root = fs.mkdtempSync(path.join(TEMP_ROOT, 'contents-'));
  const caddyFile = path.join(root, 'Caddyfile');
  fs.writeFileSync(caddyFile, '');
  const caddyDir = path.join(root, 'caddy-conf');
  fs.mkdirSync(caddyDir);
  const missing = path.join(root, 'missing');
  const stateDir = path.join(root, 'state');
  const homepageConfigRoot = path.join(root, 'homepage', 'config');
  fs.mkdirSync(homepageConfigRoot, { recursive: true });

  const service = new BackupInventoryService({
    stateDir,
    homepageConfigRoot,
    caddyFiles: [caddyFile, caddyDir, missing],
    store: makeStore([]),
  });
  const result = service.inventory();

  assert.deepEqual(result.contents.caddyFiles, [
    { exists: true, kind: 'file', path: caddyFile },
    { exists: true, kind: 'directory', path: caddyDir },
    { exists: false, kind: 'missing', path: missing },
  ]);
  assert.equal(result.contents.homepageConfig.path, homepageConfigRoot);
  assert.deepEqual(
    result.contents.homepageConfig.files,
    HOMEPAGE_CONFIG_FILES.map((name) => ({
      exists: false,
      kind: 'missing',
      path: path.join(homepageConfigRoot, name),
    })),
  );
  assert.deepEqual(result.contents.suiteManager, {
    appSecrets: { exists: false, kind: 'missing', path: path.join(stateDir, 'app-secrets') },
    database: { exists: false, kind: 'missing', path: path.join(stateDir, 'suite-manager.sqlite') },
    databaseShm: { exists: false, kind: 'missing', path: path.join(stateDir, 'suite-manager.sqlite-shm') },
    databaseWal: { exists: false, kind: 'missing', path: path.join(stateDir, 'suite-manager.sqlite-wal') },
    stateDir,
  });
});
