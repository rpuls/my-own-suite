const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const { buildPaths, collectStatus, runApply, writeUpdateTrack } = require('./lib.cjs');

function run(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-update-repo-'));
  fs.mkdirSync(path.join(root, 'version-2'), { recursive: true });
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'my-own-suite', repository: { url: 'https://github.com/rpuls/my-own-suite.git' } }));
  write(path.join(root, 'version-2', 'package.json'), JSON.stringify({ name: 'my-own-suite-version-2', scripts: { 'build:client': 'node -e "process.exit(0)"' } }));
  write(path.join(root, 'version-2', 'package-lock.json'), JSON.stringify({ name: 'my-own-suite-version-2', lockfileVersion: 3, packages: { '': { name: 'my-own-suite-version-2' } }, requires: true }));
  write(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- Test update summary.\n');
  run(root, ['init', '-b', 'feat/app-platform-v2-lab']);
  run(root, ['config', 'user.email', 'test@example.com']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'initial']);
  run(root, ['remote', 'add', 'origin', root]);
  run(root, ['update-ref', 'refs/remotes/origin/feat/app-platform-v2-lab', 'HEAD']);
  return root;
}

test('update track config validates branch refs and writes persisted track state', () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-update-state-'));
  const paths = buildPaths(repo, stateRoot);

  const track = writeUpdateTrack(paths, { ref: 'staging', track: 'branch' });
  assert.equal(track.type, 'branch');
  assert.equal(track.ref, 'staging');
  assert.throws(() => writeUpdateTrack(paths, { ref: 'bad;ref', track: 'branch' }), /unsupported/u);
});

test('status reports branch target, changelog summary, and manual app runtime reconciliation', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-update-state-'));
  const paths = buildPaths(repo, stateRoot);

  process.env.MOS_V2_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    const status = await collectStatus(paths);
    assert.equal(status.track.type, 'branch');
    assert.equal(status.track.ref, 'feat/app-platform-v2-lab');
    assert.deepEqual(status.changeSummary.items, ['Test update summary.']);
    assert.equal(status.appRuntimeReconciliation.automatic, false);
    assert.equal(status.updateAvailable, false);
  } finally {
    delete process.env.MOS_V2_UPDATE_SKIP_RELEASE_LOOKUP;
  }
});

test('apply refuses dirty working trees before running host reconciliation', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  write(path.join(repo, 'version-2', 'dirty.txt'), 'dirty');

  await assert.rejects(() => runApply(paths, { log() {} }), /Working tree is not clean/u);
});

test('apply recovers the known npm package-lock metadata dirtiness', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  write(path.join(repo, 'version-2', 'package-lock.json'), '{"name":"dirty"}\n');

  process.env.MOS_V2_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    await assert.rejects(() => runApply(paths, { log() {} }), /already up to date/u);
  } finally {
    delete process.env.MOS_V2_UPDATE_SKIP_RELEASE_LOOKUP;
  }

  assert.equal(run(repo, ['status', '--porcelain']), '');
});

test('apply installs dependencies from lockfile without dirtying package-lock', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  const logs = [];
  write(path.join(repo, 'version-2', 'scripts', 'reconcile-system.cjs'), 'process.exit(0);\n');
  run(repo, ['add', '.']);
  run(repo, ['commit', '-m', 'add reconcile stub']);
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-v2-update-remote-')), 'origin.git');
  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  run(repo, ['remote', 'set-url', 'origin', remote]);
  run(repo, ['reset', '--hard', 'HEAD~1']);

  process.env.MOS_V2_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    await runApply(paths, { log(message) { logs.push(message); } });
  } finally {
    delete process.env.MOS_V2_UPDATE_SKIP_RELEASE_LOOKUP;
  }

  assert(logs.some((message) => /npm --prefix version-2 ci --include=dev/u.test(message)));
  assert.equal(run(repo, ['status', '--porcelain']), '');
});
