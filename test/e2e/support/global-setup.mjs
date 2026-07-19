import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const containerName = 'mos-e2e-homepage';
const statePath = path.join(repoRoot, '.state', 'e2e-runtime.json');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed.`);
}

async function waitForReady() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const homepage = await fetch('http://home.127.0.0.1.sslip.io:13200/');
      const suiteManager = await fetch('http://home.127.0.0.1.sslip.io:13100/suite-manager/api/setup/status');
      if (homepage.ok && suiteManager.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for the local MOS Suite Manager.');
}

export default async function globalSetup() {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-e2e-'));
  const homepageConfig = path.join(runtimeDir, 'homepage');
  const agentSocket = process.platform === 'win32' ? `\\\\.\\pipe\\mos-homepage-e2e-${process.pid}` : path.join(runtimeDir, 'homepage-agent.sock');
  await fsp.cp(path.join(repoRoot, 'infrastructure', 'homepage'), homepageConfig, { recursive: true });
  run('npm', ['run', 'build:client']);
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', shell: process.platform === 'win32' });
  run('docker', [
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1:13200:3000',
    '--env', 'HOMEPAGE_ALLOWED_HOSTS=home.127.0.0.1.sslip.io',
    '--volume', `${homepageConfig}:/app/config`,
    'ghcr.io/gethomepage/homepage@sha256:cc84f2f5eb3c7734353701ccbaa24ed02dacb0d119114e50e4251e2005f3990a',
  ]);
  const homepageAgent = spawn(process.execPath, ['test/e2e/support/local-homepage-agent.cjs'], {
    cwd: repoRoot,
    env: { ...process.env, MOS_HOMEPAGE_AGENT_SOCKET: agentSocket, MOS_HOMEPAGE_CONFIG_ROOT: homepageConfig },
    stdio: 'ignore',
  });
  const suiteManager = spawn(process.execPath, ['suite-manager/backend/src/server/start.cjs'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MOS_FRONTEND_DIST_DIR: path.join(repoRoot, 'suite-manager', 'frontend', 'dist'),
      MOS_HOMEPAGE_UPSTREAM: 'http://127.0.0.1:13200',
      MOS_HOME_HOST: 'home.127.0.0.1.sslip.io',
      MOS_HOMEPAGE_AGENT_SOCKET: agentSocket,
      MOS_STATE_DIR: path.join(runtimeDir, 'state'),
      MOS_SUITE_MANAGER_HOST: '127.0.0.1',
      MOS_SUITE_MANAGER_PORT: '13100',
    },
    stdio: 'ignore',
  });
  await waitForReady();
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify({ agentPid: homepageAgent.pid, pid: suiteManager.pid, runtimeDir }));
}
