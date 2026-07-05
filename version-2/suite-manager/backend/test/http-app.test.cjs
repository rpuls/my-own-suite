const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { HOMEPAGE_AGENT_TIMEOUT_MS } = require('../src/homepage/homepage-agent-client.cjs');
const { loopbackPortFor } = require('../src/apps/app-package-service.cjs');

const { createV2Server } = require('../src/server/http-app.cjs');

async function tempStateDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mos-v2-http-'));
}

async function tempFrontendDistDir() {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-v2-frontend-'));
  await fs.mkdir(path.join(distDir, 'assets'), { recursive: true });
  await fs.mkdir(path.join(distDir, 'brand'), { recursive: true });
  await fs.writeFile(
    path.join(distDir, 'index.html'),
    '<!doctype html><html><head><title>Suite Manager | My Own Suite</title><script type="module" src="./assets/index.js"></script></head><body><div id="root"></div></body></html>',
  );
  await fs.writeFile(path.join(distDir, 'assets', 'index.js'), 'console.log("mos v2 app");\n');
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
  const server = createV2Server({
    frontendDistDir: await tempFrontendDistDir(),
    homeHost: '127.0.0.1',
    stateDir: await tempStateDir(),
    ...options,
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

test('static frontend assets are served from the reserved asset namespace', async () => {
  await withServer(async (baseUrl) => {
    const scriptResponse = await fetch(`${baseUrl}/suite-manager/assets/assets/index.js`);
    const script = await scriptResponse.text();
    const brandResponse = await fetch(`${baseUrl}/suite-manager/assets/brand/my-own-suite-mark.png`);

    assert.equal(scriptResponse.status, 200);
    assert.match(script, /mos v2 app/);
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
    assert.deepEqual(radicale.routes, [{ host: 'radicale', port: 5232, service: 'radicale' }]);
    assert.equal(radicale.health.url, 'http://radicale:5232/');
    assert.deepEqual(radicale.setup.fields, [
      {
        default: 'admin',
        generated: false,
        id: 'adminUsername',
        label: 'Radicale username',
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
    assert.equal(radicale.homepage.widget.integrations[0].url, '${app.publicUrl}__mos-v2/ical/${secret.icalToken}');
    assert.ok(stirling);
    assert.equal(stirling.name, 'Stirling PDF');
    assert.equal(stirling.installStatus, 'not-installed');
    assert.equal(stirling.validation.valid, true);
    assert.equal(stirling.setup.fieldCount, 0);
    assert.equal(stirling.icon, 'icon.png');
    assert.equal(stirling.iconUrl, '/suite-manager/api/apps/packages/stirling-pdf/icon');
    assert.deepEqual(stirling.routes, [{ host: 'stirling-pdf', port: 8080, service: 'stirling-pdf' }]);
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
    assert.equal(vaultwarden.onboarding.steps.length, 2);
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

test('Backup inventory API requires auth and reports V2 protected state', async () => {
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
    assert.deepEqual(vaultwarden.declaredVolumes.map((volume) => volume.dockerVolume), ['mos-v2-app-vaultwarden-data']);
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
          changeSummary: { items: ['Managed update support.'], source: 'CHANGELOG.md [Unreleased]', title: 'Upcoming V2 lab changes' },
          checkedAt: '2026-07-05T12:00:00.000Z',
          latestRevision: 'abc123',
          track: { currentBranch: 'feat/app-platform-v2-lab', currentCommit: 'def456', label: 'V2 lab branch', ref: 'feat/app-platform-v2-lab', type: 'branch' },
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
    assert.equal(status.json().appRuntimeReconciliation.automatic, false);

    const track = await hostRequest(baseUrl, '/suite-manager/api/updates/track', {
      body: JSON.stringify({ track: 'staging' }),
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(track.status, 200);

    const started = await hostRequest(baseUrl, '/suite-manager/api/updates/start', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(started.status, 202);
    assert.equal(started.json().job.id, 'job-one');
    assert.deepEqual(calls.filter((call) => call[0] !== 'status'), [
      ['track', { ref: 'feat/app-platform-v2-lab', track: 'branch' }],
      ['start', { initiator: 'owner@example.com', target: 'latest' }],
    ]);
  }, { homeHost: 'home.test', updateAgent });
});

test('Backup API proxies simple owner backup, restore, and download actions', async () => {
  const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mos-v2-backup-bundle-'));
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
      ['backup', { destinationId: '/media/backup' }],
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
      body: JSON.stringify({ config: { adminPassword: password, adminUsername: 'calendar-admin' } }),
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
    assert.equal(caddy.routes[0].internalIcalBridge.path, '/__mos-v2/ical/${secret.icalToken}');
    assert.equal(caddy.routes[0].internalIcalBridge.basicAuth.password, '${secret.adminPassword}');
    assert.equal(homepage.widget.integrations[0].url, '${app.publicUrl}__mos-v2/ical/${secret.icalToken}');
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
    assert.match(calls[0].caddy.routes[0].internalIcalBridge.path, /^\/__mos-v2\/ical\/[A-Za-z0-9_-]{40,}$/u);
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
      body: JSON.stringify({ config: { adminPassword: password, adminUsername: 'calendar-admin' } }),
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
    assert.match(add.entry.widget.integrations[0].url, /^https:\/\/radicale\.test\/__mos-v2\/ical\/[A-Za-z0-9_-]{40,}$/u);
    assert.doesNotMatch(JSON.stringify(add.entry), new RegExp(password, 'u'));
    assert.doesNotMatch(applied.body, new RegExp(add.entry.widget.integrations[0].url.split('/').at(-1), 'u'));
  }, { appAgent, homeHost: 'home.test', homepageAgent });
});

test('app lifecycle stop, start, restart, and uninstall preserve metadata while managing runtime and Homepage shortcut', async () => {
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
    assert.equal(uninstalled.json().instance.status, 'uninstalled');
    assert.equal(uninstalled.json().instance.enabled, false);
    assert.equal(uninstalled.json().instance.id, instanceId);
    assert.equal(uninstalled.json().instance.config.find((item) => item.key === 'adminToken').fingerprint, fingerprint);
    assert.equal(appCalls.map((call) => call[0]).join(','), 'apply,stop,apply,apply,remove');
    assert.equal(homepageCalls.some((call) => call[0] === 'removeLink' && call[1].id === instanceId), true);
    assert.doesNotMatch(JSON.stringify(appCalls), /volume rm|rmi/u);

    const reinstall = await hostRequest(baseUrl, '/suite-manager/api/apps/packages/vaultwarden/install', {
      headers: { Cookie: cookie, Host: 'home.test' },
      method: 'POST',
    });
    assert.equal(reinstall.status, 409);
    assert.equal(reinstall.json().code, 'APP_PREVIOUSLY_UNINSTALLED');
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
      status: 'needs-owner',
    });
  });
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
    assert.match(cookie, /mos_v2_session=/);

    const statusResponse = await fetch(`${baseUrl}/suite-manager/api/setup/status`, {
      headers: { Cookie: cookie },
    });
    const status = await statusResponse.json();

    assert.equal(status.status, 'signed-in');
    assert.equal(status.owner.email, 'owner@example.com');
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
    assert.match(cookie, /mos_v2_session=/);

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
  }, { homeHost: 'home.test', httpsAgent });
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
