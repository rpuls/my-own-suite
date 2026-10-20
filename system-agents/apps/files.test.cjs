const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DriveFiles, filesRoutes } = require('./files.cjs');

const DRIVE = '1A2B-3C4D';
const UPLOAD = '0b9e4f3a-5c1d-4e2f-8a6b-7c8d9e0f1a2b';

// One mounted exFAT drive holding jellyfin's folder and plex's leftovers.
function fixture({ claimed = ['jellyfin'], mount = { fileSystem: 'exfat', readOnly: false } } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-files-agent-'));
  const mountRoot = path.join(base, 'media');
  const files = path.join(mountRoot, DRIVE, 'MOS-files');
  fs.mkdirSync(path.join(files, 'apps', 'jellyfin', 'Movies'), { recursive: true });
  fs.mkdirSync(path.join(files, 'apps', 'plex', 'Movies'), { recursive: true });
  fs.writeFileSync(path.join(files, 'apps', 'plex', 'Movies', 'old.mkv'), 'plex film');
  fs.writeFileSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'Dune.mkv'), 'dune');
  const stagingRoot = path.join(base, 'staging');
  fs.mkdirSync(stagingRoot);
  const state = { mount, now: Date.now() };
  const calls = [];
  const agent = new DriveFiles({
    execute: async (...args) => { calls.push(args); },
    executeCapture: async (file, args) => {
      assert.equal(file, 'findmnt');
      if (!state.mount || args.at(-1) !== path.posix.join(mountRoot, DRIVE)) throw new Error('not mounted');
      return `/dev/sdb1 ${state.mount.readOnly ? 'ro' : 'rw'},noatime ${state.mount.fileSystem === 'ntfs' ? 'ntfs3' : state.mount.fileSystem}\n`;
    },
    mountRoot,
    now: () => state.now,
    registry: { drive: () => ({ apps: claimed }) },
    stagingRoot,
  });
  return { agent, calls, files, state, stagingRoot };
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

async function eventually(condition) {
  for (const deadline = Date.now() + 5_000; !condition(); ) {
    assert.ok(Date.now() < deadline, 'timed out');
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

test('a new folder is made on the drive and the drive is flushed', async () => {
  const { agent, calls, files } = fixture();
  assert.deepEqual(await agent.createFolder({ drive: DRIVE, name: 'Documentaries', path: 'apps/jellyfin/Movies' }), { path: 'apps/jellyfin/Movies/Documentaries' });
  assert.ok(fs.statSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'Documentaries')).isDirectory());
  assert.ok(calls.some(([file, args]) => file === 'sync' && args[0] === '--file-system'));
  await rejectsWith(agent.createFolder({ drive: DRIVE, name: 'documentaries', path: 'apps/jellyfin/Movies' }), 'FILES_NAME_TAKEN');
});

test('nothing is added beside the app folders', async () => {
  const { agent } = fixture();
  await rejectsWith(agent.createFolder({ drive: DRIVE, name: 'Mine', path: 'apps' }), 'FILES_PROTECTED');
  await rejectsWith(agent.createFolder({ drive: DRIVE, name: 'Extra', path: 'apps/jellyfin' }), 'FILES_PROTECTED');
});

test('a drive that is away, read-only or not portable is never written', async () => {
  const away = fixture({ mount: null });
  await rejectsWith(away.agent.createFolder({ drive: DRIVE, name: 'X', path: '' }), 'FILES_DRIVE_AWAY');
  const readOnly = fixture({ mount: { fileSystem: 'ntfs', readOnly: true } });
  await assert.rejects(readOnly.agent.createFolder({ drive: DRIVE, name: 'X', path: '' }), /needs a check, so it opened read-only/u);
  const linux = fixture({ mount: { fileSystem: 'ext4', readOnly: false } });
  await rejectsWith(linux.agent.createFolder({ drive: DRIVE, name: 'X', path: '' }), 'FILES_DRIVE_UNSUITED');
});

test('MOS-files is made on a drive that never held anything, but not by the startup sweep', async () => {
  const { agent, files } = fixture();
  fs.rmSync(files, { force: true, recursive: true });
  await agent.sweepAll();
  assert.equal(fs.existsSync(files), false);
  await agent.createFolder({ drive: DRIVE, name: 'Photos', path: '' });
  assert.ok(fs.existsSync(path.join(files, 'Photos')));
});

test('rename keeps the entry in its folder, allows a change of case, and refuses a taken name', async () => {
  const { agent, files } = fixture();
  assert.deepEqual(await agent.rename({ drive: DRIVE, name: 'Dune (2021).mkv', path: 'apps/jellyfin/Movies/Dune.mkv' }), { path: 'apps/jellyfin/Movies/Dune (2021).mkv' });
  assert.ok(fs.existsSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'Dune (2021).mkv')));
  await agent.rename({ drive: DRIVE, name: 'DUNE (2021).mkv', path: 'apps/jellyfin/Movies/Dune (2021).mkv' });
  assert.deepEqual(fs.readdirSync(path.join(files, 'apps', 'jellyfin', 'Movies')), ['DUNE (2021).mkv']);
  await agent.createFolder({ drive: DRIVE, name: 'Other', path: 'apps/jellyfin/Movies' });
  await rejectsWith(agent.rename({ drive: DRIVE, name: 'other', path: 'apps/jellyfin/Movies/DUNE (2021).mkv' }), 'FILES_NAME_TAKEN');
  await rejectsWith(agent.rename({ drive: DRIVE, name: 'bad?', path: 'apps/jellyfin/Movies/Other' }), 'FILES_PATH_INVALID');
  await rejectsWith(agent.rename({ drive: DRIVE, name: 'Films', path: 'apps/jellyfin/Movies' }), 'FILES_PROTECTED');
});

test('a move checks every entry first, then moves leftovers into an app folder and tidies up', async () => {
  const { agent, files } = fixture();
  await rejectsWith(agent.move({ drive: DRIVE, paths: ['apps/plex/Movies/old.mkv', 'apps/jellyfin/Movies'], to: '' }), 'FILES_PROTECTED');
  assert.ok(fs.existsSync(path.join(files, 'apps', 'plex', 'Movies', 'old.mkv')));
  assert.deepEqual(await agent.move({ drive: DRIVE, paths: ['apps/plex/Movies/old.mkv'], to: 'apps/jellyfin/Movies' }), { moved: 1 });
  assert.equal(fs.readFileSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'old.mkv'), 'utf8'), 'plex film');
  await agent.move({ drive: DRIVE, paths: ['apps/plex/Movies'], to: '' });
  assert.equal(fs.existsSync(path.join(files, 'apps', 'plex')), false);
  assert.ok(fs.existsSync(path.join(files, 'Movies')));
});

test('a move refuses a folder into itself, into where it already is, onto a taken name, or beside app folders', async () => {
  const { agent } = fixture();
  await agent.createFolder({ drive: DRIVE, name: 'Box', path: '' });
  await agent.createFolder({ drive: DRIVE, name: 'Inner', path: 'Box' });
  await rejectsWith(agent.move({ drive: DRIVE, paths: ['Box'], to: 'Box/Inner' }), 'FILES_INTO_ITSELF');
  await rejectsWith(agent.move({ drive: DRIVE, paths: ['Box'], to: 'Box' }), 'FILES_INTO_ITSELF');
  await rejectsWith(agent.move({ drive: DRIVE, paths: ['Box/Inner'], to: 'Box' }), 'FILES_ALREADY_THERE');
  await agent.createFolder({ drive: DRIVE, name: 'inner', path: '' });
  await rejectsWith(agent.move({ drive: DRIVE, paths: ['Box/Inner'], to: '' }), 'FILES_NAME_TAKEN');
  await rejectsWith(agent.move({ drive: DRIVE, paths: ['Box'], to: 'apps/plex' }), 'FILES_PROTECTED');
});

test('delete answers once everything is moved aside, then erases it', async () => {
  const { agent, files } = fixture();
  await rejectsWith(agent.remove({ drive: DRIVE, paths: ['apps/jellyfin/Movies'] }), 'FILES_PROTECTED');
  assert.deepEqual(await agent.remove({ drive: DRIVE, paths: ['apps/plex/Movies', 'apps/jellyfin/Movies/Dune.mkv'] }), { deleted: 2 });
  assert.equal(fs.existsSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'Dune.mkv')), false);
  await eventually(() => !fs.existsSync(path.join(files, 'apps', 'plex')));
  assert.deepEqual(fs.readdirSync(path.join(files, '.mos-deleting')), []);
  assert.ok(fs.existsSync(path.join(files, 'apps', 'jellyfin', 'Movies')));
});

test('the startup sweep finishes deletions a restart interrupted and drops day-old uploads', async () => {
  const { agent, files, state } = fixture();
  fs.mkdirSync(path.join(files, '.mos-deleting', 'half-gone'), { recursive: true });
  fs.writeFileSync(path.join(files, '.mos-deleting', 'half-gone', 'big.bin'), 'x');
  fs.mkdirSync(path.join(files, '.mos-uploads'));
  fs.writeFileSync(path.join(files, '.mos-uploads', 'stale'), 'old');
  fs.writeFileSync(path.join(files, '.mos-uploads', 'fresh'), 'new');
  const dayAgo = new Date(state.now - 25 * 60 * 60_000);
  fs.utimesSync(path.join(files, '.mos-uploads', 'stale'), dayAgo, dayAgo);
  await agent.sweepAll();
  assert.deepEqual(fs.readdirSync(path.join(files, '.mos-deleting')), []);
  assert.deepEqual(fs.readdirSync(path.join(files, '.mos-uploads')), ['fresh']);
});

function stageChunk(stagingRoot, bytes) {
  fs.writeFileSync(path.join(stagingRoot, `${UPLOAD}.chunk`), bytes);
}

test('an upload appends staged chunks at the confirmed offset and lands under its name', async () => {
  const { agent, files, stagingRoot } = fixture();
  assert.deepEqual(await agent.uploadOffset({ acknowledged: 0, drive: DRIVE, uploadId: UPLOAD }), { offset: 0 });
  stageChunk(stagingRoot, 'hello ');
  assert.deepEqual(await agent.uploadAppend({ drive: DRIVE, offset: 0, uploadId: UPLOAD }), { offset: 6 });
  assert.equal(fs.existsSync(path.join(stagingRoot, `${UPLOAD}.chunk`)), false);
  stageChunk(stagingRoot, 'again');
  await assert.rejects(agent.uploadAppend({ drive: DRIVE, offset: 3, uploadId: UPLOAD }), (error) => error.code === 'FILES_UPLOAD_OFFSET' && error.details[0] === '6');
  stageChunk(stagingRoot, 'world');
  await agent.uploadAppend({ drive: DRIVE, offset: 6, uploadId: UPLOAD });
  await rejectsWith(agent.uploadFinish({ drive: DRIVE, name: 'hello.txt', path: 'Films', size: 11, uploadId: UPLOAD }), 'FILES_NOT_FOUND');
  await rejectsWith(agent.uploadFinish({ drive: DRIVE, name: 'hello.txt', path: '', size: 12, uploadId: UPLOAD }), 'FILES_UPLOAD_INCOMPLETE');
  assert.deepEqual(await agent.uploadFinish({ drive: DRIVE, name: 'hello.txt', path: '', size: 11, uploadId: UPLOAD }), { path: 'hello.txt' });
  assert.equal(fs.readFileSync(path.join(files, 'hello.txt'), 'utf8'), 'hello world');
  assert.deepEqual(fs.readdirSync(path.join(files, '.mos-uploads')), []);
});

test('resuming cuts off bytes Suite Manager never confirmed', async () => {
  const { agent, files } = fixture();
  await agent.uploadOffset({ acknowledged: 0, drive: DRIVE, uploadId: UPLOAD });
  fs.writeFileSync(path.join(files, '.mos-uploads', UPLOAD), 'confirmedTORN');
  assert.deepEqual(await agent.uploadOffset({ acknowledged: 9, drive: DRIVE, uploadId: UPLOAD }), { offset: 9 });
  assert.equal(fs.readFileSync(path.join(files, '.mos-uploads', UPLOAD), 'utf8'), 'confirmed');
  assert.deepEqual(await agent.uploadOffset({ acknowledged: 40, drive: DRIVE, uploadId: UPLOAD }), { offset: 9 });
});

test('a staged chunk that is a second name for another file is refused', async () => {
  const { agent, stagingRoot } = fixture();
  await agent.uploadOffset({ acknowledged: 0, drive: DRIVE, uploadId: UPLOAD });
  const secret = path.join(stagingRoot, 'secret');
  fs.writeFileSync(secret, 'root only');
  fs.linkSync(secret, path.join(stagingRoot, `${UPLOAD}.chunk`));
  await rejectsWith(agent.uploadAppend({ drive: DRIVE, offset: 0, uploadId: UPLOAD }), 'FILES_UPLOAD_INVALID');
});

test('a finished upload whose name was taken meanwhile is dropped, not left half-added', async () => {
  const { agent, files, stagingRoot } = fixture();
  await agent.uploadOffset({ acknowledged: 0, drive: DRIVE, uploadId: UPLOAD });
  stageChunk(stagingRoot, 'abc');
  await agent.uploadAppend({ drive: DRIVE, offset: 0, uploadId: UPLOAD });
  fs.writeFileSync(path.join(files, 'ABC.txt'), 'other');
  await rejectsWith(agent.uploadFinish({ drive: DRIVE, name: 'abc.txt', path: '', size: 3, uploadId: UPLOAD }), 'FILES_NAME_TAKEN');
  assert.deepEqual(fs.readdirSync(path.join(files, '.mos-uploads')), []);
});

test('the agent routes take exactly their fields', async () => {
  const routes = filesRoutes({ createFolder: async (input) => input });
  await rejectsWith(routes['POST /v1/files/folder']({ drive: DRIVE, name: 'X', path: '', extra: true }), 'FILES_REQUEST_INVALID');
  await rejectsWith(routes['POST /v1/files/folder']({ drive: '../etc', name: 'X', path: '' }), 'FILES_REQUEST_INVALID');
  await rejectsWith(routes['POST /v1/files/folder']({ drive: DRIVE, name: 1, path: '' }), 'FILES_REQUEST_INVALID');
  assert.deepEqual(await routes['POST /v1/files/folder']({ drive: DRIVE, name: 'X', path: '' }), { drive: DRIVE, name: 'X', path: '' });
});
