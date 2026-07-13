const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AppPackageContractError,
  canonicalPackagePath,
  digestAppPackage,
} = require('../src/apps/package-contracts.cjs');

function packageFixture(lineEnding = '\n') {
  const packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-package-contract-'));
  const manifest = {
    category: 'test',
    health: { type: 'http', url: 'http://example:8080/health' },
    id: 'example',
    minimumMosVersion: '0.1.0',
    name: 'Example',
    resources: { services: { example: { dockerfile: 'Dockerfile', internalPort: 8080 } } },
    routes: [{ host: 'example', port: 8080, service: 'example' }],
    setup: { fields: [] },
    summary: 'Example package.',
    version: '1.0.0',
  };
  fs.writeFileSync(path.join(packageDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2).replace(/\n/gu, lineEnding)}${lineEnding}`);
  fs.writeFileSync(path.join(packageDir, 'Dockerfile'), `FROM scratch${lineEnding}`);
  return packageDir;
}

test('package digest is stable across LF and CRLF checkouts', (t) => {
  const lf = packageFixture('\n');
  const crlf = packageFixture('\r\n');
  t.after(() => {
    fs.rmSync(lf, { force: true, recursive: true });
    fs.rmSync(crlf, { force: true, recursive: true });
  });
  assert.equal(digestAppPackage(lf), digestAppPackage(crlf));
});

test('package digest binds file paths and contents', (t) => {
  const packageDir = packageFixture();
  t.after(() => fs.rmSync(packageDir, { force: true, recursive: true }));
  const before = digestAppPackage(packageDir);
  fs.appendFileSync(path.join(packageDir, 'Dockerfile'), '# changed\n');
  assert.notEqual(digestAppPackage(packageDir), before);
});

test('package validation rejects undeclared files and symlinks', (t) => {
  const packageDir = packageFixture();
  t.after(() => fs.rmSync(packageDir, { force: true, recursive: true }));
  fs.writeFileSync(path.join(packageDir, 'unexpected.bin'), 'not declared');
  assert.throws(() => digestAppPackage(packageDir), (error) => {
    assert.ok(error instanceof AppPackageContractError);
    assert.match(error.details.join('\n'), /not allowed or declared/u);
    return true;
  });
});

test('canonical package paths reject traversal and platform ambiguity', () => {
  assert.equal(canonicalPackagePath('assets/config.json'), 'assets/config.json');
  assert.equal(canonicalPackagePath('../secret'), null);
  assert.equal(canonicalPackagePath('assets\\config.json'), null);
  assert.equal(canonicalPackagePath('assets/../manifest.json'), null);
});
