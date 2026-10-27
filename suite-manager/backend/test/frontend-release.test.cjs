const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { promoteFrontendBuild } = require('../src/server/frontend-release.cjs');

function writeBuild(dir, label, { withScript = true } = {}) {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><script type="module" src="/suite-manager/assets/assets/${label}.js"></script>`);
  if (withScript) fs.writeFileSync(path.join(dir, 'assets', `${label}.js`), label);
}

function frontendDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mos-frontend-release-'));
}

test('a server that starts serves the build made beside its pages', () => {
  const root = frontendDir();
  const dist = path.join(root, 'dist');
  writeBuild(dist, 'old');
  writeBuild(path.join(root, 'dist-next'), 'new');

  assert.equal(promoteFrontendBuild(dist), true);
  assert.match(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), /new\.js/u);
  assert.deepEqual(fs.readdirSync(root), ['dist']);
});

test('a build that is missing a file it loads is not served', () => {
  const root = frontendDir();
  const dist = path.join(root, 'dist');
  writeBuild(dist, 'old');
  writeBuild(path.join(root, 'dist-next'), 'new', { withScript: false });
  const said = [];

  assert.equal(promoteFrontendBuild(dist, { log: (message) => said.push(message) }), false);
  assert.match(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), /old\.js/u);
  assert.match(said[0], /assets\/new\.js/u);
});

test('a restart with no new build keeps the pages it has', () => {
  const root = frontendDir();
  const dist = path.join(root, 'dist');
  writeBuild(dist, 'old');

  assert.equal(promoteFrontendBuild(dist), false);
  assert.match(fs.readFileSync(path.join(dist, 'index.html'), 'utf8'), /old\.js/u);
});

test('the first build on a fresh install becomes the pages', () => {
  const root = frontendDir();
  writeBuild(path.join(root, 'dist-next'), 'first');

  assert.equal(promoteFrontendBuild(path.join(root, 'dist')), true);
  assert.deepEqual(fs.readdirSync(root), ['dist']);
});
