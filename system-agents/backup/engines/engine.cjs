// The on-drive layout of backup archives: any number side by side under
// MOS-backups, each a repository, its restore points and a plaintext descriptor.
// A bucket holds one archive per connection; ../destinations.cjs opens both.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ENGINE_MISSING_MESSAGE, ResticEngine } = require('./engine-restic.cjs');

// restic, chosen 2026-09-06 after a measured comparison (docs/decisions.md). Still
// written into every descriptor and manifest so a drive can say what wrote it.
const ENGINE_NAME = 'restic';
const { ARCHIVE_DIR_PATTERN: ARCHIVE_NAME_PATTERN, BACKUPS_DIR: BACKUPS_DIRNAME } = require('../../../shared/storage-contract.cjs');
const REPOSITORY_DIRNAME = 'repository';
const RESTORE_POINTS_DIRNAME = 'restore-points';
const REPOSITORY_SIDECAR_FILENAME = 'MOS-REPOSITORY.json';

function createEngine({ agentStateDir, binaryDir, keys, onKeyUsed } = {}) {
  return new ResticEngine({ agentStateDir, binaryDir, keys, onKeyUsed });
}

function backupsRoot(mountPath) { return path.join(mountPath, BACKUPS_DIRNAME); }
function archiveRoot(mountPath, name) { return path.join(backupsRoot(mountPath), name); }
function repositoryPathFor(root) { return path.join(root, REPOSITORY_DIRNAME); }
function restorePointsDir(root) { return path.join(root, RESTORE_POINTS_DIRNAME); }
function restorePointPath(root, jobId) { return path.join(restorePointsDir(root), `${jobId}.json`); }
function repositorySidecarPath(root) { return path.join(root, REPOSITORY_SIDECAR_FILENAME); }
function repositoryExists(root) { return fs.existsSync(path.join(repositoryPathFor(root), 'config')); }

// The name says nothing about which server owns the archive: the key that opens
// it decides that, and a takeover changes the key, not the name.
function newArchiveName() {
  return `archive-${crypto.randomBytes(4).toString('hex')}`;
}

// Every archive folder with either a descriptor or a repository in it: a torn
// descriptor must not make a full repository invisible.
function archiveNames(mountPath) {
  try {
    return fs.readdirSync(backupsRoot(mountPath), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ARCHIVE_NAME_PATTERN.test(entry.name))
      .filter((entry) => fs.existsSync(repositorySidecarPath(archiveRoot(mountPath, entry.name))) || repositoryExists(archiveRoot(mountPath, entry.name)))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

// Null when the descriptor is missing or will not parse: a stated fact the
// listing carries, never a reason to treat the archive as empty.
function readRepositoryDescriptor(root) {
  try {
    return JSON.parse(fs.readFileSync(repositorySidecarPath(root), 'utf8'));
  } catch {
    return null;
  }
}

// Staged and renamed in the same folder, so exFAT and NTFS never leave half a file.
function writeRepositoryDescriptor(root, descriptor) {
  fs.mkdirSync(root, { recursive: true });
  const staged = `${repositorySidecarPath(root)}.next`;
  fs.writeFileSync(staged, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
  fs.renameSync(staged, repositorySidecarPath(root));
}

// What the archive occupies on disk, without an engine or a key. Restore points
// share deduplicated data, so this is the only additive number there is.
function repositoryUsage(root) {
  const descriptor = readRepositoryDescriptor(root);
  if (!descriptor && !repositoryExists(root)) return null;
  let restorePoints = 0;
  try {
    for (const name of fs.readdirSync(restorePointsDir(root))) {
      if (name.endsWith('.json') && fs.existsSync(path.join(restorePointsDir(root), `${name}.sha256`))) restorePoints += 1;
    }
  } catch {}
  return { engineName: descriptor?.engineName || null, restorePoints, storedBytes: treeBytes(repositoryPathFor(root)) };
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
  createEngine,
  ENGINE_MISSING_MESSAGE,
  ENGINE_NAME,
  newArchiveName,
  readRepositoryDescriptor,
  REPOSITORY_DIRNAME,
  repositoryExists,
  repositoryPathFor,
  repositorySidecarPath,
  repositoryUsage,
  RESTORE_POINTS_DIRNAME,
  restorePointPath,
  restorePointsDir,
  writeRepositoryDescriptor,
};
