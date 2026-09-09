// What a backup destination is, now that it is not always a filesystem.
//
// A drive and a bucket both hold one encrypted repository and a set of restore
// points, and everything above this file — the backup pipeline, the schedule,
// retention, the delete job — should not care which it is looking at. So each
// destination answers the same small set of questions: is it there, how much
// room is left, open its repository, and list, read, write or remove a restore
// point.
//
// The two differ in where a restore point's manifest lives. On a drive it is a
// file beside the repository, checksummed, exactly as MOS has always written
// it. In a bucket there is no filesystem to put a file in and MOS speaks no
// object protocol of its own, so the manifest is stored as its own snapshot
// inside the repository: authenticated by the repository's own encryption
// rather than by a checksum stored next to what it protects, and removed by
// the same command that removes everything else. Listing those manifests means
// asking the engine over the network, so a bucket keeps a local index of what
// it holds; manifests never change once written, which is what makes that
// index safe to trust between refreshes.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertRepositoryEngine,
  readRepositoryDescriptor,
  repositoryPathFor,
  repositorySidecarPath,
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
// How long a bucket's index of its own restore points is trusted without
// asking again. Everything that changes it goes through this agent, which
// refreshes it immediately; the interval only covers a second machine writing
// into the same bucket, which MOS refuses to set up but cannot prevent.
const OBJECT_INDEX_TTL_MS = 120_000;
const OBJECT_INDEX_DIRNAME = 'object-index';
const DRIVE_DISCONNECTED = 'The selected backup drive is not mounted anymore. Reconnect it, click Refresh drives, and try again.';

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// The engine returns a locked repository rather than throwing, because reaching
// a destination that holds another server's backups is a state the screen
// offers a recovery key for. Past this point it would be a repository nothing
// can read or write, so every caller that is about to use one stops here — with
// the sentence that names the recovery key, never the engine's own words.
function assertRepositoryUnlocked(repository) {
  if (!repository?.locked) return;
  throw Object.assign(new Error(repository.lockedMessage), { repositoryLocked: true });
}

// Hash in fixed-size chunks: volume archives are multi-gigabyte, and reading
// one into a single Buffer exhausts RAM or trips ERR_FS_FILE_TOO_LARGE.
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

// A restore point's manifest is its completion marker: it names the snapshots
// the repository holds for one backup, and nothing lists a restore point until
// it exists. So it is written whole or not at all — digest first, then an
// atomic rename of the manifest itself.
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

// A restore point in a bucket is named by its destination and its job id,
// because there is no path to name it with. The separator cannot appear in
// either half, and the whole thing can never be mistaken for a filesystem path
// because a destination id starts with "object:" and a path starts with "/".
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

  // A manifest that will not parse is left out rather than thrown over: one
  // damaged restore point must not make the other backups on the drive
  // invisible.
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

  async readNote(pointId) { return this.readNoteAt(this.locator(pointId)); }

  async writeNote(pointId, note) {
    const notePath = `${this.locator(pointId)}.note.txt`;
    if (note) fs.writeFileSync(notePath, `${note}\n`, 'utf8');
    else fs.rmSync(notePath, { force: true });
  }

  async invalidate() {}
}

// --- Restore points in a bucket --------------------------------------------

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

  // A point the index has never heard of is looked for once before it is
  // called missing: it may have been written by this machine moments ago from
  // another process, or by a restore of this machine's own state.
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
    await this.destination.rememberPoint(pointId, { manifest, manifestSnapshotId: snapshotId });
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

  async readNote(pointId) { return (await this.entries())[pointId]?.note || null; }

  // A note is the one mutable thing about a restore point, so it is stored
  // apart from the manifest here too: the new note goes in, the old snapshot
  // goes out, and the manifest that names the backup's data is never rewritten.
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
    await this.destination.rememberPoint(pointId, { ...entry, note: note || null, noteSnapshotId: snapshotId });
  }

  async invalidate() { await this.destination.readIndex({ force: true }).catch(() => null); }
}

// The list entry for one restore point, from its manifest. Kept here so a
// drive and a bucket describe what they hold in exactly the same words.
function summarize(manifest, { id, locator, note }) {
  const volumes = manifest?.contents?.volumes || [];
  const rawBytes = (manifest?.contents?.stateRawBytes || 0) + volumes.reduce((sum, volume) => sum + (volume.rawBytes || 0), 0);
  return {
    appCount: manifest?.contents?.apps?.length || 0,
    automatic: manifest?.backup?.initiator === 'schedule',
    createdAt: manifest?.backup?.createdAt || null,
    engineName: manifest?.backup?.engine || null,
    id: manifest?.backup?.id || id,
    locator,
    note: note || null,
    schemaVersion: manifest?.backup?.schemaVersion || null,
    sizeBytes: rawBytes,
    sourceCommit: manifest?.source?.commit || null,
    sourceDomain: manifest?.source?.domain || null,
    sourceHostname: manifest?.source?.hostname || null,
    sourceInstallId: manifest?.source?.installId || null,
    sourceVersion: manifest?.source?.version || null,
    volumeCount: volumes.length,
  };
}

// --- Destinations -----------------------------------------------------------

class DiskDestination {
  constructor({ engine, label, mountPath, system }) {
    this.engine = engine;
    this.id = mountPath;
    this.kind = 'disk';
    this.label = label || mountPath;
    this.mountPath = mountPath;
    this.points = new DiskRestorePoints(mountPath);
    this.system = system;
    this.lockedAtMs = 0;
    this.lockedState = null;
  }

  get noun() { return 'drive'; }

  repositorySpec() {
    const localPath = repositoryPathFor(this.mountPath);
    return { env: {}, localPath, location: localPath, secrets: [] };
  }

  // A drive proves itself by being mounted and writable, which the destination
  // listing already establishes without any engine call. The one thing left
  // that costs one is whether the repository on it opens with this machine's
  // key, so it is asked only when there is a repository to ask about and at
  // most once per index interval — the destination listing is polled, and a
  // process per drive per poll is not a thing to do to a machine.
  async health() {
    if (!readRepositoryDescriptor(this.mountPath)) return { locked: false };
    if (this.lockedState && Date.now() - this.lockedAtMs < OBJECT_INDEX_TTL_MS) return this.lockedState;
    let probe;
    try {
      probe = await this.engine.probe(this.repositorySpec());
    } catch {
      return { locked: false };
    }
    this.lockedAtMs = Date.now();
    this.lockedState = probe.state === 'locked' ? { locked: true, reason: probe.message } : { locked: false };
    return this.lockedState;
  }

  get lostMessage() {
    return 'The backup drive was disconnected while MOS was writing to it, so this did not finish. Reconnect the drive, click Refresh drives, and try again.';
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
    const health = await this.health();
    if (health.locked) throw new Error(health.reason);
  }

  writable() {
    try {
      fs.accessSync(this.mountPath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  // The destination directory outlives its mount, so without this check a
  // detached drive turns backups into silent writes onto the system disk —
  // reported as success and invisible in the backup list.
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

  async repository({ create = true } = {}) {
    assertRepositoryEngine(this.mountPath, this.engine.name);
    const localPath = repositoryPathFor(this.mountPath);
    // The description goes down before the repository is created: a crash
    // between the two leaves a described-but-empty destination that the same
    // engine quietly finishes creating next time, while the wrong-engine
    // refusal above is armed the whole way. The other order leaves a repository
    // no descriptor guards.
    if (create && !readRepositoryDescriptor(this.mountPath)) {
      writeRepositoryDescriptor(this.mountPath, {
        createdAt: new Date().toISOString(),
        engineName: this.engine.name,
        format: 'Encrypted, deduplicating content-addressed repository. Restoring it needs MOS and this repository password.',
        repositoryId: crypto.randomUUID(),
      });
    }
    const repository = await this.engine.openOrCreateRepository({
      create,
      localPath,
      location: localPath,
      missingMessage: 'The encrypted backup store is missing from this drive, so this backup cannot be read. Check that the right drive is connected and that its MOS-backups folder is intact.',
    });
    assertRepositoryUnlocked(repository);
    return { ...repository, descriptor: readRepositoryDescriptor(this.mountPath), destinationId: this.id };
  }

  // Removing the repository a failed first backup created is safe only on a
  // drive, where MOS made the directory and can see it is the one it made.
  async discardCreatedRepository() {
    fs.rmSync(repositoryPathFor(this.mountPath), { force: true, recursive: true });
    fs.rmSync(repositorySidecarPath(this.mountPath), { force: true });
  }

  descriptorRepositoryId() { return readRepositoryDescriptor(this.mountPath)?.repositoryId || null; }
}

class ObjectDestination {
  constructor({ agentStateDir, engine, record }) {
    this.agentStateDir = agentStateDir;
    this.engine = engine;
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

  repositorySpec() { return { ...this.spec, localPath: null }; }

  get lostMessage() {
    return 'MOS lost contact with the storage provider while writing this backup, so it did not finish. Check this server\'s internet connection, then try again.';
  }

  async available() {
    return (await this.engine.probeRepository(this.spec)).state !== 'unreachable';
  }

  // The engine's own verdict is the message: it names the difference between a
  // refused key, an unreachable host and a bucket that is simply empty, which
  // is exactly what an owner needs to fix and what a sentence written here
  // could only blur.
  async assertAvailable() {
    const probe = await this.engine.probe(this.spec);
    if (probe.state === 'unreachable') throw Object.assign(new Error(probe.message), { engineOutput: probe.output || null });
    if (probe.state === 'locked') throw Object.assign(new Error(probe.message), { repositoryLocked: true });
  }

  // Deliberately nothing. A drive needs proving still mounted before the
  // manifest is written, because the directory survives the drive and the
  // write would silently land on the system disk. A bucket has no such shadow:
  // the manifest goes into the repository itself, so the write is its own
  // proof, and probing again here would let one dropped packet discard a
  // backup that had already succeeded.
  async assertStillWritable() {}

  // Object storage sells capacity by what is stored rather than reserving it,
  // so there is no free-space number to check a backup against. The engine
  // reports if a bucket genuinely refuses a write.
  async freeBytes() { return null; }

  async repository({ create = true } = {}) {
    if (this.openRepository) return this.openRepository;
    const repository = await this.engine.openOrCreateRepository({
      ...this.spec,
      create,
      missingMessage: 'There is no MOS backup store in this bucket yet, so there is nothing here to read.',
    });
    // Not held, and not handed out: the caller is about to read or write with
    // it, and the next look must ask again because the owner may have entered
    // the key that opens it in between.
    assertRepositoryUnlocked(repository);
    this.openRepository = { ...repository, destinationId: this.id };
    return this.openRepository;
  }

  // Never. MOS did not create the bucket and cannot tell what else an owner
  // keeps in it, so a failed first backup leaves the repository in place and
  // takes only its own snapshots back out.
  async discardCreatedRepository() {}

  descriptorRepositoryId() { return this.loadIndex()?.repositoryId || null; }

  indexPath() {
    return path.join(this.agentStateDir, OBJECT_INDEX_DIRNAME, `${this.id.replace(/[^A-Za-z0-9_-]+/gu, '-')}.json`);
  }

  // The file is the truth, not the copy in memory. A backup runs in its own
  // worker process and records the restore point it just wrote there, so an
  // agent that trusted its own memory kept reporting a bucket as empty for the
  // whole refresh interval after a backup into it had already succeeded. The
  // modification time is what makes re-reading cheap enough to do on every
  // look.
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

  // Refreshes only what it must: a manifest is immutable once written, so a
  // point whose manifest snapshot id is unchanged is never fetched again, and
  // an established bucket costs one listing per refresh rather than one read
  // per backup it holds.
  emptyIndex() {
    return { fetchedAt: new Date().toISOString(), fetchedAtMs: Date.now(), location: this.spec.location, points: {}, repositoryId: null, storedBytes: null };
  }

  async readIndex({ force = false } = {}) {
    const current = this.loadIndex();
    if (!force && current && Date.now() - current.fetchedAtMs < OBJECT_INDEX_TTL_MS) return current;
    let repository;
    try {
      repository = await this.repository({ create: false });
    } catch (error) {
      // A bucket MOS has never written to holds no backups, which is an answer
      // rather than a failure. Anything else — a refused key, an unreachable
      // host — is the caller's to report.
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
      // An interrupted note edit can leave two note snapshots for one point.
      // The newest is the note the owner last saved.
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

  // A document that will not read leaves its point in the index without one,
  // which lists the backup and refuses to restore it — the honest outcome, and
  // better than one unreadable manifest hiding every other backup in a bucket.
  async readDocument(repository, snapshotId, filename, parse) {
    try {
      return parse(await this.engine.readDocument({ filename, repository, snapshotId }));
    } catch {
      return null;
    }
  }

  // Recording a point MOS just wrote is not the same as having listed the
  // bucket, so an index invented here is dated to the epoch: the point shows up
  // immediately, and a real refresh is still owed. Dating it now would let one
  // known point stand in for everything else in the bucket until the interval
  // expired.
  async rememberPoint(pointId, entry) {
    const current = this.loadIndex() || { fetchedAt: new Date(0).toISOString(), fetchedAtMs: 0, location: this.spec.location, points: {}, repositoryId: null, storedBytes: null };
    this.saveIndex({ ...current, points: { ...current.points, [pointId]: { note: null, noteSnapshotId: null, ...entry } } });
  }

  async forgetPoint(pointId) {
    const current = this.loadIndex();
    if (!current) return;
    const points = { ...current.points };
    delete points[pointId];
    this.saveIndex({ ...current, points });
  }

  // Everything a bucket can say about itself without being asked again.
  usage() {
    const index = this.loadIndex();
    if (!index) return null;
    return { engineName: this.engine.name, restorePoints: Object.keys(index.points).length, storedBytes: index.storedBytes ?? null };
  }

  // Whether the backups screen can offer this bucket, answered from the last
  // refresh rather than by asking again. The screen polls, and a network round
  // trip per poll would make an open Backups page a steady stream of requests
  // against an owner's storage bill. Only the very first call blocks; after
  // that a stale index is refreshed behind the answer.
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
    return {
      checkedAt: index?.fetchedAt || null,
      locked: this.lastLocked,
      ready: Boolean(index) && !this.lastError,
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

// Destinations are held between requests rather than rebuilt: an open
// repository handle and a bucket's index are both worth keeping, and rebuilding
// them per request would mean a network round trip on every poll of the backups
// screen. The fingerprint drops a destination as soon as its settings change.
class DestinationResolver {
  constructor({ agentStateDir, engine, objectRegistry, resolveDiskLabel, system }) {
    this.agentStateDir = agentStateDir;
    this.disks = new Map();
    this.engine = engine;
    this.objectRegistry = objectRegistry;
    this.objects = new Map();
    this.resolveDiskLabel = resolveDiskLabel || (() => null);
    this.system = system;
  }

  objectRecords() { return this.objectRegistry ? this.objectRegistry.list() : []; }

  objectDestination(record) {
    const fingerprint = JSON.stringify([record.accessKeyId, record.bucket, record.endpoint, record.folder, record.region, record.secretAccessKey]);
    const held = this.objects.get(record.id);
    if (held && held.fingerprint === fingerprint) {
      held.destination.label = record.label;
      return held.destination;
    }
    const destination = new ObjectDestination({ agentStateDir: this.agentStateDir, engine: this.engine, record });
    this.objects.set(record.id, { destination, fingerprint });
    return destination;
  }

  forget(id) {
    this.disks.delete(id);
    this.objects.delete(id);
  }

  // After this machine's key changes, every held answer about what it opens is
  // stale at once.
  forgetAll() {
    this.disks.clear();
    this.objects.clear();
  }

  // Held between requests like a bucket, and for the same reason: a drive that
  // has answered whether its repository opens with this machine's key must not
  // be asked again on every poll of the backups screen.
  diskDestination(mountPath) {
    const label = this.resolveDiskLabel(mountPath);
    const held = this.disks.get(mountPath);
    if (held) {
      if (label) held.label = label;
      return held;
    }
    const destination = new DiskDestination({ engine: this.engine, label, mountPath, system: this.system });
    this.disks.set(mountPath, destination);
    return destination;
  }

  // Throws rather than returning null: every caller is about to act on the
  // destination, and "which drive did you mean" is the answer to give once.
  resolve(destinationId) {
    if (isObjectDestinationId(destinationId)) {
      const record = this.objectRecords().find((entry) => entry.id === destinationId);
      if (!record) throw new Error('That storage connection no longer exists. Choose a destination and try again.');
      return this.objectDestination(record);
    }
    // Which paths are acceptable destinations is settled before a job exists
    // (normalizeDestinationId in agent.cjs holds the /media, /mnt, /run/media
    // rule); by here the only question left is which kind of thing this is.
    if (typeof destinationId === 'string' && path.isAbsolute(destinationId)) return this.diskDestination(destinationId);
    throw new Error('Choose a backup destination and try again.');
  }

  objectDestinations() { return this.objectRecords().map((record) => this.objectDestination(record)); }
}

module.exports = {
  DestinationResolver,
  DiskDestination,
  DiskRestorePoints,
  MANIFEST_FILENAME,
  NOTE_FILENAME,
  objectLocator,
  ObjectDestination,
  OBJECT_INDEX_TTL_MS,
  parseObjectLocator,
  readRestorePoint,
  sha256,
  summarize,
  writeRestorePoint,
};
