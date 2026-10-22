// What a backup archive is, wherever it is kept: one encrypted repository and its
// restore points. A drive holds any number side by side, a bucket connection one;
// everything above this file asks both the same questions.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { STORAGE_MOUNT_ROOT } = require('../../shared/storage-contract.cjs');
const {
  ARCHIVE_NAME_PATTERN,
  archiveNames,
  archiveRoot,
  assertRepositoryEngine,
  BACKUPS_DIRNAME,
  newArchiveName,
  readRepositoryDescriptor,
  repositoryExists,
  repositoryPathFor,
  restorePointPath,
  restorePointsDir,
  writeRepositoryDescriptor,
} = require('./engines/engine.cjs');
const { isObjectDestinationId, objectRepositorySpec } = require('./object-destinations.cjs');

const MANIFEST_FILENAME = 'manifest.json';
const NOTE_FILENAME = 'note.txt';
const ROLE_MANIFEST = 'manifest';
const ROLE_NOTE = 'note';
const OBJECT_LOCATOR_SEPARATOR = '#';
// How long a bucket's index of its own restore points is trusted without asking
// again; only a second machine writing into the same bucket could stale it sooner.
const OBJECT_INDEX_TTL_MS = 120_000;
const OBJECT_INDEX_DIRNAME = 'object-index';
const DRIVE_DISCONNECTED = 'The selected backup drive is not mounted anymore. Reconnect it and try again.';
const DRIVE_ID_PATTERN = /^[A-Za-z0-9-]{4,64}$/u;

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// The engine returns a locked repository rather than throwing, because the screen
// offers a recovery key for it; every caller about to use one stops here instead.
function assertRepositoryUnlocked(repository) {
  if (!repository?.locked) return;
  throw Object.assign(new Error(repository.lockedMessage), { repositoryLocked: true });
}

// Backups are only ever written under this server's own key, or the owner's one
// recovery key would no longer open everything this server made.
const OTHER_SERVERS_BUCKET = 'This bucket holds backups another server made, so this server cannot back up to it. Connect another folder of it, or choose another place.';

function otherServersRefusal(message = 'Those backups belong to another server, so this server does not write into them.') {
  return Object.assign(new Error(message), { code: 'DESTINATION_FOREIGN' });
}

// Whose key opens an archive: `own` this server's, `borrowed` another server's
// key entered here, `locked` none MOS holds, `empty` nothing written yet.
function keyStateOf(probeState, borrowed) {
  if (probeState === 'locked') return 'locked';
  if (probeState === 'absent') return 'empty';
  return borrowed ? 'borrowed' : 'own';
}

// Hashed in chunks: volume archives are multi-gigabyte.
function sha256(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(8 * 1024 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length)) > 0) hash.update(buffer.subarray(0, bytesRead));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

// The manifest is a restore point's completion marker, so it lands whole or not
// at all: digest first, then an atomic rename.
function writeRestorePoint(manifestPath, manifest) {
  ensureDir(path.dirname(manifestPath));
  const staged = `${manifestPath}.next`;
  fs.writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(`${manifestPath}.sha256`, `${sha256(staged)}  ${path.basename(manifestPath)}\n`, 'utf8');
  fs.renameSync(staged, manifestPath);
}

function readRestorePoint(manifestPath) {
  const digestFile = `${manifestPath}.sha256`;
  if (!fs.existsSync(digestFile)) throw new Error('This restore point is incomplete: the checksum recorded with it is missing.');
  if (sha256(manifestPath) !== fs.readFileSync(digestFile, 'utf8').trim().split(/\s+/u)[0]) throw new Error('Backup manifest checksum is invalid.');
  return readJson(manifestPath);
}

function tagValue(tags, key) {
  const prefix = `${key}:`;
  const found = (tags || []).find((tag) => typeof tag === 'string' && tag.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

// A bucket's restore point is named by destination and job id, since it has no
// path; it can never be mistaken for one because a destination id starts "object:".
function objectLocator(destinationId, pointId) {
  return `${destinationId}${OBJECT_LOCATOR_SEPARATOR}${pointId}`;
}

function parseObjectLocator(value) {
  if (typeof value !== 'string' || !isObjectDestinationId(value)) return null;
  const separator = value.indexOf(OBJECT_LOCATOR_SEPARATOR);
  if (separator < 0) return null;
  const destinationId = value.slice(0, separator);
  const pointId = value.slice(separator + 1);
  if (!isObjectDestinationId(destinationId) || !/^[A-Za-z0-9._-]{1,120}$/u.test(pointId)) return null;
  return { destinationId, pointId };
}

// --- Restore points on a drive ---------------------------------------------

class DiskRestorePoints {
  constructor(destinationId) {
    this.destinationId = destinationId;
  }

  locator(pointId) { return restorePointPath(this.destinationId, pointId); }

  manifestPaths() {
    const dir = restorePointsDir(this.destinationId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name))
      .filter((manifestPath) => fs.existsSync(`${manifestPath}.sha256`));
  }

  async count() { return this.manifestPaths().length; }

  // One damaged manifest is left out rather than hiding every other restore point.
  async summaries() {
    const summaries = [];
    for (const manifestPath of this.manifestPaths()) {
      try {
        summaries.push(summarize(readJson(manifestPath), {
          id: path.basename(manifestPath, '.json'),
          locator: manifestPath,
          note: this.readNoteAt(manifestPath),
        }));
      } catch {}
    }
    return summaries;
  }

  async read(pointId) { return readRestorePoint(this.locator(pointId)); }

  async write(pointId, manifest) { writeRestorePoint(this.locator(pointId), manifest); }

  async snapshotIds() { return []; }

  async remove(pointId) {
    for (const suffix of ['', '.sha256', '.next', '.note.txt']) fs.rmSync(`${this.locator(pointId)}${suffix}`, { force: true });
  }

  readNoteAt(manifestPath) {
    try {
      return fs.readFileSync(`${manifestPath}.note.txt`, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  async writeNote(pointId, note) {
    const notePath = `${this.locator(pointId)}.note.txt`;
    if (note) fs.writeFileSync(notePath, `${note}\n`, 'utf8');
    else fs.rmSync(notePath, { force: true });
  }
}

// --- Restore points in a bucket --------------------------------------------

// A bucket has no filesystem, so manifests and notes are snapshots inside the
// repository, listed through a local index that is safe because manifests never change.
class ObjectRestorePoints {
  constructor(destination) {
    this.destination = destination;
  }

  locator(pointId) { return objectLocator(this.destination.id, pointId); }

  async entries({ force = false } = {}) {
    return (await this.destination.readIndex({ force })).points;
  }

  async count() { return Object.keys(await this.entries()).length; }

  async summaries() {
    return Object.entries(await this.entries()).map(([pointId, entry]) => summarize(entry.manifest, {
      id: pointId,
      locator: this.locator(pointId),
      note: entry.note || null,
    }));
  }

  // Looked for once more before it is called missing: another process may have
  // written it moments ago.
  async entry(pointId) {
    const cached = (await this.entries())[pointId];
    if (cached) return cached;
    const refreshed = (await this.entries({ force: true }))[pointId];
    if (!refreshed) throw new Error('That backup is no longer in this bucket. Refresh the list and try again.');
    return refreshed;
  }

  async read(pointId) {
    const manifest = (await this.entry(pointId)).manifest;
    if (!manifest) throw new Error('This restore point is incomplete: the record describing what it contains could not be read.');
    return manifest;
  }

  async write(pointId, manifest) {
    const repository = await this.destination.repository();
    const { snapshotId } = await this.destination.engine.snapshotDocument({
      content: `${JSON.stringify(manifest, null, 2)}\n`,
      filename: MANIFEST_FILENAME,
      repository,
      tags: { mosjob: pointId, mosrole: ROLE_MANIFEST },
    });
    await this.destination.rememberPoint(pointId, { manifest, manifestSnapshotId: snapshotId }, repository);
  }

  async snapshotIds(pointId) {
    const entry = (await this.entries())[pointId];
    if (!entry) return [];
    return [entry.manifestSnapshotId, entry.noteSnapshotId].filter(Boolean);
  }

  async remove(pointId) {
    const snapshotIds = await this.snapshotIds(pointId);
    if (snapshotIds.length) {
      const repository = await this.destination.repository({ create: false });
      await this.destination.engine.forgetSnapshots({ repository, snapshotIds });
    }
    await this.destination.forgetPoint(pointId);
  }

  // The note is the one mutable thing about a restore point, so it is its own
  // snapshot: the manifest that names the backup's data is never rewritten.
  async writeNote(pointId, note) {
    const entry = await this.entry(pointId);
    const repository = await this.destination.repository();
    let snapshotId = null;
    if (note) {
      ({ snapshotId } = await this.destination.engine.snapshotDocument({
        content: `${note}\n`,
        filename: NOTE_FILENAME,
        repository,
        tags: { mosjob: pointId, mosrole: ROLE_NOTE },
      }));
    }
    if (entry.noteSnapshotId) {
      await this.destination.engine.forgetSnapshots({ repository, snapshotIds: [entry.noteSnapshotId] }).catch(() => {});
    }
    await this.destination.rememberPoint(pointId, { ...entry, note: note || null, noteSnapshotId: snapshotId }, repository);
  }
}

// The list entry for one restore point, the same words for a drive and a bucket.
function summarize(manifest, { id, locator, note }) {
  const volumes = manifest?.contents?.volumes || [];
  const rawBytes = (manifest?.contents?.stateRawBytes || 0) + volumes.reduce((sum, volume) => sum + (volume.rawBytes || 0), 0);
  return {
    appCount: manifest?.contents?.apps?.length || 0,
    apps: (manifest?.contents?.apps || []).map((app) => ({ packageId: app.packageId })),
    automatic: manifest?.backup?.initiator === 'schedule' || manifest?.backup?.initiator === 'update',
    createdAt: manifest?.backup?.createdAt || null,
    engineName: manifest?.backup?.engine || null,
    id: manifest?.backup?.id || id,
    initiator: manifest?.backup?.initiator === 'schedule' || manifest?.backup?.initiator === 'update' ? manifest.backup.initiator : 'owner',
    locator,
    note: note || null,
    schemaVersion: manifest?.backup?.schemaVersion || null,
    sizeBytes: rawBytes,
    sourceCommit: manifest?.source?.commit || null,
    sourceDomain: manifest?.source?.domain || null,
    sourceHostname: manifest?.source?.hostname || null,
    sourceInstallId: manifest?.source?.installId || null,
    sourceVersion: manifest?.source?.version || null,
    updateTarget: manifest?.backup?.updateTarget || null,
    volumeCount: volumes.length,
  };
}

// --- Destinations -----------------------------------------------------------

class DiskArchive {
  constructor({ createdBy, engine, guestKey, mountPath, name, placeId, system }) {
    this.createdBy = createdBy || (() => ({}));
    this.engine = engine;
    this.guestKey = guestKey || (() => null);
    this.id = `${placeId}/${name}`;
    this.kind = 'disk';
    this.mountPath = mountPath;
    this.name = name;
    this.placeId = placeId;
    this.root = archiveRoot(mountPath, name);
    this.points = new DiskRestorePoints(this.root);
    this.system = system;
    this.keyStateAtMs = 0;
    this.keyStateFor = null;
    this.keyStateHeld = null;
  }

  get noun() { return 'drive'; }

  repositorySpec() {
    const localPath = repositoryPathFor(this.root);
    return { env: {}, localPath, location: localPath, password: this.guestKey(), secrets: [] };
  }

  descriptor() { return readRepositoryDescriptor(this.root); }

  // The keys a held answer was given for: a restore's worker process adopts a
  // key or drops a borrowed one on disk, out of reach of this process's memory.
  keysInUse() {
    let engineKeyStamp = null;
    try { engineKeyStamp = fs.statSync(this.engine.keyFile).mtimeMs; } catch {}
    return JSON.stringify([engineKeyStamp, this.guestKey()]);
  }

  // Whose key opens the repository, asked of the engine at most once per index
  // interval because the listing is polled. `empty` means no repository at all;
  // a missing or torn descriptor changes nothing here.
  async health() {
    if (!repositoryExists(this.root)) return { keyState: 'empty' };
    const keys = this.keysInUse();
    if (this.keyStateHeld && this.keyStateFor === keys && Date.now() - this.keyStateAtMs < OBJECT_INDEX_TTL_MS) return this.keyStateHeld;
    let probe;
    try {
      probe = await this.engine.probe(this.repositorySpec());
    } catch {
      // Taken for locked, a passing engine failure would start a second archive.
      return { keyState: this.guestKey() ? 'borrowed' : 'own', reason: null };
    }
    const answer = { keyState: keyStateOf(probe.state, Boolean(this.guestKey())), reason: probe.state === 'locked' ? probe.message : null };
    if (answer.keyState === 'empty') return answer;
    this.keyStateAtMs = Date.now();
    this.keyStateFor = keys;
    this.keyStateHeld = answer;
    return answer;
  }

  get lostMessage() {
    return 'The backup drive was disconnected while MOS was writing to it, so this did not finish. Reconnect the drive and try again.';
  }

  async available() {
    if (!this.system?.destinationMounted) return true;
    try {
      return await this.system.destinationMounted(this.mountPath);
    } catch {
      return true;
    }
  }

  async assertAvailable(message) {
    if (this.system?.destinationMounted && !(await this.system.destinationMounted(this.mountPath))) throw new Error(message || DRIVE_DISCONNECTED);
    if (!this.writable()) throw new Error('The selected backup drive is not writable.');
    const { keyState } = await this.health();
    if (keyState !== 'own' && keyState !== 'empty') throw otherServersRefusal();
  }

  writable() {
    try {
      fs.accessSync(this.mountPath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  // The folder outlives the mount, so an unchecked detached drive would turn
  // backups into silent writes onto the system disk.
  async assertStillWritable(message) { await this.assertAvailable(message); }

  async freeBytes() {
    if (this.system?.availableBytes) return this.system.availableBytes(this.mountPath);
    try {
      const stat = fs.statfsSync(this.mountPath);
      return stat.bavail * stat.bsize;
    } catch {
      return null;
    }
  }

  // The descriptor goes down before the repository is created, so a crash between
  // the two leaves a described-but-empty archive the next backup simply finishes.
  async repository({ create = true } = {}) {
    assertRepositoryEngine(this.root, this.engine.name);
    const localPath = repositoryPathFor(this.root);
    if (create && !this.descriptor()) {
      const { hostname = null, installId = null } = this.createdBy();
      writeRepositoryDescriptor(this.root, {
        createdAt: new Date().toISOString(),
        createdByHostname: hostname,
        createdByInstallId: installId,
        engineName: this.engine.name,
        format: 'Encrypted, deduplicating content-addressed repository. Restoring it needs MOS and the recovery key of the server that made it.',
        repositoryId: crypto.randomUUID(),
      });
    }
    const repository = await this.engine.openOrCreateRepository({
      create,
      localPath,
      location: localPath,
      missingMessage: 'This backup archive is missing from the drive, so it cannot be read. Check that the right drive is connected and that its MOS-backups folder is intact.',
      password: this.guestKey(),
    });
    assertRepositoryUnlocked(repository);
    this.keyStateHeld = null;
    return { ...repository, descriptor: this.descriptor(), destinationId: this.id };
  }

  // Safe only on a drive, where MOS made the folder and can see it is the one it made.
  async discardCreatedRepository() {
    fs.rmSync(this.root, { force: true, recursive: true });
  }

  descriptorRepositoryId() { return this.descriptor()?.repositoryId || null; }
}

class ObjectDestination {
  constructor({ agentStateDir, engine, guestKey, record }) {
    this.agentStateDir = agentStateDir;
    this.engine = engine;
    this.guestKey = guestKey || (() => null);
    this.id = record.id;
    this.kind = 'object';
    this.label = record.label;
    this.points = new ObjectRestorePoints(this);
    this.record = record;
    this.spec = objectRepositorySpec(record);
    this.cached = null;
    this.cachedMtimeMs = null;
    this.lastError = null;
    this.lastLocked = false;
    this.openRepository = null;
    this.refreshing = null;
  }

  get noun() { return 'bucket'; }

  get placeId() { return this.id; }

  repositorySpec() { return { ...this.spec, localPath: null, password: this.guestKey() }; }

  get lostMessage() {
    return 'MOS lost contact with the storage provider while writing this backup, so it did not finish. Check this server\'s internet connection, then try again.';
  }

  async available() {
    return (await this.engine.probeRepository(this.repositorySpec())).state !== 'unreachable';
  }

  // The engine's own verdict is the message: it tells a refused key from an
  // unreachable host from an empty bucket, which is what an owner needs to fix.
  async assertAvailable() {
    if (this.guestKey()) throw otherServersRefusal(OTHER_SERVERS_BUCKET);
    const probe = await this.engine.probe(this.repositorySpec());
    if (probe.state === 'unreachable') throw Object.assign(new Error(probe.message), { engineOutput: probe.output || null });
    if (probe.state === 'locked') throw otherServersRefusal(OTHER_SERVERS_BUCKET);
  }

  // Nothing to prove: the manifest goes into the repository itself, so the write
  // is its own proof, and probing again could discard a backup that succeeded.
  async assertStillWritable() {}

  // Object storage reserves nothing, so there is no free-space number to check against.
  async freeBytes() { return null; }

  async repository({ create = true } = {}) {
    if (this.openRepository) return this.openRepository;
    const repository = await this.engine.openOrCreateRepository({
      ...this.repositorySpec(),
      create,
      missingMessage: 'There is no MOS backup store in this bucket yet, so there is nothing here to read.',
    });
    // A locked repository is not held: the owner may enter its key in between.
    assertRepositoryUnlocked(repository);
    this.openRepository = { ...repository, destinationId: this.id };
    return this.openRepository;
  }

  // Never: MOS did not create the bucket and cannot tell what else an owner keeps in it.
  async discardCreatedRepository() {}

  descriptorRepositoryId() { return this.loadIndex()?.repositoryId || null; }

  indexPath() {
    return path.join(this.agentStateDir, OBJECT_INDEX_DIRNAME, `${this.id.replace(/[^A-Za-z0-9_-]+/gu, '-')}.json`);
  }

  // The file is the truth, not the copy in memory: a backup's worker process
  // records the restore point it wrote there, and the mtime makes re-reading cheap.
  loadIndex() {
    let stat;
    try {
      stat = fs.statSync(this.indexPath());
    } catch {
      return null;
    }
    if (this.cached && this.cachedMtimeMs === stat.mtimeMs) return this.cached;
    try {
      const parsed = readJson(this.indexPath());
      if (parsed?.location !== this.spec.location) return null;
      this.cached = { ...parsed, fetchedAtMs: new Date(parsed.fetchedAt || 0).getTime() };
      this.cachedMtimeMs = stat.mtimeMs;
      return this.cached;
    } catch {
      return null;
    }
  }

  saveIndex(index) {
    this.cached = index;
    try {
      ensureDir(path.dirname(this.indexPath()));
      fs.writeFileSync(this.indexPath(), `${JSON.stringify({ ...index, fetchedAtMs: undefined }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.cachedMtimeMs = fs.statSync(this.indexPath()).mtimeMs;
    } catch {}
    return index;
  }

  emptyIndex() {
    return { fetchedAt: new Date().toISOString(), fetchedAtMs: Date.now(), location: this.spec.location, points: {}, repositoryId: null, storedBytes: null };
  }

  // A point whose manifest snapshot id is unchanged is never fetched again, so an
  // established bucket costs one listing per refresh.
  async readIndex({ force = false } = {}) {
    const current = this.loadIndex();
    if (!force && current && Date.now() - current.fetchedAtMs < OBJECT_INDEX_TTL_MS) return current;
    let repository;
    try {
      repository = await this.repository({ create: false });
    } catch (error) {
      // A bucket MOS has never written to holds no backups; anything else is the caller's to report.
      if (!error?.repositoryAbsent) throw error;
      return this.saveIndex(this.emptyIndex());
    }
    const snapshots = await this.engine.listSnapshots({ repository });
    const found = new Map();
    for (const snapshot of snapshots) {
      const pointId = tagValue(snapshot.tags, 'mosjob');
      const role = tagValue(snapshot.tags, 'mosrole');
      if (!pointId || (role !== ROLE_MANIFEST && role !== ROLE_NOTE)) continue;
      const entry = found.get(pointId) || {};
      if (role === ROLE_MANIFEST) entry.manifestSnapshotId = snapshot.snapshotId;
      // An interrupted note edit can leave two note snapshots; the newest is the owner's.
      else if (!entry.noteAt || String(snapshot.createdAt) > entry.noteAt) {
        entry.noteAt = String(snapshot.createdAt);
        entry.noteSnapshotId = snapshot.snapshotId;
      }
      found.set(pointId, entry);
    }
    const points = {};
    for (const [pointId, entry] of found) {
      if (!entry.manifestSnapshotId) continue;
      const previous = current?.points?.[pointId];
      points[pointId] = {
        manifest: previous?.manifestSnapshotId === entry.manifestSnapshotId
          ? previous.manifest
          : await this.readDocument(repository, entry.manifestSnapshotId, MANIFEST_FILENAME, JSON.parse),
        manifestSnapshotId: entry.manifestSnapshotId,
        note: !entry.noteSnapshotId
          ? null
          : previous?.noteSnapshotId === entry.noteSnapshotId
            ? previous.note
            : await this.readDocument(repository, entry.noteSnapshotId, NOTE_FILENAME, (raw) => raw.trim() || null),
        noteSnapshotId: entry.noteSnapshotId || null,
      };
    }
    const stats = await this.engine.repositoryStats({ repository });
    return this.saveIndex({
      fetchedAt: new Date().toISOString(),
      fetchedAtMs: Date.now(),
      location: this.spec.location,
      points,
      repositoryId: repository.repositoryId || null,
      storedBytes: stats?.storedBytes ?? null,
    });
  }

  // A document that will not read leaves its point listed without one, which
  // refuses to restore it rather than hiding every other backup in the bucket.
  async readDocument(repository, snapshotId, filename, parse) {
    try {
      return parse(await this.engine.readDocument({ filename, repository, snapshotId }));
    } catch {
      return null;
    }
  }

  // An index invented here is dated to the epoch: the point shows up at once and
  // a real listing is still owed.
  async rememberPoint(pointId, entry, repository) {
    const current = this.loadIndex() || { fetchedAt: new Date(0).toISOString(), fetchedAtMs: 0, location: this.spec.location, points: {}, repositoryId: null, storedBytes: null };
    const repositoryId = repository?.repositoryId || current.repositoryId;
    this.saveIndex({ ...current, points: { ...current.points, [pointId]: { note: null, noteSnapshotId: null, ...entry } }, repositoryId });
  }

  async forgetPoint(pointId) {
    const current = this.loadIndex();
    if (!current) return;
    const points = { ...current.points };
    delete points[pointId];
    this.saveIndex({ ...current, points });
  }

  usage() {
    const index = this.loadIndex();
    if (!index) return null;
    return { engineName: this.engine.name, restorePoints: Object.keys(index.points).length, storedBytes: index.storedBytes ?? null };
  }

  // Answered from the last refresh, since the screen polls and a network round
  // trip per poll would bill the owner; only the very first call blocks.
  async health() {
    if (!this.loadIndex()) {
      try {
        await this.readIndex({ force: true });
        this.noteReachable();
      } catch (error) {
        this.noteUnreachable(error);
      }
    } else if (Date.now() - this.loadIndex().fetchedAtMs >= OBJECT_INDEX_TTL_MS) {
      this.refreshInBackground();
    }
    const index = this.loadIndex();
    const reachable = Boolean(index) && !this.lastError;
    return {
      checkedAt: index?.fetchedAt || null,
      keyState: this.lastLocked ? 'locked' : !reachable ? null : !index.repositoryId ? 'empty' : this.guestKey() ? 'borrowed' : 'own',
      ready: reachable,
      reason: this.lastError || null,
      usage: this.usage(),
    };
  }

  noteReachable() {
    this.lastError = null;
    this.lastLocked = false;
  }

  noteUnreachable(error) {
    this.lastError = error?.message || 'MOS could not reach this storage.';
    this.lastLocked = error?.repositoryLocked === true;
  }

  refreshInBackground() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.readIndex({ force: true })
      .then(() => this.noteReachable())
      .catch((error) => this.noteUnreachable(error))
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
}

// --- Resolving ---------------------------------------------------------------

// Archives are held between requests, since an open handle, a bucket's index and
// a drive archive's key answer are each an engine call to rebuild. A drive is
// named by its filesystem UUID, so an archive id is `<uuid>/<folder>`.
class DestinationResolver {
  constructor({ agentStateDir, createdBy, engine, guestKeys, mountRoot = STORAGE_MOUNT_ROOT, objectRegistry, system }) {
    this.agentStateDir = agentStateDir;
    this.createdBy = createdBy || (() => ({}));
    this.disks = new Map();
    this.engine = engine;
    this.guestKeys = guestKeys || null;
    this.mountRoot = mountRoot;
    this.objectRegistry = objectRegistry;
    this.objects = new Map();
    this.system = system;
  }

  objectRecords() { return this.objectRegistry ? this.objectRegistry.list() : []; }

  // Read on every command rather than captured, so a key entered or removed
  // takes effect on an archive that is already held.
  guestKeyFor(archiveId) {
    return () => (this.guestKeys ? this.guestKeys.keyFor(archiveId) : null);
  }

  mountPathOf(driveId) {
    if (!DRIVE_ID_PATTERN.test(String(driveId))) throw new Error('Choose a backup destination and try again.');
    return path.join(this.mountRoot, driveId);
  }

  objectDestination(record) {
    const fingerprint = JSON.stringify([record.accessKeyId, record.bucket, record.endpoint, record.folder, record.region, record.secretAccessKey]);
    const held = this.objects.get(record.id);
    if (held && held.fingerprint === fingerprint) {
      held.destination.label = record.label;
      return held.destination;
    }
    const destination = new ObjectDestination({ agentStateDir: this.agentStateDir, engine: this.engine, guestKey: this.guestKeyFor(record.id), record });
    this.objects.set(record.id, { destination, fingerprint });
    return destination;
  }

  diskArchive(driveId, name) {
    const id = `${driveId}/${name}`;
    const held = this.disks.get(id);
    if (held) return held;
    const archive = new DiskArchive({ createdBy: this.createdBy, engine: this.engine, guestKey: this.guestKeyFor(id), mountPath: this.mountPathOf(driveId), name, placeId: driveId, system: this.system });
    this.disks.set(id, archive);
    return archive;
  }

  forget(id) {
    this.disks.delete(id);
    this.objects.delete(id);
  }

  // After this machine's key changes, every held answer about what it opens is stale.
  forgetAll() {
    this.disks.clear();
    this.objects.clear();
  }

  // Throws rather than returning null: every caller is about to act on the archive.
  resolve(archiveId) {
    if (isObjectDestinationId(archiveId)) {
      const record = this.objectRecords().find((entry) => entry.id === archiveId);
      if (!record) throw new Error('That storage connection no longer exists. Choose a destination and try again.');
      return this.objectDestination(record);
    }
    const [driveId, name, extra] = String(archiveId || '').split('/');
    if (extra === undefined && DRIVE_ID_PATTERN.test(driveId || '') && ARCHIVE_NAME_PATTERN.test(name || '')) return this.diskArchive(driveId, name);
    throw new Error('Choose a backup and try again.');
  }

  // The archive a folder on a mounted drive is, for a restore point's path.
  archiveAt(root) {
    const relative = path.relative(this.mountRoot, path.resolve(root)).split(path.sep);
    if (relative.length !== 3 || relative[1] !== BACKUPS_DIRNAME) throw new Error('Choose a backup from a connected destination.');
    return this.resolve(`${relative[0]}/${relative[2]}`);
  }

  // Every archive on a mounted drive, this server's and other servers'.
  archivesOn(driveId) {
    return archiveNames(this.mountPathOf(driveId)).map((name) => this.diskArchive(driveId, name));
  }

  // Where this server's next backup to a destination goes: a bucket's one archive,
  // or on a drive this server's own (the newest if a takeover left two), else a
  // new one beside whatever other servers keep there. Never beside an archive
  // without a descriptor that this server's key does not open: it may be this
  // server's own with a torn descriptor, and a second archive would hide it.
  async target(destinationId) {
    if (isObjectDestinationId(destinationId)) return this.resolve(destinationId);
    const own = [];
    let undescribedLocked = null;
    for (const archive of this.archivesOn(destinationId)) {
      const { keyState } = await archive.health();
      if (keyState === 'own') own.push(archive);
      else if (keyState === 'locked' && !archive.descriptor()) undescribedLocked ??= archive;
    }
    if (own.length) {
      const newest = async (archive) => (await archive.points.summaries()).map((point) => point.createdAt || '').sort().at(-1) || '';
      const dated = await Promise.all(own.map(async (archive) => [await newest(archive), archive]));
      return dated.sort((left, right) => (left[0] < right[0] ? 1 : -1))[0][1];
    }
    if (undescribedLocked) {
      throw Object.assign(new Error(`The archive ${undescribedLocked.name} on this drive has lost its description and this server's recovery key does not open it, so MOS will not start a second archive beside it. If those backups are another server's, enter that server's recovery key under Backups and erase them from there if they are not needed.`), { code: 'DESTINATION_UNDESCRIBED_ARCHIVE' });
    }
    return this.diskArchive(destinationId, newArchiveName());
  }

  // Only the buckets the owner made a backup destination; the rest are storage only.
  objectDestinations() { return this.objectRecords().filter((record) => record.backups === true).map((record) => this.objectDestination(record)); }
}

module.exports = {
  DestinationResolver,
  MANIFEST_FILENAME,
  objectLocator,
  ObjectDestination,
  OBJECT_INDEX_TTL_MS,
  parseObjectLocator,
  readRestorePoint,
  sha256,
  summarize,
  writeRestorePoint,
};
