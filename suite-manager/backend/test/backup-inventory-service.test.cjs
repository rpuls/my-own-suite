const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const servicePath = require.resolve('../src/backups/backup-inventory-service.cjs');

const dependencyRequests = {
  manifest: '../apps/package-manifest.cjs',
  contracts: '../apps/package-contracts.cjs',
  suite: '../state/suite-manager-store.cjs',
  persistent: '../../../../infrastructure/persistent-state.cjs',
};

function withService(overrides, callback) {
  const resolved = {};
  for (const [name, request] of Object.entries(dependencyRequests)) {
    resolved[name] = require.resolve(request, { paths: [path.dirname(servicePath)] });
  }

  const saved = {};
  for (const [name, resolvedPath] of Object.entries(resolved)) {
    saved[name] = require.cache[resolvedPath];
  }

  const defaults = {
    manifest: {
      readAppPackageManifest() {
        throw new Error('readAppPackageManifest() was called without a test stub');
      },
    },
    contracts: {
      digestAppPackage() {
        return 'digest';
      },
    },
    suite: {
      DATABASE_FILENAME: 'mos.db',
    },
    persistent: {
      appVolumeName(packageId, volumeName) {
        return `${packageId}-${volumeName}`;
      },
    },
  };

  for (const name of Object.keys(dependencyRequests)) {
    const resolvedPath = resolved[name];
    require.cache[resolvedPath] = {
      id: resolvedPath,
      filename: resolvedPath,
      loaded: true,
      exports: {
        ...defaults[name],
        ...(overrides[name] || {}),
      },
    };
  }

  delete require.cache[servicePath];
  const service = require(servicePath);

  try {
    return callback(service);
  } finally {
    delete require.cache[servicePath];
    for (const name of Object.keys(dependencyRequests)) {
      const resolvedPath = resolved[name];
      delete require.cache[resolvedPath];
      if (saved[name]) require.cache[resolvedPath] = saved[name];
    }
  }
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
  withService({}, (module) => {
    assert.deepEqual(module.DEFAULT_CADDY_FILES, [
      '/etc/caddy/Caddyfile',
      '/etc/caddy/mos-homepage-routes.caddy',
      '/etc/caddy/mos-app-routes.caddy',
    ]);
    assert.equal(module.DEFAULT_HTTPS_SECRET_PATH, '/etc/mos/secrets/caddy-cloudflare.env');
    assert.deepEqual(module.HOMEPAGE_CONFIG_FILES, [
      'services.template.yaml',
      'bookmarks.yaml',
      'settings.yaml',
      'widgets.yaml',
      'custom.css',
      'custom.js',
      'images',
    ]);
  });
});

test('uniqueVolumesFor deduplicates volumes and sorts by docker volume name', () => {
  withService(
    { persistent: { appVolumeName: (pkg, volume) => `${pkg}:${volume}` } },
    ({ uniqueVolumesFor }) => {
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
        { declaredName: 'cache', dockerVolume: 'pkg-a:cache', backupClass: 'data', requiredOnRestore: true },
        { declaredName: 'data', dockerVolume: 'pkg-a:data', backupClass: 'data', requiredOnRestore: true },
        { declaredName: 'logs', dockerVolume: 'pkg-a:logs', backupClass: 'data', requiredOnRestore: true },
      ]);
    },
  );
});

test('uniqueVolumesFor ignores empty or malformed volume declarations', () => {
  withService({}, ({ uniqueVolumesFor }) => {
    const manifest = {
      id: 'pkg-empty',
      resources: { services: { app: { volumes: [null, '', ':', '   '] } } },
    };
    assert.deepEqual(uniqueVolumesFor(manifest), []);
  });
});

test('uniqueVolumesFor handles manifests without services', () => {
  withService({}, ({ uniqueVolumesFor }) => {
    assert.deepEqual(uniqueVolumesFor({ id: 'no-services', resources: {} }), []);
  });
});

test('constructor uses MOS_STATE_ROOT when present', () => {
  const previous = process.env.MOS_STATE_ROOT;
  process.env.MOS_STATE_ROOT = '/tmp/mos-state';
  try {
    withService({}, ({ BackupInventoryService }) => {
      const service = new BackupInventoryService({
        stateDir: '/tmp/state/suite-manager',
        store: {},
      });
      assert.equal(service.stateRoot, '/tmp/mos-state');
      assert.equal(
        service.homepageConfigRoot,
        path.join('/tmp/mos-state', 'homepage', 'config'),
      );
    });
  } finally {
    if (previous === undefined) delete process.env.MOS_STATE_ROOT;
    else process.env.MOS_STATE_ROOT = previous;
  }
});

test('constructor defaults stateRoot to parent when stateDir is suite-manager', () => {
  const previous = process.env.MOS_STATE_ROOT;
  delete process.env.MOS_STATE_ROOT;
  try {
    withService({}, ({ BackupInventoryService }) => {
      const service = new BackupInventoryService({
        stateDir: '/tmp/mos/suite-manager',
        store: {},
      });
      assert.equal(service.stateRoot, '/tmp/mos');
    });
  } finally {
    if (previous === undefined) delete process.env.MOS_STATE_ROOT;
    else process.env.MOS_STATE_ROOT = previous;
  }
});

test('constructor resolves stateRoot to parent for non-suite-manager state dirs', () => {
  const previous = process.env.MOS_STATE_ROOT;
  delete process.env.MOS_STATE_ROOT;
  try {
    withService({}, ({ BackupInventoryService }) => {
      const service = new BackupInventoryService({
        stateDir: '/tmp/mos/state-dir',
        store: {},
      });
      assert.equal(service.stateRoot, '/tmp/mos');
    });
  } finally {
    if (previous === undefined) delete process.env.MOS_STATE_ROOT;
    else process.env.MOS_STATE_ROOT = previous;
  }
});

test('constructor applies default caddy and secret paths', () => {
  withService(
    {},
    ({ BackupInventoryService, DEFAULT_CADDY_FILES, DEFAULT_HTTPS_SECRET_PATH }) => {
      const service = new BackupInventoryService({ stateDir: '/tmp/mos', store: {} });
      assert.deepEqual(service.caddyFiles, DEFAULT_CADDY_FILES);
      assert.equal(service.httpsSecretPath, DEFAULT_HTTPS_SECRET_PATH);
    },
  );
});

test('inventory summarizes an empty store', () => {
  withService({}, ({ BackupInventoryService }) => {
    const service = new BackupInventoryService({
      stateDir: '/tmp/empty-state',
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
});

test('inventory reports missing snapshot warnings for uninstalled snapshot states', () => {
  const instance = makeInstance({
    id: 'inst-1',
    packageId: 'app-1',
    snapshotState: 'missing',
    snapshotPath: '/does/not/exist',
  });

  withService({}, ({ BackupInventoryService }) => {
    const service = new BackupInventoryService({
      stateDir: '/tmp/state',
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
});

test('inventory treats manifest read failures as invalid snapshots', () => {
  const instance = makeInstance({
    packageId: 'app-1',
    snapshotState: 'installed',
    snapshotPath: '/snap/app-1',
  });

  withService(
    {
      manifest: {
        readAppPackageManifest() {
          throw new Error('boom');
        },
      },
    },
    ({ BackupInventoryService }) => {
      const service = new BackupInventoryService({
        stateDir: '/tmp/state',
        store: makeStore([instance]),
      });
      const result = service.inventory();

      assert.equal(result.packages[0].manifestPresent, false);
      assert.equal(result.packages[0].snapshot.verified, false);
      assert.deepEqual(result.packages[0].declaredVolumes, []);
      assert.equal(result.summary.warningCount, 1);
    },
  );
});

test('inventory maps a verified installed package and its declared volumes', () => {
  const instance = makeInstance({
    packageId: 'app-1',
    manifestDigest: 'manifest-digest-1',
    packageDigest: 'package-digest-1',
    snapshotPath: '/snap/app-1',
    snapshotState: 'installed',
  });

  withService(
    {
      manifest: {
        readAppPackageManifest(snapshotPath) {
          assert.equal(snapshotPath, '/snap/app-1');
          return {
            manifest: {
              id: 'app-1',
              resources: { services: { app: { volumes: ['data:/data'] } } },
            },
          };
        },
      },
      contracts: {
        digestAppPackage(snapshotPath) {
          assert.equal(snapshotPath, '/snap/app-1');
          return 'package-digest-1';
        },
      },
      persistent: {
        appVolumeName: (pkg, volume) => `${pkg}:${volume}`,
      },
    },
    ({ BackupInventoryService }) => {
      const service = new BackupInventoryService({
        stateDir: '/tmp/state',
        store: makeStore([instance]),
      });
      const result = service.inventory();

      assert.equal(result.packages.length, 1);
      const pkg = result.packages[0];
      assert.equal(pkg.manifestPresent, true);
      assert.equal(pkg.snapshot.verified, true);
      assert.deepEqual(pkg.declaredVolumes, [
        { declaredName: 'data', dockerVolume: 'app-1:data', backupClass: 'data', requiredOnRestore: true },
      ]);
      assert.deepEqual(pkg.warnings, [
        'Package declares volumes but no explicit backup metadata yet.',
      ]);
      assert.equal(result.summary.declaredVolumeCount, 1);
      assert.equal(result.summary.warningCount, 1);
      assert.deepEqual(result.packageManifestDigests, [
        { digest: 'manifest-digest-1', packageId: 'app-1', version: '1.0.0' },
      ]);
    },
  );
});

test('inventory marks snapshot unverified when manifest id does not match package id', () => {
  const instance = makeInstance({
    packageId: 'app-1',
    snapshotState: 'installed',
    snapshotPath: '/snap/app-1',
  });

  withService(
    {
      manifest: {
        readAppPackageManifest() {
          return { manifest: { id: 'app-2', resources: { services: {} } } };
        },
      },
      contracts: {
        digestAppPackage() {
          return 'package-digest-1';
        },
      },
    },
    ({ BackupInventoryService }) => {
      const service = new BackupInventoryService({
        stateDir: '/tmp/state',
        store: makeStore([instance]),
      });
      const pkg = service.inventory().packages[0];

      assert.equal(pkg.manifestPresent, true);
      assert.equal(pkg.snapshot.verified, false);
      assert.deepEqual(pkg.declaredVolumes, []);
      assert.deepEqual(pkg.warnings, [
        'Installed package snapshot is missing or invalid; restore compatibility cannot be guaranteed.',
      ]);
    },
  );
});

test('inventory marks snapshot unverified when package digest does not match', () => {
  const instance = makeInstance({
    packageId: 'app-1',
    packageDigest: 'expected-digest',
    snapshotState: 'installed',
    snapshotPath: '/snap/app-1',
  });

  withService(
    {
      manifest: {
        readAppPackageManifest() {
          return { manifest: { id: 'app-1', resources: { services: {} } } };
        },
      },
      contracts: {
        digestAppPackage() {
          return 'wrong-digest';
        },
      },
    },
    ({ BackupInventoryService }) => {
      const service = new BackupInventoryService({
        stateDir: '/tmp/state',
        store: makeStore([instance]),
      });
      const pkg = service.inventory().packages[0];

      assert.equal(pkg.manifestPresent, true);
      assert.equal(pkg.snapshot.verified, false);
      assert.deepEqual(pkg.warnings, [
        'Installed package snapshot is missing or invalid; restore compatibility cannot be guaranteed.',
      ]);
    },
  );
});

test('inventory aggregates relationship statuses', () => {
  const relationships = [
    { status: 'active' },
    { status: 'active' },
    { status: 'disabled' },
  ];

  withService({}, ({ BackupInventoryService }) => {
    const service = new BackupInventoryService({
      stateDir: '/tmp/state',
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
});

test('inventory reports filesystem path states for contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-inventory-'));
  try {
    const caddyFile = path.join(root, 'Caddyfile');
    fs.writeFileSync(caddyFile, '');
    const caddyDir = path.join(root, 'caddy-conf');
    fs.mkdirSync(caddyDir);
    const missing = path.join(root, 'missing');
    const stateDir = path.join(root, 'state');
    const homepageConfigRoot = path.join(root, 'homepage', 'config');
    fs.mkdirSync(homepageConfigRoot, { recursive: true });

    withService(
      { suite: { DATABASE_FILENAME: 'suite.db' } },
      ({ BackupInventoryService, HOMEPAGE_CONFIG_FILES }) => {
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
          database: { exists: false, kind: 'missing', path: path.join(stateDir, 'suite.db') },
          databaseShm: { exists: false, kind: 'missing', path: path.join(stateDir, 'suite.db-shm') },
          databaseWal: { exists: false, kind: 'missing', path: path.join(stateDir, 'suite.db-wal') },
          stateDir,
        });
      },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});