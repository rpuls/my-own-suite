const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CarryOver } = require('./carry-over.cjs');
const { archiveNames, repositoryExists, repositorySidecarPath, restorePointsDir } = require('./engines/engine.cjs');
const { LastBackups } = require('./last-backups.cjs');
const { PrimaryDestination } = require('./primary.cjs');
const { StorageRegistry } = require('../lib/storage-registry.cjs');

const FS_UUID = '773e70f0-4c1e-4b1a-9d2e-5f6a7b8c9d0e';
const BUCKET = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', bucket: 'mos-backups', createdAt: '2026-09-01T00:00:00.000Z', endpoint: 'https://s3.eu-central-1.amazonaws.com', folder: 'home', id: 'object:0123456789ab', label: 'mos-backups at s3.eu-central-1.amazonaws.com', region: 'eu-central-1', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

function writeJson(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function rig(t, { holdBackups = async () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-carry-over-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const agentStateDir = path.join(root, 'backup-agent');
  const mount = path.join(root, 'mount');
  fs.mkdirSync(agentStateDir, { recursive: true });
  fs.mkdirSync(mount, { recursive: true });
  const calls = [];
  const lines = [];
  const registryPath = path.join(root, 'storage.json');
  const lastBackups = new LastBackups({ agentStateDir });
  const primary = new PrimaryDestination({ agentStateDir });
  const carryOver = new CarryOver({
    agentStateDir,
    appAgent: { holdBackups: async (input) => { calls.push(input); await holdBackups(input); } },
    lastBackups,
    log: (line) => lines.push(line),
    primary,
    registryPath,
  });
  return { agentStateDir, calls, carryOver, lastBackups, lines, mount, primary, registry: new StorageRegistry({ registryPath }), registryPath };
}

// A drive as the storage module lists it, mounted read-write and open.
function drive(mount, fields = {}) {
  return { backups: false, connected: true, holdsBackupsFormat: true, id: FS_UUID, mountPath: mount, state: 'ready', ...fields };
}

// What 0.22 left on a backup drive: one archive at the root of MOS-backups.
function oldLayout(mount) {
  const root = path.join(mount, 'MOS-backups');
  fs.mkdirSync(path.join(root, 'repository', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'repository', 'config'), 'restic-config');
  fs.writeFileSync(path.join(root, 'repository', 'data', 'pack-1'), 'pack');
  fs.mkdirSync(path.join(root, 'restore-points'), { recursive: true });
  fs.writeFileSync(path.join(root, 'restore-points', 'job-1.json'), '{}');
  fs.writeFileSync(path.join(root, 'restore-points', 'job-1.json.sha256'), 'digest');
  writeJson(path.join(root, 'MOS-REPOSITORY.json'), { createdAt: '2026-09-01T00:00:00.000Z', engineName: 'restic', format: 'Encrypted, deduplicating content-addressed repository.', repositoryId: 'repo-1' });
  return root;
}

function todayArchive(mount, name) {
  const archive = path.join(mount, 'MOS-backups', name);
  fs.mkdirSync(path.join(archive, 'repository'), { recursive: true });
  fs.writeFileSync(path.join(archive, 'repository', 'config'), 'restic-config');
  writeJson(path.join(archive, 'MOS-REPOSITORY.json'), { engineName: 'restic', repositoryId: `repo-${name}` });
  return archive;
}

const noRefresh = async () => { throw new Error('nothing was claimed, so nothing is refreshed'); };

test('the 0.22 layout is moved whole into a fresh archive, listed as the drive\'s only one, and left alone after', async (t) => {
  const { carryOver, lines, mount } = rig(t);
  const root = oldLayout(mount);
  const listed = [drive(mount)];

  assert.equal(await carryOver.onSight(listed, noRefresh), listed);
  const [name, ...others] = archiveNames(mount);
  assert.deepEqual(others, []);
  assert.match(name, /^archive-[0-9a-f]{8}$/u);
  const archive = path.join(root, name);
  assert.equal(repositoryExists(archive), true);
  assert.equal(fs.readFileSync(path.join(archive, 'repository', 'data', 'pack-1'), 'utf8'), 'pack');
  assert.deepEqual(fs.readdirSync(restorePointsDir(archive)).sort(), ['job-1.json', 'job-1.json.sha256']);
  assert.equal(readJson(repositorySidecarPath(archive)).repositoryId, 'repo-1');
  assert.deepEqual(fs.readdirSync(root), [name]);
  assert.deepEqual(lines, [`drive ${FS_UUID}: backups from MOS 0.22 moved into ${name}`]);

  await carryOver.onSight(listed, noRefresh);
  assert.deepEqual(archiveNames(mount), [name]);
  assert.equal(lines.length, 1);
});

test('another server\'s archive beside the 0.22 layout is not touched and does not take the moved backups', async (t) => {
  const { carryOver, mount } = rig(t);
  oldLayout(mount);
  const other = todayArchive(mount, 'archive-ffffffff');

  await carryOver.onSight([drive(mount)], noRefresh);
  const names = archiveNames(mount);
  assert.equal(names.length, 2);
  assert.ok(names.includes('archive-ffffffff'));
  assert.deepEqual(fs.readdirSync(other).sort(), ['MOS-REPOSITORY.json', 'repository']);
  assert.equal(readJson(repositorySidecarPath(other)).repositoryId, 'repo-archive-ffffffff');
});

test('a move cut short after the restore points is finished into the same archive', async (t) => {
  const { carryOver, mount } = rig(t);
  const root = oldLayout(mount);
  const started = path.join(root, 'archive-0123abcd');
  fs.mkdirSync(started);
  fs.renameSync(path.join(root, 'MOS-REPOSITORY.json'), path.join(started, 'MOS-REPOSITORY.json'));
  fs.renameSync(path.join(root, 'restore-points'), path.join(started, 'restore-points'));

  await carryOver.onSight([drive(mount)], noRefresh);
  assert.deepEqual(archiveNames(mount), ['archive-0123abcd']);
  assert.equal(repositoryExists(started), true);
  assert.deepEqual(fs.readdirSync(root), ['archive-0123abcd']);
  assert.deepEqual(fs.readdirSync(restorePointsDir(started)).sort(), ['job-1.json', 'job-1.json.sha256']);
  assert.equal(readJson(repositorySidecarPath(started)).repositoryId, 'repo-1');
});

test('a drive that is read-only, not open, not connected or not a backups format is not touched', async (t) => {
  const { carryOver, lines, mount } = rig(t);
  const root = oldLayout(mount);
  const before = fs.readdirSync(root).sort();
  const states = [
    { state: 'read-only' },
    { mountPath: null, state: 'available' },
    { connected: false, mountPath: null, state: 'away' },
    { mountPath: null, state: 'failed' },
    { holdsBackupsFormat: false },
  ];
  for (const fields of states) await carryOver.onSight([drive(mount, fields)], noRefresh);
  assert.deepEqual(fs.readdirSync(root).sort(), before);
  assert.deepEqual(lines, []);
});

test('0.22 buckets are folded into the storage registry as backup destinations, the old file goes, and one already there is left as it is', (t) => {
  const { agentStateDir, carryOver, lines, registry } = rig(t);
  const other = { ...BUCKET, bucket: 'other', folder: '', id: 'object:ba9876543210', label: 'other at s3.eu-central-1.amazonaws.com' };
  const renamed = { ...other, label: 'Renamed by the owner' };
  registry.update(({ buckets }) => { buckets[other.id] = renamed; });
  const file = path.join(agentStateDir, 'object-destinations.json');
  writeJson(file, { destinations: [BUCKET, other, { id: 'junk', label: 'not a bucket' }], version: 1 });

  carryOver.atStart();
  assert.deepEqual(registry.read().buckets, { [BUCKET.id]: { ...BUCKET, backups: true }, [other.id]: renamed });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(lines, ['carried 1 of 2 storage connection(s) over from MOS 0.22']);

  carryOver.atStart();
  assert.equal(lines.length, 1);
});

test('a known drive that appears is kept for backups through the storage module and leaves the file; a drawer drive and a refused one stay', async (t) => {
  const refused = 'FFF2-BC72';
  const away = 'AAAA-1111';
  let refusing = true;
  const { agentStateDir, calls, carryOver, lastBackups, lines, mount } = rig(t, {
    holdBackups: async ({ drive: id }) => { if (id === refused && refusing) throw new Error('Your apps can read this drive, but nothing can be saved to it until it is checked.'); },
  });
  const file = path.join(agentStateDir, 'known-drives.json');
  writeJson(file, {
    drives: [
      { fsUuid: FS_UUID, id: '/media/mos-backup', label: 'MOS_BACKUP', lastBackupAt: '2026-10-01T03:00:00.000Z', lastSeenAt: '2026-10-20T00:00:00.000Z' },
      { fsUuid: away, id: '/media/mos-storage/AAAA-1111', label: 'FILMS', lastBackupAt: '2026-09-01T03:00:00.000Z', lastSeenAt: '2026-09-02T00:00:00.000Z' },
      { fsUuid: refused, id: '/media/mos-storage/FFF2-BC72', label: 'PHOTOS', lastBackupAt: null, lastSeenAt: '2026-10-20T00:00:00.000Z' },
    ],
    version: 1,
  });
  oldLayout(mount);

  // The backup drive is plugged in but not yet opened by MOS; the claim mounts it,
  // and the refreshed listing is what the same pass adopts and surveys.
  const seen = [drive(mount, { mountPath: null, state: 'available' }), drive(mount, { id: refused, mountPath: path.join(mount, 'photos') })];
  const refreshed = [drive(mount, { backups: true }), drive(mount, { id: refused, mountPath: path.join(mount, 'photos') })];
  assert.equal(await carryOver.onSight(seen, async () => refreshed), refreshed);
  assert.deepEqual(calls, [{ drive: FS_UUID, held: true }, { drive: refused, held: true }]);
  assert.deepEqual(readJson(file).drives.map((entry) => entry.fsUuid), [away, refused]);
  assert.equal(lastBackups.of(FS_UUID), '2026-10-01T03:00:00.000Z');
  assert.equal(lastBackups.of(away), null);
  assert.equal(archiveNames(mount).length, 1);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], `drive ${FS_UUID}: kept for backups as in MOS 0.22`);
  assert.match(lines[1], /moved into archive-/u);

  // The refused drive is checked and opens; the drawer drive is still away.
  refusing = false;
  await carryOver.onSight([drive(mount, { id: refused, mountPath: path.join(mount, 'photos') })], async () => [drive(mount, { backups: true, id: refused, mountPath: path.join(mount, 'photos') })]);
  assert.deepEqual(readJson(file).drives.map((entry) => entry.fsUuid), [away]);

  // The drawer drive comes back already kept for backups by the owner: no claim is
  // made, its old last backup is kept only because today's record has none, and
  // the file goes once it is empty.
  lastBackups.note(FS_UUID, '2026-10-21T03:00:00.000Z');
  const made = calls.length;
  await carryOver.onSight([drive(mount, { backups: true, id: away, mountPath: path.join(mount, 'films') })], noRefresh);
  assert.equal(calls.length, made);
  assert.equal(fs.existsSync(file), false);
  assert.equal(lastBackups.of(away), '2026-09-01T03:00:00.000Z');
  assert.equal(lastBackups.of(FS_UUID), '2026-10-21T03:00:00.000Z');
});

test('a known drive whose format cannot hold backups today is neither claimed nor dropped', async (t) => {
  const { agentStateDir, calls, carryOver, mount } = rig(t);
  const file = path.join(agentStateDir, 'known-drives.json');
  writeJson(file, { drives: [{ fsUuid: FS_UUID, id: '/media/mos-backup', label: 'MOS_BACKUP', lastBackupAt: null, lastSeenAt: null }], version: 1 });
  await carryOver.onSight([drive(mount, { holdsBackupsFormat: false, state: 'available', mountPath: null })], noRefresh);
  assert.deepEqual(calls, []);
  assert.equal(readJson(file).drives.length, 1);
});

test('the primary is rewritten from a 0.22 mount path to the known drive once, and otherwise left alone', (t) => {
  const { agentStateDir, carryOver, lines, primary } = rig(t);
  writeJson(path.join(agentStateDir, 'known-drives.json'), { drives: [{ fsUuid: FS_UUID, id: '/media/mos-backup', label: 'MOS_BACKUP', lastBackupAt: null, lastSeenAt: null }], version: 1 });
  primary.write({ destinationId: '/media/mos-backup', label: 'MOS_BACKUP', repositoryId: 'repo-1', setAt: '2026-09-01T00:00:00.000Z' });

  carryOver.atStart();
  assert.deepEqual(primary.read(), { destinationId: FS_UUID, label: 'MOS_BACKUP', setAt: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(lines, [`automatic backups carried over from /media/mos-backup to drive ${FS_UUID}`]);

  const untouched = [
    { destinationId: FS_UUID, label: 'MOS_BACKUP', setAt: '2026-10-01T00:00:00.000Z' },
    { destinationId: BUCKET.id, label: 'Bucket', setAt: '2026-10-01T00:00:00.000Z' },
    { destinationId: '/media/never-backed-up', label: 'Chosen, never written', setAt: '2026-10-01T00:00:00.000Z' },
  ];
  for (const chosen of untouched) {
    primary.write(chosen);
    carryOver.atStart();
    assert.deepEqual(primary.read(), chosen);
  }
  assert.equal(lines.length, 1);
});

test('a fresh install has nothing to carry: no file appears, nothing moves, nothing is logged', async (t) => {
  const { agentStateDir, calls, carryOver, lines, mount, registryPath } = rig(t);
  todayArchive(mount, 'archive-89abcdef');
  const listed = [drive(mount, { backups: true })];

  carryOver.atStart();
  assert.equal(await carryOver.onSight(listed, noRefresh), listed);
  assert.equal(await carryOver.onSight(null, noRefresh), null);
  assert.deepEqual(fs.readdirSync(agentStateDir), []);
  assert.equal(fs.existsSync(registryPath), false);
  assert.deepEqual(archiveNames(mount), ['archive-89abcdef']);
  assert.deepEqual(calls, []);
  assert.deepEqual(lines, []);
});
