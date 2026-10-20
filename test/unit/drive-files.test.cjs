const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  addRefusal,
  changeRefusal,
  deleteRefusal,
  isHousekeeping,
  nameProblem,
  parseRelativePath,
  placeOnDrive,
  resolveExisting,
  resolveNew,
} = require('../../shared/drive-files.cjs');

// A drive as MOS mounts it, with a secret beside it that nothing may reach:
//   <mount>/MOS-files/{apps/jellyfin/Movies/film.mkv, Films/café/, .mos-uploads/u1}
//   <base>/outside/secret.txt
function fixtureDrive() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-drive-files-'));
  const mount = path.join(base, 'mount');
  const files = path.join(mount, 'MOS-files');
  fs.mkdirSync(path.join(files, 'apps', 'jellyfin', 'Movies'), { recursive: true });
  fs.writeFileSync(path.join(files, 'apps', 'jellyfin', 'Movies', 'film.mkv'), 'film');
  fs.mkdirSync(path.join(files, 'Films', 'caf\u00e9'), { recursive: true });
  fs.mkdirSync(path.join(files, '.mos-uploads'));
  fs.writeFileSync(path.join(files, '.mos-uploads', 'u1'), 'partial');
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'secret');
  return { base, files, mount, outside: path.join(base, 'outside') };
}

// Directory links are junctions on Windows, which is what an owner's laptop makes.
function linkDirectory(target, link) {
  fs.symlinkSync(target, link, 'junction');
}

function linkFile(t, target, link) {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
    t.skip('file symlinks need privileges on this machine');
    return false;
  }
}

async function refusedWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('a path with .. anywhere in it is refused before the disk is touched', () => {
  for (const relative of ['..', '../outside', 'Films/..', 'Films/../..', 'Films/../../outside', 'apps/jellyfin/../../..', 'Films/./café']) {
    assert.throws(() => parseRelativePath(relative), { code: 'FILES_PATH_INVALID' }, relative);
  }
});

test('absolute, drive-letter, backslash and empty-step paths are refused', () => {
  for (const relative of ['/etc/passwd', '/', 'C:/Windows', 'c:', 'Films\\..\\..', '\\\\server\\share', 'Films//café', 'Films/', 'a\u0000b']) {
    assert.throws(() => parseRelativePath(relative), { code: 'FILES_PATH_INVALID' }, JSON.stringify(relative));
  }
  assert.throws(() => parseRelativePath(42), { code: 'FILES_PATH_INVALID' });
  assert.throws(() => parseRelativePath(Array(65).fill('a').join('/')), { code: 'FILES_PATH_INVALID' });
  assert.deepEqual(parseRelativePath(''), []);
  assert.deepEqual(parseRelativePath('apps/jellyfin/Movies'), ['apps', 'jellyfin', 'Movies']);
});

test('MOS working folders are not reachable as owner paths', async () => {
  const drive = fixtureDrive();
  assert.throws(() => parseRelativePath('.mos-uploads/u1'), { code: 'FILES_PATH_INVALID' });
  assert.throws(() => parseRelativePath('Films/.MOS-deleting'), { code: 'FILES_PATH_INVALID' });
  await refusedWith(resolveExisting(drive.files, ['.mos-uploads', 'u1']), 'FILES_PATH_INVALID');
  const own = await resolveExisting(drive.files, ['.mos-uploads', 'u1'], { reserved: true });
  assert.equal(own.kind, 'file');
});

test('an ordinary path resolves to exactly that entry inside MOS-files', async () => {
  const drive = fixtureDrive();
  const film = await resolveExisting(drive.files, ['apps', 'jellyfin', 'Movies', 'film.mkv']);
  assert.equal(film.kind, 'file');
  assert.equal(fs.readFileSync(film.absolute, 'utf8'), 'film');
  assert.equal((await resolveExisting(drive.files, [])).kind, 'folder');
});

test('a junction or link at any depth is refused, whether it points out or back in', async (t) => {
  const drive = fixtureDrive();
  linkDirectory(drive.outside, path.join(drive.files, 'Escape'));
  linkDirectory(drive.outside, path.join(drive.files, 'Films', 'Deeper'));
  linkDirectory(path.join(drive.files, 'Films'), path.join(drive.files, 'apps', 'jellyfin', 'Movies', 'Loop'));
  await refusedWith(resolveExisting(drive.files, ['Escape']), 'FILES_PATH_REFUSED');
  await refusedWith(resolveExisting(drive.files, ['Escape', 'secret.txt']), 'FILES_PATH_REFUSED');
  await refusedWith(resolveExisting(drive.files, ['Films', 'Deeper', 'secret.txt']), 'FILES_PATH_REFUSED');
  await refusedWith(resolveExisting(drive.files, ['apps', 'jellyfin', 'Movies', 'Loop']), 'FILES_PATH_REFUSED');
  await refusedWith(resolveNew(drive.files, ['Escape'], 'planted.txt'), 'FILES_PATH_REFUSED');
  assert.equal(fs.existsSync(path.join(drive.outside, 'planted.txt')), false);
  if (linkFile(t, path.join(drive.outside, 'secret.txt'), path.join(drive.files, 'Films', 'secret.txt'))) {
    await refusedWith(resolveExisting(drive.files, ['Films', 'secret.txt']), 'FILES_PATH_REFUSED');
  }
});

test('MOS-files that is itself a junction is refused', async () => {
  const drive = fixtureDrive();
  const hostile = path.join(drive.base, 'hostile');
  fs.mkdirSync(hostile);
  linkDirectory(drive.outside, path.join(hostile, 'MOS-files'));
  await refusedWith(resolveExisting(path.join(hostile, 'MOS-files'), []), 'FILES_PATH_REFUSED');
  await refusedWith(resolveExisting(path.join(hostile, 'MOS-files'), ['secret.txt']), 'FILES_PATH_REFUSED');
});

test('a drive without MOS-files, or with a file in its place, has nothing to browse', async () => {
  const drive = fixtureDrive();
  await refusedWith(resolveExisting(path.join(drive.base, 'empty-mount', 'MOS-files'), []), 'FILES_NOT_FOUND');
  const odd = path.join(drive.base, 'odd');
  fs.mkdirSync(odd);
  fs.writeFileSync(path.join(odd, 'MOS-files'), 'not a folder');
  await refusedWith(resolveExisting(path.join(odd, 'MOS-files'), []), 'FILES_PATH_REFUSED');
});

test('a step that is a file, or missing, is not found', async () => {
  const drive = fixtureDrive();
  await refusedWith(resolveExisting(drive.files, ['apps', 'jellyfin', 'Movies', 'film.mkv', 'inside']), 'FILES_NOT_FOUND');
  await refusedWith(resolveExisting(drive.files, ['Nope']), 'FILES_NOT_FOUND');
});

test('only the name exactly as written on the drive opens, whatever the case or Unicode form', async () => {
  const drive = fixtureDrive();
  await refusedWith(resolveExisting(drive.files, ['APPS', 'jellyfin']), 'FILES_NOT_FOUND');
  await refusedWith(resolveExisting(drive.files, ['films']), 'FILES_NOT_FOUND');
  await refusedWith(resolveExisting(drive.files, ['Films', 'cafe\u0301']), 'FILES_NOT_FOUND');
  assert.equal((await resolveExisting(drive.files, ['Films', 'caf\u00e9'])).kind, 'folder');
});

test('a new name that only differs by case or Unicode form from a neighbour is taken', async () => {
  const drive = fixtureDrive();
  await refusedWith(resolveNew(drive.files, [], 'FILMS'), 'FILES_NAME_TAKEN');
  await refusedWith(resolveNew(drive.files, ['Films'], 'CAFE\u0301'), 'FILES_NAME_TAKEN');
  const fresh = await resolveNew(drive.files, ['Films'], 'Cafe\u0301 Society');
  assert.equal(fresh.name, 'Caf\u00e9 Society');
  assert.equal(path.basename(fresh.absolute), 'Caf\u00e9 Society');
});

test('names Windows could not open are refused for anything MOS makes', () => {
  for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', 'what?', 'a:b', 'pipe|d', 'star*', '<tag>', 'quote"', 'tab\tname', 'dot.', 'space ', 'CON', 'con.txt', 'LPT1', 'Com9.log', '.mos-uploads', '.MOS-anything', 'x'.repeat(256), '\u00e9'.repeat(128)]) {
    assert.ok(nameProblem(name), JSON.stringify(name));
  }
  for (const name of ['Movies', 'Das Boot (1981).mkv', '日本語のフォルダ', '.hidden', 'console', 'x'.repeat(255), 'a.b.c']) {
    assert.equal(nameProblem(name), null, name);
  }
});

test('the app folder tree stays put while its app uses the drive, and leftovers can go', () => {
  assert.match(changeRefusal([]), /top of the drive/u);
  assert.match(changeRefusal(['apps']), /keeps your apps/u);
  assert.match(changeRefusal(['apps', 'jellyfin']), /keeps your apps/u);
  assert.match(changeRefusal(['apps', 'jellyfin', 'Movies'], ['jellyfin']), /An app reads this folder/u);
  assert.equal(changeRefusal(['apps', 'plex', 'Movies'], ['jellyfin']), null);
  assert.equal(changeRefusal(['apps', 'jellyfin', 'Movies', 'film.mkv'], ['jellyfin']), null);
  assert.equal(changeRefusal(['Films']), null);
  assert.match(addRefusal(['apps']), /inside one of the app/u);
  assert.match(addRefusal(['apps', 'jellyfin']), /inside one of the app/u);
  assert.equal(addRefusal(['apps', 'jellyfin', 'Movies']), null);
  assert.equal(addRefusal([]), null);
});

test('only an app folder no app reads may be deleted whole, and never renamed or moved', () => {
  assert.equal(deleteRefusal(['apps', 'immich'], ['jellyfin']), null);
  assert.match(deleteRefusal(['apps', 'jellyfin'], ['jellyfin']), /keeps your apps/u);
  assert.match(deleteRefusal(['apps']), /keeps your apps/u);
  assert.match(changeRefusal(['apps', 'immich'], ['jellyfin']), /keeps your apps/u);
});

test('the drive top is read from, MOS-files is where changes happen, and backups and system folders stay closed', () => {
  assert.deepEqual(placeOnDrive([]), { inner: null });
  assert.deepEqual(placeOnDrive(['Photos 2019', 'Summer']), { inner: null });
  assert.deepEqual(placeOnDrive(['MOS-files', 'apps']), { inner: ['apps'] });
  assert.throws(() => placeOnDrive(['MOS-backups']), { code: 'FILES_PATH_REFUSED' });
  assert.throws(() => placeOnDrive(['System Volume Information']), { code: 'FILES_PATH_REFUSED' });
  assert.equal(isHousekeeping('$RECYCLE.BIN'), true);
  assert.equal(isHousekeeping('Photos'), false);
});
