import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v2Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const statePath = path.join(v2Root, '.state', 'e2e-runtime.json');

async function stopAndWait(pid) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export default async function globalTeardown() {
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    await Promise.all([stopAndWait(state.pid), stopAndWait(state.agentPid)]);
    await fsp.rm(state.runtimeDir, { force: true, maxRetries: 20, recursive: true, retryDelay: 100 });
    await fsp.rm(statePath, { force: true });
  }
  spawnSync('docker', ['rm', '-f', 'mos-v2-e2e-homepage'], { stdio: 'ignore', shell: process.platform === 'win32' });
}
