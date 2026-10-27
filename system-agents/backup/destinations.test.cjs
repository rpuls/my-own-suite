// Restore points in a bucket, which have no files: the manifest and the note
// are snapshots inside the repository, and what MOS knows about them between
// requests is a local index. These tests are about the two things that go wrong
// with that arrangement — an index that disagrees with the bucket, and a bucket
// that stops answering — plus the guarantee retention depends on, which is that
// a scheduled backup can still be told from one an owner took.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DestinationResolver, objectLocator, OBJECT_INDEX_TTL_MS, ObjectArchive, parseObjectLocator } = require('./destinations.cjs');
const { repositorySidecarPath, writeRepositoryDescriptor } = require('./engines/engine.cjs');
const { normalizeObjectDestination, objectRepositorySpec } = require('./object-destinations.cjs');

const ARCHIVE = 'archive-0000beef';

const CONNECTION = Object.freeze({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  bucket: 'mos-backups',
  endpoint: 'https://s3.example.com',
  folder: 'home',
  secretAccessKey: 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY',
});

const LOCKED_MESSAGE = "This bucket holds MOS backups written by another server. Enter that server's recovery key to use them here.";

// An in-memory bucket behind the engine surface an archive uses. Snapshots carry
// tags and a time, documents are addressed by snapshot and filename, and every
// document read is recorded so the index's re-read behaviour is testable. Each
// repository remembers the key it was made with, so two engines over one map are
// two servers sharing a bucket; `locked` turns every key away at once.
class FakeObjectEngine {
  constructor({ key = 'MOS-THIS', repositories = new Map() } = {}) {
    this.counter = 0;
    this.key = key;
    this.locked = false;
    this.offline = false;
    this.reads = [];
    this.repositories = repositories;
  }

  get name() { return 'restic'; }

  async probe(spec) { return this.probeRepository(spec); }

  probeRepository({ location, password = null }) {
    if (this.offline) return { message: 'MOS could not reach the storage provider.', state: 'unreachable' };
    const repository = this.repositories.get(location);
    if (!repository) return { message: 'unable to open config file', state: 'absent' };
    if (this.locked || repository.key !== (password || this.key)) return { message: LOCKED_MESSAGE, state: 'locked' };
    return { repositoryId: repository.repositoryId, state: 'open' };
  }

  async openOrCreateRepository({ create = true, env = {}, localPath = null, location, missingMessage, password = null, secrets = [] }) {
    const probe = this.probeRepository({ location, password });
    if (probe.state === 'unreachable') throw new Error(probe.message);
    if (probe.state === 'locked') return { created: false, engineName: this.name, env, localPath, location, locked: true, lockedMessage: LOCKED_MESSAGE, repositoryId: null, secrets };
    const created = probe.state === 'absent';
    if (created) {
      if (!create || password) throw Object.assign(new Error(missingMessage || 'no repository'), { repositoryAbsent: true });
      this.make(location, this.key);
    }
    return { created, engineName: this.name, env, localPath, location, repositoryId: this.repositories.get(location).repositoryId, secrets };
  }

  async openPublicRepository({ create = false, env = {}, location, password, secrets = [] }) {
    if (this.offline) throw new Error('MOS could not reach the storage provider.');
    if (!this.repositories.has(location)) {
      if (!create) return null;
      this.make(location, password);
    }
    return { engineName: this.name, env, localPath: null, location, password, secrets };
  }

  make(location, key) {
    this.repositories.set(location, { documents: new Map(), key, repositoryId: `repo-${this.repositories.size + 1}`, snapshots: new Map() });
  }

  at(repository) {
    if (this.offline) throw new Error('MOS could not reach the storage provider.');
    return this.repositories.get(repository.location);
  }

  async listSnapshots({ repository }) {
    return [...this.at(repository).snapshots.entries()]
      .map(([snapshotId, entry]) => ({ createdAt: entry.createdAt, snapshotId, sourcePath: null, tags: entry.tags }));
  }

  async snapshotDocument({ content, filename, repository, tags }) {
    this.counter += 1;
    const snapshotId = `snap-${this.key}-${String(this.counter).padStart(3, '0')}`;
    const store = this.at(repository);
    store.snapshots.set(snapshotId, {
      createdAt: new Date(Date.UTC(2026, 0, this.counter)).toISOString(),
      tags: Object.entries(tags).map(([key, value]) => `${key}:${value}`),
    });
    store.documents.set(`${snapshotId}/${filename}`, content);
    return { snapshotId };
  }

  async readDocument({ filename, repository, snapshotId }) {
    this.reads.push(snapshotId);
    const document = this.at(repository).documents.get(`${snapshotId}/${filename}`);
    if (document === undefined) throw new Error(`no document ${filename} in ${snapshotId}`);
    return document;
  }

  async forgetSnapshots({ repository, snapshotIds }) {
    const store = this.at(repository);
    for (const snapshotId of snapshotIds) store.snapshots.delete(snapshotId);
  }

  async repositoryStats() { return { storedBytes: 4096 }; }
}

function manifestFor(id, { initiator = 'owner', updateTarget = null } = {}) {
  return {
    backup: { createdAt: `2026-09-0${id.slice(-1)}T03:00:00.000Z`, engine: 'restic', id, initiator, kind: 'mos-whole-suite', schemaVersion: 4, updateTarget },
    contents: { apps: [{ packageId: 'immich' }], stateRawBytes: 1000, volumes: [{ name: 'mos-app-immich-data', rawBytes: 2000 }] },
    source: { domain: 'mos.example.com', hostname: 'mos-home', installId: 'install-one', version: '0.20.0' },
  };
}

async function bucket({ engine = new FakeObjectEngine(), stateDir } = {}) {
  const agentStateDir = stateDir || await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-bucket-'));
  const record = normalizeObjectDestination(CONNECTION);
  return { agentStateDir, destination: new ObjectArchive({ agentStateDir, engine, name: ARCHIVE, record }), engine, record };
}

// Reopening the same connection means a new archive object over the same state
// directory, which is what the agent does across a restart.
function reopen({ agentStateDir, engine, record }) {
  return new ObjectArchive({ agentStateDir, engine, name: ARCHIVE, record });
}

test('a locator names an archive and a point, and anything malformed is refused', () => {
  const locator = objectLocator(`object:abc123/${ARCHIVE}`, '7d0e-4f11');
  assert.deepEqual(parseObjectLocator(locator), { archiveId: `object:abc123/${ARCHIVE}`, placeId: 'object:abc123', pointId: '7d0e-4f11' });
  assert.deepEqual(parseObjectLocator('object:abc123/repository#7d0e'), { archiveId: 'object:abc123/repository', placeId: 'object:abc123', pointId: '7d0e' });
  for (const bad of ['/media/mos-backup/MOS-backups/restore-points/x.json', 'object:abc123#id', 'object:abc123/catalog#id', 'object:abc123/archive-1#id', `object:/${ARCHIVE}#id`, 'objectabc#id', '', null, `object:abc/${ARCHIVE}#../escape`]) {
    assert.equal(parseObjectLocator(bad), null, `accepted ${bad}`);
  }
});

test('a manifest written to a bucket comes back from a listing of the bucket alone', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1'));
  await world.destination.points.writeNote('point-1', 'Before the upgrade');

  // A second agent has none of the first one's memory beyond the state
  // directory; delete the index so it must rebuild from the bucket.
  fs.rmSync(world.destination.indexPath(), { force: true });
  const rebuilt = reopen(world);
  const summaries = await rebuilt.points.summaries();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, 'point-1');
  assert.equal(summaries[0].note, 'Before the upgrade');
  assert.equal(summaries[0].appCount, 1);
  assert.equal(summaries[0].sizeBytes, 3000);
  assert.equal(summaries[0].locator, objectLocator(`${world.record.id}/${ARCHIVE}`, 'point-1'));
  assert.equal(summaries[0].sourceDomain, 'mos.example.com');
  assert.equal(summaries[0].sourceHostname, 'mos-home');
  assert.equal(summaries[0].sourceInstallId, 'install-one');
  assert.deepEqual(await rebuilt.points.read('point-1'), manifestFor('point-1'));
});

test('an unchanged manifest is never fetched twice, and a lost index is rebuilt', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1'));
  await world.destination.points.write('point-2', manifestFor('point-2'));
  await world.destination.readIndex({ force: true });

  // Reopening reads the index off disk: the manifests are already known.
  const reopened = reopen(world);
  world.engine.reads.length = 0;
  await reopened.readIndex({ force: true });
  assert.deepEqual(world.engine.reads, [], 'refetched manifests it already had');

  // With the index gone, both have to be read back — once each.
  fs.rmSync(reopened.indexPath(), { force: true });
  const rebuilt = reopen(world);
  await rebuilt.readIndex({ force: true });
  assert.equal(world.engine.reads.length, 2);
  assert.equal(new Set(world.engine.reads).size, 2);
});

test('a note is stored apart from the manifest, and only the newest one counts', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1'));
  await world.destination.points.writeNote('point-1', 'First note');
  await world.destination.points.writeNote('point-1', 'Second note');

  const location = objectRepositorySpec(world.record, ARCHIVE).location;
  const noteSnapshots = [...world.engine.repositories.get(location).snapshots.values()].filter((entry) => entry.tags.includes('mosrole:note'));
  assert.equal(noteSnapshots.length, 1, 'the replaced note snapshot was left behind');

  fs.rmSync(world.destination.indexPath(), { force: true });
  assert.equal((await reopen(world).points.summaries())[0].note, 'Second note');
  // Clearing a note leaves the restore point itself untouched.
  await world.destination.points.writeNote('point-1', '');
  fs.rmSync(world.destination.indexPath(), { force: true });
  const cleared = reopen(world);
  const [point, ...others] = await cleared.points.summaries();
  assert.equal(point.note, null);
  assert.equal(others.length, 0);
});

test('removing a restore point takes its manifest and its note out of the bucket', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1'));
  await world.destination.points.writeNote('point-1', 'Keep me until deleted');
  await world.destination.points.write('point-2', manifestFor('point-2'));

  assert.equal((await world.destination.points.snapshotIds('point-1')).length, 2);
  await world.destination.points.remove('point-1');
  assert.deepEqual((await world.destination.points.summaries()).map((point) => point.id), ['point-2']);

  fs.rmSync(world.destination.indexPath(), { force: true });
  assert.deepEqual((await reopen(world).points.summaries()).map((point) => point.id), ['point-2']);
});

test('retention can still tell a scheduled backup from one an owner took', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1', { initiator: 'schedule' }));
  await world.destination.points.write('point-2', manifestFor('point-2'));
  const summaries = await world.destination.points.summaries();
  assert.deepEqual(summaries.map((point) => [point.id, point.automatic]).sort(), [['point-1', true], ['point-2', false]]);
});

test('a backup taken before an update is listed as automatic and says which update', async () => {
  const world = await bucket();
  await world.destination.points.write('point-3', manifestFor('point-3', { initiator: 'update', updateTarget: '0.20.0' }));
  const [point] = await world.destination.points.summaries();
  assert.equal(point.automatic, true, 'retention counts it, and its newest is what retention spares');
  assert.equal(point.initiator, 'update');
  assert.equal(point.updateTarget, '0.20.0');
});

test('a bucket with no MOS store in it yet lists nothing instead of failing', async () => {
  const world = await bucket();
  assert.deepEqual(await world.destination.points.summaries(), []);
  assert.equal((await world.destination.health()).ready, true);
  assert.equal(await world.destination.points.count(), 0);
});

// The screen keeps showing what is in a bucket while the bucket is unreachable,
// and says why it cannot be used. Hiding the backups would tell an owner
// looking for something to restore that they have nothing.
test('an unreachable bucket keeps the last known list and reports why it is not ready', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1'));
  await world.destination.readIndex({ force: true });

  world.engine.offline = true;
  const reopened = reopen(world);
  const health = await reopened.health();
  assert.deepEqual((await reopened.points.summaries()).map((point) => point.id), ['point-1']);
  // The first health call after a reopen serves the stored index; the refresh
  // it triggers is what discovers the outage.
  await reopened.refreshInBackground();
  const afterRefresh = await reopened.health();
  assert.equal(afterRefresh.ready, false);
  assert.match(afterRefresh.reason, /could not reach/iu);
  assert.equal(health.usage.restorePoints, 1);

  world.engine.offline = false;
  await reopened.refreshInBackground();
  assert.equal((await reopened.health()).ready, true);
});

test('a bucket that has never answered is asked once an interval, not on every poll', async () => {
  const world = await bucket();
  world.engine.offline = true;
  let asked = 0;
  const probe = world.engine.probeRepository.bind(world.engine);
  world.engine.probeRepository = (spec) => { asked += 1; return probe(spec); };

  assert.equal((await world.destination.health()).ready, false);
  const afterFirst = asked;
  assert.ok(afterFirst > 0);
  assert.equal((await world.destination.health()).ready, false);
  assert.equal(asked, afterFirst);
});

test('a bucket never reports free space, so a backup is not refused against a number nobody has', async () => {
  const world = await bucket();
  assert.equal(await world.destination.freeBytes(), null);
  // A drive proves it is still mounted before the manifest is written; a bucket
  // proves itself by accepting the write, so this must not add a second way to
  // fail after the data is already stored.
  await world.destination.assertStillWritable('unused');
  world.engine.offline = true;
  await assert.rejects(() => world.destination.assertAvailable(), /could not reach/iu);
});

// A backup runs in a worker process of its own and records the restore point
// it wrote there. The agent process, which is what the Backups screen asks,
// must see that immediately — trusting its own memory instead made a bucket
// keep reporting itself empty for the whole refresh interval after a backup
// into it had already succeeded.
test('a restore point written by another process shows up at once, in an archive that is no longer empty', async () => {
  const world = await bucket();
  await world.destination.readIndex({ force: true });
  assert.deepEqual(await world.destination.points.summaries(), []);

  // The worker: same state directory and bucket, its own object.
  const worker = reopen(world);
  await worker.points.write('point-1', manifestFor('point-1'));

  // The agent, without a refresh and well inside the interval it would
  // otherwise wait out.
  assert.deepEqual((await world.destination.points.summaries()).map((point) => point.id), ['point-1']);
  assert.equal(world.destination.usage().restorePoints, 1);
  assert.equal((await world.destination.health()).keyState, 'own');
});

// The Backups screen polls; a bucket that stopped answering held every poll for
// as long as restic kept retrying, so the page showed nothing at all.
test('a bucket that stops answering still lists what it last held, at once', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1'));
  await world.destination.readIndex({ force: true });
  const stale = Date.now() - OBJECT_INDEX_TTL_MS - 1000;
  world.destination.saveIndex({ ...world.destination.loadIndex(), fetchedAt: new Date(stale).toISOString(), fetchedAtMs: stale });
  world.engine.listSnapshots = () => new Promise(() => {});

  assert.deepEqual((await world.destination.points.summaries()).map((point) => point.id), ['point-1']);
});

// Recording a point MOS just wrote is not the same as having listed the bucket.
// When there was no index to add to, the one invented for it must not be dated
// now, or a single known point would stand in for everything else in the bucket
// until the refresh interval expired.
test('a point recorded with no index behind it still leaves a full listing owed', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1'));
  // Dated to the epoch, so it is stale the moment it is written...
  assert.equal(world.destination.loadIndex().fetchedAtMs, 0);
  // ...which makes the very next look list the bucket instead of trusting it.
  assert.deepEqual((await world.destination.points.summaries()).map((point) => point.id), ['point-1']);
  assert.ok(Date.now() - world.destination.loadIndex().fetchedAtMs < OBJECT_INDEX_TTL_MS);

  // And a point another process adds after that is still seen straight away.
  await reopen(world).points.write('point-2', manifestFor('point-2'));
  assert.deepEqual((await world.destination.points.summaries()).map((point) => point.id).sort(), ['point-1', 'point-2']);
});

// A destination holding another server's backups is one recovery key away from
// being usable. Reporting that as "MOS could not reach this storage" is what
// made a replacement machine pointed at a surviving bucket look broken at the
// exact moment recovery depended on it.
test('a bucket written by another server is reported locked, not unreachable', async () => {
  const world = await bucket();
  await world.destination.points.write('point-1', manifestFor('point-1'));
  await world.destination.readIndex({ force: true });

  world.engine.locked = true;
  const reopened = reopen(world);
  await reopened.refreshInBackground();
  const health = await reopened.health();
  assert.equal(health.ready, false);
  assert.equal(health.keyState, 'locked');
  assert.match(health.reason, /written by another server/u);
  assert.match(health.reason, /recovery key/u);
  // And nothing hands the locked repository on to something that would read or
  // write with it: a backup aimed here is refused, not met with whatever the
  // engine says about a wrong password.
  await assert.rejects(() => reopened.repository({ create: false }), /written by another server/u);
  await assert.rejects(() => reopened.assertAvailable(), { code: 'DESTINATION_FOREIGN', message: /another server/u });

  // And the moment the key is entered it is a normal bucket again — the locked
  // repository is never held on to.
  world.engine.locked = false;
  await reopened.refreshInBackground();
  const unlocked = await reopened.health();
  assert.equal(unlocked.keyState, 'own');
  assert.equal(unlocked.ready, true);
});

const DRIVE = 'TEST-DRIVE-0001';

function drives() {
  const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-media-'));
  return { mountRoot, mountPath: path.join(mountRoot, DRIVE) };
}

function fullRepository(root) {
  fs.mkdirSync(path.join(root, 'repository'), { recursive: true });
  fs.writeFileSync(path.join(root, 'repository', 'config'), '{"id":"abc"}');
}

function describedRepository(root, repositoryId = 'r1') {
  writeRepositoryDescriptor(root, { engineName: 'restic', repositoryId });
  fullRepository(root);
}

// An archive the way the agent reaches one: through the resolver, by its id.
function diskArchive({ engine, guest = () => null, mountRoot }) {
  return new DestinationResolver({ engine, guestKeys: { keyFor: guest }, mountRoot }).resolve(`${DRIVE}/archive-0000beef`);
}

// Whose key opens an archive on a drive is asked the only way it can be: by
// trying this machine's key against the repository there.
test('an archive on a drive another server made is reported locked, at most once per interval', async () => {
  const { mountRoot } = drives();
  const probes = [];
  const engine = {
    name: 'restic',
    async probe({ localPath, location }) {
      probes.push({ localPath, location });
      return { message: "This drive holds MOS backups written by another server. Enter that server's recovery key to use them here.", state: 'locked' };
    },
  };
  const archive = diskArchive({ engine, mountRoot });

  // An archive with nothing written yet costs nothing to judge.
  assert.deepEqual(await archive.health(), { keyState: 'empty' });
  assert.equal(probes.length, 0);

  describedRepository(archive.root);
  const health = await archive.health();
  assert.equal(health.keyState, 'locked');
  assert.match(health.reason, /written by another server/u);
  // The listing is polled, so the answer is held rather than spawning a process per archive per look.
  await archive.health();
  assert.equal(probes.length, 1);
  assert.equal(probes[0].localPath, probes[0].location);
  await assert.rejects(() => archive.assertAvailable(), { code: 'DESTINATION_FOREIGN' });
});

test('a key adopted or dropped by another process is not answered from the held key state', async () => {
  const { mountRoot } = drives();
  const keyFile = path.join(mountRoot, 'engine-key');
  fs.writeFileSync(keyFile, 'MOS-OLD');
  let guest = 'MOS-BORROWED';
  const engine = { keyFile, name: 'restic', async probe() { return { state: 'open' }; } };
  const archive = diskArchive({ engine, guest: () => guest, mountRoot });
  describedRepository(archive.root);
  assert.equal((await archive.health()).keyState, 'borrowed');

  guest = null;
  fs.writeFileSync(keyFile, 'MOS-ADOPTED');
  fs.utimesSync(keyFile, new Date(), new Date(Date.now() + 5000));
  assert.equal((await archive.health()).keyState, 'own');
});

// A first backup writes the descriptor before the repository, so a poll in
// between sees an archive with nothing to open yet: a moment, not an answer to hold.
test('an archive seen between its descriptor and its repository is empty, and asked again once the repository is there', async () => {
  const { mountRoot } = drives();
  const probes = [];
  const engine = { name: 'restic', async probe() { probes.push(1); return { state: 'open' }; } };
  const archive = diskArchive({ engine, mountRoot });
  writeRepositoryDescriptor(archive.root, { engineName: 'restic', repositoryId: 'r1' });
  assert.equal((await archive.health()).keyState, 'empty');
  assert.equal(probes.length, 0, 'nothing to probe yet');
  fullRepository(archive.root);
  assert.equal((await archive.health()).keyState, 'own');
});

// A descriptor torn by a pulled drive must neither hide the repository behind it
// nor let the next backup start a second archive beside it.
test('a torn or missing descriptor over a full repository is a stated fact, not an empty archive', async () => {
  const { mountRoot, mountPath } = drives();
  const engine = { name: 'restic', async probe() { return { state: 'open' }; } };
  const resolver = new DestinationResolver({ engine, mountRoot });
  const torn = path.join(mountPath, 'MOS-backups', 'archive-00000001');
  fullRepository(torn);
  fs.writeFileSync(repositorySidecarPath(torn), '{"engineName":"res');

  assert.deepEqual((await resolver.archivesIn(DRIVE)).map((archive) => archive.name), ['archive-00000001']);
  const archive = resolver.resolve(`${DRIVE}/archive-00000001`);
  assert.equal(archive.descriptor(), null);
  assert.equal((await archive.health()).keyState, 'own');
  assert.equal((await resolver.target(DRIVE)).id, `${DRIVE}/archive-00000001`, 'the next backup goes into the archive this key opens');
});

test('an undescribed archive this server\'s key does not open stops a new archive being made beside it', async () => {
  const { mountRoot, mountPath } = drives();
  const engine = { name: 'restic', async probe() { return { message: 'locked', state: 'locked' }; } };
  const resolver = new DestinationResolver({ engine, mountRoot });
  fullRepository(path.join(mountPath, 'MOS-backups', 'archive-00000001'));
  await assert.rejects(() => resolver.target(DRIVE), { code: 'DESTINATION_UNDESCRIBED_ARCHIVE', message: /archive-00000001 .*lost its description/u });

  // Described and locked is simply another server's: this server writes beside it.
  writeRepositoryDescriptor(path.join(mountPath, 'MOS-backups', 'archive-00000001'), { engineName: 'restic', repositoryId: 'theirs' });
  assert.match((await resolver.target(DRIVE)).name, /^archive-[0-9a-f]{8}$/u);
});

test('an archive opened with another server\'s key is read from but never backed up into', async () => {
  const { mountRoot } = drives();
  const engine = { name: 'restic', async probe() { return { state: 'open' }; } };
  const archive = diskArchive({ engine, guest: () => 'MOS-BORROWED', mountRoot });
  describedRepository(archive.root);
  assert.equal((await archive.health()).keyState, 'borrowed');
  await assert.rejects(() => archive.assertAvailable(), { code: 'DESTINATION_FOREIGN' });

  const world = await bucket();
  const borrowed = new ObjectArchive({ agentStateDir: world.agentStateDir, engine: world.engine, guestKey: () => 'MOS-BORROWED', name: ARCHIVE, record: world.record });
  await assert.rejects(() => borrowed.assertAvailable(), { code: 'DESTINATION_FOREIGN', message: /another server/u });
});

// One drive can carry this server's archive beside archives other servers
// made, so a drive is never refused for what someone else left on it.
test('this server backs up into its own archive on a drive, beside other servers\' archives', async () => {
  const { mountRoot, mountPath } = drives();
  const owners = { 'archive-00000001': 'locked', 'archive-00000002': 'open' };
  const engine = { name: 'restic', async probe({ localPath }) { return { state: owners[path.basename(path.dirname(localPath))] }; } };
  const resolver = new DestinationResolver({ engine, mountRoot });
  assert.match((await resolver.target(DRIVE)).name, /^archive-[0-9a-f]{8}$/u, 'a drive with nothing on it gets a new archive');

  for (const name of Object.keys(owners)) describedRepository(path.join(mountPath, 'MOS-backups', name), name);
  fs.mkdirSync(path.join(mountPath, 'MOS-backups', 'Not an archive'), { recursive: true });
  assert.deepEqual((await resolver.archivesIn(DRIVE)).map((archive) => archive.name), ['archive-00000001', 'archive-00000002']);
  assert.equal((await resolver.target(DRIVE)).id, `${DRIVE}/archive-00000002`);
  const point = path.join(mountPath, 'MOS-backups', 'archive-00000001', 'restore-points', 'job-1.json');
  assert.equal(resolver.archiveAt(path.dirname(path.dirname(point))).id, `${DRIVE}/archive-00000001`);
  assert.throws(() => resolver.resolve(`${DRIVE}/../etc`), /Choose a backup/u);
  assert.throws(() => resolver.archiveAt(path.join(mountRoot, '..')), /connected storage/u);
});

// --- Several servers in one bucket -------------------------------------------

// Two servers connected to one bucket: one map of repositories, two keys, two
// state directories, two registries holding the same connection.
async function sharedBucket() {
  const repositories = new Map();
  const record = normalizeObjectDestination(CONNECTION);
  const server = async (key, installId) => {
    const agentStateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-bucket-'));
    const engine = new FakeObjectEngine({ key, repositories });
    const resolver = new DestinationResolver({ agentStateDir, createdBy: () => ({ hostname: `${installId}-host`, installId }), engine, objectRegistry: { list: () => [record] } });
    return { engine, resolver };
  };
  return { record, repositories, one: await server('MOS-ONE', 'install-one'), two: await server('MOS-TWO', 'install-two') };
}

// A catalog is asked again only once its interval has passed.
function letIntervalPass(server, record) {
  const catalog = server.resolver.catalogOf(record);
  catalog.save({ ...catalog.load(), fetchedAt: new Date(0).toISOString(), fetchedAtMs: 0 });
}

test('a bucket holds each server\'s archive beside the others, and each server finds every one from the catalog', async () => {
  const { one, record, two } = await sharedBucket();
  assert.deepEqual(await one.resolver.archivesIn(record.id), [], 'a bucket nothing was written to holds no archives');

  const first = await one.resolver.target(record.id);
  await first.points.write('point-1', manifestFor('point-1'));
  assert.match(first.id, new RegExp(`^${record.id}/archive-[0-9a-f]{8}$`, 'u'));

  // The second server sees the first one's archive, locked to it, and backs up beside it.
  const seen = await two.resolver.archivesIn(record.id, { wait: true });
  assert.deepEqual(seen.map((archive) => archive.id), [first.id]);
  assert.equal((await seen[0].health()).keyState, 'locked');
  assert.deepEqual(seen[0].entry && [seen[0].entry.hostname, seen[0].entry.installId], ['install-one-host', 'install-one']);
  const second = await two.resolver.target(record.id);
  assert.notEqual(second.id, first.id);
  await second.points.write('point-2', manifestFor('point-2'));

  letIntervalPass(one, record);
  const listed = await one.resolver.archivesIn(record.id, { wait: true });
  assert.deepEqual(listed.map((archive) => archive.id).sort(), [first.id, second.id].sort());
  assert.equal((await one.resolver.target(record.id)).id, first.id, 'each server keeps writing into its own');
});

test('a backup cut off between the catalog and the repository is finished in the same archive, not started again beside it', async () => {
  const { one, record } = await sharedBucket();
  const started = await one.resolver.target(record.id);
  await started.catalog.ensure(started.name, { hostname: 'install-one-host', installId: 'install-one' });
  const again = await one.resolver.target(record.id);
  assert.equal(again.id, started.id);
});

test('the archive MOS 0.22 kept at the root of a bucket is found where it lies', async () => {
  const { one, record } = await sharedBucket();
  const legacy = objectRepositorySpec(record, 'repository').location;
  assert.match(legacy, /\/home\/MOS-backups\/repository$/u);
  one.engine.make(legacy, 'MOS-ONE');

  const [archive] = await one.resolver.archivesIn(record.id, { wait: true });
  assert.equal(archive.id, `${record.id}/repository`);
  assert.equal((await archive.health()).keyState, 'own', 'this server opens it with its own key');
  assert.equal(one.resolver.resolve(`${record.id}/repository`), archive);
  await archive.points.write('point-1', manifestFor('point-1'));
  assert.equal((await one.resolver.target(record.id)).id, archive.id, 'this server goes on writing into its 0.22 archive');
});

test('a bucket that does not answer is said to be unreachable, and its last list is kept', async () => {
  const { one, record } = await sharedBucket();
  const archive = await one.resolver.target(record.id);
  await archive.points.write('point-1', manifestFor('point-1'));
  await one.resolver.archivesIn(record.id, { wait: true });

  one.engine.offline = true;
  letIntervalPass(one, record);
  await assert.rejects(() => one.resolver.archivesIn(record.id, { wait: true }), /could not reach/u);
  assert.match(one.resolver.catalogProblem(record.id), /could not reach/u);
  assert.deepEqual((await one.resolver.archivesIn(record.id)).map((entry) => entry.id), [archive.id]);
});
