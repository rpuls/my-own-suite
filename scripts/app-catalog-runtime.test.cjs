const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  caddyServiceRoutesForMode,
  catalogEnvProjections,
  catalogInternalRouteSnippets,
  catalogRouteSpecs,
} = require('./app-catalog-runtime.cjs');

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeLegacyManifest(repoRoot, id, routes, extra = {}) {
  await writeJson(path.join(repoRoot, `apps/suite-manager/catalog/apps/${id}.json`), {
    id,
    name: id,
    category: 'test',
    summary: `${id} test app.`,
    docs: { app: `/docs/apps/${id}` },
    compose: {
      envTemplates: [`deploy/vps/services/${id}/.env.template`],
      profile: id,
      services: [routes[0]?.upstream.split(':')[0] || id],
      volumes: [],
    },
    routes,
    homepage: null,
    provisioning: {
      mode: 'automatic',
      setupHelper: null,
    },
    backup: {
      includeVolumes: [],
    },
    ...extra,
  });
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
  await writeLegacyManifest(repoRoot, 'stirling-pdf', [{ host: 'stirling-pdf', upstream: 'stirling-pdf:8080' }]);
  await writeLegacyManifest(repoRoot, 'radicale', [{ host: 'radicale', upstream: 'radicale:5232' }]);
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

test('loads package-owned internal routes and env projections only for selected apps', async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-catalog-runtime-'));
  t.after(() => fs.rm(repoRoot, { force: true, recursive: true }));
  await writeJson(path.join(repoRoot, 'apps/suite-manager/catalog/apps/radicale/manifest.json'), {
    id: 'radicale',
    name: 'Radicale',
    category: 'calendar',
    summary: 'Private calendar sync.',
    docs: { app: '/docs/apps/radicale' },
    compose: {
      envTemplates: ['deploy/vps/services/radicale/.env.template'],
      profile: 'radicale',
      services: ['radicale'],
      volumes: ['radicale_data'],
    },
    env: {
      projections: [
        {
          serviceEnv: 'services/homepage/.env',
          key: 'RADICALE_ICAL_URL',
          value: 'http://caddy/internal/radicale-ical/${RADICALE_ICAL_TOKEN}',
        },
      ],
    },
    routes: {
      internal: [{ id: 'radicale-ical-bridge', asset: 'caddy.internal.caddy' }],
      public: [{ host: 'radicale', upstream: 'radicale:5232' }],
    },
    homepage: {
      tile: {
        description: 'Calendar',
        group: 'Calendar',
        hrefEnv: 'RADICALE_URL',
        name: 'Radicale',
      },
      contributions: {
        services: ['homepage.services.yaml'],
        widgets: [],
      },
    },
    provisioning: {
      mode: 'assisted',
      setupHelper: 'radicale-device-setup',
      postInstallActionLabel: 'Open calendar setup',
    },
    backup: { includeVolumes: ['radicale_data'] },
  });
  await fs.writeFile(
    path.join(repoRoot, 'apps/suite-manager/catalog/apps/radicale/caddy.internal.caddy'),
    'http://caddy {\n\trespond 404\n}\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(repoRoot, 'apps/suite-manager/catalog/apps/radicale/homepage.services.yaml'),
    '- Calendar: []\n',
    'utf8',
  );
  await writeJson(path.join(repoRoot, 'deploy/vps/generated/app-catalog/compose-selection.json'), {
    apps: [{ id: 'radicale', status: 'installed' }],
    profiles: ['radicale'],
    version: 1,
  });

  assert.deepEqual(catalogRouteSpecs(repoRoot), [
    { host: 'radicale', httpsInHttpMode: false, upstream: 'radicale:5232' },
  ]);
  assert.deepEqual(catalogEnvProjections(repoRoot), [
    {
      appId: 'radicale',
      key: 'RADICALE_ICAL_URL',
      serviceEnv: 'services/homepage/.env',
      value: 'http://caddy/internal/radicale-ical/${RADICALE_ICAL_TOKEN}',
    },
  ]);
  assert.deepEqual(
    catalogInternalRouteSnippets(repoRoot).map((snippet) => ({
      appId: snippet.appId,
      content: snippet.content,
      id: snippet.id,
    })),
    [
      {
        appId: 'radicale',
        content: 'http://caddy {\n\trespond 404\n}\n',
        id: 'radicale-ical-bridge',
      },
    ],
  );
});

test('keeps Vaultwarden on an internal HTTPS route in HTTP mode only when installed', async (t) => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-catalog-runtime-'));
  t.after(() => fs.rm(repoRoot, { force: true, recursive: true }));
  await writeLegacyManifest(repoRoot, 'vaultwarden', [
    { host: 'vaultwarden', httpsInHttpMode: true, upstream: 'vaultwarden:80' },
  ]);
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
