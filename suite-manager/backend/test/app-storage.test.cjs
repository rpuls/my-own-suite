const assert = require('node:assert/strict');
const test = require('node:test');

const { renderDryRunProjections } = require('../src/apps/app-package-internals.cjs');
const { compareAppPackages } = require('../src/apps/app-update-comparison.cjs');
const { placeFolders } = require('../src/apps/app-storage.cjs');
const { unmetHostRequirements, declaredHostRequirements } = require('../src/apps/host-requirements.cjs');

function mediaApp(required) {
  return {
    health: { type: 'http', url: 'http://media:8096/health' },
    id: 'media',
    name: 'Media',
    resources: { services: { media: { dockerfile: 'Dockerfile', internalPort: 8096, volumes: ['config:/config'] } } },
    routes: [{ host: 'media', service: 'media' }],
    storage: {
      folders: [{ name: 'Movies', path: '/media/movies', service: 'media' }, { name: 'Series', path: '/media/series', service: 'media' }],
      required,
    },
  };
}

const DRIVES = [
  { id: '1A2B-3C4D', usable: true },
  { id: 'e1e1-linux', reason: 'This drive is formatted as ext4.', usable: false },
];

test('every folder of an app is placed on the one drive the owner picked', () => {
  assert.deepEqual(placeFolders(mediaApp(true), '1A2B-3C4D', DRIVES), [
    { driveId: '1A2B-3C4D', name: 'Movies' },
    { driveId: '1A2B-3C4D', name: 'Series' },
  ]);
});

test('an app that needs a drive is refused without one, and an optional one installs without folders', () => {
  assert.throws(() => placeFolders(mediaApp(true), null, DRIVES), (error) => error.code === 'APP_STORAGE_DRIVE_REQUIRED');
  assert.deepEqual(placeFolders(mediaApp(false), null, DRIVES), []);
});

test('a drive that is gone or cannot hold app files is refused with its own reason', () => {
  assert.throws(() => placeFolders(mediaApp(false), 'GONE-0000', DRIVES), (error) => error.code === 'APP_STORAGE_DRIVE_UNAVAILABLE' && /no longer connected/u.test(error.message));
  assert.throws(() => placeFolders(mediaApp(false), 'e1e1-linux', DRIVES), /ext4/u);
});

test('placed folders reach their service in the runtime projection, never as volumes', () => {
  const placed = placeFolders(mediaApp(true), '1A2B-3C4D', DRIVES);
  const compose = renderDryRunProjections(mediaApp(true), [], { folders: placed }).find((projection) => projection.kind === 'compose').content;
  assert.deepEqual(compose.services[0].folders, [
    { drive: '1A2B-3C4D', name: 'Movies', path: '/media/movies' },
    { drive: '1A2B-3C4D', name: 'Series', path: '/media/series' },
  ]);
  assert.deepEqual(compose.volumes, ['config']);
  const unplaced = renderDryRunProjections(mediaApp(false), []).find((projection) => projection.kind === 'compose').content;
  assert.equal('folders' in unplaced.services[0], false);
});

test('an update that brings folders an app needs offers the drive choice once; optional ones wait for its settings', () => {
  const versioned = (version, storage) => ({ ...mediaApp(false), name: 'Media', storage, version });
  const compare = (installed, candidate, folders = []) => compareAppPackages({
    candidate: { manifest: candidate, packageDigest: 'sha256:b', packageDir: '/nowhere', source: { trust: 'unverified' } },
    installed: { folders, manifest: installed, packageDigest: 'sha256:a', packageDir: '/nowhere', source: { trust: 'unverified' } },
    platformVersion: '99.0.0',
  });
  const needed = { ...mediaApp(true).storage, label: 'Drive for films' };
  const first = compare(versioned('1.0.0', undefined), versioned('1.1.0', needed));
  assert.deepEqual(first.storage, { description: null, folders: [{ name: 'Movies', service: 'media' }, { name: 'Series', service: 'media' }], label: 'Drive for films', required: true });
  assert.ok(first.changes.some((change) => change.area === 'storage'));
  assert.equal(compare(versioned('1.1.0', needed), versioned('1.2.0', needed), placeFolders(mediaApp(true), '1A2B-3C4D', DRIVES)).storage, null);

  const optional = compare(versioned('1.0.0', undefined), versioned('1.1.0', mediaApp(false).storage));
  assert.equal(optional.storage, null);
  assert.match(optional.changes.find((change) => change.area === 'storage').summary, /in its settings/u);
});

test('an update that adds or renames folders keeps them on the drive the app already uses', () => {
  const versioned = (version, folders) => ({ ...mediaApp(true), storage: { folders, required: true }, version });
  const before = versioned('1.0.0', mediaApp(true).storage.folders);
  const after = versioned('1.1.0', [{ name: 'Films', path: '/media/movies', service: 'media' }, { name: 'Series', path: '/media/series', service: 'media' }]);
  const held = placeFolders(before, '1A2B-3C4D', DRIVES);
  const comparison = compareAppPackages({
    candidate: { manifest: after, packageDigest: 'sha256:b', packageDir: '/nowhere', source: { trust: 'unverified' } },
    installed: { folders: held, manifest: before, packageDigest: 'sha256:a', packageDir: '/nowhere', source: { trust: 'unverified' } },
    platformVersion: '99.0.0',
  });
  assert.equal(comparison.storage, null, 'no drive is asked for again');
  assert.deepEqual(comparison.changes.filter((change) => change.area === 'storage').map((change) => change.summary), [
    'Media now also keeps Films on the drive it already uses.',
    'Media no longer uses Movies. Everything in that folder stays on the drive.',
  ]);
  assert.deepEqual(placeFolders(after, '1A2B-3C4D', DRIVES, new Set(held.map((folder) => folder.name))), [{ driveId: '1A2B-3C4D', name: 'Films' }]);
  const compose = renderDryRunProjections(after, [], { folders: [...held, { driveId: '1A2B-3C4D', name: 'Films' }] }).find((projection) => projection.kind === 'compose').content;
  assert.deepEqual(compose.services[0].folders.map((folder) => folder.name), ['Films', 'Series']);
});

test('an app that needs a drive is blocked on a server with none, and only then', () => {
  const declared = declaredHostRequirements(mediaApp(true));
  assert.deepEqual(unmetHostRequirements(declared, { storageDrives: 0 }).map((unmet) => unmet.id), ['storage']);
  assert.match(unmetHostRequirements(declared, { storageDrives: 0 })[0].reason, /^Requires an extra storage device/u);
  assert.deepEqual(unmetHostRequirements(declared, { storageDrives: 1 }), []);
  assert.deepEqual(unmetHostRequirements(declared, { storageDrives: null }), []);
  assert.deepEqual(unmetHostRequirements(declaredHostRequirements(mediaApp(false)), { storageDrives: 0 }), []);
});
