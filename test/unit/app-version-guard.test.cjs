const assert = require('node:assert/strict');
const test = require('node:test');

const { compareCatalogs } = require('../../scripts/app-version-guard.cjs');

const digest = (value) => `sha256:${String(value).repeat(64).slice(0, 64)}`;
const entry = (packageVersion, seed) => ({
  minimumMosVersion: '0.1.0',
  packageDigest: digest(seed),
  packageVersion,
  path: 'apps/example',
  privacy: { status: 'review-required' },
});

// The case that shipped: every app gained a privacy review under an unchanged
// version number, which the catalog check could not see because catalog.json
// honestly described the working tree. Installed boxes would never be offered
// the change, because availability is decided by version.
test('changed package contents under an unchanged version number is refused', () => {
  const errors = compareCatalogs(
    { packages: { seafile: entry('0.1.0', '1') } },
    { packages: { seafile: entry('0.1.0', '2') } },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /seafile: contents changed but packageVersion is still 0\.1\.0/u);
});

test('changed contents with a bumped version is how a package is published', () => {
  assert.deepEqual(compareCatalogs(
    { packages: { seafile: entry('0.1.0', '1') } },
    { packages: { seafile: entry('0.2.0', '2') } },
  ), []);
});

test('an untouched package is not reported', () => {
  assert.deepEqual(compareCatalogs(
    { packages: { seafile: entry('0.1.0', '1') } },
    { packages: { seafile: entry('0.1.0', '1') } },
  ), []);
});

// Installed boxes never downgrade, so a version that moves backwards strands
// whatever it replaced rather than replacing it.
test('a version that moves backwards is refused', () => {
  const errors = compareCatalogs(
    { packages: { seafile: entry('0.2.0', '1') } },
    { packages: { seafile: entry('0.1.0', '2') } },
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /packageVersion moves backwards, from 0\.2\.0 to 0\.1\.0/u);
});

test('a package the published catalog does not carry yet has nothing to compare against', () => {
  assert.deepEqual(compareCatalogs(
    { packages: {} },
    { packages: { seafile: entry('0.1.0', '1') } },
  ), []);
});

test('a package removed from the catalog is not treated as a version fault', () => {
  assert.deepEqual(compareCatalogs(
    { packages: { seafile: entry('0.1.0', '1') } },
    { packages: {} },
  ), []);
});
