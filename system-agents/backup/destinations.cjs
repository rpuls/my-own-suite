// What a backup archive is, wherever it is kept: one encrypted repository and its
// restore points. A drive and a bucket each hold any number side by side, and
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
  REPOSITORY_DIRNAME,
  repositoryExists,
  repositoryPathFor,
  restorePointPath,
  restorePointsDir,
  writeRepositoryDescriptor,
} = require('./engines/engine.cjs');
const { isBucketArchiveName, isObjectDestinationId, objectCatalogSpec, objectRepositorySpec } = require('./object-destinations.cjs');

const MANIFEST_FILENAME = 'manifest.json';
const CATALOG_DOCUMENT = 'archive.json';
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

// A bucket's restore point is named by archive and job id, since it has no path;
// it can never be mistaken for one because a bucket archive's id starts "object:".
function objectLocator(archiveId, pointId) {
  return `${archiveId}${OBJECT_LOCATOR_SEPARATOR}${pointId}`;
}

// `object:<connection>/<archive name>`, split into the connection and the name.
function parseObjectArchiveId(value) {
  if (!isObjectDestinationId(value)) return null;
  const slash = value.indexOf('/');
  if (slash < 0) return null;
  const placeId = value.slice(0, slash);
  const name = value.slice(slash + 1);
  return /^object:[A-Za-z0-9]{1,64}$/u.test(placeId) && isBucketArchiveName(name) ? { name, placeId } : null;
}

function parseObjectLocator(value) {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf(OBJECT_LOCATOR_SEPARATOR);
  if (separator < 0) return null;
  const archiveId = value.slice(0, separator);
  const pointId = value.slice(separator + 1);
  const archive = parseObjectArchiveId(archiveId);
  if (!archive || !/^[A-Za-z0-9._-]{1,120}$/u.test(pointId)) return null;
  return { archiveId, placeId: archive.placeId, pointId };
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

  madeHere() {
    const installId = this.createdBy().installId;
    return Boolean(installId) && this.descriptor()?.createdByInstallId === installId;
  }

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

class ObjectArchive {
  constructor({ agentStateDir, catalog, createdBy, engine, entry = null, guestKey, name, record }) {
    this.agentStateDir = agentStateDir;
    this.catalog = catalog || null;
    this.createdBy = createdBy || (() => ({}));
    this.engine = engine;
    this.entry = entry;
    this.guestKey = guestKey || (() => null);
    this.id = `${record.id}/${name}`;
    this.kind = 'object';
    this.label = record.label;
    this.name = name;
    this.points = new ObjectRestorePoints(this);
    this.record = record;
    this.spec = objectRepositorySpec(record, name);
    this.cached = null;
    this.cachedMtimeMs = null;
    this.lastError = null;
    this.lastLocked = false;
    this.openRepository = null;
    this.refreshing = null;
  }

  get noun() { return 'bucket'; }

  get placeId() { return this.record.id; }

  // Whether this machine put the archive in the catalog, so a backup cut off
  // before its repository existed is finished rather than started again beside it.
  madeHere() { return Boolean(this.entry?.installId) && this.entry.installId === this.createdBy().installId; }

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
    if (this.guestKey()) throw otherServersRefusal();
    const probe = await this.engine.probe(this.repositorySpec());
    if (probe.state === 'unreachable') throw Object.assign(new Error(probe.message), { engineOutput: probe.output || null });
    if (probe.state === 'locked') throw otherServersRefusal();
  }

  // Nothing to prove: the manifest goes into the repository itself, so the write
  // is its own proof, and probing again could discard a backup that succeeded.
  async assertStillWritable() {}

  // Object storage reserves nothing, so there is no free-space number to check against.
  async freeBytes() { return null; }

  // Put in the catalog before its repository is made, as a drive's descriptor is,
  // so another server sees an archive the moment there is anything in it.
  async repository({ create = true } = {}) {
    if (this.openRepository) return this.openRepository;
    if (create && this.catalog) this.entry = await this.catalog.ensure(this.name, this.createdBy()) || this.entry;
    const repository = await this.engine.openOrCreateRepository({
      ...this.repositorySpec(),
      create,
      missingMessage: 'These backups are missing from the bucket, so there is nothing here to read.',
    });
    // A locked repository is not held: the owner may enter its key in between.
    assertRepositoryUnlocked(repository);
    this.openRepository = { ...repository, destinationId: this.id };
    return this.openRepository;
  }

  // Never: restic gives no way to take a repository out of a bucket again.
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

// --- What a bucket holds ------------------------------------------------------

// The archives in a bucket, read from its catalog plus the one MOS 0.22 left at
// the root. Kept in a file like an archive's index, so a worker that adds an
// archive is seen by the agent at once, and the bucket is asked at most once an
// interval: in the background, once there is an answer to give meanwhile.
class BucketCatalog {
  constructor({ agentStateDir, engine, record }) {
    this.agentStateDir = agentStateDir;
    this.engine = engine;
    this.id = record.id;
    this.legacySpec = objectRepositorySpec(record, REPOSITORY_DIRNAME);
    this.spec = objectCatalogSpec(record);
    this.cached = null;
    this.cachedMtimeMs = null;
    this.lastError = null;
    this.refreshing = null;
  }

  filePath() {
    return path.join(this.agentStateDir, OBJECT_INDEX_DIRNAME, `${this.id.replace(/[^A-Za-z0-9_-]+/gu, '-')}.catalog.json`);
  }

  load() {
    let stat;
    try {
      stat = fs.statSync(this.filePath());
    } catch {
      return null;
    }
    if (this.cached && this.cachedMtimeMs === stat.mtimeMs) return this.cached;
    try {
      const parsed = readJson(this.filePath());
      if (parsed?.location !== this.spec.location || !Array.isArray(parsed.archives)) return null;
      this.cached = { ...parsed, fetchedAtMs: new Date(parsed.fetchedAt || 0).getTime() };
      this.cachedMtimeMs = stat.mtimeMs;
      return this.cached;
    } catch {
      return null;
    }
  }

  save(catalog) {
    this.cached = catalog;
    try {
      ensureDir(path.dirname(this.filePath()));
      fs.writeFileSync(this.filePath(), `${JSON.stringify({ ...catalog, fetchedAtMs: undefined }, null, 2)}
`, { encoding: 'utf8', mode: 0o600 });
      this.cachedMtimeMs = fs.statSync(this.filePath()).mtimeMs;
    } catch {}
    return catalog;
  }

  // The 0.22 archive is looked for once per connection: nothing writes there any more.
  async fetch() {
    const current = this.load();
    const repository = await this.engine.openPublicRepository(this.spec);
    const archives = [];
    for (const snapshot of repository ? await this.engine.listSnapshots({ repository }) : []) {
      const name = tagValue(snapshot.tags, 'mosarchive');
      if (!isBucketArchiveName(name) || archives.some((entry) => entry.name === name)) continue;
      archives.push({ createdAt: snapshot.createdAt || null, hostname: tagValue(snapshot.tags, 'moshost'), installId: tagValue(snapshot.tags, 'mosinstall'), name });
    }
    let legacy = current?.legacy ?? null;
    if (legacy === null) {
      const probe = await this.engine.probeRepository({ ...this.legacySpec, noun: 'bucket' });
      if (probe.state === 'unreachable') throw new Error(probe.message);
      legacy = probe.state !== 'absent';
    }
    if (legacy && !archives.some((entry) => entry.name === REPOSITORY_DIRNAME)) archives.push({ createdAt: null, hostname: null, installId: null, name: REPOSITORY_DIRNAME });
    return this.save({ archives, fetchedAt: new Date().toISOString(), fetchedAtMs: Date.now(), legacy, location: this.spec.location });
  }

  // `wait` for a caller about to act on the answer; the listing takes the last one.
  async archives({ wait = false } = {}) {
    const current = this.load();
    const fresh = current && Date.now() - current.fetchedAtMs < OBJECT_INDEX_TTL_MS;
    if (fresh) return current.archives;
    if (current && !wait) {
      this.refreshInBackground();
      return current.archives;
    }
    try {
      const fetched = await this.fetch();
      this.lastError = null;
      return fetched.archives;
    } catch (error) {
      this.lastError = error?.message || 'MOS could not reach this storage.';
      if (current && !wait) return current.archives;
      throw error;
    }
  }

  refreshInBackground() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.fetch()
      .then(() => { this.lastError = null; })
      .catch((error) => { this.lastError = error?.message || 'MOS could not reach this storage.'; })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  // The catalog entry for an archive this machine is about to create, written
  // first; the entry already there when a backup cut short is finished.
  async ensure(name, { hostname = null, installId = null } = {}) {
    const known = (await this.archives({ wait: true })).find((entry) => entry.name === name);
    if (known || name === REPOSITORY_DIRNAME) return known || null;
    const repository = await this.engine.openPublicRepository({ ...this.spec, create: true });
    const entry = { createdAt: new Date().toISOString(), hostname, installId, name };
    await this.engine.snapshotDocument({
      content: `${JSON.stringify(entry, null, 2)}
`,
      filename: CATALOG_DOCUMENT,
      repository,
      tags: { mosarchive: name, moshost: hostname, mosinstall: installId },
    });
    const current = this.load() || { archives: [], legacy: null, location: this.spec.location };
    const fetchedAt = current.fetchedAt || new Date(0).toISOString();
    this.save({ ...current, archives: [...current.archives.filter((item) => item.name !== name), entry], fetchedAt, fetchedAtMs: new Date(fetchedAt).getTime() });
    return entry;
  }
}

// --- Resolving ---------------------------------------------------------------

// Archives are held between requests, since an open handle, an index and a key
// answer are each an engine call to rebuild. An archive id is the place and the
// archive's name: `<drive UUID>/archive-<hex>` or `object:<connection>/archive-<hex>`.
class DestinationResolver {
  constructor({ agentStateDir, createdBy, engine, guestKeys, mountRoot = STORAGE_MOUNT_ROOT, objectRegistry, system }) {
    this.agentStateDir = agentStateDir;
    this.catalogs = new Map();
    this.createdBy = createdBy || (() => ({}));
    this.disks = new Map();
    this.engine = engine;
    this.guestKeys = guestKeys || null;
    this.mountRoot = mountRoot;
    this.objectRegistry = objectRegistry;
    this.objects = new Map();
    this.system = system;
  }

  bucketRecords() { return this.objectRegistry ? this.objectRegistry.list() : []; }

  bucketRecord(placeId) {
    const record = this.bucketRecords().find((entry) => entry.id === placeId);
    if (!record) throw new Error('That storage connection no longer exists. Choose another place and try again.');
    return record;
  }

  // Read on every command rather than captured, so a key entered or removed
  // takes effect on an archive that is already held.
  guestKeyFor(archiveId) {
    return () => (this.guestKeys ? this.guestKeys.keyFor(archiveId) : null);
  }

  mountPathOf(driveId) {
    if (!DRIVE_ID_PATTERN.test(String(driveId))) throw new Error('Choose where to back up and try again.');
    return path.join(this.mountRoot, driveId);
  }

  // Held per connection, and rebuilt when its address or keys change.
  held(map, key, record, build) {
    const fingerprint = JSON.stringify([record.accessKeyId, record.bucket, record.endpoint, record.folder, record.region, record.secretAccessKey]);
    const held = map.get(key);
    if (held && held.fingerprint === fingerprint) return held.value;
    const value = build();
    map.set(key, { fingerprint, value });
    return value;
  }

  catalogOf(record) {
    return this.held(this.catalogs, record.id, record, () => new BucketCatalog({ agentStateDir: this.agentStateDir, engine: this.engine, record }));
  }

  objectArchive(record, name, entry = null) {
    const id = `${record.id}/${name}`;
    const archive = this.held(this.objects, id, record, () => new ObjectArchive({
      agentStateDir: this.agentStateDir,
      catalog: this.catalogOf(record),
      createdBy: this.createdBy,
      engine: this.engine,
      entry,
      guestKey: this.guestKeyFor(id),
      name,
      record,
    }));
    archive.label = record.label;
    if (entry) archive.entry = entry;
    return archive;
  }

  diskArchive(driveId, name) {
    const id = `${driveId}/${name}`;
    const held = this.disks.get(id);
    if (held) return held;
    const archive = new DiskArchive({ createdBy: this.createdBy, engine: this.engine, guestKey: this.guestKeyFor(id), mountPath: this.mountPathOf(driveId), name, placeId: driveId, system: this.system });
    this.disks.set(id, archive);
    return archive;
  }

  // An archive id, or a whole connection: one edited or removed takes its archives with it.
  forget(id) {
    this.disks.delete(id);
    this.objects.delete(id);
    this.catalogs.delete(id);
    for (const [key, held] of this.objects) {
      if (held.value.placeId === id) this.objects.delete(key);
    }
  }

  // After this machine's key changes, every held answer about what it opens is stale.
  forgetAll() {
    this.disks.clear();
    this.objects.clear();
  }

  // Throws rather than returning null: every caller is about to act on the archive.
  resolve(archiveId) {
    const object = parseObjectArchiveId(String(archiveId || ''));
    if (object) return this.objectArchive(this.bucketRecord(object.placeId), object.name);
    const [driveId, name, extra] = String(archiveId || '').split('/');
    if (extra === undefined && DRIVE_ID_PATTERN.test(driveId || '') && ARCHIVE_NAME_PATTERN.test(name || '')) return this.diskArchive(driveId, name);
    throw new Error('Choose a backup and try again.');
  }

  // The archive a folder on a mounted drive is, for a restore point's path.
  archiveAt(root) {
    const relative = path.relative(this.mountRoot, path.resolve(root)).split(path.sep);
    if (relative.length !== 3 || relative[1] !== BACKUPS_DIRNAME) throw new Error('Choose a backup from connected storage.');
    return this.resolve(`${relative[0]}/${relative[2]}`);
  }

  // Every archive in a place, this server's and other servers'. A bucket's list
  // is its catalog's last answer unless `wait` asks for a current one.
  async archivesIn(placeId, { wait = false } = {}) {
    if (!isObjectDestinationId(placeId)) return archiveNames(this.mountPathOf(placeId)).map((name) => this.diskArchive(placeId, name));
    const record = this.bucketRecord(placeId);
    return (await this.catalogOf(record).archives({ wait })).map((entry) => this.objectArchive(record, entry.name, entry));
  }

  // Why a bucket's list could not be read the last time it was asked, or null.
  catalogProblem(placeId) {
    return this.catalogs.get(placeId)?.value.lastError || null;
  }

  // Where this server's next backup to a place goes: its own archive there (the
  // newest if a takeover left two), else one it began and never finished, else a
  // new one beside whatever other servers keep there. Never beside an archive on
  // a drive without a descriptor that this server's key does not open: it may be
  // this server's own with a torn descriptor, and a second one would hide it.
  async target(placeId) {
    const own = [];
    let unfinished = null;
    let undescribedLocked = null;
    for (const archive of await this.archivesIn(placeId, { wait: true })) {
      const { keyState } = await archive.health();
      if (keyState === 'own') own.push(archive);
      else if (keyState === 'empty' && archive.madeHere()) unfinished ??= archive;
      else if (keyState === 'locked' && archive.kind === 'disk' && !archive.descriptor()) undescribedLocked ??= archive;
    }
    if (own.length) {
      const newest = async (archive) => (await archive.points.summaries()).map((point) => point.createdAt || '').sort().at(-1) || '';
      const dated = await Promise.all(own.map(async (archive) => [await newest(archive), archive]));
      return dated.sort((left, right) => (left[0] < right[0] ? 1 : -1))[0][1];
    }
    if (undescribedLocked) {
      throw Object.assign(new Error(`The archive ${undescribedLocked.name} on this drive has lost its description and this server's recovery key does not open it, so MOS will not start a second archive beside it. If those backups are another server's, enter that server's recovery key under Backups and erase them from there if they are not needed.`), { code: 'DESTINATION_UNDESCRIBED_ARCHIVE' });
    }
    if (unfinished) return unfinished;
    if (isObjectDestinationId(placeId)) return this.objectArchive(this.bucketRecord(placeId), newArchiveName());
    return this.diskArchive(placeId, newArchiveName());
  }
}

module.exports = {
  BucketCatalog,
  DestinationResolver,
  MANIFEST_FILENAME,
  objectLocator,
  ObjectArchive,
  OBJECT_INDEX_TTL_MS,
  parseObjectLocator,
  readRestorePoint,
  sha256,
  summarize,
  writeRestorePoint,
};
