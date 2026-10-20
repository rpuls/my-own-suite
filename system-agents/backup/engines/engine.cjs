// The on-drive layout of backup archives.
//
// MOS has one backup storage engine: restic, chosen 2026-09-06 after a
// 15.4 GB measured comparison against Kopia on the lab VM (docs/decisions.md
// records the numbers). The engine name is still written into every archive's
// descriptor and every manifest, because a drive has to be able to say what
// wrote it.
//
// A drive holds any number of archives side by side, one folder each under
// MOS-backups: this server's own, and archives other servers made. Each is a
// repository, its restore points, and a plaintext descriptor. A bucket holds
// one archive per connection and has no files beside the repository; how
// either is opened lives in ../destinations.cjs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ENGINE_MISSING_MESSAGE, ResticEngine } = require('./engine-restic.cjs');

const ENGINE_NAME = 'restic';
const { BACKUPS_DIR: BACKUPS_DIRNAME } = require('../../../shared/storage-contract.cjs');
const REPOSITORY_DIRNAME = 'repository';
const RESTORE_POINTS_DIRNAME = 'restore-points';
const REPOSITORY_SIDECAR_FILENAME = 'MOS-REPOSITORY.json';
const ARCHIVE_NAME_PATTERN = /^archive-[0-9a-f]{8}$/u;

function createEngine({ agentStateDir, binaryDir, keys, onKeyUsed } = {}) {
  return new ResticEngine({ agentStateDir, binaryDir, keys, onKeyUsed });
}

function backupsRoot(mountPath) { return path.join(mountPath, BACKUPS_DIRNAME); }
function archiveRoot(mountPath, name) { return path.join(backupsRoot(mountPath), name); }
function repositoryPathFor(root) { return path.join(root, REPOSITORY_DIRNAME); }
function restorePointsDir(root) { return path.join(root, RESTORE_POINTS_DIRNAME); }
function restorePointPath(root, jobId) { return path.join(restorePointsDir(root), `${jobId}.json`); }
function repositorySidecarPath(root) { return path.join(root, REPOSITORY_SIDECAR_FILENAME); }

// A name that is the archive's own and says nothing about which server owns
// it: that is decided by which key opens it, and a takeover changes it.
function newArchiveName() {
  return `archive-${crypto.randomBytes(4).toString('hex')}`;
}

// The archives on a drive, by folder name: every folder MOS wrote a
// descriptor into.
function archiveNames(mountPath) {
  try {
    return fs.readdirSync(backupsRoot(mountPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ARCHIVE_NAME_PATTERN.test(entry.name) && fs.existsSync(repositorySidecarPath(archiveRoot(mountPath, entry.name))))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// A plaintext description of what the archive folder is, so a listing can name
// it and say which server made it without invoking the engine, and an archive
// in a storage format this MOS does not speak is refused rather than corrupted.
function readRepositoryDescriptor(root) {
  try {
    return JSON.parse(fs.readFileSync(repositorySidecarPath(root), 'utf8'));
  } catch {
    return null;
  }
}

function writeRepositoryDescriptor(root, descriptor) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(repositorySidecarPath(root), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
}

// What an archive actually occupies, from the filesystem alone — no engine
// invocation, no key. Restore points share the repository's deduplicated data,
// so per-point data sizes must never be read as additive; this is the one
// number that says what the drive really carries for it.
function repositoryUsage(root) {
  const descriptor = readRepositoryDescriptor(root);
  if (!descriptor) return null;
  let restorePoints = 0;
  try {
    for (const name of fs.readdirSync(restorePointsDir(root))) {
      if (name.endsWith('.json') && fs.existsSync(path.join(restorePointsDir(root), `${name}.sha256`))) restorePoints += 1;
    }
  } catch {}
  return { engineName: descriptor.engineName || null, restorePoints, storedBytes: treeBytes(repositoryPathFor(root)) };
}

function treeBytes(root) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const absolute = path.join(root, entry.name);
      if (entry.isDirectory()) total += treeBytes(absolute);
      else if (entry.isFile()) total += fs.statSync(absolute).size;
    }
  } catch {}
  return total;
}

function assertRepositoryEngine(root, engineName) {
  const descriptor = readRepositoryDescriptor(root);
  if (!descriptor || descriptor.engineName === engineName) return descriptor;
  throw new Error(`This archive is in a different storage format (${descriptor.engineName}), which this MOS cannot read.`);
}

module.exports = {
  ARCHIVE_NAME_PATTERN,
  archiveNames,
  archiveRoot,
  assertRepositoryEngine,
  BACKUPS_DIRNAME,
  backupsRoot,
  createEngine,
  ENGINE_MISSING_MESSAGE,
  ENGINE_NAME,
  newArchiveName,
  readRepositoryDescriptor,
  REPOSITORY_DIRNAME,
  repositoryPathFor,
  repositorySidecarPath,
  repositoryUsage,
  RESTORE_POINTS_DIRNAME,
  restorePointPath,
  restorePointsDir,
  writeRepositoryDescriptor,
};
