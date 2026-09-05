// Engine selection and the on-destination layout that surrounds a repository.
//
// The selection below is deliberately a plain branch. Both engines exist only
// until MOS picks one; this is not a plugin seam and must not grow into a
// registry.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { KopiaEngine } = require('./engine-kopia.cjs');
const { ResticEngine } = require('./engine-restic.cjs');

const ENGINE_NAMES = Object.freeze(['kopia', 'restic']);
// Provisional default, chosen 2026-09-05 on the lab measurements: restic used
// less peak memory on every operation — the axis named in advance as able to
// decide this — with equal or better fidelity. Reversing it is this one line
// while both engines exist; the scale rerun in the morning brief is what
// confirms or reverses it before the losing engine is deleted.
const DEFAULT_ENGINE_NAME = 'restic';
const BACKUPS_DIRNAME = 'MOS-backups';
const REPOSITORY_DIRNAME = 'repository';
const RESTORE_POINTS_DIRNAME = 'restore-points';
const REPOSITORY_SIDECAR_FILENAME = 'MOS-REPOSITORY.json';

function engineNameFromEnv(env = process.env) {
  const configured = String(env.MOS_BACKUP_ENGINE || '').trim().toLowerCase();
  if (!configured) return DEFAULT_ENGINE_NAME;
  if (!ENGINE_NAMES.includes(configured)) throw new Error(`MOS_BACKUP_ENGINE must be one of ${ENGINE_NAMES.join(', ')}.`);
  return configured;
}

function createEngine({ agentStateDir, binaryDir, keyFile, name = DEFAULT_ENGINE_NAME } = {}) {
  const options = { agentStateDir, binaryDir, keyFile };
  if (name === 'restic') return new ResticEngine(options);
  if (name === 'kopia') return new KopiaEngine(options);
  throw new Error(`Unknown backup storage engine "${name}".`);
}

function backupsRoot(destinationId) { return path.join(destinationId, BACKUPS_DIRNAME); }
function repositoryPathFor(destinationId) { return path.join(backupsRoot(destinationId), REPOSITORY_DIRNAME); }
function restorePointsDir(destinationId) { return path.join(backupsRoot(destinationId), RESTORE_POINTS_DIRNAME); }
function restorePointPath(destinationId, jobId) { return path.join(restorePointsDir(destinationId), `${jobId}.json`); }
function repositorySidecarPath(destinationId) { return path.join(backupsRoot(destinationId), REPOSITORY_SIDECAR_FILENAME); }

// A plaintext description of what the repository directory is, so a listing
// can name the storage without invoking an engine and a destination written by
// one engine is refused rather than corrupted by the other.
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

// Opens the destination's repository, creating it and its description on first
// use. Mixed-format destinations are refused before the engine is invoked.
//
// `create` is false everywhere a repository is being read rather than written.
// Without it, reading a restore point from a drive whose store was deleted
// would quietly create an empty one and fail later with something unrelated,
// instead of saying the store is gone.
async function openDestinationRepository(engine, destinationId, { create = true } = {}) {
  assertRepositoryEngine(destinationId, engine.name);
  const repositoryPath = repositoryPathFor(destinationId);
  if (!create && !engine.repositoryInitialized(repositoryPath)) {
    throw new Error('The encrypted backup store is missing from this drive, so this backup cannot be read. Check that the right drive is connected and that its MOS-backups folder is intact.');
  }
  // The description goes down before the repository is created: a crash
  // between the two leaves a described-but-empty destination that the same
  // engine quietly finishes creating next time, while the wrong-engine
  // refusal above is armed the whole way. The other order leaves a repository
  // no descriptor guards.
  if (!readRepositoryDescriptor(destinationId)) {
    writeRepositoryDescriptor(destinationId, {
      createdAt: new Date().toISOString(),
      engineName: engine.name,
      format: 'Encrypted, deduplicating content-addressed repository. Restoring it needs MOS and this repository password.',
      repositoryId: crypto.randomUUID(),
    });
  }
  const repository = await engine.openOrCreateRepository({ repositoryPath });
  return { ...repository, descriptor: readRepositoryDescriptor(destinationId), destinationId };
}

module.exports = {
  assertRepositoryEngine,
  BACKUPS_DIRNAME,
  backupsRoot,
  createEngine,
  DEFAULT_ENGINE_NAME,
  ENGINE_NAMES,
  engineNameFromEnv,
  openDestinationRepository,
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
