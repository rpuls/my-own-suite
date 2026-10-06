#!/usr/bin/env node
// A disposable MOS lab on this Linux machine, for a throwaway VM or CI runner. MOS is
// served to it from a local repository, so moving the lab to the commit under test needs
// no GitHub login, and the tests run on the lab itself.
//
//   node scripts/smoke/local-lab.cjs install <base>            install MOS from <base>
//   node scripts/smoke/local-lab.cjs drill <app> <candidate>   @update <app> onto <candidate>, then @app-dr <app>

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..');
const RESULTS = path.join(repoRoot, 'test', 'e2e', 'results');
const LAB_REPO = '/srv/mos-lab.git';
const LAB_BRANCH = 'lab';
const DOMAIN = process.env.MOS_LOCAL_LAB_DOMAIN || 'mos.lab';
const SOURCE = process.env.MOS_LOCAL_LAB_SOURCE || 'https://github.com/rpuls/my-own-suite';
const HOME_URL = `http://home.${DOMAIN}`;
const HOSTS_MARK = '# mos-local-lab';
const READY_MINUTES = 45;

function run(program, args, { capture = false } = {}) {
  const result = spawnSync(program, args, { cwd: repoRoot, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return result.stdout;
}

// Moving the lab's branch is all it takes for the lab to be offered an update.
function move(ref) {
  if (!fs.existsSync(LAB_REPO)) run('sudo', ['git', 'init', '--quiet', '--bare', LAB_REPO]);
  run('sudo', ['git', '-C', LAB_REPO, 'fetch', '--quiet', SOURCE, ref]);
  run('sudo', ['git', '-C', LAB_REPO, 'update-ref', `refs/heads/${LAB_BRANCH}`, 'FETCH_HEAD']);
  console.log(`[local-lab] ${LAB_BRANCH} is at ${ref}`);
}

function routeHosts() {
  const appsDir = path.join(repoRoot, 'apps');
  return fs.readdirSync(appsDir).filter((id) => fs.existsSync(path.join(appsDir, id, 'manifest.json'))).flatMap((id) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(appsDir, id, 'manifest.json'), 'utf8'));
    return (manifest.routes || []).map((route) => route.host).filter(Boolean);
  });
}

// The machine's own address rather than loopback, so app containers reach each other's
// public addresses too. The `dns01` step's domain is here as well: DNS-01 proves it
// through a TXT record alone, so nothing public points it at this machine.
function writeHosts() {
  const address = run('hostname', ['-I'], { capture: true }).trim().split(/\s+/u)[0];
  const hosts = ['home', ...new Set(routeHosts())];
  const domains = [DOMAIN, process.env.MOS_E2E_DNS01_BASE_DOMAIN?.trim()].filter(Boolean);
  const lines = domains.map((domain) => `${address} ${hosts.map((host) => `${host}.${domain}`).join(' ')} ${HOSTS_MARK}`);
  const kept = fs.readFileSync('/etc/hosts', 'utf8').split('\n').filter((line) => !line.endsWith(HOSTS_MARK));
  const file = path.join(os.tmpdir(), 'mos-local-lab-hosts');
  fs.writeFileSync(file, `${[...kept.filter(Boolean), ...lines].join('\n')}\n`);
  run('sudo', ['cp', file, '/etc/hosts']);
}

async function waitForSuiteManager() {
  const deadline = Date.now() + READY_MINUTES * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await fetch(`${HOME_URL}/suite-manager/api/setup/status`).catch(() => null);
    if (response?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 10000));
  }
  throw new Error(`Suite Manager did not answer at ${HOME_URL} within ${READY_MINUTES} minutes.`);
}

// A CI runner ships Docker's own engine, held, and its containerd.io conflicts with the
// containerd that Ubuntu's docker.io needs. A machine MOS really installs on has none, so
// on CI it goes, data and all; anywhere else the lab stops rather than wipe someone's Docker.
function removeForeignEngine() {
  const installed = run('dpkg-query', ['-W', '-f=${db:Status-Abbrev}|${Package}\\n'], { capture: true }).split('\n')
    .filter((line) => line[1] === 'i').map((line) => line.split('|')[1]);
  if (installed.includes('docker.io')) return;
  const engine = installed.filter((name) => /^(?:moby-.+|docker-.+|containerd.*|runc|podman-docker)$/u.test(name));
  if (!engine.length) return;
  if (process.env.CI !== 'true') throw new Error(`This machine already has a container engine (${engine.join(', ')}). MOS installs Ubuntu's docker.io, so remove it first, or run the lab on a throwaway machine.`);
  run('sudo', ['apt-get', 'purge', '--yes', '--quiet', '--allow-change-held-packages', ...engine]);
  run('sudo', ['rm', '-rf', '/var/lib/docker', '/var/lib/containerd', '/etc/docker']);
  console.log(`[local-lab] removed the runner's own container engine: ${engine.join(', ')}`);
}

const epoch = () => Math.floor(Date.now() / 1000);

// The bootstrap and the e2e steps say only that something stopped; systemd says which unit
// and why. The whole journal since `since` goes with the results, MOS's tail to the log.
function reportSystemd(since) {
  spawnSync('sudo', ['systemctl', '--no-pager', '--failed'], { stdio: 'inherit' });
  spawnSync('sudo', ['systemctl', '--no-pager', 'list-jobs'], { stdio: 'inherit' });
  spawnSync('sudo', ['journalctl', '--no-pager', '--lines', '60', '--unit', 'mos-*'], { stdio: 'inherit' });
  fs.mkdirSync(RESULTS, { recursive: true });
  const journal = fs.openSync(path.join(RESULTS, 'journal.log'), 'w');
  spawnSync('sudo', ['journalctl', '--no-pager', '--since', `@${since}`], { stdio: ['ignore', journal, 'inherit'] });
  fs.closeSync(journal);
}

async function install(base) {
  const since = epoch();
  move(base);
  writeHosts();
  removeForeignEngine();
  const script = run(process.execPath, [
    'scripts/installers/render-bootstrap.cjs', '--target', 'shell', '--repo-url', LAB_REPO, '--repo-ref', LAB_BRANCH,
    '--domain', DOMAIN, '--front-door', 'ssh-bootstrap', '--disposable-lab',
  ], { capture: true });
  const file = path.join(os.tmpdir(), 'mos-local-lab-bootstrap.sh');
  fs.writeFileSync(file, script);
  try {
    run('sudo', ['bash', file]);
  } catch (error) {
    reportSystemd(since);
    throw error;
  }
  await waitForSuiteManager();
  console.log(`[local-lab] MOS from ${base} answers at ${HOME_URL}`);
}

function e2e(items, onStep = () => {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['test/e2e/run.mjs', ...items], {
      cwd: repoRoot,
      env: { ...process.env, MOS_E2E_BASE_URL: HOME_URL, MOS_E2E_LAB_SSH: 'local' },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let id = null;
    let partial = '';
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      const lines = `${partial}${chunk}`.split('\n');
      partial = lines.pop();
      for (const line of lines) {
        id ||= /results\/([^/\s]+)\//u.exec(line)?.[1] || null;
        const step = /^\s+→ (\S+)/u.exec(line)?.[1];
        if (step) onStep(step);
      }
    });
    child.on('exit', () => resolve(outcome(items.join(' '), id)));
  });
}

function outcome(path_, id) {
  const summaryFile = id && path.join(RESULTS, id, 'summary.json');
  const summary = summaryFile && fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, 'utf8')) : { status: 'crashed', steps: [] };
  const failed = summary.steps.find((step) => step.status !== 'passed');
  return { error: failed?.error || summary.error || null, failedStep: failed?.title || null, path: path_, run: id, status: summary.status, steps: summary.steps.map((step) => `${step.status === 'passed' ? '✓' : '✗'} ${step.title}`) };
}

// The recovery drill runs only on a lab that took the update, or it would prove the old version.
async function drill(app, candidate) {
  const since = epoch();
  let moved = false;
  const update = await e2e(['@update', app], (step) => {
    if (step.startsWith('platform-update') && !moved) {
      moved = true;
      move(candidate);
    }
  });
  const updated = update.steps.some((line) => line.startsWith('✓ platform-update'));
  const recovery = updated ? await e2e(['@app-dr', app]) : { path: `@app-dr ${app}`, status: 'not run', steps: [] };
  const runs = [update, recovery];
  fs.writeFileSync(path.join(RESULTS, 'drill.json'), `${JSON.stringify({ app, candidate, runs }, null, 2)}\n`);
  for (const run_ of runs) console.log(`[local-lab] ${run_.path}: ${run_.status}${run_.failedStep ? ` at ${run_.failedStep}` : ''}`);
  const passed = runs.every((run_) => run_.status === 'passed');
  if (!passed) reportSystemd(since);
  return passed;
}

async function main([command, ...args]) {
  if (process.platform !== 'linux') throw new Error('The local lab installs MOS on this machine, so it runs on Linux only.');
  if (command === 'install' && args[0]) return install(args[0]);
  if (command === 'drill' && args[1]) return drill(args[0], args[1]);
  throw new Error('Usage: local-lab.cjs install <base> | drill <app> <candidate>');
}

main(process.argv.slice(2)).then((ok) => {
  if (ok === false) process.exitCode = 1;
}).catch((error) => {
  console.error(`[local-lab] ${error.message}`);
  process.exitCode = 2;
});
