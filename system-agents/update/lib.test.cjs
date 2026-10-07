const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');

const { StepFailure, buildPaths, collectStatus, runApply, summarizeJob, writeUpdateTrack } = require('./lib.cjs');

function run(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-repo-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'my-own-suite', repository: { url: 'https://github.com/rpuls/my-own-suite.git' }, scripts: { 'build:client': 'node -e "process.exit(0)"' } }));
  write(path.join(root, 'package-lock.json'), JSON.stringify({ name: 'my-own-suite', lockfileVersion: 3, packages: { '': { name: 'my-own-suite' } }, requires: true }));
  write(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n- Test update summary.\n');
  run(root, ['init', '-b', 'staging']);
  run(root, ['config', 'user.email', 'test@example.com']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, ['add', '.']);
  run(root, ['commit', '-m', 'initial']);
  run(root, ['remote', 'add', 'origin', root]);
  run(root, ['update-ref', 'refs/remotes/origin/staging', 'HEAD']);
  return root;
}

test('update track config validates branch refs and writes persisted track state', () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);

  const track = writeUpdateTrack(paths, { ref: 'staging', track: 'branch' });
  assert.equal(track.type, 'branch');
  assert.equal(track.ref, 'staging');
  assert.throws(() => writeUpdateTrack(paths, { ref: 'bad;ref', track: 'branch' }), /unsupported/u);
});

test('status reports branch target without a manual app runtime reconciliation warning', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);

  process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    const status = await collectStatus(paths);
    assert.equal(status.track.type, 'branch');
    assert.equal(status.track.ref, 'staging');
    assert.deepEqual(status.changeSummary.items, ['Test update summary.']);
    assert.equal(status.appRuntimeReconciliation, undefined);
    assert.equal(status.updateAvailable, false);
  } finally {
    delete process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP;
  }
});

test('a branch head moved only by site, docs and tests is not offered as an update', async () => {
  const upstream = makeRepo();
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-installed-'));
  run(installed, ['clone', '--quiet', '--branch', 'staging', upstream, '.']);
  const paths = buildPaths(installed, fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-')));
  const commit = (file) => {
    write(path.join(upstream, file), `${file}\n`);
    run(upstream, ['add', '.']);
    run(upstream, ['commit', '-m', file]);
  };

  commit('site/src/assets/screenshots/backups.png');
  commit('test/e2e/support/hyperv-updates.mjs');
  commit('docs/roadmap.md');
  assert.equal((await collectStatus(paths)).updateAvailable, false);

  commit('suite-manager/backend/src/server/start.cjs');
  assert.equal((await collectStatus(paths)).updateAvailable, true);
});

test('a branch update lists the changelog entries it brings, not the ones this machine already runs', async () => {
  const upstream = makeRepo();
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-installed-'));
  run(installed, ['clone', '--quiet', '--branch', 'staging', upstream, '.']);
  const paths = buildPaths(installed, fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-')));
  write(path.join(upstream, 'CHANGELOG.md'), [
    '# Changelog', '', '## [Unreleased]', '', '### Added', '',
    '- Test update summary.',
    '- **Backups run on a schedule.** Pick when:',
    '  - daily',
    '  - weekly',
    '',
    '  Retention keeps the last seven.',
    '',
  ].join('\n'));
  write(path.join(upstream, 'suite-manager/backend/src/server/start.cjs'), 'start\n');
  run(upstream, ['add', '.']);
  run(upstream, ['commit', '-m', 'schedules']);

  const status = await collectStatus(paths);

  assert.equal(status.updateAvailable, true);
  assert.deepEqual(status.changeSummary.items, ['**Backups run on a schedule.** Pick when:\n- daily\n- weekly\n\nRetention keeps the last seven.']);
  assert.equal(status.changeSummary.source, 'CHANGELOG.md [Unreleased]');
});

test('a stable update lists every release it brings, read from the release tag', async () => {
  const repo = makeRepo();
  const paths = buildPaths(repo, fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-')));
  const changelog = (...sections) => ['# Changelog', '', '## [Unreleased]', '', ...sections.flat(), ''].join('\n');
  const shipped = ['## [0.1.0] - 2026-09-01', '', '- **Backups exist.** Detail.'];
  write(path.join(repo, 'VERSION'), '0.1.0\n');
  write(path.join(repo, 'CHANGELOG.md'), changelog(shipped));
  run(repo, ['add', '.']);
  run(repo, ['commit', '-m', 'release 0.1.0']);
  write(path.join(repo, 'VERSION'), '0.2.0\n');
  write(path.join(repo, 'CHANGELOG.md'), changelog(['## [0.2.0] - 2026-10-01', '', '- **Backups run on a schedule.** Detail.'], ['## [0.1.1] - 2026-09-15', '', '- **Backups say where they went.** Detail.'], shipped));
  run(repo, ['add', '.']);
  run(repo, ['commit', '-m', 'release 0.2.0']);
  run(repo, ['tag', 'v0.2.0']);
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-remote-')), 'origin.git');
  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  run(repo, ['remote', 'set-url', 'origin', remote]);
  run(repo, ['reset', '--hard', 'HEAD~1']);
  run(repo, ['tag', '-d', 'v0.2.0']);
  writeUpdateTrack(paths, { track: 'stable' });

  const status = await collectStatus(paths, { releaseLookup: async () => ({ channel: 'stable', version: '0.2.0' }) });

  assert.equal(status.updateAvailable, true);
  assert.deepEqual(status.changeSummary.items, ['**Backups run on a schedule.** Detail.', '**Backups say where they went.** Detail.']);
  assert.equal(status.changeSummary.source, 'CHANGELOG.md [0.1.1 – 0.2.0]');
  assert.equal(status.changeSummary.title, 'Changes in 0.2.0');
});

test('apply refuses dirty working trees before running host reconciliation', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  write(path.join(repo, 'dirty.txt'), 'dirty');

  await assert.rejects(() => runApply(paths, { log() {} }), /Working tree is not clean/u);
});

test('apply recovers the known npm package-lock metadata dirtiness', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  write(path.join(repo, 'package-lock.json'), '{"name":"dirty"}\n');

  process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    await assert.rejects(() => runApply(paths, { log() {} }), /already up to date/u);
  } finally {
    delete process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP;
  }

  assert.equal(run(repo, ['status', '--porcelain']), '');
});

test('a detached checkout without a saved track defaults to Stable releases', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  run(repo, ['checkout', '--detach']);

  process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    const status = await collectStatus(paths);
    assert.equal(status.track.type, 'stable');
    assert.equal(status.track.ref, 'main');
  } finally {
    delete process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP;
  }
});

test('stable status compares the installed VERSION against the latest release', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  write(path.join(repo, 'VERSION'), '0.1.0\n');
  writeUpdateTrack(paths, { track: 'stable' });
  const release = { channel: 'stable', notesUrl: null, publishedAt: null, source: 'github-release', version: '0.2.0' };

  const behind = await collectStatus(paths, { releaseLookup: async () => release });
  assert.equal(behind.track.type, 'stable');
  assert.equal(behind.installedVersion, '0.1.0');
  assert.equal(behind.updateAvailable, true);

  write(path.join(repo, 'VERSION'), '0.2.0\n');
  const current = await collectStatus(paths, { releaseLookup: async () => release });
  assert.equal(current.installedVersion, '0.2.0');
  assert.equal(current.updateAvailable, false);
});

test('stable apply fetches and checks out the published release tag', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  write(path.join(repo, 'scripts', 'reconcile-system.cjs'), 'process.exit(0);\n');
  write(path.join(repo, 'VERSION'), '0.2.0\n');
  run(repo, ['add', '.']);
  run(repo, ['commit', '-m', 'release 0.2.0']);
  run(repo, ['tag', 'v0.2.0']);
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-remote-')), 'origin.git');
  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  run(repo, ['remote', 'set-url', 'origin', remote]);
  run(repo, ['reset', '--hard', 'HEAD~1']);
  run(repo, ['tag', '-d', 'v0.2.0']);
  writeUpdateTrack(paths, { track: 'stable' });
  const release = { channel: 'stable', notesUrl: null, publishedAt: null, source: 'github-release', version: '0.2.0' };

  const finalStatus = await runApply(paths, { log() {}, releaseLookup: async () => release });

  assert.equal(run(repo, ['rev-parse', 'HEAD']), run(repo, ['rev-parse', 'refs/tags/v0.2.0']));
  assert.equal(run(repo, ['branch', '--show-current']), '');
  assert.equal(fs.readFileSync(path.join(repo, 'VERSION'), 'utf8').trim(), '0.2.0');
  assert.equal(finalStatus.installedVersion, '0.2.0');
  assert.equal(finalStatus.track.type, 'stable');
  assert.equal(finalStatus.updateAvailable, false);
});

test('branch apply lands on the remote head even after the branch was force-rewritten', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  write(path.join(repo, 'scripts', 'reconcile-system.cjs'), 'process.exit(0);\n');
  run(repo, ['add', '.']);
  run(repo, ['commit', '-m', 'add reconcile stub']);
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-remote-')), 'origin.git');
  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  run(repo, ['remote', 'set-url', 'origin', remote]);
  run(repo, ['reset', '--hard', 'HEAD~1']);
  write(path.join(repo, 'diverged.txt'), 'local-only history\n');
  run(repo, ['add', '.']);
  run(repo, ['commit', '-m', 'diverged local commit']);

  process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    await runApply(paths, { log() {} });
  } finally {
    delete process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP;
  }

  const remoteHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: remote, encoding: 'utf8' }).trim();
  assert.equal(run(repo, ['rev-parse', 'HEAD']), remoteHead);
  assert.equal(run(repo, ['branch', '--show-current']), 'staging');
});

test('apply installs dependencies from lockfile without dirtying package-lock', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  const logs = [];
  write(path.join(repo, 'scripts', 'reconcile-system.cjs'), 'process.exit(0);\n');
  run(repo, ['add', '.']);
  run(repo, ['commit', '-m', 'add reconcile stub']);
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-remote-')), 'origin.git');
  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  run(repo, ['remote', 'set-url', 'origin', remote]);
  run(repo, ['reset', '--hard', 'HEAD~1']);

  process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    await runApply(paths, { log(message) { logs.push(message); } });
  } finally {
    delete process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP;
  }

  assert(logs.some((message) => /npm ci --include=dev/u.test(message)));
  assert.equal(run(repo, ['status', '--porcelain']), '');
});

// The reason an update failed used to live only in the journal of a transient
// unit. It now rides on the job: a sentence naming the step, and the last lines
// the step wrote.
test('a failing apply step names itself and keeps the tail of what it wrote', async () => {
  const repo = makeRepo();
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-state-'));
  const paths = buildPaths(repo, stateRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  manifest.scripts['build:client'] = 'node -e "console.error(\'vite: JavaScript heap out of memory\'); process.exit(3)"';
  write(path.join(repo, 'package.json'), JSON.stringify(manifest));
  run(repo, ['add', '.']);
  run(repo, ['commit', '-m', 'break the build']);
  const remote = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mos-update-remote-')), 'origin.git');
  execFileSync('git', ['clone', '--bare', repo, remote], { encoding: 'utf8' });
  run(repo, ['remote', 'set-url', 'origin', remote]);
  run(repo, ['reset', '--hard', 'HEAD~1']);

  process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP = '1';
  try {
    await assert.rejects(() => runApply(paths, { log() {} }), (error) => {
      assert.ok(error instanceof StepFailure);
      assert.equal(error.message, 'npm run build:client exited with code 3.');
      assert.match(error.output, /heap out of memory/u);
      return true;
    });
  } finally {
    delete process.env.MOS_UPDATE_SKIP_RELEASE_LOOKUP;
  }
});

test('a job summary carries the failure output only when there is one', () => {
  assert.equal(summarizeJob(null), null);
  assert.equal(summarizeJob({ id: 'a', status: 'succeeded' }).output, null);
  assert.equal(summarizeJob({ id: 'a', output: '', status: 'failed' }).output, null);
  assert.equal(summarizeJob({ id: 'a', output: 'npm ERR! 404', status: 'failed' }).output, 'npm ERR! 404');
});
