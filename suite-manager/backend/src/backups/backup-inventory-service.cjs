const fs = require('node:fs');
const path = require('node:path');

const { DATABASE_FILENAME } = require('../state/suite-manager-store.cjs');
const { readAppPackageManifest } = require('../apps/package-manifest.cjs');
const { digestAppPackage } = require('../apps/package-contracts.cjs');

const DEFAULT_CADDY_FILES = [
  '/etc/caddy/Caddyfile',
  '/etc/caddy/mos-homepage-routes.caddy',
  '/etc/caddy/mos-app-routes.caddy',
];
const DEFAULT_HTTPS_SECRET_PATH = '/etc/mos/secrets/caddy-cloudflare.env';
const HOMEPAGE_CONFIG_FILES = [
  'services.template.yaml',
  'bookmarks.yaml',
  'settings.yaml',
  'widgets.yaml',
  'custom.css',
  'custom.js',
  'images',
];

function pathState(target) {
  try {
    const stat = fs.statSync(target);
    return {
      exists: true,
      kind: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      path: target,
    };
  } catch {
    return {
      exists: false,
      kind: 'missing',
      path: target,
    };
  }
}

function declaredVolumeName(packageId, volumeDeclaration) {
  const source = String(volumeDeclaration || '').split(':')[0].trim();
  if (!source) return null;
  return {
    declaredName: source,
    dockerVolume: `mos-app-${packageId}-${source}`,
    backupClass: 'data',
    requiredOnRestore: true,
  };
}

function uniqueVolumesFor(manifest) {
  const byName = new Map();
  for (const service of Object.values(manifest.resources?.services || {})) {
    for (const declaration of service.volumes || []) {
      const volume = declaredVolumeName(manifest.id, declaration);
      if (volume) byName.set(volume.dockerVolume, volume);
    }
  }
  return [...byName.values()].sort((left, right) => left.dockerVolume.localeCompare(right.dockerVolume));
}

function defaultStateRoot(stateDir) {
  if (process.env.MOS_STATE_ROOT) return process.env.MOS_STATE_ROOT;
  if (path.basename(stateDir) === 'suite-manager') return path.dirname(stateDir);
  return path.resolve(stateDir, '..');
}

class BackupInventoryService {
  constructor({
    appsDir,
    caddyFiles = DEFAULT_CADDY_FILES,
    homepageConfigRoot = null,
    httpsSecretPath = DEFAULT_HTTPS_SECRET_PATH,
    stateDir,
    stateRoot = null,
    store,
  }) {
    this.appsDir = appsDir;
    this.caddyFiles = caddyFiles;
    this.httpsSecretPath = httpsSecretPath;
    this.stateDir = stateDir;
    this.stateRoot = stateRoot || defaultStateRoot(stateDir);
    this.homepageConfigRoot = homepageConfigRoot || path.join(this.stateRoot, 'homepage', 'config');
    this.store = store;
  }

  inventory() {
    const installed = this.store.getAppInstances();
    const relationships = this.store.getAppIntegrations();
    const packages = installed.map((instance) => {
      let manifest = null;
      let snapshotVerified = false;
      if (instance.snapshotState === 'installed' && instance.snapshotPath) {
        try {
          manifest = readAppPackageManifest(instance.snapshotPath).manifest;
          snapshotVerified = manifest.id === instance.packageId && digestAppPackage(instance.snapshotPath) === instance.packageDigest;
        } catch {}
      }
      const declaredVolumes = manifest ? uniqueVolumesFor(manifest) : [];
      return {
        declaredVolumes,
        instanceId: instance.id,
        installedAt: instance.installedAt,
        manifestDigest: instance.manifestDigest,
        manifestPresent: Boolean(manifest),
        packageDigest: instance.packageDigest,
        packageId: instance.packageId,
        packageVersion: instance.packageVersion,
        snapshot: { path: instance.snapshotPath, state: instance.snapshotState, verified: snapshotVerified },
        source: {
          kind: instance.sourceKind,
          path: instance.sourcePath,
          repository: instance.sourceRepository,
          revision: instance.sourceRevision,
          trust: instance.sourceTrust,
        },
        status: instance.status,
        warnings: [
          ...(snapshotVerified ? [] : ['Installed package snapshot is missing or invalid; restore compatibility cannot be guaranteed.']),
          ...(declaredVolumes.length > 0 ? ['Package declares volumes but no explicit backup metadata yet.'] : []),
        ],
      };
    });
    const warningDetails = packages.flatMap((item) => item.warnings.map((message) => ({
      packageId: item.packageId,
      message,
    })));

    return {
      actions: {
        backupEnabled: false,
        backupLabel: 'Back up everything',
        backupReason: 'MOS backup inventory is ready, but archive and restore jobs wait for a MOS backup agent.',
        restoreEnabled: false,
      },
      checkedAt: new Date().toISOString(),
      contents: {
        caddyFiles: this.caddyFiles.map(pathState),
        homepageConfig: {
          files: HOMEPAGE_CONFIG_FILES.map((name) => pathState(path.join(this.homepageConfigRoot, name))),
          path: this.homepageConfigRoot,
        },
        httpsSecret: pathState(this.httpsSecretPath),
        suiteManager: {
          appSecrets: pathState(path.join(this.stateDir, 'app-secrets')),
          database: pathState(path.join(this.stateDir, DATABASE_FILENAME)),
          databaseShm: pathState(path.join(this.stateDir, `${DATABASE_FILENAME}-shm`)),
          databaseWal: pathState(path.join(this.stateDir, `${DATABASE_FILENAME}-wal`)),
          stateDir: this.stateDir,
        },
      },
      destinationModel: {
        preferred: ['Connected USB or external drive', 'Local disk path reserved for MOS backups'],
        status: 'planned',
        summary: 'The MOS backup agent will discover mounted storage and mountable USB drives before archive jobs are enabled.',
      },
      packages,
      relationships: {
        active: relationships.filter((relationship) => relationship.status === 'active').length,
        count: relationships.length,
        statuses: Object.entries(relationships.reduce((totals, relationship) => {
          totals[relationship.status] = (totals[relationship.status] || 0) + 1;
          return totals;
        }, {})).map(([status, count]) => ({ count, status })),
      },
      summary: {
        appCount: installed.length,
        declaredVolumeCount: packages.reduce((total, item) => total + item.declaredVolumes.length, 0),
        relationshipCount: relationships.length,
        warningCount: warningDetails.length,
      },
      warnings: warningDetails,
      packageManifestDigests: packages.filter((item) => item.snapshot.verified).map((item) => ({
        digest: item.manifestDigest,
        packageId: item.packageId,
        version: item.packageVersion,
      })),
    };
  }
}

module.exports = {
  BackupInventoryService,
  DEFAULT_CADDY_FILES,
  DEFAULT_HTTPS_SECRET_PATH,
  HOMEPAGE_CONFIG_FILES,
  uniqueVolumesFor,
};
