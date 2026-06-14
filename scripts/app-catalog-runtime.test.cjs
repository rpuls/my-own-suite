const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { caddyServiceRoutesForMode, catalogRouteSpecs } = require('./app-catalog-runtime.cjs');

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('generates only control-plane Caddy routes without installed app routes', () => {
  const caddyfile = caddyServiceRoutesForMode('localhost', 'off', []);

  assert.match(caddyfile, /@suite_manager host suite-manager\.localhost/);
  assert.match(caddyfile, /@homepage host homepage\.localhost/);
  assert.doesNotMatch(caddyfile, /stirling-pdf\.localhost/);
  assert.doesNotMatch(caddyfile, /radicale\.localhost/);
  assert.doesNotMatch(caddyfile, /vaultwarden\.localhost/);
});

test('generates installed catalog app Caddy routes from selection and manifests', async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-catalog-runtime-'));
  t.after(() => fs.rm(repoRoot, { force: true, recursive: true }));
  await writeJson(path.join(repoRoot, 'apps/suite-manager/catalog/apps/stirling-pdf.json'), {
    id: 'stirling-pdf',
    routes: [{ host: 'stirling-pdf', upstream: 'stirling-pdf:8080' }],
  });
  await writeJson(path.join(repoRoot, 'apps/suite-manager/catalog/apps/radicale.json'), {
    id: 'radicale',
    routes: [{ host: 'radicale', upstream: 'radicale:5232' }],
  });
  await writeJson(path.join(repoRoot, 'deploy/vps/generated/app-catalog/compose-selection.json'), {
    apps: [
      { id: 'stirling-pdf', status: 'installed' },
      { id: 'radicale', status: 'failed' },
    ],
    profiles: ['stirling-pdf'],
    version: 1,
  });

  const routes = catalogRouteSpecs(repoRoot);
  const caddyfile = caddyServiceRoutesForMode('home.example.com', 'cloudflare-dns01', routes);

  assert.deepEqual(routes, [{ host: 'stirling-pdf', httpsInHttpMode: false, upstream: 'stirling-pdf:8080' }]);
  assert.match(caddyfile, /suite-manager\.home\.example\.com/);
  assert.match(caddyfile, /homepage\.home\.example\.com/);
  assert.match(caddyfile, /stirling-pdf\.home\.example\.com/);
  assert.doesNotMatch(caddyfile, /radicale\.home\.example\.com/);
});

test('keeps Vaultwarden on an internal HTTPS route in HTTP mode only when installed', async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-catalog-runtime-'));
  t.after(() => fs.rm(repoRoot, { force: true, recursive: true }));
  await writeJson(path.join(repoRoot, 'apps/suite-manager/catalog/apps/vaultwarden.json'), {
    id: 'vaultwarden',
    routes: [{ host: 'vaultwarden', httpsInHttpMode: true, upstream: 'vaultwarden:80' }],
  });
  await writeJson(path.join(repoRoot, 'deploy/vps/generated/app-catalog/compose-selection.json'), {
    apps: [{ id: 'vaultwarden', status: 'installed' }],
    profiles: ['vaultwarden'],
    version: 1,
  });

  const caddyfile = caddyServiceRoutesForMode('localhost', 'off', catalogRouteSpecs(repoRoot));

  assert.match(caddyfile, /https:\/\/vaultwarden\.localhost \{/);
  assert.match(caddyfile, /\ttls internal/);
  assert.doesNotMatch(caddyfile, /@vaultwarden host vaultwarden\.localhost/);
});
