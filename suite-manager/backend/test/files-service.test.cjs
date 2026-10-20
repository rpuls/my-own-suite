const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { FilesService, batchesOf, byteRange, contentDisposition } = require('../src/storage/files-service.cjs');
const { capabilitiesOf } = require('../src/storage/storage-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

const DRIVE = '20C2CDDCC2CDB676';
const BASE = `/storage/drives/${DRIVE}/files`;

// The Movies drive: jellyfin reads its folder, plex left one behind.
function fixture({ availableBytes = 346e9, state = 'ready' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-files-sm-'));
  const mountPath = path.join(root, 'mount');
  const files = path.join(mountPath, 'MOS-files');
  fs.mkdirSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'Interstellar (2014)'), { recursive: true });
  fs.writeFileSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'Interstellar (2014)', 'film.mkv'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'Das Boot (1981).mkv'), '0123456789');
  fs.mkdirSync(path.join(files, 'apps', 'plex', 'Movies'), { recursive: true });
  fs.writeFileSync(path.join(files, 'apps', 'plex', 'Movies', 'old.mkv'), 'old');
  fs.mkdirSync(path.join(files, '.mos-uploads'));
  fs.mkdirSync(path.join(files, 'Home videos'));
  const entry = { apps: ['jellyfin'], availableBytes, connected: true, holdsAppFoldersFormat: true, id: DRIVE, kind: 'drive', mountPath, name: 'Movies drive', reason: state === 'read-only' ? 'Needs a check.' : null, state };
  const drive = { ...entry, capabilities: capabilitiesOf(entry) };
  const calls = [];
  const partials = new Map();
  const stateDir = path.join(root, 'state');
  const service = new FilesService({
    appAgent: {
      filesCreateFolder: async (input) => { calls.push(['folder', input]); return { path: input.path ? `${input.path}/${input.name}` : input.name }; },
      filesDelete: async (input) => { calls.push(['delete', input]); return { deleted: input.paths.length }; },
      filesMove: async (input) => { calls.push(['move', input]); return { moved: input.paths.length }; },
      filesUploadAppend: async ({ offset, uploadId }) => {
        const chunk = path.join(stateDir, 'file-uploads', `${uploadId}.chunk`);
        const current = partials.get(uploadId);
        assert.equal(current.length, offset);
        partials.set(uploadId, Buffer.concat([current, fs.readFileSync(chunk)]));
        fs.rmSync(chunk);
        return { offset: partials.get(uploadId).length };
      },
      filesUploadCancel: async ({ uploadId }) => { partials.delete(uploadId); return { cancelled: true }; },
      filesUploadFinish: async ({ name, path: folder, uploadId }) => {
        fs.writeFileSync(path.join(files, ...folder.split('/'), name), partials.get(uploadId));
        partials.delete(uploadId);
        return { path: `${folder}/${name}` };
      },
      filesUploadOffset: async ({ acknowledged, uploadId }) => {
        const current = partials.get(uploadId) || Buffer.alloc(0);
        partials.set(uploadId, current.subarray(0, Math.min(current.length, acknowledged)));
        return { offset: partials.get(uploadId).length };
      },
    },
    stateDir,
    storage: {
      drive: async (id) => (id === DRIVE ? drive : null),
      names: () => new Map([['jellyfin', { installed: true, name: 'Jellyfin' }], ['plex', { installed: false, name: 'Plex' }]]),
    },
  });
  return { calls, files, partials, service, stateDir };
}

test('a listing shows folders then files with their sizes, and nothing MOS keeps for itself', async () => {
  const { files, service } = fixture();
  fs.symlinkSync(os.tmpdir(), path.join(files, 'apps', 'jellyfin', 'Movies', 'Link'), 'junction');
  const listed = await service.list(DRIVE, 'apps/jellyfin/Movies');
  assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.kind, entry.bytes, entry.items]), [
    ['Interstellar (2014)', 'folder', 1000, 1],
    ['Das Boot (1981).mkv', 'file', 10, null],
  ]);
  assert.deepEqual(listed.totals, { bytes: 1010, items: 2 });
  assert.deepEqual(listed.app, { id: 'jellyfin', name: 'Jellyfin', readsDrive: true });
  assert.deepEqual(listed.segments, ['apps', 'jellyfin', 'Movies']);
  assert.equal(listed.addRefusal, null);
  assert.equal(listed.drive.writable, true);
});

test('the apps folder lists the folders of apps not reading this drive last, and the app tree says why it stays put', async () => {
  const { files, service } = fixture();
  fs.mkdirSync(path.join(files, 'apps', 'immich', 'Photos'), { recursive: true });
  const top = await service.list(DRIVE, '');
  assert.deepEqual(top.entries.map((entry) => entry.name), ['apps', 'Home videos']);
  assert.match(top.entries[0].locked, /keeps your apps/u);
  assert.equal(top.entries[1].locked, null);
  const apps = await service.list(DRIVE, 'apps');
  assert.deepEqual(apps.entries.map((entry) => [entry.name, entry.appState, Boolean(entry.locked)]), [
    ['jellyfin', null, true],
    ['immich', 'not-installed', true],
    ['plex', 'not-installed', true],
  ]);
  const jellyfin = await service.list(DRIVE, 'apps/jellyfin');
  assert.match(jellyfin.addRefusal, /inside one of the app/u);
  assert.match(jellyfin.entries[0].locked, /An app reads this folder/u);
});

test('a drive MOS keeps nothing on is opened by the first look at its files', async () => {
  const mountPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-files-open-'));
  let opened = false;
  const entry = () => {
    const found = { apps: [], availableBytes: 1e9, connected: true, holdsAppFoldersFormat: true, id: DRIVE, kind: 'drive', mountPath: opened ? mountPath : null, name: 'Ext HDD', state: opened ? 'ready' : 'available' };
    return { ...found, capabilities: capabilitiesOf(found) };
  };
  assert.equal(entry().capabilities.browsable, true);
  assert.equal(entry().capabilities.writable, false);
  const service = new FilesService({
    appAgent: { openDrive: async ({ drive }) => { assert.equal(drive, DRIVE); opened = true; return { readOnly: false }; } },
    stateDir: mountPath,
    storage: { drive: async () => entry(), names: () => new Map() },
  });
  const listed = await service.list(DRIVE, '');
  assert.equal(opened, true);
  assert.deepEqual(listed.entries, []);
  assert.equal(listed.drive.writable, true);
});

test('a drive without MOS-files lists empty, and a closed drive says why', async () => {
  const { files, service } = fixture();
  fs.rmSync(files, { force: true, recursive: true });
  assert.deepEqual((await service.list(DRIVE, '')).entries, []);
  await assert.rejects(service.list(DRIVE, 'Nope'), { code: 'FILES_NOT_FOUND' });
  await assert.rejects(service.list('OTHER-DRIVE', ''), { code: 'FILES_DRIVE_NOT_FOUND' });
});

test('a read-only drive can be browsed but not added to', async () => {
  const { service } = fixture({ state: 'read-only' });
  assert.equal((await service.list(DRIVE, '')).drive.writable, false);
  await assert.rejects(service.beginUpload(DRIVE, { lastModified: 1, name: 'a.txt', path: '', size: 1 }), /needs a check, so it opened read-only/u);
});

test('routes refuse the signed-out, other sites and paths that leave the drive', async () => {
  const { service } = fixture();
  await withRoutes({ files: service }, async (call) => {
    assert.equal((await call('GET', `${BASE}?path=`, { signedIn: false })).status, 401);
    assert.equal((await call('GET', `${BASE}?path=..%2F..`)).status, 400);
    assert.equal((await call('GET', `${BASE}?path=%2Fetc`)).status, 400);
    assert.equal((await call('GET', `${BASE}/download?path=apps%2Fjellyfin%2FMovies%2FDas%20Boot%20(1981).mkv`, { headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal((await call('POST', `${BASE}/folder`, { body: { name: 'X', path: '' }, headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    assert.equal((await call('POST', `${BASE}/delete`, { body: { paths: ['Home videos'] } })).status, 400);
    assert.equal((await call('POST', `${BASE}/delete`, { body: { confirmed: true, paths: ['Home videos'] } })).status, 200);
  });
});

test('a download streams the file as an attachment, in ranges when asked', async () => {
  const { service } = fixture();
  await withRoutes({ files: service }, async (call) => {
    const whole = await call('GET', `${BASE}/download?path=${encodeURIComponent('apps/jellyfin/Movies/Das Boot (1981).mkv')}`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(whole.status, 200);
    assert.equal(whole.body, '0123456789');
    assert.equal(whole.headers['content-disposition'], 'attachment; filename="Das Boot (1981).mkv"; filename*=UTF-8\'\'Das%20Boot%20%281981%29.mkv');
    assert.equal(whole.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(whole.headers['x-content-type-options'], 'nosniff');
    const part = await call('GET', `${BASE}/download?path=${encodeURIComponent('apps/jellyfin/Movies/Das Boot (1981).mkv')}`, { headers: { Range: 'bytes=4-' } });
    assert.deepEqual([part.status, part.body, part.headers['content-range']], [206, '456789', 'bytes 4-9/10']);
    const beyond = await call('GET', `${BASE}/download?path=${encodeURIComponent('apps/jellyfin/Movies/Das Boot (1981).mkv')}`, { headers: { Range: 'bytes=40-' } });
    assert.equal(beyond.status, 416);
    assert.equal((await call('GET', `${BASE}/download?path=${encodeURIComponent('apps/jellyfin/Movies')}`)).status, 400);
  });
  assert.equal(contentDisposition('Fête "x".mkv'), 'attachment; filename="F_te _x_.mkv"; filename*=UTF-8\'\'F%C3%AAte%20%22x%22.mkv');
  assert.deepEqual(byteRange('bytes=-3', 10), { end: 9, start: 7 });
  assert.equal(byteRange('bytes=1-2,4-5', 10), false);
});

async function upload(call, bytes, { chunk = 4, name = 'clip.bin', path: folder = 'Home videos' } = {}) {
  const begun = (await call('POST', `${BASE}/uploads`, { body: { lastModified: 1700000000000, name, path: folder, size: bytes.length } })).json();
  let { offset } = begun;
  while (offset < bytes.length) {
    const answer = await call('PUT', `${BASE}/uploads/${begun.uploadId}?offset=${offset}`, { body: bytes.subarray(offset, offset + chunk).toString('latin1'), headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(answer.status, 200, answer.body);
    ({ offset } = answer.json());
  }
  return begun.uploadId;
}

test('an upload arrives chunk by chunk and lands under its name in the folder', async () => {
  const { files, service } = fixture();
  const bytes = Buffer.from('a whole home video');
  await withRoutes({ files: service }, async (call) => {
    const uploadId = await upload(call, bytes);
    const finished = await call('POST', `${BASE}/uploads/${uploadId}/finish`);
    assert.deepEqual(finished.json(), { path: 'Home videos/clip.bin' });
    assert.equal(fs.readFileSync(path.join(files, 'Home videos', 'clip.bin'), 'latin1'), bytes.toString('latin1'));
    const again = await call('POST', `${BASE}/uploads`, { body: { lastModified: 1, name: 'CLIP.bin', path: 'Home videos', size: 3 } });
    assert.deepEqual([again.status, again.json().code], [409, 'FILES_NAME_TAKEN']);
  });
});

test('an upload picked up again after a cut carries on where the drive has it, never twice', async () => {
  const { partials, service } = fixture();
  await withRoutes({ files: service }, async (call) => {
    const body = { lastModified: 5, name: 'film.mkv', path: 'Home videos', size: 12 };
    const first = (await call('POST', `${BASE}/uploads`, { body })).json();
    await call('PUT', `${BASE}/uploads/${first.uploadId}?offset=0`, { body: 'abcd', headers: { 'Content-Type': 'application/octet-stream' } });
    const skipped = await call('PUT', `${BASE}/uploads/${first.uploadId}?offset=0`, { body: 'abcd', headers: { 'Content-Type': 'application/octet-stream' } });
    assert.deepEqual([skipped.status, skipped.json().details], [409, ['4']]);
    partials.set(first.uploadId, Buffer.from('abcdTORN'));
    const resumed = (await call('POST', `${BASE}/uploads`, { body })).json();
    assert.deepEqual([resumed.uploadId, resumed.offset], [first.uploadId, 4]);
    assert.equal(partials.get(first.uploadId).toString(), 'abcd');
    const early = await call('POST', `${BASE}/uploads/${first.uploadId}/finish`);
    assert.equal(early.json().code, 'FILES_UPLOAD_INCOMPLETE');
    const other = await call('POST', `${BASE}/uploads`, { body: { ...body, size: 99 } });
    assert.match(other.json().error, /already being added/u);
  });
});

test('an upload that would not fit, or is bigger than it said, is refused', async () => {
  const { service } = fixture({ availableBytes: 100 * 1024 * 1024 });
  await withRoutes({ files: service }, async (call) => {
    const full = await call('POST', `${BASE}/uploads`, { body: { lastModified: 1, name: 'big.mkv', path: '', size: 90 * 1024 * 1024 } });
    assert.deepEqual([full.status, full.json().code], [507, 'FILES_DRIVE_FULL']);
    const begun = (await call('POST', `${BASE}/uploads`, { body: { lastModified: 1, name: 'small.txt', path: '', size: 2 } })).json();
    const over = await call('PUT', `${BASE}/uploads/${begun.uploadId}?offset=0`, { body: 'too long', headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(over.status, 400);
    const beside = await call('POST', `${BASE}/uploads`, { body: { lastModified: 1, name: 'x.txt', path: 'apps/jellyfin', size: 2 } });
    assert.equal(beside.json().code, 'FILES_PROTECTED');
    const lost = await call('PUT', `${BASE}/uploads/not-an-upload?offset=0`, { body: 'x', headers: { 'Content-Type': 'application/octet-stream' } });
    assert.equal(lost.status, 410);
  });
});

test('a chunk whose connection went quiet gives way to the next request for its upload', async () => {
  const { service } = fixture();
  const { uploadId } = await service.beginUpload(DRIVE, { lastModified: 1, name: 'cut.bin', path: '', size: 8 });
  const silent = new PassThrough();
  silent.setTimeout = () => {};
  silent.write('abcd');
  const cut = service.appendChunk(DRIVE, uploadId, 0, silent).then(() => null, (error) => error);
  while (!service.inFlight.has(uploadId)) await new Promise((resolve) => { setTimeout(resolve, 5); });
  const retry = new PassThrough();
  retry.setTimeout = () => {};
  retry.end('abcd');
  assert.deepEqual(await service.appendChunk(DRIVE, uploadId, 0, retry), { offset: 4 });
  assert.ok(await cut, 'the silent chunk is dropped');
});

test('a restart clears staged chunks and forgets uploads idle for a day', async () => {
  const { service, stateDir } = fixture();
  const staging = path.join(stateDir, 'file-uploads');
  fs.mkdirSync(staging, { recursive: true });
  fs.writeFileSync(path.join(staging, 'a.chunk'), 'x');
  fs.writeFileSync(path.join(staging, 'old.json'), JSON.stringify({ updatedAt: Date.now() - 25 * 60 * 60_000 }));
  fs.writeFileSync(path.join(staging, 'new.json'), JSON.stringify({ updatedAt: Date.now() }));
  await service.sweep();
  assert.deepEqual(fs.readdirSync(staging), ['new.json']);
});

test('a big selection goes to the agent in batches it accepts', async () => {
  const { calls, service } = fixture();
  const paths = Array.from({ length: 450 }, (_, index) => `Home videos/clip ${index}.mkv`);
  assert.deepEqual(await service.move(DRIVE, { paths, to: '' }), { moved: 450 });
  assert.deepEqual(calls.map(([kind, input]) => [kind, input.paths.length]), [['move', 200], ['move', 200], ['move', 50]]);
  assert.ok(batchesOf(['x'.repeat(30_000), 'y'.repeat(30_000)]).length === 2);
  await assert.rejects(service.move(DRIVE, { paths: ['../x'], to: '' }), { code: 'FILES_PATH_INVALID' });
});
