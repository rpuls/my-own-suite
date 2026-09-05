// Canonical persistent-state contract for MOS backup and recovery.
//
// This module is the single answer to "what state does MOS own, and how is it
// recognized?". The backup agent, the apps agent, and Suite Manager all derive
// resource names, ownership labels, and backup coverage from here so that a
// new app or feature participates in recovery by declaration alone — never by
// adding backup code.
//
// State classes:
// - authoritative-persistent: cannot be regenerated; the backup payload.
// - reproducible-software:    recreatable from recorded identities; carried in
//                             bundles only so restore does not depend on any
//                             remote being reachable.
// - generated-runtime:        projections (containers, routes, Homepage
//                             entries); restore rebuilds and verifies them.
// - machine-local:            policy or scratch state that stays with the
//                             machine (agent journals, rescue copies, claim
//                             tokens).
// - excluded:                 regenerable caches never worth carrying.

const APP_VOLUME_PREFIX = 'mos-app-';
const SUITE_MANAGER_DATABASE_FILENAME = 'suite-manager.sqlite';

// Docker object labels that mark a resource as MOS-owned. `owned` is the
// authoritative marker; `resource` is the stable logical identity; `package`
// and `instance` tie the resource to the installation that created it so a
// later installation can never silently adopt another installation's data.
const OWNERSHIP_LABELS = Object.freeze({
  instance: 'mos.instance',
  owned: 'mos.owned',
  package: 'mos.package',
  resource: 'mos.resource',
});

// Backup schema. Version 3 adds the owned-resource inventory, ownership
// evidence, and space accounting. Version 4 replaces the per-backup tar
// bundle with snapshots in an encrypted, deduplicating repository on the
// destination, so it records snapshot ids where 3 recorded archive paths and
// digests. Restore accepts the declared window only; anything else must fail
// validation before any mutation. Versions 2 and 3 stay in the window because
// existing installs have those bundles on their drives.
const BACKUP_SCHEMA_VERSION = 4;
const RESTORE_COMPATIBLE_SCHEMA_VERSIONS = Object.freeze([2, 3, 4]);

// Beta ceiling for total raw authoritative state in one bundle. Deliberately
// conservative: the streaming and space-accounting behavior beyond this size
// is unproven, and a refused backup is safer than an unrestorable one.
const BACKUP_BETA_MAX_TOTAL_BYTES = 256 * 1024 * 1024 * 1024;

function appVolumeName(packageId, volumeName) {
  return `${APP_VOLUME_PREFIX}${packageId}-${volumeName}`;
}

function appVolumeLabels({ instanceId, name, packageId }) {
  const labels = {
    [OWNERSHIP_LABELS.owned]: 'true',
    [OWNERSHIP_LABELS.resource]: `docker-volume:${name}`,
  };
  if (packageId) labels[OWNERSHIP_LABELS.package] = packageId;
  if (instanceId) labels[OWNERSHIP_LABELS.instance] = instanceId;
  return labels;
}

// Ownership evidence for one Docker volume, strongest first:
// - labeled: carries the MOS ownership label written at creation.
// - derived: unlabeled (created before labeling existed) but named
//   `mos-app-<packageId>-…` for a package this installation or the backup
//   being restored actually knows.
// - ambiguous: wears the prefix but matches no known package. Reported, never
//   destructively touched — a bare name prefix is not authority.
function volumeOwnership(volume, knownPackageIds) {
  const labels = volume.labels || {};
  if (labels[OWNERSHIP_LABELS.owned] === 'true') {
    return {
      instanceId: labels[OWNERSHIP_LABELS.instance] || null,
      ownership: 'labeled',
      packageId: labels[OWNERSHIP_LABELS.package] || null,
    };
  }
  if (!String(volume.name || '').startsWith(APP_VOLUME_PREFIX)) return null;
  for (const packageId of knownPackageIds || []) {
    if (volume.name.startsWith(`${APP_VOLUME_PREFIX}${packageId}-`)) {
      return { instanceId: null, ownership: 'derived', packageId };
    }
  }
  return { instanceId: null, ownership: 'ambiguous', packageId: null };
}

function classifyVolumes(volumes, knownPackageIds) {
  const ambiguous = [];
  const owned = [];
  for (const volume of volumes || []) {
    const evidence = volumeOwnership(volume, knownPackageIds);
    if (!evidence) continue;
    if (evidence.ownership === 'ambiguous') ambiguous.push(volume.name);
    else owned.push({ instanceId: evidence.instanceId, name: volume.name, ownership: evidence.ownership, packageId: evidence.packageId });
  }
  return {
    ambiguous: ambiguous.sort(),
    owned: owned.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

// The complete classification of MOS-managed state on a host. Entries with
// `backedUp: true` and a `stagePath` are staged into the bundle's state tree
// at that relative path and restored back to `path`; the backup engine stages
// exactly this list, so adding a managed location means adding an entry here,
// not editing engine code. Volumes are enumerated dynamically via
// `classifyVolumes` and appear here as the contract entry `app-volumes`.
function managedStateTargets({ caddyDir = '/etc/caddy', secretsDir = '/etc/mos/secrets', stateDir, stateRoot }) {
  return [
    {
      backedUp: true,
      class: 'authoritative-persistent',
      // The SQLite database is excluded from the tree copy and captured as a
      // consistent snapshot instead; the candidate cache is regenerable.
      exclude: ['app-candidates', SUITE_MANAGER_DATABASE_FILENAME, `${SUITE_MANAGER_DATABASE_FILENAME}-shm`, `${SUITE_MANAGER_DATABASE_FILENAME}-wal`],
      id: 'suite-manager-state',
      kind: 'directory',
      path: stateDir,
      sqliteDatabase: SUITE_MANAGER_DATABASE_FILENAME,
      stagePath: 'var-lib-mos/suite-manager',
    },
    {
      backedUp: true,
      class: 'reproducible-software',
      id: 'app-package-snapshots',
      kind: 'directory',
      path: `${stateRoot}/app-packages`,
      stagePath: 'var-lib-mos/app-packages',
    },
    {
      backedUp: true,
      class: 'authoritative-persistent',
      id: 'homepage-config',
      kind: 'directory',
      path: `${stateRoot}/homepage/config`,
      stagePath: 'var-lib-mos/homepage/config',
    },
    ...['Caddyfile', 'mos-homepage-routes.caddy', 'mos-app-routes.caddy'].map((file) => ({
      backedUp: true,
      class: 'generated-runtime',
      id: `caddy-${file}`,
      kind: 'file',
      // Regenerated by reconciliation; carried so a restored machine serves
      // routes before its first reconcile, then overwritten by regeneration.
      path: `${caddyDir}/${file}`,
      stagePath: `etc/caddy/${file}`,
    })),
    {
      backedUp: true,
      class: 'authoritative-persistent',
      id: 'https-provider-secret',
      kind: 'file',
      path: `${secretsDir}/caddy-cloudflare.env`,
      stagePath: 'etc/mos/secrets/caddy-cloudflare.env',
    },
    {
      backedUp: true,
      class: 'authoritative-persistent',
      id: 'app-volumes',
      kind: 'docker-volumes',
      path: `docker-volume:${APP_VOLUME_PREFIX}*`,
    },
    {
      backedUp: false,
      class: 'machine-local',
      id: 'agent-state',
      kind: 'directory',
      path: `${stateRoot}/{backup,https,homepage,update}-agent`,
    },
    {
      backedUp: false,
      class: 'machine-local',
      id: 'owner-claim-secret',
      kind: 'file',
      path: `${secretsDir}/owner-claim.env`,
    },
    {
      backedUp: false,
      class: 'excluded',
      id: 'app-candidate-cache',
      kind: 'directory',
      path: `${stateDir}/app-candidates`,
    },
    {
      backedUp: false,
      class: 'generated-runtime',
      id: 'docker-runtime',
      kind: 'docker-objects',
      path: 'docker:containers,images,networks',
    },
  ];
}

module.exports = {
  APP_VOLUME_PREFIX,
  appVolumeLabels,
  appVolumeName,
  BACKUP_BETA_MAX_TOTAL_BYTES,
  BACKUP_SCHEMA_VERSION,
  classifyVolumes,
  managedStateTargets,
  OWNERSHIP_LABELS,
  RESTORE_COMPATIBLE_SCHEMA_VERSIONS,
  SUITE_MANAGER_DATABASE_FILENAME,
  volumeOwnership,
};
