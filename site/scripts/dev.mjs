#!/usr/bin/env node
// `npm run dev` serves the whole public site from one origin: Astro on 4321 and
// the planner sub-app's own Vite server on 5173, which astro.config.mjs proxies
// at /plan/. Without this the planner is only reachable on its own port and
// http://localhost:4321/plan/ 404s, unlike the deployed site.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('..', import.meta.url));
const plannerRoot = fileURLToPath(new URL('../planner/', import.meta.url));

const children = [];
let shuttingDown = false;

function stop(code) {
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exit(code);
}

function start(label, cwd, script, args = []) {
  const child = spawn(process.execPath, [script, ...args], { cwd, stdio: 'inherit' });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(`\n${label} exited (${signal ?? code}); stopping the other dev server.\n`);
    stop(typeof code === 'number' ? code : 1);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop(0));

// Staged planner assets (brand copies, Dashboard Icons, MOS catalog) must exist
// before its server starts; the fetch is cached, so repeat runs are instant.
const prepare = spawn(process.execPath, ['scripts/prepare-assets.mjs'], { cwd: plannerRoot, stdio: 'inherit' });
prepare.on('exit', (code) => {
  if (code !== 0) stop(code ?? 1);
  start('Planner dev server', plannerRoot, 'node_modules/vite/bin/vite.js', ['--host', '127.0.0.1']);
  start('Astro dev server', siteRoot, 'node_modules/astro/bin/astro.mjs', ['dev', ...process.argv.slice(2)]);
});
