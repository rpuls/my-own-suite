import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const e2eRoot = path.join(repoRoot, 'test', 'e2e');
const SKIPPED_DIRS = new Set(['node_modules', 'playwright-report', 'playwright-report-hyperv', 'results', 'screenshots', 'test-results']);
const APP_HOOKS = ['journey', 'verify'];

const apps = fs.readdirSync(path.join(repoRoot, 'apps'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(repoRoot, 'apps', entry.name, 'manifest.json')))
  .map((entry) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'apps', entry.name, 'manifest.json'), 'utf8')));

function coreFiles(dir = e2eRoot) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : coreFiles(full);
    return /\.(?:c|m)?js$/u.test(entry.name) ? [full] : [];
  });
}

function escapeRegex(value) {
  return value.replace(/[/\\^$*+?.()|[\]{}]/gu, '\\$&');
}

// MOS outside apps/ knows no app by name, and the E2E core is held to the same
// rule: what is particular to an app lives in apps/<id>/e2e/, where it can grow
// without touching the core every other app runs through.
test('the E2E core names no catalog app', () => {
  const names = apps.flatMap((manifest) => [manifest.id, manifest.name]);
  const pattern = new RegExp(`(?<![\\w-])(?:${names.map(escapeRegex).join('|')})(?![\\w-])`, 'iu');
  const offenders = [];
  for (const file of coreFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      const found = pattern.exec(line);
      if (found) offenders.push(`${path.relative(repoRoot, file)}:${index + 1} names "${found[0]}"`);
    });
  }
  assert.deepEqual(offenders, [], `Move app-specific test code into apps/<id>/e2e/:\n${offenders.join('\n')}`);
});

test('every catalog app ships an E2E module with a journey and a verify', async () => {
  for (const manifest of apps) {
    const file = path.join(repoRoot, 'apps', manifest.id, 'e2e', 'index.mjs');
    assert.ok(fs.existsSync(file), `apps/${manifest.id}/e2e/index.mjs is missing`);
    const module = (await import(pathToFileURL(file).href)).default;
    for (const hook of APP_HOOKS) assert.equal(typeof module?.[hook], 'function', `apps/${manifest.id}/e2e/index.mjs has no ${hook}()`);
    for (const optional of ['landed', 'masks', 'secrets', 'setupValue']) {
      if (optional in module) assert.equal(typeof module[optional], 'function', `apps/${manifest.id}/e2e ${optional} should be a function`);
    }
    for (const [shot, rank] of Object.entries(module.showcase || {})) {
      assert.ok(Number.isInteger(rank) && rank > 0, `apps/${manifest.id}/e2e showcase.${shot} should be a positive rank`);
    }
  }
});
