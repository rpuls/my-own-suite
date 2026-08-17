const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  AppPackageManifestError,
  discoverAppPackages,
  publicPackageSummary,
  readAppPackageManifest,
  validateAppPackageManifest,
} = require('../src/apps/package-manifest.cjs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const v2AppsDir = path.join(repoRoot, 'apps');

function validManifest(overrides = {}) {
  return {
    manifestVersion: 1,
    id: 'example-app',
    name: 'Example App',
    version: '0.1.0',
    minimumMosVersion: '0.1.0',
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
    routes: [{ host: 'example-app', service: 'example-app' }],
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
  assert.equal(stirling.manifest.manifestVersion, 1);
  assert.equal(stirling.manifest.name, 'Stirling PDF');
  assert.equal(stirling.manifest.category, 'office');
  assert.equal(stirling.manifest.setup, undefined);
  assert.ok(stirling.manifest.catalog.tags.includes('adobe-acrobat-alternative'));
  assert.equal(stirling.manifest.resources.services['stirling-pdf'].internalPort, 8080);
  assert.deepEqual(validateAppPackageManifest(stirling.manifest, { packageDir: stirling.packageDir }), []);
});

test('Vaultwarden package is discoverable and declares generated secret setup generically', () => {
  const packages = discoverAppPackages(v2AppsDir);
  const vaultwarden = packages.find((entry) => entry.manifest.id === 'vaultwarden');

  assert.ok(vaultwarden);
  assert.equal(vaultwarden.manifest.name, 'Vaultwarden');
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

test('Radicale package is discoverable and declares user-supplied credentials generically', () => {
  const packages = discoverAppPackages(v2AppsDir);
  const radicale = packages.find((entry) => entry.manifest.id === 'radicale');

  assert.ok(radicale);
  assert.equal(radicale.manifest.name, 'Radicale');
  assert.equal(radicale.manifest.setup.fields.length, 4);
  assert.deepEqual(radicale.manifest.setup.fields.map((field) => ({
    id: field.id,
    generated: Boolean(field.generated),
    required: field.required,
    secret: field.secret === true,
    type: field.type,
  })), [
    { generated: false, id: 'adminUsername', required: true, secret: false, type: 'text' },
    { generated: false, id: 'calendarName', required: true, secret: false, type: 'text' },
    { generated: false, id: 'adminPassword', required: true, secret: true, type: 'password' },
    { generated: true, id: 'icalToken', required: true, secret: true, type: 'password' },
  ]);
  assert.equal(radicale.manifest.homepage.widget.type, 'calendar');
  assert.equal(radicale.manifest.homepage.widget.integrations[0].url, '${app.publicUrl}__mos/ical/${secret.icalToken}');
  assert.equal(radicale.manifest.routes[0].internalIcalBridge.path, '/__mos/ical/${secret.icalToken}');
  assert.equal(radicale.manifest.resources.services.radicale.internalPort, 5232);
  assert.deepEqual(radicale.manifest.resources.services.radicale.volumes, ['data:/data']);
  assert.equal(radicale.manifest.onboarding.title, 'Connect your calendar');
  assert.equal(radicale.manifest.onboarding.sections[0].type, 'steps');
  assert.equal(radicale.manifest.onboarding.sections[1].type, 'values');
  assert.equal(radicale.manifest.onboarding.sections[1].values[0].value, '${app.publicUrl}${config.adminUsername}/default-calendar/');
  assert.equal(radicale.manifest.onboarding.sections[4].type, 'choice-guide');
  assert.ok(radicale.manifest.onboarding.sections[4].choices.some((choice) => choice.id === 'ios'));
  assert.deepEqual(validateAppPackageManifest(radicale.manifest, { packageDir: radicale.packageDir }), []);
});

test('Seafile package is discoverable and declares a multi-service core package generically', () => {
  const packages = discoverAppPackages(v2AppsDir);
  const seafile = packages.find((entry) => entry.manifest.id === 'seafile');

  assert.ok(seafile);
  assert.equal(seafile.manifest.name, 'Seafile');
  assert.deepEqual(Object.keys(seafile.manifest.resources.services).sort(), ['seafile', 'seafile-mysql', 'seafile-valkey']);
  assert.equal(seafile.manifest.routes.length, 1);
  assert.equal(seafile.manifest.routes[0].service, 'seafile');
  assert.equal(seafile.manifest.health.url, 'http://seafile:80/api2/ping/');
  assert.deepEqual(seafile.manifest.resources.services.seafile.volumes, ['data:/shared']);
  assert.deepEqual(seafile.manifest.resources.services['seafile-mysql'].volumes, ['mysql-data:/var/lib/mysql']);
  assert.equal(seafile.manifest.resources.services['seafile-valkey'].internalPort, 6379);
  assert.equal(seafile.manifest.setup.fields.length, 5);
  assert.deepEqual(seafile.manifest.setup.fields.map((field) => ({
    id: field.id,
    generated: Boolean(field.generated),
    required: field.required,
    secret: field.secret === true,
    type: field.type,
  })), [
    { generated: false, id: 'adminEmail', required: true, secret: false, type: 'email' },
    { generated: false, id: 'adminPassword', required: true, secret: true, type: 'password' },
    { generated: true, id: 'mysqlRootPassword', required: true, secret: true, type: 'password' },
    { generated: true, id: 'mysqlUserPassword', required: true, secret: true, type: 'password' },
    { generated: true, id: 'jwtPrivateKey', required: true, secret: true, type: 'password' },
  ]);
  assert.equal(seafile.manifest.exports.filePlatform.type, 'document-platform');
  assert.equal(seafile.manifest.integrations.documentEditor.accepts[0].type, 'document-editor');
  assert.equal(seafile.manifest.integrations.documentEditor.apply.kind, 'service-env');
  assert.deepEqual(validateAppPackageManifest(seafile.manifest, { packageDir: seafile.packageDir }), []);
});

test('OnlyOffice package is discoverable and exports a document editor capability', () => {
  const packages = discoverAppPackages(v2AppsDir);
  const onlyoffice = packages.find((entry) => entry.manifest.id === 'onlyoffice');

  assert.ok(onlyoffice);
  assert.equal(onlyoffice.manifest.name, 'ONLYOFFICE');
  assert.equal(onlyoffice.manifest.resources.services.onlyoffice.internalPort, 80);
  assert.deepEqual(onlyoffice.manifest.resources.services.onlyoffice.volumes, ['data:/var/www/onlyoffice/Data']);
  assert.equal(onlyoffice.manifest.setup.fields.length, 2);
  assert.equal(onlyoffice.manifest.role, 'capability-provider');
  assert.equal(onlyoffice.manifest.homepage, undefined);
  assert.equal(onlyoffice.manifest.exports.documentEditor.type, 'document-editor');
  assert.equal(onlyoffice.manifest.exports.documentEditor.protocol, 'onlyoffice-docs-api');
  assert.equal(onlyoffice.manifest.usefulness.requiresOneOf[0], 'document-platform');
  assert.deepEqual(validateAppPackageManifest(onlyoffice.manifest, { packageDir: onlyoffice.packageDir }), []);
});

test('Immich package is discoverable and declares its heavy multi-service stack generically', () => {
  const packages = discoverAppPackages(v2AppsDir);
  const immich = packages.find((entry) => entry.manifest.id === 'immich');

  assert.ok(immich);
  assert.equal(immich.manifest.name, 'Immich');
  // Every base image here is pinned to an amd64 manifest, so this package cannot
  // build anywhere else. Declaring it is what lets MOS say so before the build.
  assert.deepEqual(immich.manifest.architectures, ['amd64']);
  assert.deepEqual(Object.keys(immich.manifest.resources.services).sort(), [
    'immich-machine-learning',
    'immich-postgres',
    'immich-server',
    'immich-valkey',
  ]);
  assert.equal(immich.manifest.resources.services['immich-postgres'].dockerfile, 'Dockerfile.postgres');
  assert.equal(immich.manifest.resources.services['immich-postgres'].env.POSTGRES_INITDB_ARGS, '--data-checksums');
  assert.deepEqual(immich.manifest.resources.services['immich-postgres'].volumes, ['postgres-data:/var/lib/postgresql/data']);
  assert.equal(immich.manifest.resources.services['immich-valkey'].dockerfile, 'Dockerfile.valkey');
  assert.equal(immich.manifest.homepage.icon, 'immich');
  assert.equal(immich.manifest.routes[0].service, 'immich-server');
  assert.equal(immich.manifest.health.url, 'http://immich-server:2283/api/server/ping');
  assert.equal(immich.manifest.setup.fields.length, 2);
  assert.ok(Array.isArray(immich.manifest.onboarding.sections));
  assert.deepEqual(validateAppPackageManifest(immich.manifest, { packageDir: immich.packageDir }), []);
});

// The open-world rule is the locked contract's escape hatch: a field added by
// a later manifest generation amendment must be ignored by this MOS, never
// fatal. This test is the tripwire the roadmap asked for — it fails the moment
// anyone reintroduces a closed allow-list anywhere in the manifest shape.
test('unknown manifest fields are ignored at every level, never fatal', () => {
  const manifest = validManifest({
    futureTopLevelField: { anything: ['goes', 'here'] },
    catalog: {
      description: 'Described.',
      links: { website: 'https://example.com/', forum: 'https://example.com/forum' },
      futureCatalogField: true,
    },
    update: { backupRequired: false, futureUpdateHint: 'ignored' },
    setup: {
      fields: [{ id: 'username', type: 'text', label: 'Username', futureFieldFlag: 1 }],
      futureSetupField: {},
    },
    homepage: {
      description: 'A useful example.',
      group: 'Tools',
      icon: 'example-app',
      name: 'Example App',
      futureHomepageField: 'ok',
    },
    onboarding: {
      sections: [{ id: 'hello', type: 'note', title: 'Hello', futureSectionField: 'ok' }],
    },
  });
  manifest.routes[0].futureRouteField = 'ok';
  manifest.resources.services['example-app'].futureServiceField = 'ok';
  manifest.health.futureHealthField = 'ok';

  assert.deepEqual(validateAppPackageManifest(manifest), []);
});

test('manifestVersion is required and must be a known generation', () => {
  const missing = validManifest();
  delete missing.manifestVersion;
  assert.deepEqual(validateAppPackageManifest(missing), ['manifestVersion is required.']);

  const wrong = validManifest({ manifestVersion: 2 });
  assert.deepEqual(validateAppPackageManifest(wrong), ['manifestVersion must be 1, got 2.']);
});

test('manifest validation accepts companion packages without Homepage metadata', () => {
  const manifest = validManifest({
    homepage: undefined,
    role: 'capability-provider',
  });

  assert.deepEqual(validateAppPackageManifest(manifest), []);
});

// A package names the architectures its pinned base images actually publish.
// Naming none is how every package predating the field reads, and means MOS
// constrains nothing; naming one MOS has no builder for is an authoring mistake
// worth catching here rather than at install on somebody else's host.
test('manifest validation accepts declared architectures and rejects unbuildable ones', () => {
  assert.deepEqual(validateAppPackageManifest(validManifest({ architectures: ['amd64', 'arm64'] })), []);
  assert.deepEqual(validateAppPackageManifest(validManifest({ architectures: undefined })), []);
  assert.deepEqual(validateAppPackageManifest(validManifest({ architectures: [] })), [
    'architectures must contain at least 1 item.',
  ]);
  assert.deepEqual(validateAppPackageManifest(validManifest({ architectures: 'amd64' })), [
    'architectures must be array, got "amd64".',
  ]);
  assert.deepEqual(validateAppPackageManifest(validManifest({ architectures: ['x86_64'] })), [
    'architectures[0] must be one of: amd64, arm64.',
  ]);
});

// Declared resource needs are advisory display data, so the validator's job is
// to stop figures that would make capacity advice wrong rather than to police
// the numbers themselves.
test('manifest validation accepts declared service resource requirements', () => {
  const withRequires = (requires) => validManifest({
    resources: { services: { 'example-app': { dockerfile: 'Dockerfile', internalPort: 8080, requires } } },
  });

  assert.deepEqual(validateAppPackageManifest(withRequires({ cpuCores: 0.25, memoryMb: 1024 })), []);
  assert.deepEqual(validateAppPackageManifest(withRequires({
    cpuCores: 0.25, cpuPeakCores: 2, memoryMb: 1024, memoryPeakMb: 2048,
  })), []);
  assert.deepEqual(validateAppPackageManifest(validManifest()), []);

  assert.deepEqual(validateAppPackageManifest(withRequires({ memoryMb: 1024 })), [
    'resources.services.example-app.requires.cpuCores is required.',
  ]);
  assert.deepEqual(validateAppPackageManifest(withRequires({ cpuCores: 0.25 })), [
    'resources.services.example-app.requires.memoryMb is required.',
  ]);
  assert.deepEqual(validateAppPackageManifest(withRequires({ cpuCores: 0, memoryMb: 1024 })), [
    'resources.services.example-app.requires.cpuCores must be at least 0.01.',
  ]);
  assert.deepEqual(validateAppPackageManifest(withRequires({ cpuCores: 0.25, memoryMb: 512.5 })), [
    'resources.services.example-app.requires.memoryMb must be integer, got 512.5.',
  ]);
  // A peak under the resting figure reads as a transposed pair, not a claim.
  assert.deepEqual(validateAppPackageManifest(withRequires({ cpuCores: 2, memoryMb: 1024, memoryPeakMb: 512 })), [
    'resources.services.example-app.requires.memoryPeakMb must be at least memoryMb (1024), got 512.',
  ]);
});

test('public package summary carries declared requirements and drops partial ones', () => {
  const summary = publicPackageSummary(validManifest({
    resources: {
      services: {
        'example-app': {
          dockerfile: 'Dockerfile',
          internalPort: 8080,
          requires: { cpuCores: 0.25, cpuPeakCores: 2, memoryMb: 1024, memoryPeakMb: 2048 },
        },
      },
    },
  }));
  assert.deepEqual(summary.services[0].requires, {
    cpuCores: 0.25, cpuPeakCores: 2, memoryMb: 1024, memoryPeakMb: 2048,
  });

  const noPeaks = publicPackageSummary(validManifest({
    resources: { services: { 'example-app': { dockerfile: 'Dockerfile', internalPort: 8080, requires: { cpuCores: 0.1, memoryMb: 128 } } } },
  }));
  assert.deepEqual(noPeaks.services[0].requires, {
    cpuCores: 0.1, cpuPeakCores: null, memoryMb: 128, memoryPeakMb: null,
  });

  // An older or hand-edited package that states neither, or only half, must
  // reach the UI as "not declared" rather than as a figure to add up.
  assert.equal(publicPackageSummary(validManifest()).services[0].requires, null);
  const partial = publicPackageSummary(validManifest({
    resources: { services: { 'example-app': { dockerfile: 'Dockerfile', internalPort: 8080, requires: { memoryMb: 512 } } } },
  }));
  assert.equal(partial.services[0].requires, null);
});

test('manifest validation accepts structured optional catalog presentation metadata', () => {
  const manifest = validManifest({
    packageFiles: ['assets/screenshot.png'],
    catalog: {
      description: 'A longer description for the app detail view.',
      demoDeployTargets: [{ label: 'Railway', provider: 'railway', url: 'https://railway.com/deploy/example' }],
      features: [
        { title: 'Quick setup' },
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
      replaces: ['Hosted example tools', 'Another hosted tool'],
      resourceHint: { description: 'Small service.', label: 'Light resources', level: 'low' },
      screenshots: [{ alt: 'Example app screenshot', src: 'assets/screenshot.png' }],
      tags: ['example', 'demo'],
    },
  });

  assert.deepEqual(validateAppPackageManifest(manifest), []);
});

test('manifest validation requires package screenshots to ship inside the package', () => {
  const manifest = validManifest({
    catalog: {
      replaces: 'Hosted example tools',
      screenshots: [
        { alt: 'Undeclared file', src: 'assets/screenshot.png' },
        { caption: 'Remote screenshots are refused', src: 'https://example.com/shot.png' },
      ],
    },
  });

  const errors = validateAppPackageManifest(manifest);
  assert.ok(errors.some((error) => error.startsWith('catalog.replaces must be array')));
  assert.ok(errors.includes('catalog.screenshots[0].src must be listed in packageFiles so it ships with the package.'));
  // A remote URL is structurally not a package-relative path: catalog browsing
  // must never fetch third-party origins.
  assert.ok(errors.some((error) => error.startsWith('catalog.screenshots[1].src')));
});

test('manifest validation rejects malformed demo deployment targets', () => {
  const manifest = validManifest({
    catalog: {
      demoDeployTargets: [
        { label: '', provider: 'Bad Provider', url: 'ftp://example.com' },
      ],
    },
  });

  const errors = validateAppPackageManifest(manifest);
  assert.ok(errors.some((error) => error.startsWith('catalog.demoDeployTargets[0].provider')));
  assert.ok(errors.includes('catalog.demoDeployTargets[0].label must not be empty.'));
  assert.ok(errors.some((error) => error.startsWith('catalog.demoDeployTargets[0].url')));
});

test('manifest validation rejects malformed optional catalog metadata but ignores unknown link keys', () => {
  const manifest = validManifest({
    catalog: {
      features: [{ body: 'Missing title.' }],
      links: { forum: 'https://example.com/forum', website: 'ftp://example.com' },
      related: ['Bad_App'],
      resourceHint: { level: 'tiny' },
      tags: ['valid', ''],
    },
  });

  const errors = validateAppPackageManifest(manifest);
  assert.ok(errors.includes('catalog.resourceHint.level must be one of: low, medium, high.'));
  assert.ok(errors.includes('catalog.features[0].title is required.'));
  assert.ok(errors.includes('catalog.tags[1] must not be empty.'));
  assert.ok(errors.some((error) => error.startsWith('catalog.related[0]')));
  assert.ok(errors.some((error) => error.startsWith('catalog.links.website')));
  // Unknown link keys are ignored (open world), never fatal — they are simply
  // not rendered.
  assert.ok(!errors.some((error) => error.includes('forum')));
});

test('manifest validation rejects V1-style unsafe app coupling', () => {
  const manifest = validManifest({
    routes: [
      {
        host: 'example-app',
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

  const errors = validateAppPackageManifest(manifest);
  assert.ok(errors.includes('setup.fields[0] is secret and must not declare a default value.'));
  assert.ok(errors.includes('routes[0].service must reference a declared service.'));
  assert.ok(errors.includes('routes[0].snippet is not allowed; routes are structured fields, never raw proxy configuration.'));
});

test('manifest validation rejects malformed onboarding guide sections', () => {
  const manifest = validManifest({
    onboarding: {
      sections: [
        {
          id: 'bad',
          title: '',
          type: 'script',
          values: [{ label: 'Password', value: '${secret.adminPassword}' }],
        },
      ],
    },
  });

  const errors = validateAppPackageManifest(manifest);
  assert.ok(errors.includes('onboarding.sections[0].type must be one of: note, warning, steps, values, choice-guide, manual-complete.'));
  assert.ok(errors.includes('onboarding.sections[0].title must not be empty.'));
  assert.ok(errors.some((error) => error.startsWith('onboarding.sections[0].values[0].value must not reference ${secret.*}')));
});

// The template grammar is half the locked contract: a mistyped reference must
// fail validation here instead of shipping verbatim into a container env var
// and failing silently on somebody else's machine.
test('manifest validation enforces the template grammar', () => {
  const withField = (env) => validManifest({
    setup: {
      fields: [
        { id: 'adminName', label: 'Admin name', type: 'text' },
        { id: 'adminToken', label: 'Admin token', secret: true, type: 'password' },
      ],
    },
    resources: {
      services: {
        'example-app': { dockerfile: 'Dockerfile', env, internalPort: 8080 },
      },
    },
  });

  assert.deepEqual(validateAppPackageManifest(withField({
    ADMIN_NAME: '${config.adminName}',
    ADMIN_TOKEN: '${secret.adminToken}',
    PUBLIC_URL: '${app.publicUrl}',
    SHELL_STYLE: '${HOME} $PATH ${not-a-namespace}',
  })), []);

  assert.deepEqual(validateAppPackageManifest(withField({ TYPO: '${config.adminNam}' })), [
    'resources.services.example-app.env.TYPO references ${config.adminNam}, which is not a declared non-secret setup field.',
  ]);
  assert.deepEqual(validateAppPackageManifest(withField({ SECRET_AS_CONFIG: '${config.adminToken}' })), [
    'resources.services.example-app.env.SECRET_AS_CONFIG references ${config.adminToken}, which is not a declared non-secret setup field.',
  ]);
  assert.deepEqual(validateAppPackageManifest(withField({ UNKNOWN: '${smtp.host}' })), [
    'resources.services.example-app.env.UNKNOWN references unknown template namespace "smtp" in ${smtp.host}. Known namespaces: app, config, export, import, owner, secret.',
  ]);
  assert.deepEqual(validateAppPackageManifest(withField({ BAD_APP_KEY: '${app.port}' })), [
    'resources.services.example-app.env.BAD_APP_KEY references ${app.port}; supported app keys are host, publicUrl, scheme.',
  ]);
  // The owner namespace resolves at setup time, so it lives only in field
  // defaults — never in runtime projections.
  assert.deepEqual(validateAppPackageManifest(withField({ OWNER: '${owner.email}' })), [
    'resources.services.example-app.env.OWNER must not reference ${owner.*}.',
  ]);

  const ownerDefault = validManifest({
    setup: { fields: [{ default: '${owner.email}', id: 'username', label: 'Username', type: 'text' }] },
  });
  assert.deepEqual(validateAppPackageManifest(ownerDefault), []);
});

test('manifest validation requires the health probe to target a declared service', () => {
  const manifest = validManifest({ health: { type: 'http', url: 'http://not-a-service:8080/healthz' } });
  assert.deepEqual(validateAppPackageManifest(manifest), [
    'health.url hostname must be a declared service id, got "not-a-service".',
  ]);
});

test('manifest validation requires named package volumes, never host paths', () => {
  const withVolumes = (volumes) => validManifest({
    resources: { services: { 'example-app': { dockerfile: 'Dockerfile', internalPort: 8080, volumes } } },
  });
  assert.deepEqual(validateAppPackageManifest(withVolumes(['data:/data'])), []);
  assert.ok(validateAppPackageManifest(withVolumes(['/host/path:/data'])).length > 0);
  assert.ok(validateAppPackageManifest(withVolumes(['data'])).length > 0);
  assert.ok(validateAppPackageManifest(withVolumes(['../escape:/data'])).length > 0);
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
    'resources.services.example-app.dockerfile must be a canonical forward-slash path inside the app package folder.',
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
    'resources.services.example-app.env.bad-key is not an allowed key name.',
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
    'setup.fields[0].generated.bytes must be at least 16.',
    'setup.fields[0].generated.encoding must be one of: base64url, hex.',
    'setup.fields[0].generated.kind must be one of: random.',
  ]);
});

test('production app package engine code does not hardcode package ids', () => {
  const roots = [
    path.join(repoRoot, 'suite-manager', 'backend', 'src'),
    path.join(repoRoot, 'suite-manager', 'frontend', 'src'),
    path.join(repoRoot, 'system-agents', 'apps'),
    path.join(repoRoot, 'scripts', 'smoke'),
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
      if (/\b(?:immich|stirling|vaultwarden|radicale|seafile|Immich|Stirling|Vaultwarden|Radicale|Seafile)\b/u.test(content)) {
        offenders.push(path.relative(repoRoot, fullPath));
      }
    }
  };
  roots.forEach(visit);

  assert.deepEqual(offenders, []);
});

test('readAppPackageManifest reports all validation details', async () => {
  const packageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-package-'));
  await fsp.writeFile(path.join(packageDir, 'manifest.json'), `${JSON.stringify(validManifest({
    id: 'Bad_App',
    resources: { services: {} },
  }))}\n`);

  assert.throws(
    () => readAppPackageManifest(packageDir),
    (error) => {
      assert.ok(error instanceof AppPackageManifestError);
      assert.ok(error.details.some((detail) => detail.startsWith('id ')));
      assert.ok(error.details.includes('routes[0].service must reference a declared service.'));
      return true;
    },
  );

  fs.rmSync(packageDir, { recursive: true, force: true });
});
