const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { StorageRegistry, isRememberedDrive, publicBucket } = require('./storage-registry.cjs');

const DRIVE = { apps: ['media-app'], fileSystem: 'ntfs', label: 'Expansion' };
const BUCKET = { accessKeyId: 'AKIAEXAMPLE', backups: true, bucket: 'family', createdAt: '2026-10-18T03:00:00.000Z', endpoint: 'https://s3.test', folder: 'home', id: 'object:0123456789ab', label: 'Family backups', region: 'eu-central-1', secretAccessKey: 'super-secret-value' };

function registry(initial) {
  const registryPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-storage-registry-')), 'storage.json');
  if (initial !== undefined) fs.writeFileSync(registryPath, typeof initial === 'string' ? initial : JSON.stringify(initial));
  return new StorageRegistry({ registryPath });
}

function withDrive(fields = DRIVE, id = 'DRIVE-0001') {
  const store = registry();
  store.update(({ drives }) => { drives[id] = { ...fields }; });
  return store;
}

test('a record that is missing, unreadable or of another version reads as empty', () => {
  assert.deepEqual(registry().read().drives, {});
  assert.deepEqual(registry('not json').read().drives, {});
  const kept = withDrive();
  const { version } = kept.read();
  assert.deepEqual(Object.keys(kept.read().drives), ['DRIVE-0001']);
  for (const other of [version - 1, version + 1]) {
    const foreign = registry({ buckets: { [BUCKET.id]: BUCKET }, drives: { 'DRIVE-0001': DRIVE }, version: other });
    assert.deepEqual(foreign.read(), { buckets: {}, drives: {}, version });
  }
});

test('an update lands whole, root-only, with no lock or temporary file left behind', () => {
  const store = withDrive();
  const answer = store.update((record) => { record.buckets[BUCKET.id] = BUCKET; return 'answered'; });
  assert.equal(answer, 'answered');
  const written = JSON.parse(fs.readFileSync(store.registryPath, 'utf8'));
  assert.deepEqual(Object.keys(written.drives), ['DRIVE-0001']);
  assert.equal(written.buckets[BUCKET.id].secretAccessKey, BUCKET.secretAccessKey);
  if (process.platform !== 'win32') assert.equal(fs.statSync(store.registryPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(store.registryPath)), ['storage.json']);
});

test('a lock left behind by a process that died is taken over', () => {
  const store = withDrive();
  const lock = `${store.registryPath}.lock`;
  fs.writeFileSync(lock, '');
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, stale, stale);
  store.update(({ drives }) => { drives['DRIVE-0001'].name = 'Films'; });
  assert.equal(store.drive('DRIVE-0001').name, 'Films');
  assert.equal(fs.existsSync(lock), false);
});

test('a change that throws leaves the record as it was and the lock released', () => {
  const store = withDrive();
  assert.throws(() => store.update(({ drives }) => { drives.NEW = {}; throw new Error('refused'); }), /refused/u);
  assert.deepEqual(Object.keys(store.read().drives), ['DRIVE-0001']);
  assert.equal(fs.existsSync(`${store.registryPath}.lock`), false);
});

test('recording drive facts merges them, drops those set to undefined, and leaves an unknown drive alone', () => {
  const store = withDrive();
  store.recordDrive('DRIVE-0001', { ejected: true, problem: { detail: 'dirty', reason: 'needs a check' } });
  assert.deepEqual(store.drive('DRIVE-0001'), { ...DRIVE, ejected: true, problem: { detail: 'dirty', reason: 'needs a check' } });
  store.recordDrive('DRIVE-0001', { ejected: undefined, problem: undefined });
  assert.deepEqual(store.drive('DRIVE-0001'), DRIVE);
  store.recordDrive('NEVER-SEEN', { ejected: true });
  assert.equal(store.drive('NEVER-SEEN'), null);
});

test('renaming sets the owner\'s name, tidies it, and an empty name gives a drive its own label back', () => {
  const store = withDrive();
  assert.equal(store.rename('DRIVE-0001', '  Family   films  '), 'Family films');
  assert.equal(store.drive('DRIVE-0001').name, 'Family films');
  assert.equal(store.rename('DRIVE-0001', 'x'.repeat(80)).length, 60);
  assert.equal(store.rename('DRIVE-0001', ''), '');
  assert.equal('name' in store.drive('DRIVE-0001'), false);
  assert.deepEqual(store.drive('DRIVE-0001').apps, DRIVE.apps, 'a rename touches nothing but the name');
});

test('naming a drive MOS has never kept anything on does not make it remembered', () => {
  const store = registry();
  store.rename('NEW-DRIVE', 'Spare');
  assert.equal(store.drive('NEW-DRIVE').name, 'Spare');
  assert.equal(isRememberedDrive(store.drive('NEW-DRIVE')), false);
});

test('a bucket is renamed through the same call and must keep a name', () => {
  const store = registry();
  store.update(({ buckets }) => { buckets[BUCKET.id] = { ...BUCKET }; });
  assert.equal(store.rename(BUCKET.id, 'Offsite'), 'Offsite');
  assert.equal(store.bucketList()[0].label, 'Offsite');
  assert.throws(() => store.rename(BUCKET.id, '   '), /Give it a name/u);
  assert.equal(store.bucketList()[0].label, 'Offsite');
});

test('forgetting drops a drive no app reads and keeps one an app does', () => {
  const store = withDrive();
  assert.equal(store.forgetDrive('DRIVE-0001'), false);
  assert.ok(store.drive('DRIVE-0001'));
  store.update(({ drives }) => { drives['DRIVE-0001'].apps = []; drives['DRIVE-0001'].backups = true; });
  assert.equal(store.forgetDrive('DRIVE-0001'), true);
  assert.equal(store.drive('DRIVE-0001'), null);
  assert.equal(store.forgetDrive('DRIVE-0001'), false);
});

test('a drive is remembered while an app reads it, backups go to it, or it is kept open', () => {
  assert.equal(isRememberedDrive({ apps: ['media-app'] }), true);
  assert.equal(isRememberedDrive({ apps: [], backups: true }), true);
  assert.equal(isRememberedDrive({ apps: [], keepOpen: true }), true);
  assert.equal(isRememberedDrive({ apps: [], name: 'Spare' }), false);
  assert.equal(isRememberedDrive(null), false);
});

test('a bucket leaves the agent with its access key id and without its secret', () => {
  const shown = publicBucket(BUCKET);
  assert.equal('secretAccessKey' in shown, false);
  assert.deepEqual(shown, { accessKeyId: BUCKET.accessKeyId, backups: true, bucket: 'family', createdAt: BUCKET.createdAt, endpoint: BUCKET.endpoint, folder: 'home', id: BUCKET.id, label: BUCKET.label, region: 'eu-central-1' });
});
