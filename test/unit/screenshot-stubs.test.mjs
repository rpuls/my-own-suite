import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  STUBBABLE_PATHS,
  applyStub,
  changedPaths,
  changelogReleases,
  nextPackageVersion,
  readRepoChangelog,
  stubPackagesUpdateAvailable,
  stubStableTrackStatus,
  stubUpdateComparison,
} from '../e2e/support/screenshot-stubs.mjs';

const require = createRequire(import.meta.url);
const { normalizeStatus } = require('../../suite-manager/backend/src/updates/update-service.cjs');
const { buildPaths, collectStatus } = require('../../system-agents/update/lib.cjs');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A screenshot arranged from these transforms is published as a picture of MOS,
// so the tests come at them from both sides: the arranged response has to be one
// the real producer could have emitted, and a response missing what a transform
// needs has to throw rather than return something half-arranged that renders
// into a wrong screenshot nobody notices.

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

// A checkout the real update agent will read, mirroring the harness in
// system-agents/update/lib.test.cjs.
function makeRepo(changelog) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-screenshot-stub-'));
  const run = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'my-own-suite', repository: { url: 'https://github.com/rpuls/my-own-suite.git' } }));
  write(path.join(root, 'CHANGELOG.md'), changelog);
  run(['init', '-b', 'staging']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['add', '.']);
  run(['commit', '-m', 'initial']);
  run(['remote', 'add', 'origin', root]);
  run(['update-ref', 'refs/remotes/origin/staging', 'HEAD']);
  return root;
}

// The lab-shaped `/updates/status` response, produced by the real update agent
// against a real checkout and normalized by the real Suite Manager service. A
// hand-written approximation would let the transform keep passing after the
// response shape moved, which is the failure mode the screenshot cannot see.
async function labStatus(changelog) {
  const repo = makeRepo(changelog);
  const paths = buildPaths(repo, fs.mkdtempSync(path.join(os.tmpdir(), 'mos-screenshot-state-')));
  process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    return normalizeStatus({
      capabilities: { updates: ['apply', 'configure-track'] },
      updaterStatus: await collectStatus(paths),
    }, true);
  } finally {
    delete process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP;
  }
}

const RELEASED_CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '- Something not shipped yet.',
  '',
  '## [0.20.0] - 2026-09-01',
  '',
  '- Apps can declare what each service needs to run.',
  '- Backups verify every archive before a restore.',
  '',
  '## [0.19.0] - 2026-08-17',
  '',
  '- Owner environment is instance-owned.',
  '',
].join('\n');

test('the changelog reader agrees with the update agent that produces the real summary', async () => {
  // Same bullets under both headings, so the agent's own parse of [Unreleased]
  // is the expected value for this module's parse of the released section.
  const changelog = RELEASED_CHANGELOG.replace('## [Unreleased]\n\n- Something not shipped yet.', '## [Unreleased]\n\n- Apps can declare what each service needs to run.\n- Backups verify every archive before a restore.');
  const status = await labStatus(changelog);
  assert.deepEqual(changelogReleases(changelog)[0].items, status.changeSummary.items);
});

test('the real repository CHANGELOG yields a release and the one before it', () => {
  const releases = changelogReleases(readRepoChangelog());
  assert.ok(releases.length >= 2, 'the repository changelog should carry at least two released sections');
  assert.ok(releases[0].items.length, 'the newest released section should carry bullets to render');
  assert.notEqual(releases[0].version, releases[1].version);
});

test('an Unreleased-only changelog is refused rather than arranged into an empty screen', async () => {
  const status = await labStatus('# Changelog\n\n## [Unreleased]\n\n- Not shipped.\n');
  assert.throws(() => stubStableTrackStatus(status, { changelog: '# Changelog\n\n## [Unreleased]\n\n- Not shipped.\n' }), /released section/u);
});

test('a released section with no bullets is refused rather than rendering an empty release-notes panel', async () => {
  const changelog = '# Changelog\n\n## [0.20.0] - 2026-09-01\n\n## [0.19.0] - 2026-08-17\n\n- Shipped.\n';
  const status = await labStatus(changelog);
  assert.throws(() => stubStableTrackStatus(status, { changelog }), /no bullets/u);
});

test('the arranged status is the lab response with only the stable-track identity moved', async () => {
  const status = await labStatus(RELEASED_CHANGELOG);
  assert.equal(status.track.type, 'branch');
  assert.equal(status.track.ref, 'staging');

  const arranged = applyStub('updates/status', status, (body) => stubStableTrackStatus(body, { changelog: RELEASED_CHANGELOG }));

  assert.equal(arranged.track.type, 'stable');
  assert.equal(arranged.track.label, 'Stable releases');
  assert.equal(arranged.track.ref, 'main');
  assert.equal(arranged.installedVersion, '0.19.0');
  assert.equal(arranged.latestRelease.version, '0.20.0');
  assert.equal(arranged.updateAvailable, true);
  assert.equal(arranged.changeSummary.title, 'Changes in 0.20.0');
  assert.equal(arranged.changeSummary.source, 'CHANGELOG.md [0.20.0]');
  assert.deepEqual(arranged.changeSummary.items, ['Apps can declare what each service needs to run.', 'Backups verify every archive before a restore.']);
  // The commit the machine is really on, the check time, and what the updater
  // can actually do are the machine's own and stay untouched.
  assert.equal(arranged.track.currentCommit, status.track.currentCommit);
  assert.equal(arranged.checkedAt, status.checkedAt);
  assert.equal(arranged.managedApplyAvailable, status.managedApplyAvailable);
  assert.deepEqual(Object.keys(arranged).sort(), Object.keys(status).sort());
});

test('a status response missing the fields the screen reads throws instead of half-arranging', () => {
  for (const [name, body] of [
    ['no track', { changeSummary: {}, latestRelease: {} }],
    ['no latestRelease', { changeSummary: {}, track: {} }],
    ['no changeSummary', { latestRelease: {}, track: {} }],
    ['nothing at all', null],
  ]) {
    assert.throws(() => stubStableTrackStatus(body, { changelog: RELEASED_CHANGELOG }), /update status response/u, name);
  }
});

// The comparison the lab really produces: the same package on both sides, which
// is what the backend computes when the catalog branch and the installed
// checkout hold identical packages.
function realComparisonBody(packageId) {
  const { compareAppPackages } = require('../../suite-manager/backend/src/apps/app-update-comparison.cjs');
  const packageDir = path.join(repoRoot, 'apps', packageId);
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'));
  const side = { manifest, packageDigest: 'a'.repeat(64), packageDir, source: { kind: 'official', trust: 'mos-reviewed' } };
  return {
    comparison: compareAppPackages({
      agentCapabilities: ['apps.package.snapshot'],
      agentContractVersion: 99,
      candidate: side,
      hostArchitecture: 'amd64',
      installed: side,
      platformVersion: '99.0.0',
    }),
  };
}

test('the lab comparison this arranges from is the one the real comparator produces', () => {
  const body = realComparisonBody('radicale');
  assert.equal(body.comparison.updateStatus, 'current');
  assert.equal(body.comparison.installed.packageVersion, body.comparison.candidate.packageVersion);
});

test('arranging a comparison dates the candidate forward and changes nothing else', () => {
  const body = realComparisonBody('radicale');
  const availableVersion = nextPackageVersion(body.comparison.installed.packageVersion);
  const arranged = applyStub('apps/packages/:id/prepare-update', body, (input) => stubUpdateComparison(input, { availableVersion }));

  assert.equal(arranged.comparison.updateStatus, 'update-available');
  assert.equal(arranged.comparison.candidate.packageVersion, availableVersion);
  assert.equal(arranged.comparison.installed.packageVersion, body.comparison.installed.packageVersion);
  // The privacy verdicts, the permission diff, the change list, and the token
  // that binds an apply to a reviewed pair are the backend's, untouched.
  assert.deepEqual(arranged.comparison.candidate.privacy, body.comparison.candidate.privacy);
  assert.deepEqual(arranged.comparison.permissions, body.comparison.permissions);
  assert.deepEqual(arranged.comparison.changes, body.comparison.changes);
  assert.equal(arranged.comparison.confirmationToken, body.comparison.confirmationToken);
});

test('a comparison that already has a real update is refused, so a real one is captured instead', () => {
  const body = realComparisonBody('radicale');
  body.comparison.updateStatus = 'update-available';
  assert.throws(() => stubUpdateComparison(body, { availableVersion: '9.9.9' }), /capture it without arranging/u);
});

test('a comparison missing its version pair throws instead of half-arranging', () => {
  assert.throws(() => stubUpdateComparison({}, { availableVersion: '1.1.0' }), /no comparison/u);
  assert.throws(() => stubUpdateComparison({ comparison: { candidate: {}, updateStatus: 'current' } }, { availableVersion: '1.1.0' }), /installed\/candidate pair/u);
});

function packagesBody(overrides = {}) {
  return {
    packages: [
      { catalogUpdate: null, id: 'onlyoffice', instance: null, name: 'ONLYOFFICE' },
      {
        catalogUpdate: {
          available: { compatibility: 'compatible', minimumMosVersion: '0.17.0', packageDigest: 'b'.repeat(64), packageVersion: '1.34.1', privacy: { status: 'reviewed' }, sourceRevision: 'abc123' },
          installed: { packageDigest: 'b'.repeat(64), packageVersion: '1.34.1' },
          status: 'current',
        },
        id: 'vaultwarden',
        instance: { id: 'instance-1', packageVersion: '1.34.1' },
        name: 'Vaultwarden',
        ...overrides,
      },
    ],
  };
}

test('arranging the catalog moves one package to update-available and leaves every other package alone', () => {
  const body = packagesBody();
  const arranged = applyStub('apps/packages', body, (input) => stubPackagesUpdateAvailable(input, { availableVersion: '1.35.0', packageId: 'vaultwarden' }));

  const target = arranged.packages.find((item) => item.id === 'vaultwarden');
  assert.equal(target.catalogUpdate.status, 'update-available');
  assert.equal(target.catalogUpdate.available.packageVersion, '1.35.0');
  assert.equal(target.catalogUpdate.installed.packageVersion, '1.34.1');
  assert.equal(target.catalogUpdate.available.packageDigest, 'b'.repeat(64));
  assert.deepEqual(arranged.packages[0], body.packages[0]);
});

test('a package with nothing installed or no catalog candidate throws instead of rendering no action', () => {
  assert.throws(() => stubPackagesUpdateAvailable(packagesBody(), { availableVersion: '1.35.0', packageId: 'seafile' }), /not in the packages response/u);
  assert.throws(() => stubPackagesUpdateAvailable(packagesBody({ instance: null }), { availableVersion: '1.35.0', packageId: 'vaultwarden' }), /not installed/u);
  assert.throws(() => stubPackagesUpdateAvailable(packagesBody({ catalogUpdate: { available: null, installed: null, status: 'not-in-catalog' } }), { availableVersion: '1.35.0', packageId: 'vaultwarden' }), /no catalog candidate/u);
  assert.throws(() => stubPackagesUpdateAvailable({}, { availableVersion: '1.35.0', packageId: 'vaultwarden' }), /no packages array/u);
});

test('only plain semantic versions can be dated forward', () => {
  assert.equal(nextPackageVersion('1.34.1'), '1.35.0');
  assert.equal(nextPackageVersion('0.9.0'), '0.10.0');
  for (const bad of ['', null, '1.34', 'latest', '1.34.1-rc.1']) {
    assert.throws(() => nextPackageVersion(bad), /not a plain semantic version/u);
  }
});

test('the allow-list is enforced, not decorative', () => {
  const body = packagesBody();
  assert.throws(
    () => applyStub('apps/packages', body, (input) => ({
      ...input,
      packages: input.packages.map((item) => (item.id === 'vaultwarden' ? { ...item, privacy: { posture: 'A' } } : item)),
    })),
    /not stubbable: packages\[\]\.privacy/u,
  );
  assert.throws(() => applyStub('apps/catalog', body, (input) => input), /not a stubbable endpoint/u);
});

test('the allow-list is exactly what was decided, so widening it is a deliberate edit', () => {
  // Every path here arranges which release a machine happens to be on. None of
  // them arranges a privacy verdict, a permission diff, a structural change
  // list, a package digest, a compatibility verdict, or an app count — things a
  // marketing screenshot presents as fact about MOS. Adding a line to this list
  // is a decision to publish a picture of something MOS did not produce.
  assert.deepEqual(STUBBABLE_PATHS, {
    'apps/packages': [
      'packages[].catalogUpdate.status',
      'packages[].catalogUpdate.available.packageVersion',
    ],
    'apps/packages/:id/prepare-update': [
      'comparison.updateStatus',
      'comparison.candidate.packageVersion',
    ],
    'updates/status': [
      'track.type',
      'track.label',
      'track.ref',
      'track.currentBranch',
      'installedVersion',
      'latestRelease.version',
      'updateAvailable',
      'changeSummary.items',
      'changeSummary.source',
      'changeSummary.title',
    ],
  });
});

test('changed paths name fields rather than rows, and see additions and removals', () => {
  assert.deepEqual(changedPaths({ a: 1 }, { a: 1 }), []);
  assert.deepEqual(changedPaths({ a: 1 }, { a: 2 }), ['a']);
  assert.deepEqual(changedPaths({ a: { b: 1 } }, { a: { b: 1, c: 2 } }), ['a.c']);
  assert.deepEqual(changedPaths({ a: [{ b: 1 }, { b: 2 }] }, { a: [{ b: 1 }, { b: 3 }] }), ['a[].b']);
  assert.deepEqual(changedPaths({ a: [1] }, { a: [1, 2] }), ['a[]']);
  assert.deepEqual(changedPaths({ a: 1 }, {}), ['a']);
});
