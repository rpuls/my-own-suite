'use strict';

// A package that builds two services on one upstream image, as Paperless-ngx does
// for its MCP service, must move both pins together, or an update ships two versions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appsDir = path.resolve(__dirname, '..', '..', 'apps');

function pinsOf(packageDir) {
  const pins = [];
  for (const file of fs.readdirSync(packageDir).filter((name) => /^Dockerfile(?:\..+)?$/u.test(name))) {
    for (const match of fs.readFileSync(path.join(packageDir, file), 'utf8').matchAll(/^FROM\s+(\S+?)(?::[^@\s]+)?@(sha256:[0-9a-f]{64})/gmu)) {
      pins.push({ digest: match[2], file, image: match[1] });
    }
  }
  return pins;
}

test('every Dockerfile in a package pins the same digest for the same image', () => {
  for (const app of fs.readdirSync(appsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const byImage = new Map();
    for (const pin of pinsOf(path.join(appsDir, app.name))) {
      byImage.set(pin.image, [...(byImage.get(pin.image) || []), pin]);
    }
    for (const [image, pins] of byImage) {
      const digests = new Set(pins.map((pin) => pin.digest));
      assert.equal(digests.size, 1, `apps/${app.name} pins ${image} at ${digests.size} digests: ${pins.map((pin) => `${pin.file} ${pin.digest.slice(7, 19)}`).join(', ')}`);
    }
  }
});

test('a pin read from a Dockerfile keeps its image name apart from its tag', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'mos-pins-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), `FROM valkey/valkey:9@sha256:${'a'.repeat(64)}\n`);
  fs.writeFileSync(path.join(dir, 'Dockerfile.mcp'), `FROM valkey/valkey@sha256:${'b'.repeat(64)}\n`);
  assert.deepEqual(pinsOf(dir).map((pin) => pin.image), ['valkey/valkey', 'valkey/valkey']);
});
