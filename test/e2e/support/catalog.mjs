import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from './env.mjs';

const appsDir = path.join(repoRoot, 'apps');

export function appModulePath(id) {
  return path.join(appsDir, id, 'e2e', 'index.mjs');
}

// The apps the paths can name, read from the packages themselves so core test
// code never carries a list of them.
export function catalogApps() {
  return fs.readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(appsDir, entry.name, 'manifest.json')))
    .map((entry) => {
      const manifest = JSON.parse(fs.readFileSync(path.join(appsDir, entry.name, 'manifest.json'), 'utf8'));
      return {
        accepts: Object.values(manifest.integrations || {}).flatMap((slot) => (slot.accepts || []).map((item) => item.type)),
        hasModule: fs.existsSync(appModulePath(manifest.id)),
        id: manifest.id,
        name: manifest.name,
        needsHttps: manifest.requirements?.https === true,
        provides: Object.values(manifest.exports || {}).map((item) => item.type),
        role: manifest.role || 'standalone',
        routeHosts: (manifest.routes || []).map((route) => route.host).filter(Boolean),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id, 'en'));
}

const loaded = new Map();

export async function loadAppModule(id) {
  if (!loaded.has(id)) {
    const file = appModulePath(id);
    loaded.set(id, fs.existsSync(file) ? (await import(pathToFileURL(file).href)).default : null);
  }
  return loaded.get(id);
}

export async function requireAppModule(id) {
  const module = await loadAppModule(id);
  if (!module) throw new Error(`apps/${id}/e2e/index.mjs is missing: every catalog app ships its own E2E module.`);
  return module;
}
