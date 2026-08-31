const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HOMEPAGE_AGENT_TIMEOUT_MS } = require('../src/homepage/homepage-agent-client.cjs');
const { loopbackPortFor } = require('../src/apps/app-package-service.cjs');
const { LoginThrottle } = require('../src/auth/login-throttle.cjs');

const { createMOSServer } = require('../src/server/http-app.cjs');
const { TERMS_VERSION } = require('../src/setup/setup-service.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');
const { ExternalSourceService } = require('../src/apps/external-source-service.cjs');
const { ExternalSourceError } = require('../src/apps/external-source-registry.cjs');
const appsDir = path.resolve(__dirname, '..', '..', '..', 'apps');

async function tempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mos-http-'));
}

async function tempFrontendDistDir() {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-frontend-'));
  await fs.mkdir(path.join(distDir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(distDir, 'brand'), { recursive: true });
  await fs.writeFile(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><title>Suite Manager | My Own Suite</title><script type="module" src="./assets/index.js"></script></head><body><div id="root"></div></body></html>',
  );
  await fs.writeFile(path.join(distDir, 'assets', 'index.js'), 'console.log("mos app");\n');
  await fs.writeFile(path.join(distDir, 'brand', 'my-own-suite-mark.png'), 'fake image');
  return distDir;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://${address.address}:${address.port}`);
    });
  });
}

async function withServer(fn, options = {}) {
  const appAgent = {
    async snapshotPackage(input) {
      return { snapshotPath: path.join(appsDir, input.packageId) };
    },
    ...(options.appAgent || {}),
  };
  const server = createMOSServer({
    frontendDistDir: await tempFrontendDistDir(),
    homeHost: '127.0.0.1',
    stateDir: await tempStateDir(),
    ...options,
    appAgent,
  });
  const baseUrl = await listen(server);

  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function hostRequest(baseUrl, requestPath, { body = '', headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const request = http.request({
      headers,
      hostname: url.hostname,
      method,
      path: requestPath,
      port: url.port,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          body: responseBody,
          headers: response.headers,
          json: () => JSON.parse(responseBody),
          status: response.statusCode,
        });
      });
    });
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

test('first visit serves the built Suite Manager frontend', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Suite Manager \| My Own Suite/);
    assert.match(html, /id="root"/);
  });
});

// The whole point of the build stamp is that a running frontend can tell it has
// been replaced, and a document served from cache defeats that on its own.
test('the served document names its build, is never cached, and the API agrees', async () => {
  await withServer(async (baseUrl) => {
    const document = await fetch(`${baseUrl}/`);
    const html = await document.text();
    const stamped = /<meta name="mos-build" content="([0-9a-f]{16})" \/>/u.exec(html);

    assert.equal(document.headers.get('cache-control'), 'no-store');
    assert.ok(stamped, 'the served document carries its build id');

    const build = await fetch(`${baseUrl}/suite-manager/api/build`);
    assert.equal(build.status, 200);
    assert.equal(build.headers.get('cache-control'), 'no-store');
    assert.equal((await build.json()).id, stamped[1]);
  });
});

test('build output is cached forever and everything else is not', async () => {
  await withServer(async (baseUrl) => {
    // Vite puts the content hash in the filename, so a new build is a new URL
    // and the old one can never be the wrong answer.
    const bundle = await fetch(`${baseUrl}/suite-manager/assets/assets/index.js`);
    // A brand mark keeps its name across a rebrand, so it must not.
    const brand = await fetch(`${baseUrl}/suite-manager/assets/brand/my-own-suite-mark.png`);

    assert.equal(bundle.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(brand.headers.get('cache-control'), 'public, max-age=3600');
  });
});

test('static frontend assets are served from the reserved asset namespace', async () => {
  await withServer(async (baseUrl) => {
    const scriptResponse = await fetch(`${baseUrl}/suite-manager/assets/assets/index.js`);
    const script = await scriptResponse.text();
    const brandResponse = await fetch(`${baseUrl}/suite-manager/assets/brand/my-own-suite-mark.png`);

    assert.equal(scriptResponse.status, 200);
    assert.match(script, /mos app/);
    assert.equal(scriptResponse.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(brandResponse.status, 200);
    assert.equal(brandResponse.headers.get('content-type'), 'image/png');
  });
});

async function createOwner(baseUrl, host = 'home.test') {
  const response = await hostRequest(baseUrl, '/suite-manager/api/setup/owner', {
    body: JSON.stringify({
      email: 'owner@example.com',
      name: 'Suite Owner',
      password: 'correct horse battery',
    }),
    headers: { 'Content-Type': 'application/json', Host: host },
    method: 'POST',
  });
  return response.headers['set-cookie'][0];
}

test('the owner preference route is authenticated, validated, and reflected in setup status', async () => {
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/settings/preferences', {
      body: JSON.stringify({ key: 'technicalControls', value: true }),
      headers: { 'Content-Type': 'application/json', Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.json().code, 'AUTH_REQUIRED');

    const cookie = await createOwner(baseUrl);
    const signedOutStatus = await hostRequest(baseUrl, '/suite-manager/api/setup/status', { headers: { Host: 'home.test' } });
    assert.equal(signedOutStatus.json().preferences, undefined);

    const before = await hostRequest(baseUrl, '/suite-manager/api/setup/status', { headers: { Cookie: cookie, Host: 'home.test' } });
    assert.deepEqual(before.json().preferences, { technicalControls: false });

    const saved = await hostRequest(baseUrl, '/suite-manager/api/settings/preferences', {
      body: JSON.stringify({ key: 'technicalControls', value: true }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json().preferences, { technicalControls: true });

    const after = await hostRequest(baseUrl, '/suite-manager/api/setup/status', { headers: { Cookie: cookie, Host: 'home.test' } });
    assert.deepEqual(after.json().preferences, { technicalControls: true });

    const wrongType = await hostRequest(baseUrl, '/suite-manager/api/settings/preferences', {
      body: JSON.stringify({ key: 'technicalControls', value: 'yes' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(wrongType.status, 400);
    assert.equal(wrongType.json().code, 'INVALID_PREFERENCE_VALUE');

    const unknownKey = await hostRequest(baseUrl, '/suite-manager/api/settings/preferences', {
      body: JSON.stringify({ key: 'showEverything', value: true }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(unknownKey.status, 400);
    assert.equal(unknownKey.json().code, 'UNKNOWN_PREFERENCE');

    // A rejected write changes nothing.
    const unchanged = await hostRequest(baseUrl, '/suite-manager/api/setup/status', { headers: { Cookie: cookie, Host: 'home.test' } });
    assert.deepEqual(unchanged.json().preferences, { technicalControls: true });
  }, { homeHost: 'home.test' });
});

test('Home serves Suite Manager but blocks its dashboard until authentication', async () => {
  await withServer(async (baseUrl) => {
    const setupResponse = await hostRequest(baseUrl, '/suite-manager/', { headers: { Host: 'home.test' } });
    const dashboardResponse = await hostRequest(baseUrl, '/', {
      headers: { Host: 'home.test' },
    });

    assert.equal(setupResponse.status, 200);
    assert.equal(dashboardResponse.status, 302);
    assert.equal(dashboardResponse.headers.location, '/suite-manager/');
  }, { homeHost: 'home.test' });
});

test('authenticated Home requests stream through the private Homepage proxy without the MOS cookie', async () => {
  const seen = [];
  const upstream = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      seen.push({ body, headers: request.headers, method: request.method, url: request.url });
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Set-Cookie': 'homepage=value' });
      response.write('first-');
      response.end('second');
    });
  });
  const upstreamUrl = await listen(upstream);

  try {
    await withServer(async (baseUrl) => {
      const cookie = await createOwner(baseUrl);
      const suiteManagerStatus = await hostRequest(baseUrl, '/suite-manager/api/setup/status', {
        headers: { Cookie: cookie, Host: 'home.test' },
      });
      const response = await hostRequest(baseUrl, '/api/data?view=empty', {
        body: 'dashboard request',
        headers: { Cookie: cookie, Host: 'home.test', Origin: 'http://home.test' },
        method: 'POST',
      });

      assert.equal(suiteManagerStatus.json().status, 'signed-in');
      assert.equal(response.status, 200);
      assert.equal(response.body, 'first-second');
      assert.equal(response.headers['set-cookie'], undefined);
      assert.deepEqual(seen.map(({ body, method, url }) => ({ body, method, url })), [{
        body: 'dashboard request',
        method: 'POST',
        url: '/api/data?view=empty',
      }]);
      assert.equal(seen[0].headers.cookie, undefined);
      assert.equal(seen[0].headers.host, 'home.test');
      assert.equal(seen[0].headers['x-forwarded-host'], 'home.test');
    }, { homeHost: 'home.test', homepageUpstream: upstreamUrl });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('Homepage redirects are rewritten to the public Home origin', async () => {
  const upstream = http.createServer((request, response) => {
    response.writeHead(307, { Location: `http://${request.socket.localAddress}:${request.socket.localPort}/next?ok=1` });
    response.end();
  });
  const upstreamUrl = await listen(upstream);

  try {
    await withServer(async (baseUrl) => {
      const cookie = await createOwner(baseUrl);
      const response = await hostRequest(baseUrl, '/redirect', {
        headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      });

      assert.equal(response.status, 307);
      assert.equal(response.headers.location, 'https://home.test/next?ok=1');
    }, { homeHost: 'home.test', homepageUpstream: upstreamUrl });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('Suite Manager path and unknown hosts cannot bypass the Homepage boundary', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((request, response) => {
    upstreamRequests += 1;
    response.end('homepage');
  });
  const upstreamUrl = await listen(upstream);

  try {
    await withServer(async (baseUrl) => {
      const cookie = await createOwner(baseUrl);
      const suiteResponse = await hostRequest(baseUrl, '/suite-manager/', { headers: { Host: 'home.test' } });
      const unknownSuiteResponse = await hostRequest(baseUrl, '/suite-manager/unknown', {
        headers: { Cookie: cookie, Host: 'home.test' },
        method: 'POST',
      });
      const unknownResponse = await hostRequest(baseUrl, '/', { headers: { Host: 'bypass.test' } });

      assert.equal(suiteResponse.status, 200);
      assert.match(suiteResponse.body, /Suite Manager/);
      assert.equal(unknownSuiteResponse.status, 404);
      assert.equal(unknownResponse.status, 421);
      assert.equal(upstreamRequests, 0);
    }, {
      homeHost: 'home.test',
      homepageUpstream: upstreamUrl,
    });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('logout immediately blocks Home dashboard access again', async () => {
  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/auth/logout', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const response = await hostRequest(baseUrl, '/', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });

    assert.equal(response.status, 302);
    assert.equal(response.headers.location, '/suite-manager/');
  }, { homeHost: 'home.test' });
});

test('Homepage customization APIs require authentication and pass only structured operations', async () => {
  const calls = [];
  const homepageAgent = {
    async status() { calls.push(['status']); return { capabilities: ['homepage.apply'] }; },
    async read(file) { calls.push(['read', file]); return { content: '- Links: []\n', file, revision: 'sha256:current' }; },
    async validate(file, content) { calls.push(['validate', file, content]); return { valid: true }; },
  };
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/customize/file/read', {
      body: JSON.stringify({ file: 'services.template.yaml' }), headers: { 'Content-Type': 'application/json', Host: 'home.test' }, method: 'POST',
    });
    assert.equal(denied.status, 401);
    assert.equal(calls.length, 0);

    const cookie = await createOwner(baseUrl);
    const status = await hostRequest(baseUrl, '/suite-manager/api/customize/status', { headers: { Cookie: cookie, Host: 'home.test' } });
    const read = await hostRequest(baseUrl, '/suite-manager/api/customize/file/read', {
      body: JSON.stringify({ file: 'services.template.yaml' }), headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' }, method: 'POST',
    });
    assert.equal(status.status, 200);
    assert.deepEqual(status.json().files, ['bookmarks.yaml', 'services.template.yaml', 'settings.yaml', 'widgets.yaml']);
    assert.equal(read.status, 200);
    assert.deepEqual(calls, [['status'], ['read', 'services.template.yaml']]);
  }, { homeHost: 'home.test', homepageAgent });
});

test('App package catalog API requires authentication and exposes safe manifest summaries', async () => {
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Host: 'home.test' },
    });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    const response = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    const body = response.json();
    const radicale = body.packages.find((entry) => entry.id === 'radicale');
    const stirling = body.packages.find((entry) => entry.id === 'stirling-pdf');
    const vaultwarden = body.packages.find((entry) => entry.id === 'vaultwarden');

    assert.equal(response.status, 200);
    assert.ok(radicale);
    assert.equal(radicale.name, 'Radicale');
    assert.equal(radicale.validation.valid, true);
    assert.deepEqual(radicale.routes, [{ host: 'radicale', service: 'radicale' }]);
    assert.equal(radicale.health.url, 'http://radicale:5232/');
    assert.deepEqual(radicale.setup.fields, [
      {
        default: '${owner.email}',
        generated: false,
        id: 'adminUsername',
        label: 'Radicale username',
        required: true,
        secret: false,
        type: 'text',
      },
      {
        default: "${owner.name}'s calendar",
        generated: false,
        id: 'calendarName',
        label: 'Calendar name',
        required: true,
        secret: false,
        type: 'text',
      },
      {
        generated: false,
        id: 'adminPassword',
        label: 'Radicale password',
        required: true,
        secret: true,
        type: 'password',
      },
      {
        generated: true,
        id: 'icalToken',
        label: 'Calendar widget token',
        required: true,
        secret: true,
        type: 'password',
      },
    ]);
    assert.equal(radicale.homepage.widget.type, 'calendar');
    assert.equal(radicale.homepage.widget.integrations[0].url, '${app.publicUrl}__mos/ical/${secret.icalToken}');
    assert.ok(stirling);
    assert.equal(stirling.name, 'Stirling PDF');
    assert.equal(stirling.installStatus, 'not-installed');
    assert.equal(stirling.validation.valid, true);
    assert.equal(stirling.setup.fieldCount, 0);
    assert.equal(stirling.icon, 'icon.png');
    assert.equal(stirling.iconUrl, '/suite-manager/api/apps/packages/stirling-pdf/icon');
    assert.deepEqual(stirling.routes, [{ host: 'stirling-pdf', service: 'stirling-pdf' }]);
    assert.equal(stirling.health.url, 'http://stirling-pdf:8080/api/v1/info/status');
    assert.equal(JSON.stringify(stirling).includes('reverse_proxy'), false);
    assert.ok(vaultwarden);
    assert.equal(vaultwarden.name, 'Vaultwarden');
    assert.equal(vaultwarden.validation.valid, true);
    assert.equal(vaultwarden.setup.fieldCount, 1);
    assert.deepEqual(vaultwarden.setup.fields, [{
      generated: true,
      id: 'adminToken',
      label: 'Admin token',
      required: true,
      secret: true,
      type: 'password',
    }]);
    assert.equal(vaultwarden.onboarding.sections.length, 2);
  }, { homeHost: 'home.test' });
});

test('app update staging endpoint requires owner authentication', async () => {
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/stage-update', {
      body: JSON.stringify({ confirmationToken: '0'.repeat(64) }),
      headers: { 'Content-Type': 'application/json', Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.json().code, 'AUTH_REQUIRED');
  }, { homeHost: 'home.test' });
});

test('App package icon API serves only authenticated declared package icons', async () => {
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/icon', {
      headers: { Host: 'home.test' },
    });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    const response = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/icon', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'image/png');
    assert.ok(response.body.length > 100);
  }, { homeHost: 'home.test' });
});

test('App package install API creates a logical instance with dry-run projections', async () => {
  const stirlingPort = loopbackPortFor('stirling-pdf');
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/install', {
      headers: { Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    const installed = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const instance = installed.json().instance;

    assert.equal(installed.status, 200);
    assert.equal(instance.packageId, 'stirling-pdf');
    assert.equal(instance.status, 'installed');
    assert.equal(instance.enabled, true);
    assert.deepEqual(instance.projections.map((projection) => projection.kind).sort(), ['caddy', 'compose', 'health', 'homepage']);
    assert.equal(instance.projections.find((projection) => projection.kind === 'compose').status, 'rendered');

    const packages = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    const stirling = packages.json().packages.find((entry) => entry.id === 'stirling-pdf');
    assert.equal(stirling.installStatus, 'installed');
    assert.equal(stirling.instance.packageId, 'stirling-pdf');
    assert.equal(stirling.instance.projections.find((projection) => projection.kind === 'caddy').content.routes[0].reverseProxy, `127.0.0.1:${stirlingPort}`);
    assert.equal(stirling.instance.projections.find((projection) => projection.kind === 'health').content.target, `http://127.0.0.1:${stirlingPort}/api/v1/info/status`);
  }, { homeHost: 'home.test' });
});

test('Security activity API is owner-only and returns a bounded summary without subjects', async () => {
  const stateDir = await tempStateDir();
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/settings/security-events', { headers: { Host: 'home.test' } });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    const store = new SuiteManagerStore(stateDir);
    const at = new Date().toISOString();
    store.recordSecurityEvent({ at, eventType: 'login-throttled', retryAfterSeconds: 2, subject: 'private-client-fingerprint' });
    store.recordSecurityEvent({ at, eventType: 'app-source-candidate-rejected', subject: 'private-source-id' });
    store.close();

    const response = await hostRequest(baseUrl, '/suite-manager/api/settings/security-events', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    const summary = response.json();
    assert.equal(response.status, 200);
    assert.equal(summary.eventCount, 2);
    assert.equal(summary.byType.length, 2);
    assert.match(summary.since, /^\d{4}-\d{2}-\d{2}T/u);
    assert.doesNotMatch(JSON.stringify(summary), /private-client-fingerprint|private-source-id/u);
  }, { homeHost: 'home.test', stateDir });
});

test('Backup inventory API requires auth and reports MOS protected state', async () => {
  const stateDir = await tempStateDir();
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/backups/inventory', {
      headers: { Host: 'home.test' },
    });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });

    const response = await hostRequest(baseUrl, '/suite-manager/api/backups/inventory', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    const inventory = response.json();
    const vaultwarden = inventory.packages.find((entry) => entry.packageId === 'vaultwarden');

    assert.equal(response.status, 200);
    assert.equal(inventory.actions.backupEnabled, false);
    assert.equal(inventory.contents.suiteManager.database.path, path.join(stateDir, 'suite-manager.sqlite'));
    assert.equal(inventory.contents.suiteManager.database.exists, true);
    assert.equal(inventory.contents.suiteManager.appSecrets.exists, true);
    assert.equal(inventory.summary.appCount, 1);
    assert.ok(vaultwarden);
    assert.equal(vaultwarden.manifestPresent, true);
    assert.deepEqual(vaultwarden.declaredVolumes.map((volume) => volume.dockerVolume), ['mos-app-vaultwarden-data']);
    assert.match(vaultwarden.manifestDigest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(inventory.warnings.some((warning) => warning.packageId === 'vaultwarden' && /no explicit backup metadata/u.test(warning.message)));
    assert.ok(inventory.packageManifestDigests.some((entry) => entry.packageId === 'vaultwarden'));
  }, { homeHost: 'home.test', stateDir });
});

test('Updates API requires auth and proxies narrow update-agent actions', async () => {
  const calls = [];
  const updateAgent = {
    async configureTrack(input) {
      calls.push(['track', input]);
      return { track: input, updaterStatus: {} };
    },
    async startUpdate(input) {
      calls.push(['start', input]);
      return { job: { id: 'job-one', status: 'queued' } };
    },
    async status() {
      calls.push(['status']);
      return {
        capabilities: { updates: { capabilities: ['apply', 'configure-track'] } },
        currentJob: null,
        updaterStatus: {
          appRuntimeReconciliation: { automatic: false, summary: 'Installed app runtimes are preserved.' },
          changeSummary: { items: ['Managed update support.'], source: 'CHANGELOG.md [Unreleased]', title: 'Upcoming MOS changes' },
          checkedAt: '2026-07-05T12:00:00.000Z',
          latestRevision: 'abc123',
          track: { currentBranch: 'staging', currentCommit: 'def456', label: 'Staging branch', ref: 'staging', type: 'branch' },
          updateAvailable: true,
        },
      };
    },
  };

  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/updates/status', { headers: { Host: 'home.test' } });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    const status = await hostRequest(baseUrl, '/suite-manager/api/updates/status', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    assert.equal(status.status, 200);
    assert.equal(status.json().managedApplyAvailable, true);
    assert.equal(status.json().changeSummary.items[0], 'Managed update support.');
    assert.equal(status.json().appRuntimeReconciliation, undefined);

    const track = await hostRequest(baseUrl, '/suite-manager/api/updates/track', {
      body: JSON.stringify({ track: 'staging' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(track.status, 200);

    const mainTrack = await hostRequest(baseUrl, '/suite-manager/api/updates/track', {
      body: JSON.stringify({ track: 'main' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(mainTrack.status, 200);

    const started = await hostRequest(baseUrl, '/suite-manager/api/updates/start', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(started.status, 202);
    assert.equal(started.json().job.id, 'job-one');
    assert.deepEqual(calls.filter((call) => call[0] !== 'status'), [
      ['track', { ref: 'staging', track: 'branch' }],
      ['track', { ref: 'main', track: 'branch' }],
      ['start', { initiator: 'owner@example.com', target: 'latest' }],
    ]);
  }, { homeHost: 'home.test', updateAgent });
});

test('Stable-track apply starts the update agent when a newer release is available', async () => {
  const calls = [];
  const updateAgent = {
    async startUpdate(input) {
      calls.push(['start', input]);
      return { job: { id: 'job-one', status: 'queued' } };
    },
    async status() {
      return {
        capabilities: { updates: { capabilities: ['apply', 'configure-track'] } },
        currentJob: null,
        updaterStatus: {
          checkedAt: '2026-07-21T12:00:00.000Z',
          installedVersion: '0.11.0',
          latestRelease: { channel: 'stable', source: 'github-releases', version: '0.12.0' },
          track: { currentBranch: 'main', currentCommit: 'def456', label: 'Stable releases', ref: 'main', type: 'stable' },
          updateAvailable: true,
        },
      };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const statusResponse = await hostRequest(baseUrl, '/suite-manager/api/updates/status', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    assert.equal(statusResponse.status, 200);
    assert.equal(statusResponse.json().installedVersion, '0.11.0');
    const started = await hostRequest(baseUrl, '/suite-manager/api/updates/start', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(started.status, 202);
    assert.deepEqual(calls, [['start', { initiator: 'owner@example.com', target: 'latest' }]]);
  }, { homeHost: 'home.test', updateAgent });
});

test('Backup API proxies simple owner backup, restore, and download actions', async () => {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-backup-bundle-'));
  const archivePath = path.join(backupDir, 'bundle.tar.gz');
  await fs.writeFile(archivePath, 'fake backup archive');
  const calls = [];
  const backupAgent = {
    async mount(destinationId) {
      calls.push(['mount', destinationId]);
      return { destination: { id: '/media/backup', label: 'Backup Drive', mountPath: '/media/backup', writable: true } };
    },
    async startBackup(input) {
      calls.push(['backup', input]);
      return { job: { id: 'job-backup', status: 'queued' } };
    },
    async startRestore(input) {
      calls.push(['restore', input]);
      return { job: { id: 'job-restore', status: 'queued' } };
    },
    async status() {
      calls.push(['status']);
      return {
        backups: [{
          archivePath,
          appCount: 1,
          createdAt: '2026-07-05T12:00:00.000Z',
          destinationId: '/media/backup',
          destinationLabel: 'Backup Drive',
          id: 'backup-one',
          path: backupDir,
          sourceVersion: null,
          volumeCount: 1,
        }],
        currentJob: null,
        destinations: [{
          availableBytes: 1024,
          id: '/media/backup',
          label: 'Backup Drive',
          mountPath: '/media/backup',
          mountState: 'mounted',
          sizeBytes: 2048,
          storageKind: 'external',
          writable: true,
        }],
        lastJob: null,
      };
    },
  };

  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/backups/status', { headers: { Host: 'home.test' } });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    const status = await hostRequest(baseUrl, '/suite-manager/api/backups/status', { headers: { Cookie: cookie, Host: 'home.test' } });
    assert.equal(status.status, 200);
    assert.equal(status.json().serviceAvailable, true);
    assert.equal(status.json().destinations[0].label, 'Backup Drive');

    const start = await hostRequest(baseUrl, '/suite-manager/api/backups/start', {
      body: JSON.stringify({ destinationId: '/media/backup' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(start.status, 202);

    const restore = await hostRequest(baseUrl, '/suite-manager/api/backups/restore', {
      body: JSON.stringify({ backupPath: backupDir, confirmation: 'RESTORE' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(restore.status, 202);

    const download = await hostRequest(baseUrl, `/suite-manager/api/backups/download?path=${encodeURIComponent(backupDir)}`, {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    assert.equal(download.status, 200);
    assert.equal(download.body, 'fake backup archive');
    assert.match(download.headers['content-disposition'], /backup-one\.tar\.gz/);
    assert.deepEqual(calls.filter((call) => call[0] !== 'status'), [
      ['backup', { destinationId: '/media/backup', note: '' }],
      ['restore', { backupPath: backupDir, confirmation: 'RESTORE' }],
    ]);
  }, { backupAgent, homeHost: 'home.test' });
});

test('Vaultwarden install generates a redacted secret and materializes it only for runtime apply', async () => {
  const vaultwardenPort = loopbackPortFor('vaultwarden');
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(input);
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const installed = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const instance = installed.json().instance;
    const secretConfig = instance.config.find((item) => item.key === 'adminToken');
    const compose = instance.projections.find((projection) => projection.kind === 'compose').content;

    assert.equal(installed.status, 200);
    assert.equal(instance.packageId, 'vaultwarden');
    assert.equal(secretConfig.secret, true);
    assert.equal(secretConfig.generated, true);
    assert.equal(secretConfig.value, undefined);
    assert.match(secretConfig.fingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(secretConfig.redactedLabel, 'Generated Vaultwarden admin token');
    assert.equal(compose.services[0].environment.ADMIN_TOKEN, '${secret.adminToken}');
    assert.equal(compose.services[0].environment.DOMAIN, '${app.publicUrl}');
    assert.equal(compose.services[0].volumes[0], 'data:/data');

    const applied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    const adminToken = calls[0].compose.services[0].environment.ADMIN_TOKEN;

    assert.equal(applied.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].appHost, 'vaultwarden.test');
    assert.equal(calls[0].publicUrl, 'https://vaultwarden.test/');
    assert.equal(calls[0].compose.services[0].loopbackPort, vaultwardenPort);
    assert.equal(calls[0].compose.services[0].environment.DOMAIN, '${app.publicUrl}');
    assert.notEqual(adminToken, '${secret.adminToken}');
    assert.match(adminToken, /^[A-Za-z0-9_-]{40,}$/u);
    assert.doesNotMatch(installed.body, new RegExp(adminToken, 'u'));
    assert.doesNotMatch(applied.body, new RegExp(adminToken, 'u'));

    const packages = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    assert.doesNotMatch(packages.body, new RegExp(adminToken, 'u'));
  }, { appAgent, homeHost: 'home.test' });
});

test('Vaultwarden runtime apply returns a controlled redacted error when its secret file is missing', async () => {
  const stateDir = await tempStateDir();
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(['apply', input]);
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
    async connectNetwork(input) {
      calls.push(['connectNetwork', input]);
      return { status: 'connected', steps: ['network-connected'] };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const installed = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const instance = installed.json().instance;
    const secretPath = path.join(stateDir, 'app-secrets', instance.id, 'adminToken.secret');
    await fs.rm(secretPath, { force: true });

    const applied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    const body = applied.json();

    assert.equal(applied.status, 409);
    assert.equal(body.code, 'APP_SECRET_UNAVAILABLE');
    assert.equal(body.error, 'A required app secret is unavailable. Restore the app secret before applying this runtime.');
    assert.equal(calls.length, 0);
    assert.doesNotMatch(applied.body, /adminToken\.secret/u);
    assert.doesNotMatch(applied.body, new RegExp(instance.id, 'u'));
  }, { appAgent, homeHost: 'home.test', stateDir });
});

test('app integration connect materializes provider exports into consumer runtime without leaking secrets', async () => {
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(['apply', input]);
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
    async connectNetwork(input) {
      calls.push(['connectNetwork', input]);
      return { status: 'connected', steps: ['network-connected'] };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/seafile/install', {
      body: JSON.stringify({ config: { adminEmail: 'owner@example.com', adminPassword: 'seafile-password' } }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/seafile/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/onlyoffice/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/onlyoffice/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });

    const before = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    const seafile = before.json().packages.find((entry) => entry.id === 'seafile');
    const connection = seafile.compatibility.connections.find((entry) => entry.provider.id === 'onlyoffice');
    assert.equal(connection.ready, true);

    const connected = await hostRequest(baseUrl, '/suite-manager/api/apps/integrations/connect', {
      body: JSON.stringify({
        consumerPackageId: connection.consumerPackageId,
        providerCapabilityId: connection.capabilityId,
        providerPackageId: connection.provider.id,
        slotId: connection.slotId,
      }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    const connectedBody = connected.json();
    const seafileApply = calls.at(-2)[1];
    const seafileService = seafileApply.compose.services.find((service) => service.id === 'seafile');
    const jwtSecret = seafileService.environment.ONLYOFFICE_JWT_SECRET;

    assert.equal(connected.status, 200);
    assert.equal(connectedBody.integration.status, 'active');
    assert.equal(seafileApply.packageId, 'seafile');
    assert.deepEqual(calls.at(-1), ['connectNetwork', {
      consumerPackageId: 'seafile',
      providerPackageId: 'onlyoffice',
      providerServiceCount: 1,
      providerServices: ['onlyoffice'],
    }]);
    assert.equal(seafileService.environment.ONLYOFFICE_APIJS_URL, 'https://onlyoffice.test/web-apps/apps/api/documents/api.js');
    assert.equal(seafileService.environment.ONLYOFFICE_INTERNAL_SEAFILE_URL, 'http://seafile');
    assert.equal(seafileService.environment.VERIFY_ONLYOFFICE_CERTIFICATE, 'false');
    assert.match(jwtSecret, /^[A-Za-z0-9_-]{40,}$/u);
    assert.doesNotMatch(connected.body, new RegExp(jwtSecret, 'u'));

    const after = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    assert.doesNotMatch(after.body, new RegExp(jwtSecret, 'u'));
    const afterSeafile = after.json().packages.find((entry) => entry.id === 'seafile');
    assert.equal(afterSeafile.compatibility.connections.find((entry) => entry.provider.id === 'onlyoffice').relationship.status, 'active');
  }, { appAgent, homeHost: 'home.test' });
});

test('Radicale install stores user-supplied credentials with secret redaction and runtime materialization', async () => {
  const radicalePort = loopbackPortFor('radicale');
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(input);
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const missing = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/radicale/install', {
      body: JSON.stringify({ config: { adminUsername: 'admin' } }),
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json().code, 'APP_SETUP_REQUIRED');

    const password = 'correct horse battery staple';
    const installed = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/radicale/install', {
      body: JSON.stringify({ config: { adminPassword: password, adminUsername: 'calendar-admin', calendarName: 'Family calendar' } }),
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const instance = installed.json().instance;
    const username = instance.config.find((item) => item.key === 'adminUsername');
    const passwordConfig = instance.config.find((item) => item.key === 'adminPassword');
    const tokenConfig = instance.config.find((item) => item.key === 'icalToken');
    const compose = instance.projections.find((projection) => projection.kind === 'compose').content;
    const caddy = instance.projections.find((projection) => projection.kind === 'caddy').content;
    const homepage = instance.projections.find((projection) => projection.kind === 'homepage').content;

    assert.equal(installed.status, 200);
    assert.equal(instance.packageId, 'radicale');
    assert.equal(username.value, 'calendar-admin');
    assert.equal(passwordConfig.secret, true);
    assert.equal(passwordConfig.generated, false);
    assert.equal(passwordConfig.value, undefined);
    assert.equal(passwordConfig.redactedLabel, 'Radicale admin password');
    assert.match(passwordConfig.fingerprint, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(tokenConfig.secret, true);
    assert.equal(tokenConfig.generated, true);
    assert.equal(tokenConfig.value, undefined);
    assert.equal(compose.services[0].environment.RADICALE_ADMIN_USERNAME, 'calendar-admin');
    assert.equal(compose.services[0].environment.RADICALE_ADMIN_PASSWORD, '${secret.adminPassword}');
    assert.equal(caddy.routes[0].internalIcalBridge.path, '/__mos/ical/${secret.icalToken}');
    assert.equal(caddy.routes[0].internalIcalBridge.basicAuth.password, '${secret.adminPassword}');
    assert.equal(homepage.widget.integrations[0].url, '${app.publicUrl}__mos/ical/${secret.icalToken}');
    assert.equal(compose.services[0].internalPort, 5232);
    assert.equal(compose.services[0].loopbackPort, radicalePort);
    assert.deepEqual(compose.services[0].volumes, ['data:/data']);
    assert.doesNotMatch(installed.body, new RegExp(password, 'u'));

    const applied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/radicale/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });

    assert.equal(applied.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].appHost, 'radicale.test');
    assert.equal(calls[0].publicUrl, 'https://radicale.test/');
    assert.equal(calls[0].compose.services[0].environment.RADICALE_ADMIN_USERNAME, 'calendar-admin');
    assert.equal(calls[0].compose.services[0].environment.RADICALE_ADMIN_PASSWORD, password);
    assert.match(calls[0].caddy.routes[0].internalIcalBridge.path, /^\/__mos\/ical\/[A-Za-z0-9_-]{40,}$/u);
    assert.equal(calls[0].caddy.routes[0].internalIcalBridge.basicAuth.password, password);
    assert.equal(calls[0].health.target, `http://127.0.0.1:${radicalePort}/`);
    assert.doesNotMatch(applied.body, new RegExp(password, 'u'));
    assert.doesNotMatch(applied.body, new RegExp(calls[0].caddy.routes[0].internalIcalBridge.path.split('/').at(-1), 'u'));
  }, { appAgent, homeHost: 'home.test' });
});

test('Seafile install renders multi-service projections with internal services unrouted and redacted secrets', async () => {
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(input);
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const installed = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/seafile/install', {
      body: JSON.stringify({ config: { adminEmail: 'owner@example.com', adminPassword: 'seafile-admin-pass' } }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const instance = installed.json().instance;
    const compose = instance.projections.find((projection) => projection.kind === 'compose').content;
    const caddy = instance.projections.find((projection) => projection.kind === 'caddy').content;
    const health = instance.projections.find((projection) => projection.kind === 'health').content;

    assert.equal(installed.status, 200);
    assert.equal(instance.packageId, 'seafile');
    assert.deepEqual(compose.services.map((service) => service.id).sort(), ['seafile', 'seafile-mysql', 'seafile-valkey']);
    assert.deepEqual(caddy.routes, [{
      host: 'seafile',
      reverseProxy: `127.0.0.1:${loopbackPortFor('seafile', 'seafile')}`,
      service: 'seafile',
    }]);
    assert.equal(JSON.stringify(caddy).includes('seafile-mysql'), false);
    assert.equal(JSON.stringify(caddy).includes('seafile-valkey'), false);
    assert.equal(health.target, `http://127.0.0.1:${loopbackPortFor('seafile', 'seafile')}/api2/ping/`);
    assert.equal(compose.services.find((service) => service.id === 'seafile').environment.SEAFILE_MYSQL_DB_PASSWORD, '${secret.mysqlUserPassword}');
    assert.equal(compose.services.find((service) => service.id === 'seafile').environment.SEAFILE_SERVER_HOSTNAME, '${app.host}');
    assert.equal(instance.config.find((item) => item.key === 'adminPassword').value, undefined);
    assert.equal(instance.config.filter((item) => item.secret).length, 4);
    assert.doesNotMatch(installed.body, /seafile-admin-pass/u);

    const applied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/seafile/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });

    assert.equal(applied.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].appHost, 'seafile.test');
    assert.equal(calls[0].compose.services.find((service) => service.id === 'seafile').environment.SEAFILE_SERVER_HOSTNAME, '${app.host}');
    assert.equal(calls[0].compose.services.find((service) => service.id === 'seafile').environment.INIT_SEAFILE_ADMIN_PASSWORD, 'seafile-admin-pass');
    assert.equal(calls[0].compose.services.find((service) => service.id === 'seafile-mysql').environment.MYSQL_ROOT_PASSWORD.includes('${secret.'), false);
    assert.doesNotMatch(applied.body, /seafile-admin-pass/u);
  }, { appAgent, homeHost: 'home.test' });
});

test('Installed app packages can apply their runtime through the app agent boundary', async () => {
  const stirlingPort = loopbackPortFor('stirling-pdf');
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(input);
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
  };

  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/apply-runtime', {
      headers: { Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(denied.status, 401);
    assert.equal(calls.length, 0);

    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const applied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });

    assert.equal(applied.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].appHost, 'stirling-pdf.test');
    assert.equal(calls[0].publicUrl, 'https://stirling-pdf.test/');
    assert.equal(calls[0].compose.services[0].loopbackPort, stirlingPort);
    assert.equal(calls[0].caddy.routes[0].reverseProxy, `127.0.0.1:${stirlingPort}`);

    const instance = applied.json().instance;
    for (const kind of ['compose', 'caddy', 'health']) {
      const projection = instance.projections.find((item) => item.kind === kind);
      assert.equal(projection.status, 'applied');
      assert.equal(projection.appliedDigest, projection.digest);
    }
    const homepageProjection = instance.projections.find((item) => item.kind === 'homepage');
    assert.equal(homepageProjection.status, 'rendered');
    assert.equal(homepageProjection.appliedDigest, null);
  }, { appAgent, homeHost: 'home.test' });
});

test('app runtime status refresh marks stale applied health as failed', async () => {
  const appAgent = {
    async apply(input) {
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
    async checkHealth() {
      throw Object.assign(new Error('The app container started but did not become healthy in time.'), {
        code: 'APP_HEALTH_FAILED',
        statusCode: 502,
      });
    },
  };

  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/refresh-runtime-status', {
      headers: { Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });

    const refreshed = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/refresh-runtime-status', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(refreshed.status, 502);
    assert.equal(refreshed.json().code, 'APP_HEALTH_FAILED');

    const packages = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    const stirling = packages.json().packages.find((entry) => entry.id === 'stirling-pdf');
    const health = stirling.instance.projections.find((projection) => projection.kind === 'health');
    assert.equal(health.status, 'failed');
    assert.equal(stirling.instance.projections.find((projection) => projection.kind === 'compose').status, 'applied');
    assert.equal(stirling.instance.projections.find((projection) => projection.kind === 'caddy').status, 'applied');
  }, { appAgent, homeHost: 'home.test' });
});

test('Installed app packages can be added to Homepage through the existing agent boundary', async () => {
  const stirlingPort = loopbackPortFor('stirling-pdf');
  const calls = [];
  const homepageAgent = {
    async addLink(input) {
      calls.push(['addLink', input]);
      return { changed: true, file: 'services.template.yaml', id: input.requestId, revision: 'sha256:next' };
    },
    async addHomeService(input) {
      calls.push(['addHomeService', input]);
      return { changed: true, file: 'services.template.yaml', id: input.requestId, revision: 'sha256:next' };
    },
    async read(file) {
      calls.push(['read', file]);
      return { content: '- Tools: []\n', file, revision: 'sha256:current' };
    },
  };

  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/add-to-homepage', {
      headers: { Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(denied.status, 401);
    assert.equal(calls.length, 0);

    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const tooEarly = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/add-to-homepage', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(tooEarly.status, 409);
    assert.equal(tooEarly.json().code, 'APP_RUNTIME_NOT_APPLIED');

    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const applied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/add-to-homepage', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });

    assert.equal(applied.status, 200);
    assert.deepEqual(calls.map((call) => call[0]), ['read', 'addLink']);
    assert.equal(calls[1][1].expectedRevision, 'sha256:current');
    assert.equal(calls[1][1].entry.name, 'Stirling PDF');
    assert.equal(calls[1][1].entry.group, 'Tools');
    assert.equal(calls[1][1].entry.url, 'http://stirling-pdf.test/');
    assert.equal(Object.hasOwn(calls[1][1].entry, 'host'), false);
    assert.equal(Object.hasOwn(calls[1][1].entry, 'port'), false);

    const instance = applied.json().instance;
    const homepageProjection = instance.projections.find((projection) => projection.kind === 'homepage');
    assert.equal(homepageProjection.status, 'applied');
    assert.equal(homepageProjection.appliedDigest, homepageProjection.digest);
  }, {
    appAgent: {
      async apply(input) {
        assert.equal(input.compose.services[0].loopbackPort, stirlingPort);
        return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
      },
    },
    homeHost: 'home.test',
    homepageAgent,
  });
});

test('Radicale Homepage projection adds a calendar widget without exposing credentials in package APIs', async () => {
  const calls = [];
  const homepageAgent = {
    async addLink(input) {
      calls.push(['addLink', input]);
      return { changed: true, file: 'services.template.yaml', id: input.requestId, revision: 'sha256:next' };
    },
    async read(file) {
      calls.push(['read', file]);
      return { content: '- Office: []\n', file, revision: 'sha256:current' };
    },
  };
  const appAgent = {
    async apply(input) {
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const password = 'calendar widget passphrase';
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/radicale/install', {
      body: JSON.stringify({ config: { adminPassword: password, adminUsername: 'calendar-admin', calendarName: 'Family calendar' } }),
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/radicale/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    const applied = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/radicale/add-to-homepage', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });

    assert.equal(applied.status, 200);
    const add = calls.find((call) => call[0] === 'addLink')[1];
    assert.equal(add.entry.name, 'Radicale');
    assert.equal(add.entry.widget.type, 'calendar');
    assert.equal(add.entry.widget.integrations[0].type, 'ical');
    assert.match(add.entry.widget.integrations[0].url, /^https:\/\/radicale\.test\/__mos\/ical\/[A-Za-z0-9_-]{40,}$/u);
    assert.doesNotMatch(JSON.stringify(add.entry), new RegExp(password, 'u'));
    assert.doesNotMatch(applied.body, new RegExp(add.entry.widget.integrations[0].url.split('/').at(-1), 'u'));
  }, { appAgent, homeHost: 'home.test', homepageAgent });
});

test('app lifecycle stop, start, restart, and uninstall remove app state, data, and Homepage shortcut', async () => {
  const appCalls = [];
  const homepageCalls = [];
  const appAgent = {
    async apply(input) {
      appCalls.push(['apply', input]);
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
    async remove(input) {
      appCalls.push(['remove', input]);
      return { status: 'removed', steps: ['stopped', 'route-removed', 'caddy-reloaded'] };
    },
    async stop(input) {
      appCalls.push(['stop', input]);
      return { status: 'stopped', steps: ['stopped'] };
    },
  };
  const homepageAgent = {
    async addLink(input) {
      homepageCalls.push(['addLink', input]);
      return { changed: true, file: 'services.template.yaml', id: input.requestId, revision: 'sha256:with-link' };
    },
    async read(file) {
      homepageCalls.push(['read', file]);
      return { content: '- Tools: []\n', file, revision: homepageCalls.some((call) => call[0] === 'addLink') ? 'sha256:with-link' : 'sha256:current' };
    },
    async removeLink(input) {
      homepageCalls.push(['removeLink', input]);
      return { changed: true, file: 'services.template.yaml', id: input.id, revision: 'sha256:without-link' };
    },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/add-to-homepage', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });

    const before = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    const beforeVaultwarden = before.json().packages.find((entry) => entry.id === 'vaultwarden');
    const instanceId = beforeVaultwarden.instance.id;
    const fingerprint = beforeVaultwarden.instance.config.find((item) => item.key === 'adminToken').fingerprint;

    const disabled = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/stop', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json().instance.status, 'disabled');
    assert.equal(disabled.json().instance.enabled, false);
    assert.equal(disabled.json().instance.config.find((item) => item.key === 'adminToken').fingerprint, fingerprint);
    assert.equal(disabled.json().instance.projections.find((item) => item.kind === 'compose').appliedDigest, null);
    assert.equal(disabled.json().instance.projections.find((item) => item.kind === 'health').appliedDigest, null);
    assert.equal(disabled.json().instance.projections.find((item) => item.kind === 'caddy').status, 'applied');
    assert.equal(disabled.json().instance.projections.find((item) => item.kind === 'homepage').status, 'applied');
    assert.deepEqual(appCalls.map((call) => call[0]), ['apply', 'stop']);
    assert.deepEqual(appCalls[1], ['stop', { packageId: 'vaultwarden', services: ['vaultwarden'] }]);
    assert.equal(homepageCalls.some((call) => call[0] === 'removeLink' && call[1].id === instanceId), false);

    const enabled = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/enable', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json().instance.status, 'installed');
    assert.equal(enabled.json().instance.enabled, true);
    assert.equal(enabled.json().instance.config.find((item) => item.key === 'adminToken').fingerprint, fingerprint);
    assert.equal(appCalls.map((call) => call[0]).join(','), 'apply,stop,apply');

    const restarted = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/restart', {
      headers: { Cookie: cookie, Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    assert.equal(restarted.status, 200);
    assert.equal(restarted.json().instance.status, 'installed');
    assert.equal(restarted.json().instance.enabled, true);
    assert.equal(restarted.json().instance.config.find((item) => item.key === 'adminToken').fingerprint, fingerprint);
    assert.equal(appCalls.map((call) => call[0]).join(','), 'apply,stop,apply,apply');

    const uninstalled = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/uninstall', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(uninstalled.status, 200);
    assert.equal(uninstalled.json().instance, null);
    assert.equal(appCalls.map((call) => call[0]).join(','), 'apply,stop,apply,apply,remove');
    assert.deepEqual(appCalls.at(-1)[1], { packageId: 'vaultwarden', services: ['vaultwarden'], volumes: ['data'] });
    assert.equal(homepageCalls.some((call) => call[0] === 'removeLink' && call[1].id === instanceId), true);
    assert.doesNotMatch(JSON.stringify(appCalls), /rmi/u);

    const catalogAfterUninstall = await hostRequest(baseUrl, '/suite-manager/api/apps/packages', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });
    const uninstalledVaultwarden = catalogAfterUninstall.json().packages.find((entry) => entry.id === 'vaultwarden');
    assert.equal(uninstalledVaultwarden.installStatus, 'not-installed');
    assert.equal(uninstalledVaultwarden.instance, null);

    const reinstall = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(reinstall.status, 200);
    assert.equal(reinstall.json().instance.status, 'installed');
    assert.notEqual(reinstall.json().instance.id, instanceId);
  }, { appAgent, homeHost: 'home.test', homepageAgent });
});

test('invalid app lifecycle transitions fail clearly', async () => {
  const appAgent = {
    async apply() {
      throw Object.assign(new Error('App runtime system agent is unavailable.'), {
        code: 'APP_AGENT_UNAVAILABLE',
        statusCode: 503,
      });
    },
    async remove() { throw new Error('must not run'); },
  };
  const homepageAgent = {
    async read() { throw new Error('must not run'); },
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const missingDisable = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/stop', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(missingDisable.status, 409);
    assert.equal(missingDisable.json().code, 'APP_NOT_INSTALLED');

    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const restartBeforeRuntime = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/restart', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(restartBeforeRuntime.status, 409);
    assert.equal(restartBeforeRuntime.json().code, 'APP_RUNTIME_NOT_APPLIED');

    const enableInstalled = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/enable', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(enableInstalled.status, 503);
    assert.equal(enableInstalled.json().code, 'APP_AGENT_UNAVAILABLE');
  }, { appAgent, homeHost: 'home.test', homepageAgent });
});

test('Homepage agent request budget exceeds the observed restart rollback window', () => {
  assert.ok(HOMEPAGE_AGENT_TIMEOUT_MS > 60_000);
});

test('Homepage restart failure preserves the exact controlled 502 response', async () => {
  const homepageAgent = {
    async apply() {
      throw Object.assign(new Error('Homepage did not restart successfully.'), {
        code: 'HOMEPAGE_RESTART_FAILED',
        statusCode: 502,
      });
    },
  };
  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const response = await hostRequest(baseUrl, '/suite-manager/api/customize/file/apply', {
      body: JSON.stringify({ content: '- Links: []\n', expectedRevision: 'sha256:current', file: 'services.template.yaml' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(response.status, 502);
    assert.deepEqual(response.json(), {
      code: 'HOMEPAGE_RESTART_FAILED',
      error: 'Homepage did not restart successfully.',
    });
  }, { homeHost: 'home.test', homepageAgent });
});

test('Homepage failure returns a controlled bad gateway response', async () => {
  const unavailable = http.createServer();
  const unavailableUrl = await listen(unavailable);
  await new Promise((resolve) => unavailable.close(resolve));

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const response = await hostRequest(baseUrl, '/', { headers: { Cookie: cookie, Host: 'home.test' } });

    assert.equal(response.status, 502);
    assert.deepEqual(response.json(), { error: 'Homepage is unavailable.' });
  }, { homeHost: 'home.test', homepageUpstream: unavailableUrl });
});

function websocketExchange(baseUrl, cookie = '', requestPath = '/socket') {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    const socket = net.connect(Number(url.port), url.hostname);
    let received = '';
    let sentPayload = false;

    socket.setTimeout(3000);
    socket.on('connect', () => {
      socket.write([
        `GET ${requestPath} HTTP/1.1`,
        'Host: home.test',
        'Connection: Upgrade',
        'Upgrade: websocket',
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        '',
        '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (!sentPayload && received.includes('101 Switching Protocols')) {
        sentPayload = true;
        socket.write('dashboard-socket-payload');
      }
      if (
        received.includes('dashboard-socket-payload')
        || received.includes('401 Unauthorized')
        || received.includes('404 Not Found')
      ) {
        socket.end();
      }
    });
    socket.on('end', () => resolve(received));
    socket.on('error', reject);
    socket.on('timeout', () => socket.destroy(new Error('Timed out waiting for WebSocket proxy.')));
  });
}

test('WebSocket upgrades require a valid Home session and tunnel when authenticated', async () => {
  const upstream = http.createServer();
  upstream.on('upgrade', (request, socket) => {
    assert.equal(request.headers.cookie, undefined);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSet-Cookie: homepage=value\r\n\r\n');
    socket.pipe(socket);
  });
  const upstreamUrl = await listen(upstream);

  try {
    await withServer(async (baseUrl) => {
      const denied = await websocketExchange(baseUrl);
      const cookie = await createOwner(baseUrl);
      const suiteManagerDenied = await websocketExchange(baseUrl, cookie, '/suite-manager/socket');
      const allowed = await websocketExchange(baseUrl, cookie);

      assert.match(denied, /401 Unauthorized/);
      assert.match(suiteManagerDenied, /404 Not Found/);
      assert.match(allowed, /101 Switching Protocols/);
      assert.match(allowed, /dashboard-socket-payload/);
      assert.doesNotMatch(allowed, /Set-Cookie/i);
    }, { homeHost: 'home.test', homepageUpstream: upstreamUrl });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('empty setup status requires owner creation', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/suite-manager/api/setup/status`);
    const status = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(status, {
      owner: null,
      ownerClaimRequired: false,
      secureTransport: false,
      status: 'needs-owner',
      terms: { accepted: false, acceptedAt: null, version: TERMS_VERSION },
    });
  });
});

test('cloud owner creation requires HTTPS and the one-time claim token', async () => {
  await withServer(async (baseUrl) => {
    const insecure = await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({ claimToken: 'claim-secret', email: 'owner@example.com', name: 'Owner', password: 'correct horse battery staple' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    assert.equal(insecure.status, 403);
    assert.equal((await insecure.json()).code, 'HTTPS_REQUIRED_FOR_OWNER_SETUP');

    const wrongClaim = await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({ claimToken: 'wrong', email: 'owner@example.com', name: 'Owner', password: 'correct horse battery staple' }),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    assert.equal(wrongClaim.status, 403);
    assert.equal((await wrongClaim.json()).code, 'OWNER_CLAIM_REQUIRED');

    const claimed = await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({ claimToken: 'claim-secret', email: 'owner@example.com', name: 'Owner', password: 'correct horse battery staple' }),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    assert.equal(claimed.status, 201);
    assert.match(String(claimed.headers.get('set-cookie')), /; Secure/u);
  }, { ownerClaimToken: 'claim-secret' });
});

test('owner creation API signs in and changes setup status', async () => {
  await withServer(async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        name: 'Suite Owner',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const created = await createResponse.json();
    const cookie = createResponse.headers.get('set-cookie');

    assert.equal(createResponse.status, 201);
    assert.equal(created.status, 'signed-in');
    assert.match(cookie, /mos_session=/);

    const statusResponse = await fetch(`${baseUrl}/suite-manager/api/setup/status`, {
      headers: { Cookie: cookie },
    });
    const status = await statusResponse.json();

    assert.equal(status.status, 'signed-in');
    assert.equal(status.owner.email, 'owner@example.com');
  });
});

test('lab reset endpoint is disabled unless explicitly enabled by the install', async () => {
  await withServer(async (baseUrl) => {
    const response = await hostRequest(baseUrl, '/suite-manager/api/lab/reset', { method: 'POST' });

    assert.equal(response.status, 404);
    assert.equal(response.json().code, 'LAB_RESET_DISABLED');
  });
});

test('lab reset endpoint schedules the narrow lab agent when enabled', async () => {
  const calls = [];
  await withServer(async (baseUrl) => {
    const response = await hostRequest(baseUrl, '/suite-manager/api/lab/reset', { method: 'POST' });

    assert.equal(response.status, 202);
    assert.deepEqual(response.json(), { resetId: 'reset-one', scheduled: true });
    assert.deepEqual(calls, [{ reason: 'hyperv-e2e' }]);
    assert.match(String(response.headers['set-cookie']), /mos_session=/u);
  }, {
    disposableLab: true,
    labResetAgent: {
      async reset(input) {
        calls.push(input);
        return { resetId: 'reset-one', scheduled: true };
      },
    },
  });
});

test('lab reset status endpoint proxies the scheduled reset job when enabled', async () => {
  await withServer(async (baseUrl) => {
    const response = await hostRequest(baseUrl, '/suite-manager/api/lab/reset/reset-one');

    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), {
      resetId: 'reset-one',
      status: 'completed',
    });
  }, {
    disposableLab: true,
    labResetAgent: {
      async resetStatus(resetId) {
        assert.equal(resetId, 'reset-one');
        return { resetId, status: 'completed' };
      },
    },
  });
});

test('existing-owner signed-out state never returns setup again', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        name: 'Suite Owner',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const statusResponse = await fetch(`${baseUrl}/suite-manager/api/setup/status`);
    const status = await statusResponse.json();

    assert.equal(statusResponse.status, 200);
    assert.equal(status.status, 'signed-out');
    assert.equal(status.owner.email, 'owner@example.com');
  });
});

test('login and logout transition session state', async () => {
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        name: 'Suite Owner',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const loginResponse = await fetch(`${baseUrl}/suite-manager/api/auth/login`, {
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'correct horse battery',
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const login = await loginResponse.json();
    const cookie = loginResponse.headers.get('set-cookie');

    assert.equal(loginResponse.status, 200);
    assert.equal(login.status, 'signed-in');
    assert.match(cookie, /mos_session=/);

    const signedInResponse = await fetch(`${baseUrl}/suite-manager/api/setup/status`, {
      headers: { Cookie: cookie },
    });
    const signedIn = await signedInResponse.json();

    assert.equal(signedIn.status, 'signed-in');

    const logoutResponse = await fetch(`${baseUrl}/suite-manager/api/auth/logout`, {
      headers: { Cookie: cookie },
      method: 'POST',
    });
    const logout = await logoutResponse.json();

    assert.equal(logoutResponse.status, 200);
    assert.equal(logout.status, 'signed-out');
    assert.match(logoutResponse.headers.get('set-cookie'), /Max-Age=0/);
  });
});

test('terms acceptance and the owner password change require a session', async () => {
  await withServer(async (baseUrl) => {
    for (const [pathname, body] of [
      ['/suite-manager/api/setup/terms/accept', { version: TERMS_VERSION }],
      ['/suite-manager/api/settings/owner/password', { currentPassword: 'correct horse battery', newPassword: 'a much better passphrase' }],
    ]) {
      const response = await fetch(`${baseUrl}${pathname}`, {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, 'AUTH_REQUIRED');
    }
  });
});

test('an owner accepts the terms and rotates the password without losing this browser', async () => {
  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({ email: 'owner@example.com', name: 'Suite Owner', password: 'correct horse battery' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const cookie = created.headers.get('set-cookie').split(';')[0];

    const accepted = await fetch(`${baseUrl}/suite-manager/api/setup/terms/accept`, {
      body: JSON.stringify({ version: TERMS_VERSION }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      method: 'POST',
    });
    assert.equal(accepted.status, 200);
    assert.equal((await accepted.json()).terms.accepted, true);

    const stale = await fetch(`${baseUrl}/suite-manager/api/setup/terms/accept`, {
      body: JSON.stringify({ version: 'not-the-shown-version' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      method: 'POST',
    });
    assert.equal(stale.status, 400);
    assert.equal((await stale.json()).code, 'TERMS_VERSION_MISMATCH');

    const changed = await fetch(`${baseUrl}/suite-manager/api/settings/owner/password`, {
      body: JSON.stringify({ currentPassword: 'correct horse battery', newPassword: 'a much better passphrase' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      method: 'POST',
    });
    assert.equal(changed.status, 200);
    const rotatedCookie = changed.headers.get('set-cookie').split(';')[0];
    assert.notEqual(rotatedCookie, cookie);

    // The cookie the change was made with is dead; the one it handed back works,
    // and the acceptance recorded earlier survived the rotation.
    const withOldCookie = await fetch(`${baseUrl}/suite-manager/api/setup/status`, { headers: { Cookie: cookie } });
    assert.equal((await withOldCookie.json()).status, 'signed-out');
    const withNewCookie = await fetch(`${baseUrl}/suite-manager/api/setup/status`, { headers: { Cookie: rotatedCookie } });
    const status = await withNewCookie.json();
    assert.equal(status.status, 'signed-in');
    assert.equal(status.terms.accepted, true);

    const wrongCurrent = await fetch(`${baseUrl}/suite-manager/api/settings/owner/password`, {
      body: JSON.stringify({ currentPassword: 'correct horse battery', newPassword: 'yet another passphrase' }),
      headers: { 'Content-Type': 'application/json', Cookie: rotatedCookie },
      method: 'POST',
    });
    assert.equal(wrongCurrent.status, 400);
    assert.equal((await wrongCurrent.json()).code, 'INVALID_CURRENT_PASSWORD');
  });
});

test('repeated login failures return a retry contract without logging secrets', async () => {
  const securityEvents = [];
  const recordedEvents = [];
  const loginThrottle = new LoginThrottle({ policy: {
    account: { freeFailures: 10 },
    ip: { baseDelayMs: 5_000, freeFailures: 1, maxDelayMs: 5_000 },
  } });
  await withServer(async (baseUrl) => {
    await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify({ email: 'owner@example.com', name: 'Suite Owner', password: 'correct horse battery' }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const badLogin = () => fetch(`${baseUrl}/suite-manager/api/auth/login`, {
      body: JSON.stringify({ email: 'owner@example.com', password: 'definitely-wrong' }),
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.25' },
      method: 'POST',
    });

    assert.equal((await badLogin()).status, 401);
    assert.equal((await badLogin()).status, 401);
    const throttled = await badLogin();
    const body = await throttled.json();

    assert.equal(throttled.status, 429);
    assert.equal(throttled.headers.get('retry-after'), '5');
    assert.equal(body.code, 'LOGIN_THROTTLED');
    assert.deepEqual(securityEvents, [{
      clientFingerprint: securityEvents[0].clientFingerprint,
      event: 'login-throttled',
      retryAfterSeconds: 5,
    }]);
    assert.match(securityEvents[0].clientFingerprint, /^[a-f0-9]{12}$/u);
    assert.doesNotMatch(JSON.stringify(securityEvents), /owner@example|definitely-wrong/u);
    assert.equal(recordedEvents.length, 1);
    assert.equal(recordedEvents[0].subject, securityEvents[0].clientFingerprint);
    assert.equal(recordedEvents[0].eventType, 'login-throttled');
    assert.equal(recordedEvents[0].retryAfterSeconds, 5);
    assert.equal(Number.isNaN(Date.parse(recordedEvents[0].at)), false);
  }, {
    loginThrottle,
    securityEventRecorder: (event) => recordedEvents.push(event),
    securityLogger: (event) => securityEvents.push(event),
  });
});

test('duplicate owner creation returns conflict', async () => {
  await withServer(async (baseUrl) => {
    const owner = {
      email: 'owner@example.com',
      name: 'Suite Owner',
      password: 'correct horse battery',
    };

    await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify(owner),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });

    const duplicateResponse = await fetch(`${baseUrl}/suite-manager/api/setup/owner`, {
      body: JSON.stringify(owner),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const duplicate = await duplicateResponse.json();

    assert.equal(duplicateResponse.status, 409);
    assert.equal(duplicate.code, 'OWNER_ALREADY_EXISTS');
  });
});

test('HTTPS Settings API requires authentication and never returns the submitted token', async () => {
  const calls = [];
  const httpsAgent = {
    apply: async (input) => { calls.push(input); return { rollbackId: 'rollback-one' }; },
    commit: async () => ({ status: 'committed' }),
    rollback: async () => ({ status: 'rolled-back' }),
    status: async () => ({ capabilities: ['cloudflare-dns01.apply'] }),
  };
  const homepageAgent = {
    async read(file) { return { content: '[]', file, revision: 'sha256:current' }; },
    async reconcileUrls(input) { return { changed: false, entries: input.entries, file: 'services.template.yaml', revision: 'sha256:next' }; },
  };

  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/settings/https', { headers: { Host: 'home.test' } });
    assert.equal(denied.status, 401);

    const cookie = await createOwner(baseUrl);
    const token = 'cloudflare_token_1234567890';
    const applied = await hostRequest(baseUrl, '/suite-manager/api/settings/https/apply', {
      body: JSON.stringify({ acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com', cloudflareApiToken: token }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.json().homeUrl, 'https://home.mos.example.com/');
    assert.equal(applied.json().appReconciliation.status, 'applied');
    assert.doesNotMatch(applied.body, new RegExp(token, 'u'));

    const status = await hostRequest(baseUrl, '/suite-manager/api/settings/https', {
      headers: { Cookie: cookie, Host: 'home.mos.example.com' },
    });
    assert.equal(status.status, 200);
    assert.equal(status.json().baseDomain, 'mos.example.com');
    assert.equal(status.json().installContext, 'ssh-bootstrap');
    assert.equal(status.json().privateHttpsAvailable, true);
    assert.equal(status.json().tokenConfigured, true);
    assert.ok(Object.hasOwn(status.json(), 'serverAddress'));
    assert.doesNotMatch(status.body, new RegExp(token, 'u'));
    assert.equal(calls[0].cloudflareApiToken, token);
  }, { homeHost: 'home.test', homepageAgent, httpsAgent });
});

// Homepage serves one dashboard file to every visitor, so the tile cannot hold
// an address. This endpoint is what makes it door-agnostic, and it is also the
// one place a tile could become an open redirector if the target ever came from
// the request rather than from installed state.
test('a dashboard tile redirect resolves the app against the door it was reached through', async () => {
  const appAgent = {
    async apply(input) { return { publicUrl: input.publicUrl, status: 'applied', steps: [] }; },
  };
  const homepageAgent = {
    async addLink(input) { return { changed: true, file: 'services.template.yaml', id: input.requestId, revision: 'sha256:added' }; },
    async read(file) { return { content: '[]', file, revision: 'sha256:current' }; },
    async reconcileUrls() { return { changed: true, file: 'services.template.yaml', revision: 'sha256:reconciled' }; },
  };
  const httpsAgent = {
    apply: async () => ({ rollbackId: 'rollback-one' }),
    commit: async () => ({ status: 'committed' }),
    rollback: async () => ({ status: 'rolled-back' }),
    status: async () => ({ capabilities: ['cloudflare-dns01.apply'] }),
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    for (const action of ['install', 'apply-runtime']) {
      await hostRequest(baseUrl, `/suite-manager/api/apps/packages/stirling-pdf/${action}`, {
        headers: { Cookie: cookie, Host: 'home.test' },
        method: 'POST',
      });
    }
    const added = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/add-to-homepage', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    const instanceId = added.json().homepage.requestId;

    // Signed out on purpose: the app behind the tile does its own auth, and a
    // tile that only works for a signed-in owner is a broken tile.
    const firstDoor = await hostRequest(baseUrl, `/suite-manager/open/${instanceId}`, { headers: { Host: 'home.test' } });
    assert.equal(firstDoor.status, 302);
    assert.equal(firstDoor.headers.location, 'http://stirling-pdf.test/');

    await hostRequest(baseUrl, '/suite-manager/api/settings/https/apply', {
      body: JSON.stringify({
        acmeEmail: 'owner@example.com',
        baseDomain: 'mos.example.com',
        cloudflareApiToken: 'cloudflare_token_1234567890',
      }),
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Host: 'home.test' },
      method: 'POST',
    });

    // Same tile, second door, second answer — and neither was stamped anywhere.
    const secondDoor = await hostRequest(baseUrl, `/suite-manager/open/${instanceId}`, { headers: { Host: 'home.mos.example.com' } });
    assert.equal(secondDoor.status, 302);
    assert.equal(secondDoor.headers.location, 'https://stirling-pdf.mos.example.com/');

    const unknown = await hostRequest(baseUrl, '/suite-manager/open/00000000-0000-4000-8000-000000000000', { headers: { Host: 'home.test' } });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json().code, 'APP_NOT_INSTALLED');

    // Nothing that is not an instance id reaches the redirect at all.
    const steered = await hostRequest(baseUrl, '/suite-manager/open/evil.example.com', { headers: { Host: 'home.test' } });
    assert.equal(steered.headers.location, undefined);

    // The host gate still owns the door: an unknown host gets no app address.
    const unknownHost = await hostRequest(baseUrl, `/suite-manager/open/${instanceId}`, { headers: { Host: 'attacker.example.com' } });
    assert.equal(unknownHost.status, 421);
  }, { appAgent, homeHost: 'home.test', homepageAgent, httpsAgent });
});

test('HTTPS Settings apply reports partial app URL reconciliation without hiding HTTPS success', async () => {
  const calls = [];
  const appAgent = {
    async apply(input) {
      calls.push(['app', input.packageId, input.publicUrl]);
      if (input.publicUrl.startsWith('https://')) {
        throw Object.assign(new Error('route apply failed'), { code: 'APP_AGENT_ROUTE_FAILED' });
      }
      return { publicUrl: input.publicUrl, status: 'applied', steps: [] };
    },
  };
  const homepageAgent = {
    async addLink(input) {
      calls.push(['homepage-add', input.entry.url]);
      return { changed: true, file: 'services.template.yaml', id: input.requestId, revision: 'sha256:added' };
    },
    async read(file) {
      calls.push(['homepage-read', file]);
      return { content: '[]', file, revision: 'sha256:current' };
    },
    async reconcileUrls(input) {
      calls.push(['homepage-reconcile', input.entries]);
      return { changed: true, file: 'services.template.yaml', revision: 'sha256:reconciled' };
    },
  };
  const httpsAgent = {
    apply: async () => ({ rollbackId: 'rollback-one' }),
    commit: async () => ({ status: 'committed' }),
    rollback: async () => ({ status: 'rolled-back' }),
    status: async () => ({ capabilities: ['cloudflare-dns01.apply'] }),
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/stirling-pdf/add-to-homepage', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });

    const applied = await hostRequest(baseUrl, '/suite-manager/api/settings/https/apply', {
      body: JSON.stringify({
        acmeEmail: 'owner@example.com',
        baseDomain: 'mos.example.com',
        cloudflareApiToken: 'cloudflare_token_1234567890',
      }),
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Host: 'home.test' },
      method: 'POST',
    });

    assert.equal(applied.status, 200);
    assert.equal(applied.json().homeUrl, 'https://home.mos.example.com/');
    assert.equal(applied.json().appReconciliation.status, 'partial');
    assert.deepEqual(applied.json().appReconciliation.runtime, [{
      appHost: 'stirling-pdf.mos.example.com',
      errorCode: 'APP_AGENT_ROUTE_FAILED',
      packageId: 'stirling-pdf',
      publicUrl: 'https://stirling-pdf.mos.example.com/',
      status: 'failed',
    }]);
    // The tile carries no address to re-stamp: its href is derived from its own
    // id, so a domain change leaves it correct without touching it.
    const reconciled = calls.find((call) => call[0] === 'homepage-reconcile')[1];
    assert.equal(reconciled.length, 1);
    assert.deepEqual(Object.keys(reconciled[0]), ['id']);
    assert.ok(calls.findIndex((call) => call[0] === 'homepage-reconcile') < calls.findIndex((call) => call[0] === 'app' && call[2].startsWith('https://')));
  }, { appAgent, homeHost: 'home.test', homepageAgent, httpsAgent });
});

test('app package URLs use active DNS-01 HTTPS settings even without forwarded proto', async () => {
  const appCalls = [];
  const homepageCalls = [];
  const appAgent = {
    async apply(input) {
      appCalls.push(input);
      return { publicUrl: input.publicUrl, status: 'applied', steps: ['built', 'started', 'healthy'] };
    },
  };
  const homepageAgent = {
    async addLink(input) {
      homepageCalls.push(input);
      return { changed: true, file: 'services.template.yaml', id: input.requestId, revision: 'sha256:added' };
    },
    async read(file) {
      return { content: '[]', file, revision: 'sha256:current' };
    },
    async reconcileUrls() {
      return { changed: false, file: 'services.template.yaml', revision: 'sha256:current' };
    },
  };
  const httpsAgent = {
    apply: async () => ({ rollbackId: 'rollback-one' }),
    commit: async () => ({ status: 'committed' }),
    rollback: async () => ({ status: 'rolled-back' }),
    status: async () => ({ capabilities: ['cloudflare-dns01.apply'] }),
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const applied = await hostRequest(baseUrl, '/suite-manager/api/settings/https/apply', {
      body: JSON.stringify({
        acmeEmail: 'owner@example.com',
        baseDomain: 'mos.example.com',
        cloudflareApiToken: 'cloudflare_token_1234567890',
      }),
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(applied.status, 200);

    await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/install', {
      headers: { Cookie: cookie, Host: 'home.mos.example.com' },
      method: 'POST',
    });
    const runtime = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/apply-runtime', {
      headers: { Cookie: cookie, Host: 'home.mos.example.com' },
      method: 'POST',
    });
    const homepage = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/add-to-homepage', {
      headers: { Cookie: cookie, Host: 'home.mos.example.com' },
      method: 'POST',
    });

    assert.equal(runtime.status, 200);
    assert.equal(homepage.status, 200);
    assert.equal(appCalls[0].publicUrl, 'https://vaultwarden.mos.example.com/');
    assert.equal(homepageCalls[0].entry.url, 'https://vaultwarden.mos.example.com/');
  }, { appAgent, homeHost: 'home.test', homepageAgent, httpsAgent });
});

test('HTTPS Settings status marks cloud installs as provider-managed domain guidance', async () => {
  const httpsAgent = {
    apply: async () => { throw new Error('must not run'); },
    commit: async () => ({}),
    rollback: async () => ({}),
    status: async () => ({ capabilities: ['cloudflare-dns01.apply'] }),
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const status = await hostRequest(baseUrl, '/suite-manager/api/settings/https', {
      headers: { Cookie: cookie, Host: 'home.test' },
    });

    assert.equal(status.status, 200);
    assert.equal(status.json().installContext, 'cloud-init');
    assert.equal(status.json().privateHttpsAvailable, false);
  }, { frontDoor: 'cloud-init', homeHost: 'home.test', httpsAgent });
});

test('HTTPS Settings apply is blocked for cloud installs', async () => {
  const httpsAgent = {
    apply: async () => { throw new Error('must not run'); },
    commit: async () => ({}),
    rollback: async () => ({}),
    status: async () => ({ capabilities: ['cloudflare-dns01.apply'] }),
  };

  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const response = await hostRequest(baseUrl, '/suite-manager/api/settings/https/apply', {
      body: JSON.stringify({
        acmeEmail: 'owner@example.com',
        baseDomain: 'mos.example.com',
        cloudflareApiToken: 'abcdefghijklmnopqrstuvwxyz',
      }),
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Host: 'home.test' },
      method: 'POST',
    });

    assert.equal(response.status, 409);
    assert.equal(response.json().code, 'PRIVATE_HTTPS_UNAVAILABLE');
  }, { frontDoor: 'cloud-init', homeHost: 'home.test', httpsAgent });
});

test('HTTPS input validation is sanitized and leaves the bootstrap host active', async () => {
  const httpsAgent = {
    apply: async () => { throw new Error('must not run'); },
    commit: async () => {},
    rollback: async () => {},
    status: async () => ({ capabilities: ['cloudflare-dns01.apply'] }),
  };
  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const secret = 'secret-with-spaces-that-must-not-echo';
    const response = await hostRequest(baseUrl, '/suite-manager/api/settings/https/apply', {
      body: JSON.stringify({ acmeEmail: 'bad', baseDomain: 'localhost', cloudflareApiToken: secret }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(response.body, new RegExp(secret, 'u'));
    const bootstrap = await hostRequest(baseUrl, '/suite-manager/', { headers: { Host: 'home.test' } });
    assert.equal(bootstrap.status, 200);
  }, { homeHost: 'home.test', httpsAgent });
});

// An external source service backed by an isolated temp store and a fake
// download client, so the owner-only source routes are exercised without
// network access. A repository ending in `/hostile` makes the fake client reject
// the candidate the way the real constrained gate would.
async function externalSourcesFixture({ appPackages = null } = {}) {
  const revision = 'b'.repeat(40);
  const store = new SuiteManagerStore(await tempStateDir());
  const client = {
    async resolveRevision(record) { return { ...record, revision }; },
    async downloadCandidate(record) {
      if (record.repository.endsWith('/hostile')) throw new ExternalSourceError('CANDIDATE_REJECTED', 'External candidate failed validation: manifest.privileged is not permitted.');
      const packageId = 'community-notes';
      return {
        cleanup: () => {},
        manifest: { id: packageId, version: '1.0.0' },
        namespacedPackageId: `x-abcdef01-${packageId}`,
        packageId,
        permissions: ['route:notes', 'volume:notes-data'],
        source: { kind: 'external-git', path: '.mos', repository: record.repository, revision, trust: record.trust },
        trust: record.trust,
      };
    },
  };
  const service = new ExternalSourceService({ appPackages, client, now: () => new Date('2026-07-15T10:00:00.000Z'), officialPackageIds: ['immich'], platformVersion: '0.11.0', store });
  return { service, store };
}

test('owner-only external source routes require authentication', async () => {
  const { service, store } = await externalSourcesFixture();
  await withServer(async (baseUrl) => {
    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/sources', { headers: { Host: 'home.test' } });
    assert.equal(denied.status, 401);
    assert.equal(denied.json().code, 'AUTH_REQUIRED');
  }, { externalSources: service, homeHost: 'home.test' });
  store.close();
});

test('an owner adds, previews, lists, and removes an external package source', async () => {
  const { service, store } = await externalSourcesFixture();
  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const headers = { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' };

    const added = await hostRequest(baseUrl, '/suite-manager/api/apps/sources', {
      body: JSON.stringify({ catalogPath: 'apps', publisher: 'community', repository: 'https://github.com/community/apps', trust: 'unverified' }),
      headers, method: 'POST',
    });
    assert.equal(added.status, 201);
    const source = added.json().source;
    assert.equal(source.trust, 'unverified');
    assert.equal(source.mosReviewed, false);
    assert.equal(source.official, false);
    assert.equal(source.revision, 'b'.repeat(40));

    const listed = await hostRequest(baseUrl, '/suite-manager/api/apps/sources', { headers: { Cookie: cookie, Host: 'home.test' } });
    assert.deepEqual(listed.json().sources.map((item) => item.id), [source.id]);

    const preview = await hostRequest(baseUrl, `/suite-manager/api/apps/sources/${source.id}/preview`, { headers, method: 'POST' });
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.json().candidate.permissions, ['route:notes', 'volume:notes-data']);
    assert.equal(preview.json().candidate.mosReviewed, false);

    const removed = await hostRequest(baseUrl, `/suite-manager/api/apps/sources/${source.id}/remove`, { headers, method: 'POST' });
    assert.equal(removed.status, 200);
    assert.equal(removed.json().keepsSnapshots, true);
    assert.equal(removed.json().source.status, 'removed');
  }, { externalSources: service, homeHost: 'home.test' });
  store.close();
});

test('pasting a package URL resolves an external card without persisting a source', async () => {
  const { service, store } = await externalSourcesFixture();
  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const headers = { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' };
    const resolved = await hostRequest(baseUrl, '/suite-manager/api/apps/sources/resolve', {
      body: JSON.stringify({ url: 'https://github.com/community/community-notes' }), headers, method: 'POST',
    });
    assert.equal(resolved.status, 200);
    const payload = resolved.json();
    assert.equal(payload.card.external, true);
    assert.equal(payload.card.trust, 'unverified');
    assert.equal(payload.card.mosReviewed, false);
    assert.equal(payload.source.packageId, 'community-notes');

    const listed = await hostRequest(baseUrl, '/suite-manager/api/apps/sources', { headers: { Cookie: cookie, Host: 'home.test' } });
    assert.deepEqual(listed.json().sources, []); // preview persists nothing

    const badUrl = await hostRequest(baseUrl, '/suite-manager/api/apps/sources/resolve', {
      body: JSON.stringify({ url: 'https://gitlab.com/community/notes' }), headers, method: 'POST',
    });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.json().code, 'SOURCE_URL_INVALID');
  }, { externalSources: service, homeHost: 'home.test' });
  store.close();
});

test('an owner installs a pasted package URL, and only then is the source recorded', async () => {
  const installs = [];
  const { service, store } = await externalSourcesFixture({
    appPackages: {
      async installExternalPackage(input) {
        installs.push(input);
        return { id: 'instance-1', packageId: input.candidate.namespacedPackageId, status: 'installed' };
      },
    },
  });
  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const headers = { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' };

    const denied = await hostRequest(baseUrl, '/suite-manager/api/apps/sources/install', {
      body: JSON.stringify({ url: 'https://github.com/community/community-notes' }),
      headers: { 'Content-Type': 'application/json', Host: 'home.test' }, method: 'POST',
    });
    assert.equal(denied.status, 401);
    assert.deepEqual(installs, []);

    const installed = await hostRequest(baseUrl, '/suite-manager/api/apps/sources/install', {
      body: JSON.stringify({ config: { adminEmail: 'owner@example.com' }, url: 'https://github.com/community/community-notes' }),
      headers, method: 'POST',
    });
    assert.equal(installed.status, 201);
    const payload = installed.json();
    assert.equal(payload.mosReviewed, false);
    assert.equal(payload.trust, 'unverified');
    assert.match(payload.packageId, /^x-[a-f0-9]{8}-community-notes$/u);
    assert.equal(payload.instance.packageId, payload.packageId);
    assert.deepEqual(installs.map((item) => item.input), [{ adminEmail: 'owner@example.com' }]);

    const listed = await hostRequest(baseUrl, '/suite-manager/api/apps/sources', { headers: { Cookie: cookie, Host: 'home.test' } });
    assert.deepEqual(listed.json().sources.map((item) => [item.repository, item.trust, item.mosReviewed]), [['https://github.com/community/community-notes', 'unverified', false]]);

    // A candidate the gate rejects installs nothing and registers no source.
    const hostile = await hostRequest(baseUrl, '/suite-manager/api/apps/sources/install', {
      body: JSON.stringify({ url: 'https://github.com/community/hostile' }), headers, method: 'POST',
    });
    assert.equal(hostile.status, 422);
    assert.equal(installs.length, 1);
    const stillListed = await hostRequest(baseUrl, '/suite-manager/api/apps/sources', { headers: { Cookie: cookie, Host: 'home.test' } });
    assert.equal(stillListed.json().sources.length, 1);
  }, { externalSources: service, homeHost: 'home.test' });
  store.close();
});

test('external source routes reject a bad URL as 400 and a hostile candidate as 422', async () => {
  const { service, store } = await externalSourcesFixture();
  await withServer(async (baseUrl) => {
    const cookie = await createOwner(baseUrl);
    const headers = { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' };

    const badUrl = await hostRequest(baseUrl, '/suite-manager/api/apps/sources', {
      body: JSON.stringify({ repository: 'http://github.com/community/apps', trust: 'unverified' }), headers, method: 'POST',
    });
    assert.equal(badUrl.status, 400);
    assert.equal(badUrl.json().code, 'SOURCE_URL_INVALID');

    const added = await hostRequest(baseUrl, '/suite-manager/api/apps/sources', {
      body: JSON.stringify({ repository: 'https://github.com/community/hostile', trust: 'unverified' }), headers, method: 'POST',
    });
    const hostile = await hostRequest(baseUrl, `/suite-manager/api/apps/sources/${added.json().source.id}/preview`, { headers, method: 'POST' });
    assert.equal(hostile.status, 422);
    assert.equal(hostile.json().code, 'CANDIDATE_REJECTED');

    const missing = await hostRequest(baseUrl, '/suite-manager/api/apps/sources/src-does-not-exist/remove', { headers, method: 'POST' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json().code, 'SOURCE_NOT_FOUND');
  }, { externalSources: service, homeHost: 'home.test' });
  store.close();
});

test('session cookies become Secure only for HTTPS forwarded requests', async () => {
  await withServer(async (baseUrl) => {
    const httpResponse = await hostRequest(baseUrl, '/suite-manager/api/setup/owner', {
      body: JSON.stringify({ email: 'owner@example.com', name: 'Owner', password: 'correct horse battery' }),
      headers: { 'Content-Type': 'application/json', Host: 'home.test' },
      method: 'POST',
    });
    assert.doesNotMatch(httpResponse.headers['set-cookie'][0], /; Secure/u);

    const httpsLogin = await hostRequest(baseUrl, '/suite-manager/api/auth/login', {
      body: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' }),
      headers: { 'Content-Type': 'application/json', Host: 'home.test', 'X-Forwarded-Proto': 'https' },
      method: 'POST',
    });
    assert.match(httpsLogin.headers['set-cookie'][0], /; Secure/u);
  }, { homeHost: 'home.test' });
});
