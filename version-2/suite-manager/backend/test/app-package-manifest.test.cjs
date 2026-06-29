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
  assert.equal(stirling.manifest.category, 'office');
  assert.equal(stirling.manifest.setup.fields.length, 0);
  assert.equal(stirling.manifest.catalog.complexity.level, 'easy');
  assert.ok(stirling.manifest.catalog.tags.includes('adobe-acrobat-alternative'));
  assert.equal(stirling.manifest.resources.services['stirling-pdf'].internalPort, 8080);
  assert.deepEqual(validateAppPackageManifest(stirling.manifest, { packageDir: stirling.packageDir }), []);
});

test('Vaultwarden package is discoverable and declares generated secret setup generically', () => {
  const packages = discoverAppPackages(v2AppsDir);
  const vaultwarden = packages.find((entry) => entry.manifest.id === 'vaultwarden');

  assert.ok(vaultwarden);
  assert.equal(vaultwarden.manifest.name, 'Vaultwarden');
  assert.equal(vaultwarden.manifest.catalog.complexity.level, 'guided');
  assert.equal(vaultwarden.manifest.catalog.resourceHint.level, 'low');
  assert.equal(vaultwarden.manifest.setup.fields.length, 1);
  assert.equal(vaultwarden.manifest.setup.fields[0].id, 'adminToken');
  assert.equal(vaultwarden.manifest.setup.fields[0].secret, true);
  assert.deepEqual(vaultwarden.manifest.setup.fields[0].generated, {
    bytes: 32,
    encoding: 'base64url',
    kind: 'random',
  });
  assert.equal(vaultwarden.manifest.resources.services.vaultwarden.internalPort, 80);
  assert.deepEqual(validateAppPackageManifest(vaultwarden.manifest, { packageDir: vaultwarden.packageDir }), []);
});

test('manifest validation accepts structured optional catalog presentation metadata', () => {
  const manifest = validManifest({
    catalog: {
      complexity: { description: 'One click.', label: 'Easy setup', level: 'easy' },
      description: 'A longer description for the app detail view.',
      features: [
        'Quick setup',
        { body: 'Useful for everyday workflows.', title: 'Everyday friendly' },
      ],
      links: {
        docs: 'https://example.com/docs',
        repository: 'https://example.com/repo',
        website: 'https://example.com/',
      },
      privacy: {
        notes: ['Runs in your own MOS runtime.'],
        summary: 'Private by default.',
      },
      related: ['another-app'],
      resourceHint: { description: 'Small service.', label: 'Light resources', level: 'low' },
      screenshots: [{ alt: 'Example app screenshot', src: 'assets/screenshot.png' }],
      tags: ['example', 'demo'],
    },
  });

  assert.deepEqual(validateAppPackageManifest(manifest), []);
});

test('manifest validation rejects malformed optional catalog metadata', () => {
  const manifest = validManifest({
    catalog: {
      complexity: { level: 'wizard' },
      features: [{ body: 'Missing title.' }],
      links: { forum: 'https://example.com/forum', website: 'ftp://example.com' },
      related: ['Bad_App'],
      resourceHint: { level: 'tiny' },
      tags: ['valid', ''],
    },
  });

  assert.deepEqual(validateAppPackageManifest(manifest), [
    'catalog.tags must be an array of non-empty strings when present.',
    'catalog.related must be an array of DNS-safe app ids when present.',
    'catalog.features[0] must be a string or an object with title and optional body.',
    'catalog.complexity.level must be one of: easy, guided, advanced.',
    'catalog.resourceHint.level must be one of: low, medium, high.',
    'catalog.links.forum is not supported.',
    'catalog.links.website must be an HTTP or HTTPS URL.',
  ]);
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

test('manifest validation rejects unsafe generated setup declarations', () => {
  const manifest = validManifest({
    setup: {
      fields: [
        {
          generated: { bytes: 8, encoding: 'plain', kind: 'timestamp' },
          id: 'adminToken',
          label: 'Admin token',
          secret: true,
          type: 'password',
        },
      ],
    },
  });

  assert.deepEqual(validateAppPackageManifest(manifest), [
    'setup.fields[0].generated.kind must be one of: random.',
    'setup.fields[0].generated.bytes must be a whole number from 16 to 128.',
    'setup.fields[0].generated.encoding must be one of: base64url, hex.',
  ]);
});

test('production app package engine code does not hardcode package ids', () => {
  const roots = [
    path.join(v2Root, 'suite-manager', 'backend', 'src'),
    path.join(v2Root, 'suite-manager', 'frontend', 'src'),
    path.join(v2Root, 'system-agents', 'apps'),
    path.join(v2Root, 'scripts', 'smoke'),
  ];
  const offenders = [];
  const visit = (target) => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const fullPath = path.join(target, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!/\.(?:cjs|js|ps1|ts|tsx)$/u.test(entry.name) || /\.test\./u.test(entry.name)) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      if (/\b(?:stirling|vaultwarden|Stirling|Vaultwarden)\b/u.test(content)) {
        offenders.push(path.relative(v2Root, fullPath));
      }
    }
  };
  roots.forEach(visit);

  assert.deepEqual(offenders, []);
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
