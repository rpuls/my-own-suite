import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const v2Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const statePath = path.join(v2Root, '.state', 'e2e-runtime.json');

export default async function globalTeardown() {
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    try { process.kill(state.pid, 'SIGTERM'); } catch {}
    await fsp.rm(state.runtimeDir, { force: true, recursive: true });
    await fsp.rm(statePath, { force: true });
  }
  spawnSync('docker', ['rm', '-f', 'mos-v2-e2e-homepage'], { stdio: 'ignore', shell: process.platform === 'win32' });
}
