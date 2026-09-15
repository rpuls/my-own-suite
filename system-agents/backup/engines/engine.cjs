// The on-destination layout that surrounds a repository on a drive.
//
// MOS has one backup storage engine: restic, chosen 2026-09-06 after a
// 15.4 GB measured comparison against Kopia on the lab VM (docs/decisions.md
// records the numbers). The engine name is still written into every
// destination's descriptor and every manifest, because a drive has to be able
// to say what wrote it.
//
// Object-storage destinations reuse the same names inside a bucket but have no
// files beside the repository; how a destination of either kind is opened and
// what its restore points look like lives in ../destinations.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { ENGINE_MISSING_MESSAGE, ResticEngine } = require('./engine-restic.cjs');

const ENGINE_NAME = 'restic';
const BACKUPS_DIRNAME = 'MOS-backups';
const REPOSITORY_DIRNAME = 'repository';
const RESTORE_POINTS_DIRNAME = 'restore-points';
const REPOSITORY_SIDECAR_FILENAME = 'MOS-REPOSITORY.json';

function createEngine({ agentStateDir, binaryDir, keyFile, onKeyUsed } = {}) {
  return new ResticEngine({ agentStateDir, binaryDir, keyFile, onKeyUsed });
}

function backupsRoot(destinationId) { return path.join(destinationId, BACKUPS_DIRNAME); }
function repositoryPathFor(destinationId) { return path.join(backupsRoot(destinationId), REPOSITORY_DIRNAME); }
function restorePointsDir(destinationId) { return path.join(backupsRoot(destinationId), RESTORE_POINTS_DIRNAME); }
function restorePointPath(destinationId, jobId) { return path.join(restorePointsDir(destinationId), `${jobId}.json`); }
function repositorySidecarPath(destinationId) { return path.join(backupsRoot(destinationId), REPOSITORY_SIDECAR_FILENAME); }

// A plaintext description of what the repository directory is, so a listing
// can name the storage without invoking the engine, and a destination written
// in a storage format this MOS does not speak is refused rather than corrupted.
function readRepositoryDescriptor(destinationId) {
  try {
    return JSON.parse(fs.readFileSync(repositorySidecarPath(destinationId), 'utf8'));
  } catch {
    return null;
  }
}

function writeRepositoryDescriptor(destinationId, descriptor) {
  fs.mkdirSync(backupsRoot(destinationId), { recursive: true });
  fs.writeFileSync(repositorySidecarPath(destinationId), `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
}

// What the encrypted store on a destination actually occupies, from the
// filesystem alone — no engine invocation, no key. Restore points share the
// repository's deduplicated data, so per-point data sizes must never be read
// as additive; this is the one number that says what the drive really carries.
function repositoryUsage(destinationId) {
  const descriptor = readRepositoryDescriptor(destinationId);
  if (!descriptor) return null;
  let restorePoints = 0;
  try {
    for (const name of fs.readdirSync(restorePointsDir(destinationId))) {
      if (name.endsWith('.json') && fs.existsSync(path.join(restorePointsDir(destinationId), `${name}.sha256`))) restorePoints += 1;
    }
  } catch {}
  return { engineName: descriptor.engineName || null, restorePoints, storedBytes: treeBytes(repositoryPathFor(destinationId)) };
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

function assertRepositoryEngine(destinationId, engineName) {
  const descriptor = readRepositoryDescriptor(destinationId);
  if (!descriptor || descriptor.engineName === engineName) return descriptor;
  throw new Error(`This drive already holds a backup repository in a different storage format (${descriptor.engineName}). Use a different drive, or restore what is on this one before reusing it.`);
}

module.exports = {
  assertRepositoryEngine,
  BACKUPS_DIRNAME,
  backupsRoot,
  createEngine,
  ENGINE_MISSING_MESSAGE,
  ENGINE_NAME,
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
