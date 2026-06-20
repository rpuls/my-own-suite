import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v2Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const containerName = 'mos-v2-e2e-homepage';
const statePath = path.join(v2Root, '.state', 'e2e-runtime.json');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: v2Root, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed.`);
}

async function waitForReady() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      const homepage = await fetch('http://127.0.0.1:13200/', { headers: { Host: 'home.localhost' } });
      const suiteManager = await fetch('http://127.0.0.1:13100/suite-manager/api/setup/status', { headers: { Host: 'home.localhost' } });
      if (homepage.ok && suiteManager.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for the local V2 Suite Manager.');
}

export default async function globalSetup() {
  const runtimeDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-v2-e2e-'));
  const homepageConfig = path.join(runtimeDir, 'homepage');
  await fsp.cp(path.join(v2Root, 'infrastructure', 'homepage'), homepageConfig, { recursive: true });
  run('npm', ['run', 'build:client']);
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', shell: process.platform === 'win32' });
  run('docker', [
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1:13200:3000',
    '--env', 'HOMEPAGE_ALLOWED_HOSTS=home.localhost',
    '--volume', `${homepageConfig}:/app/config`,
    'ghcr.io/gethomepage/homepage@sha256:cc84f2f5eb3c7734353701ccbaa24ed02dacb0d119114e50e4251e2005f3990a',
  ]);
  const suiteManager = spawn(process.execPath, ['suite-manager/backend/src/server/start.cjs'], {
    cwd: v2Root,
    env: {
      ...process.env,
      MOS_V2_FRONTEND_DIST_DIR: path.join(v2Root, 'suite-manager', 'frontend', 'dist'),
      MOS_V2_HOMEPAGE_UPSTREAM: 'http://127.0.0.1:13200',
      MOS_V2_HOME_HOST: 'home.localhost',
      MOS_V2_STATE_DIR: path.join(runtimeDir, 'state'),
      MOS_V2_SUITE_MANAGER_HOST: '127.0.0.1',
      MOS_V2_SUITE_MANAGER_PORT: '13100',
    },
    stdio: 'ignore',
  });
  await waitForReady();
  await fsp.mkdir(path.dirname(statePath), { recursive: true });
  await fsp.writeFile(statePath, JSON.stringify({ pid: suiteManager.pid, runtimeDir }));
}
