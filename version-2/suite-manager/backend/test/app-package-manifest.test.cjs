const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AppPackageManifestError,
  discoverAppPackages,
  readAppPackageManifest,
  validateAppPackageManifest,
} = require('../src/apps/package-manifest.cjs');

const v2Root = path.resolve(__dirname, '..', '..', '..');
const v2AppsDir = path.join(v2Root, 'apps');

function validManifest(overrides = {}) {
  return {
    id: 'example-app',
    name: 'Example App',
    version: '0.1.0',
    summary: 'A small example app.',
    category: 'tools',
    setup: { fields: [] },
    resources: {
      services: {
        'example-app': {
          dockerfile: 'Dockerfile',
          internalPort: 8080,
          volumes: ['data:/data'],
        },
      },
    },
    routes: [{ host: 'example-app', service: 'example-app', port: 8080 }],
    homepage: {
      description: 'A useful example.',
      group: 'Tools',
      icon: 'example-app',
      name: 'Example App',
    },
    health: { type: 'http', url: 'http://example-app:8080/healthz' },
    ...overrides,
  };
}

test('Stirling PDF package is discoverable and validates as the first boring app', () => {
  const packages = discoverAppPackages(v2AppsDir);
  const stirling = packages.find((entry) => entry.manifest.id === 'stirling-pdf');

  assert.ok(stirling);
  assert.equal(stirling.manifest.name, 'Stirling PDF');
  assert.equal(stirling.manifest.setup.fields.length, 0);
  assert.equal(stirling.manifest.resources.services['stirling-pdf'].internalPort, 8080);
  assert.deepEqual(validateAppPackageManifest(stirling.manifest, { packageDir: stirling.packageDir }), []);
});

test('manifest validation rejects V1-style unsafe app coupling', () => {
  const manifest = validManifest({
    routes: [
      {
        host: 'example-app',
        port: 8080,
        service: 'missing-service',
        snippet: 'reverse_proxy example-app:8080',
      },
    ],
    setup: {
      fields: [
        {
          default: 'do-not-store-me',
          id: 'adminPassword',
          label: 'Admin password',
          secret: true,
          type: 'password',
        },
      ],
    },
  });

  assert.deepEqual(validateAppPackageManifest(manifest), [
    'setup.fields[0] is secret and must not define a default value.',
    'routes[0].service must reference a declared service.',
    'manifest.routes[0].snippet is not allowed; use structured route fields.',
    'manifest.routes[0].snippet must not contain raw Caddy directives.',
  ]);
});

test('manifest validation rejects package paths that escape the app folder', () => {
  const manifest = validManifest({
    resources: {
      services: {
        'example-app': {
          dockerfile: '../old-apps/example/Dockerfile',
          internalPort: 8080,
        },
      },
    },
  });

  assert.deepEqual(validateAppPackageManifest(manifest), [
    'resources.services.example-app.dockerfile must stay inside the app package folder.',
  ]);
});

test('manifest validation keeps service environment projection generic', () => {
  const manifest = validManifest({
    resources: {
      services: {
        'example-app': {
          dockerfile: 'Dockerfile',
          env: {
            'bad-key': 'value',
          },
          internalPort: 8080,
        },
      },
    },
  });

  assert.deepEqual(validateAppPackageManifest(manifest), [
    'resources.services.example-app.env must contain uppercase environment keys with string values.',
  ]);
});

test('readAppPackageManifest reports all validation details', async () => {
  const packageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-v2-package-'));
  await fsp.writeFile(path.join(packageDir, 'manifest.json'), `${JSON.stringify(validManifest({
    id: 'Bad_App',
    resources: { services: {} },
  }))}\n`);

  assert.throws(
    () => readAppPackageManifest(packageDir),
    (error) => {
      assert.ok(error instanceof AppPackageManifestError);
      assert.ok(error.details.includes('id must be a DNS-safe app id.'));
      assert.ok(error.details.includes('routes[0].service must reference a declared service.'));
      return true;
    },
  );

  fs.rmSync(packageDir, { recursive: true, force: true });
});
