const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { digestAppPackage, validatePrivacyBinding } = require('../../suite-manager/backend/src/apps/package-contracts.cjs');
const { bumpPackage } = require('../../scripts/app-bump.cjs');
const { parseImageReference } = require('../../scripts/app-images.cjs');

const appsDir = path.resolve(__dirname, '../../apps');
const digest = (seed) => `sha256:${seed.repeat(64)}`;
const read = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));

function copyPackage(t, appId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-bump-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const dir = path.join(root, appId);
  fs.cpSync(path.join(appsDir, appId), dir, { recursive: true });
  return dir;
}

function publishedEntry(dir) {
  const manifest = read(dir, 'manifest.json');
  return { packageDigest: digestAppPackage(dir, { manifest }), packageVersion: manifest.version };
}

function repin(dir, dockerfile, reference) {
  const file = path.join(dir, dockerfile);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^FROM\s+\S+/mu, `FROM ${reference}`));
}

function nextVersion(version, level) {
  const [major, minor, patch] = version.split('.').map(Number);
  return level === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

test('image references are named the way review components name them', () => {
  assert.deepEqual(parseImageReference(`mysql@${digest('a')}`), { artifact: 'docker.io/library/mysql', digest: digest('a'), tag: null });
  assert.deepEqual(parseImageReference('valkey/valkey:9'), { artifact: 'docker.io/valkey/valkey', digest: null, tag: '9' });
  assert.equal(parseImageReference('ghcr.io/immich-app/immich-server:v3.1.0').artifact, 'ghcr.io/immich-app/immich-server');
  assert.equal(parseImageReference('localhost:5000/app').artifact, 'localhost:5000/app');
});

test('a bump re-stamps the manifest, the review and the package digest together', (t) => {
  const dir = copyPackage(t, 'stirling-pdf');
  const baseline = publishedEntry(dir);
  repin(dir, 'Dockerfile', `stirlingtools/stirling-pdf@${digest('a')}`);

  bumpPackage(dir, { appVersion: '2.11.0', baseline });

  const manifest = read(dir, 'manifest.json');
  const review = read(dir, 'privacy-review.json');
  assert.equal(manifest.version, nextVersion(baseline.packageVersion, 'patch'));
  assert.equal(manifest.appVersion, '2.11.0');
  const component = review.scope.components.find((item) => item.artifact === 'docker.io/stirlingtools/stirling-pdf');
  assert.deepEqual([component.digest, component.version], [digest('a'), '2.11.0']);
  const packageDigest = digestAppPackage(dir, { manifest });
  assert.deepEqual(validatePrivacyBinding(review, { manifest, packageDigest, source: review.scope.source }), []);
});

test('running the bump twice changes nothing the second time', (t) => {
  const dir = copyPackage(t, 'stirling-pdf');
  const baseline = publishedEntry(dir);
  repin(dir, 'Dockerfile', `stirlingtools/stirling-pdf@${digest('a')}`);
  const snapshot = () => ['manifest.json', 'privacy-review.json'].map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));

  bumpPackage(dir, { appVersion: '2.11.0', baseline });
  const once = snapshot();
  bumpPackage(dir, { appVersion: '2.11.0', baseline });

  assert.deepEqual(snapshot(), once);
});

test('a moved primary pin with no tag is refused until its version is stated', (t) => {
  const dir = copyPackage(t, 'stirling-pdf');
  const baseline = publishedEntry(dir);
  repin(dir, 'Dockerfile', `stirlingtools/stirling-pdf@${digest('a')}`);

  assert.throws(() => bumpPackage(dir, { baseline }), /pass --app-version/u);
  assert.equal(read(dir, 'manifest.json').version, baseline.packageVersion);
});

test('tagged pins name their own versions, with a leading v dropped', (t) => {
  const dir = copyPackage(t, 'immich');
  const baseline = publishedEntry(dir);
  repin(dir, 'Dockerfile', `ghcr.io/immich-app/immich-server:v3.2.2@${digest('b')}`);
  repin(dir, 'Dockerfile.machine-learning', `ghcr.io/immich-app/immich-machine-learning:v3.2.2@${digest('c')}`);

  bumpPackage(dir, { baseline });

  assert.equal(read(dir, 'manifest.json').appVersion, '3.2.2');
  const learning = read(dir, 'privacy-review.json').scope.components.find((item) => item.artifact === 'ghcr.io/immich-app/immich-machine-learning');
  assert.deepEqual([learning.digest, learning.version], [digest('c'), '3.2.2']);
});

test('a moved companion pin with no tag needs its version stated', (t) => {
  const dir = copyPackage(t, 'seafile');
  const baseline = publishedEntry(dir);
  const appVersion = read(dir, 'manifest.json').appVersion;
  repin(dir, 'Dockerfile.valkey', `valkey/valkey@${digest('d')}`);

  assert.throws(() => bumpPackage(dir, { baseline }), /--component docker\.io\/valkey\/valkey=<version>/u);
  bumpPackage(dir, { baseline, componentVersions: { 'docker.io/valkey/valkey': '9.0.4' } });

  const valkey = read(dir, 'privacy-review.json').scope.components.find((item) => item.artifact === 'docker.io/valkey/valkey');
  assert.deepEqual([valkey.digest, valkey.version], [digest('d'), '9.0.4']);
  assert.equal(read(dir, 'manifest.json').appVersion, appVersion);
});

test('a package identical to the published one is not bumped', (t) => {
  const dir = copyPackage(t, 'stirling-pdf');
  assert.throws(() => bumpPackage(dir, { baseline: publishedEntry(dir) }), /nothing to bump/u);
});

test('a level moves the package version that far past the published one', (t) => {
  const dir = copyPackage(t, 'stirling-pdf');
  const baseline = publishedEntry(dir);
  repin(dir, 'Dockerfile', `stirlingtools/stirling-pdf@${digest('a')}`);

  bumpPackage(dir, { appVersion: '3.0.0', baseline, level: 'minor' });

  assert.equal(read(dir, 'manifest.json').version, nextVersion(baseline.packageVersion, 'minor'));
});
