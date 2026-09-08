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

const { DiskDestination, objectLocator, OBJECT_INDEX_TTL_MS, ObjectDestination, parseObjectLocator } = require('./destinations.cjs');
const { writeRepositoryDescriptor } = require('./engines/engine.cjs');
const { normalizeObjectDestination, objectRepositorySpec } = require('./object-destinations.cjs');

const CONNECTION = Object.freeze({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  bucket: 'mos-backups',
  endpoint: 'https://s3.example.com',
  folder: 'home',
  secretAccessKey: 'wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY',
});

// An in-memory bucket behind the engine surface the destination uses. Snapshots
// carry tags and a time, documents are addressed by snapshot and filename, and
// every document read is recorded so the index's re-read behaviour is testable.
class FakeObjectEngine {
  constructor() {
    this.counter = 0;
    this.locked = false;
    this.offline = false;
    this.reads = [];
    this.repositories = new Map();
  }

  get name() { return 'restic'; }

  async probe(spec) { return this.probeRepository(spec); }

  probeRepository({ location }) {
    if (this.offline) return { message: 'MOS could not reach the storage provider.', state: 'unreachable' };
    if (this.locked) return { message: "This bucket holds MOS backups written by another server. Enter that server's recovery key to use them here.", state: 'locked' };
    const repository = this.repositories.get(location);
    return repository ? { repositoryId: repository.repositoryId, state: 'open' } : { message: 'unable to open config file', state: 'absent' };
  }

  async openOrCreateRepository({ create = true, env = {}, localPath = null, location, missingMessage, secrets = [] }) {
    const probe = this.probeRepository({ location });
    if (probe.state === 'unreachable') throw new Error(probe.message);
    if (this.locked) return { created: false, engineName: this.name, env, localPath, location, locked: true, lockedMessage: "This bucket holds MOS backups written by another server. Enter that server's recovery key to use them here.", repositoryId: null, secrets };
    const created = probe.state === 'absent';
    if (created) {
      if (!create) throw Object.assign(new Error(missingMessage || 'no repository'), { repositoryAbsent: true });
      this.repositories.set(location, { documents: new Map(), repositoryId: `repo-${this.repositories.size + 1}`, snapshots: new Map() });
    }
    return { created, engineName: this.name, env, localPath, location, repositoryId: this.repositories.get(location).repositoryId, secrets };
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
    const snapshotId = `snap-${String(this.counter).padStart(3, '0')}`;
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

function manifestFor(id, { initiator = 'owner' } = {}) {
  return {
    backup: { createdAt: `2026-09-0${id.slice(-1)}T03:00:00.000Z`, engine: 'restic', id, initiator, kind: 'mos-whole-suite', schemaVersion: 4 },
    contents: { apps: [{ packageId: 'immich' }], stateRawBytes: 1000, volumes: [{ name: 'mos-app-immich-data', rawBytes: 2000 }] },
    source: { version: '0.20.0' },
  };
}

async function bucket({ engine = new FakeObjectEngine(), stateDir } = {}) {
  const agentStateDir = stateDir || await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-bucket-'));
  const record = normalizeObjectDestination(CONNECTION);
  return { agentStateDir, destination: new ObjectDestination({ agentStateDir, engine, record }), engine, record };
}

// Reopening the same connection means a new destination object over the same
// state directory, which is what the agent does across a restart.
function reopen({ agentStateDir, engine, record }) {
  return new ObjectDestination({ agentStateDir, engine, record });
}

test('a locator names a destination and a point, and anything malformed is refused', () => {
  const locator = objectLocator('object:abc123', '7d0e-4f11');
  assert.deepEqual(parseObjectLocator(locator), { destinationId: 'object:abc123', pointId: '7d0e-4f11' });
  for (const bad of ['/media/mos-backup/MOS-backups/restore-points/x.json', 'object:abc123', 'object:#id', 'objectabc#id', '', null, 'object:abc#../escape']) {
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
  assert.equal(summaries[0].locator, objectLocator(world.record.id, 'point-1'));
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

  const location = objectRepositorySpec(world.record).location;
  const noteSnapshots = [...world.engine.repositories.get(location).snapshots.values()].filter((entry) => entry.tags.includes('mosrole:note'));
  assert.equal(noteSnapshots.length, 1, 'the replaced note snapshot was left behind');

  fs.rmSync(world.destination.indexPath(), { force: true });
  assert.equal(await reopen(world).points.readNote('point-1'), 'Second note');
  // Clearing a note leaves the restore point itself untouched.
  await world.destination.points.writeNote('point-1', '');
  fs.rmSync(world.destination.indexPath(), { force: true });
  const cleared = reopen(world);
  assert.equal(await cleared.points.readNote('point-1'), null);
  assert.equal((await cleared.points.summaries()).length, 1);
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
test('a restore point written by another process shows up at once', async () => {
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
  assert.equal(health.locked, true);
  assert.match(health.reason, /written by another server/u);
  assert.match(health.reason, /recovery key/u);
  // And nothing hands the locked repository on to something that would read or
  // write with it: a backup aimed here is refused with the same sentence, not
  // with whatever the engine says about a wrong password.
  await assert.rejects(() => reopened.repository({ create: false }), /written by another server/u);
  await assert.rejects(() => reopened.assertAvailable(), /written by another server/u);

  // And the moment the key is entered it is a normal bucket again — the locked
  // repository is never held on to.
  world.engine.locked = false;
  await reopened.refreshInBackground();
  const unlocked = await reopened.health();
  assert.equal(unlocked.locked, false);
  assert.equal(unlocked.ready, true);
});

// The same answer for a drive, asked the only way a drive can be asked: by
// trying this machine's key against the repository on it.
test('a drive written by another server is reported locked, at most once per interval', async () => {
  const mountPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-drive-'));
  const probes = [];
  const engine = {
    name: 'restic',
    async probe({ localPath, location }) {
      probes.push({ localPath, location });
      return { message: "This drive holds MOS backups written by another server. Enter that server's recovery key to use them here.", state: 'locked' };
    },
  };
  const destination = new DiskDestination({ engine, label: 'Backup USB', mountPath });

  // A drive with no repository on it costs nothing to judge.
  assert.deepEqual(await destination.health(), { locked: false });
  assert.equal(probes.length, 0);

  writeRepositoryDescriptor(mountPath, { engineName: 'restic', repositoryId: 'r1' });
  const health = await destination.health();
  assert.equal(health.locked, true);
  assert.match(health.reason, /written by another server/u);
  // The destination listing is polled, so the answer is held rather than
  // spawning a process per drive per look.
  await destination.health();
  assert.equal(probes.length, 1);
  assert.equal(probes[0].localPath, probes[0].location);
  // A drive whose restore points are readable as files but whose repository is
  // not must refuse a backup, rather than starting one that fails on its first
  // write with the engine own words.
  await assert.rejects(() => destination.assertAvailable(), /written by another server/u);
});
