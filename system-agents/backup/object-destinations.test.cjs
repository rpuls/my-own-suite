// What an owner may type into the storage-connection dialog, what MOS keeps of
// it, and what the storage engine is told. The interesting cases are the ones
// where accepting the input would produce a repository address that quietly
// disagrees with what the dialog said, and the ones where a secret could leak
// out of the agent.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  isObjectDestinationId,
  MAX_OBJECT_DESTINATIONS,
  normalizeObjectDestination,
  ObjectDestinationRegistry,
  objectRepositorySpec,
  publicObjectDestination,
} = require('./object-destinations.cjs');

const VALID = Object.freeze({
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  bucket: 'mos-backups',
  endpoint: 'https://s3.eu-central-1.amazonaws.com',
  folder: 'home-server',
  region: 'eu-central-1',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
});

async function registry() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-object-dest-'));
  return { registry: new ObjectDestinationRegistry({ agentStateDir: root }), root };
}

test('an endpoint that carries a bucket, a path or credentials is refused rather than reinterpreted', () => {
  for (const endpoint of ['https://s3.example.com/my-bucket', 'https://key:secret@s3.example.com', 'ftp://s3.example.com', 'https://s3.example.com/?x=1']) {
    assert.throws(() => normalizeObjectDestination({ ...VALID, endpoint }), /endpoint|access key/iu, `accepted ${endpoint}`);
  }
  // A bare host is the common way to write one and means https.
  assert.equal(normalizeObjectDestination({ ...VALID, endpoint: 's3.example.com' }).endpoint, 'https://s3.example.com');
  // A trailing slash is a path of "/" and is the one path that means nothing.
  assert.equal(normalizeObjectDestination({ ...VALID, endpoint: 'http://minio.lan:9000/' }).endpoint, 'http://minio.lan:9000');
});

test('bucket and folder are held to what a provider will actually accept', () => {
  for (const bucket of ['', 'ab', 'UPPER', '-leading', 'trailing-', 'has..dots', 'a'.repeat(64)]) {
    assert.throws(() => normalizeObjectDestination({ ...VALID, bucket }), /bucket/iu, `accepted bucket ${bucket}`);
  }
  assert.equal(normalizeObjectDestination({ ...VALID, folder: '/servers/home/' }).folder, 'servers/home');
  assert.equal(normalizeObjectDestination({ ...VALID, folder: '' }).folder, '');
  for (const folder of ['../escape', 'a/../b', 'with space', 'a//b']) {
    assert.throws(() => normalizeObjectDestination({ ...VALID, folder }), /folder/iu, `accepted folder ${folder}`);
  }
});

test('an edit keeps the stored secret when none is typed, and replaces it when one is', () => {
  const existing = normalizeObjectDestination(VALID);
  const renamed = normalizeObjectDestination({ ...VALID, id: existing.id, label: 'Offsite', secretAccessKey: '' }, existing);
  assert.equal(renamed.secretAccessKey, existing.secretAccessKey);
  assert.equal(renamed.id, existing.id);
  assert.equal(renamed.label, 'Offsite');
  const rekeyed = normalizeObjectDestination({ ...VALID, id: existing.id, secretAccessKey: 'a-brand-new-secret-value' }, existing);
  assert.equal(rekeyed.secretAccessKey, 'a-brand-new-secret-value');
  // A first connection has nothing to fall back on.
  assert.throws(() => normalizeObjectDestination({ ...VALID, secretAccessKey: '' }), /secret access key/iu);
});

test('the repository address is built from the fields, and the credentials never appear in it', () => {
  const spec = objectRepositorySpec(normalizeObjectDestination(VALID));
  assert.equal(spec.location, 's3:https://s3.eu-central-1.amazonaws.com/mos-backups/home-server/MOS-backups/repository');
  assert.equal(spec.env.AWS_ACCESS_KEY_ID, VALID.accessKeyId);
  assert.equal(spec.env.AWS_SECRET_ACCESS_KEY, VALID.secretAccessKey);
  assert.equal(spec.env.AWS_DEFAULT_REGION, VALID.region);
  assert.ok(!spec.location.includes(VALID.secretAccessKey));
  assert.ok(!spec.location.includes(VALID.accessKeyId));
  // The engine masks these out of anything it captured before it leaves root.
  assert.ok(spec.secrets.includes(VALID.secretAccessKey));
  // Without a folder the repository sits at the top of the bucket, still under
  // the same names a drive uses.
  assert.equal(
    objectRepositorySpec(normalizeObjectDestination({ ...VALID, folder: '' })).location,
    's3:https://s3.eu-central-1.amazonaws.com/mos-backups/MOS-backups/repository',
  );
  // A provider that needs no region is not given an empty one.
  assert.equal(objectRepositorySpec(normalizeObjectDestination({ ...VALID, region: '' })).env.AWS_DEFAULT_REGION, undefined);
});

test('what leaves the agent describes the connection without the secret', () => {
  const record = normalizeObjectDestination(VALID);
  const shown = publicObjectDestination(record);
  assert.equal(JSON.stringify(shown).includes(VALID.secretAccessKey), false);
  assert.equal(shown.accessKeyId, VALID.accessKeyId);
  assert.equal(shown.bucket, 'mos-backups');
  assert.ok(isObjectDestinationId(shown.id));
});

test('a stored connection is root-only, survives a reread, and cannot be added twice', async () => {
  const { registry: store, root } = await registry();
  const saved = store.save(VALID);
  assert.deepEqual(store.list().map((entry) => entry.id), [saved.id]);
  assert.equal(store.get(saved.id).secretAccessKey, VALID.secretAccessKey);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(root, 'object-destinations.json')).mode & 0o777, 0o600);
  }
  assert.throws(() => store.save({ ...VALID, label: 'Second try' }), /already connected/iu);
  // The same bucket with a different folder is a different destination.
  const other = store.save({ ...VALID, folder: 'other-server' });
  assert.equal(store.list().length, 2);
  store.remove(other.id);
  assert.deepEqual(store.list().map((entry) => entry.id), [saved.id]);
  assert.throws(() => store.remove(other.id), /no longer exists/iu);
});

test('the number of connections is capped so the destination list stays a choice', async () => {
  const { registry: store } = await registry();
  for (let index = 0; index < MAX_OBJECT_DESTINATIONS; index += 1) store.save({ ...VALID, folder: `server-${index}` });
  assert.throws(() => store.save({ ...VALID, folder: 'one-too-many' }), /up to \d+ storage connections/iu);
});
