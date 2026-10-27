const assert = require('node:assert/strict');
const test = require('node:test');

const { addressForHost } = require('../../../shared/suite-address.cjs');
const { HOMEPAGE_AGENT_TIMEOUT_MS } = require('../src/homepage/homepage-agent-client.cjs');
const { HomepageService } = require('../src/homepage/homepage-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

function homepageConfig(agent, appHosts = () => new Map()) {
  const store = {
    completeHomepageOperation() {},
    failHomepageOperation() {},
    recordHomepageRevision() {},
    startHomepageOperation() {},
  };
  return new HomepageService({ agent, appHosts, store, suiteAddress: { read: () => addressForHost('home.test') } });
}

test('a home service cannot take the address an installed app is served at', async () => {
  const config = homepageConfig({ async addHomeService() { throw new Error('should not be called'); } }, () => new Map([['jellyfin', 'Jellyfin']]));
  assert.throws(() => config.add({ entry: { subdomain: 'Jellyfin' } }, true), (error) => error.code === 'DUPLICATE_PUBLIC_HOST' && /Jellyfin's address/u.test(error.message));
  await assert.rejects(config.previewHomeService({ host: '192.168.1.3', port: 8096, protocol: 'http', subdomain: 'jellyfin' }), { code: 'DUPLICATE_PUBLIC_HOST' });
});

test('Homepage customization APIs require authentication and pass only structured operations', async () => {
  const calls = [];
  const homepageAgent = {
    async status() { calls.push(['status']); return { capabilities: ['homepage.apply'] }; },
    async read(file) { calls.push(['read', file]); return { content: '- Links: []\n', file, revision: 'sha256:current' }; },
  };

  await withRoutes({ homepageConfig: homepageConfig(homepageAgent) }, async (call) => {
    const denied = await call('POST', '/customize/file/read', { body: { file: 'services.template.yaml' }, signedIn: false });
    assert.equal(denied.status, 401);
    assert.equal(calls.length, 0);

    const status = await call('GET', '/customize/status');
    const read = await call('POST', '/customize/file/read', { body: { file: 'services.template.yaml' } });

    assert.equal(status.status, 200);
    assert.deepEqual(status.json().files, ['bookmarks.yaml', 'services.template.yaml', 'settings.yaml', 'widgets.yaml']);
    assert.equal(read.status, 200);
  });

  assert.deepEqual(calls, [['status'], ['read', 'services.template.yaml']]);
});

const JELLYFIN_LINK = `- Home services:
    - NAS Jellyfin:
        href: https://jellyfin.home.test/
        mos: { id: 0b5c1f3e-8a2d-4c6b-9e1f-2a3b4c5d6e7f, managedBy: user, proxy: { subdomain: " Jellyfin", upstream: "http://192.168.1.3:8096" } }
`;

test('the address preview refuses a subdomain another Homepage link already holds', async () => {
  const config = homepageConfig({ async read() { return { content: JELLYFIN_LINK, file: 'services.template.yaml', revision: 'r1' }; } });
  await assert.rejects(config.previewHomeService({ host: '192.168.1.4', port: 80, protocol: 'http', subdomain: 'jellyfin' }), (error) => error.code === 'DUPLICATE_PUBLIC_HOST' && /NAS Jellyfin/u.test(error.message));
});

test('a raw save of the services file cannot put a link on the address of an installed app', async () => {
  const config = homepageConfig({ async apply() { throw new Error('should not be called'); } }, () => new Map([['jellyfin', 'Jellyfin']]));
  await assert.rejects(config.apply({ content: JELLYFIN_LINK, expectedRevision: 'r1', file: 'services.template.yaml' }), { code: 'DUPLICATE_PUBLIC_HOST' });
});

test('the addresses Homepage links hold are read from the services file, by link name', async () => {
  const content = `- Home services:
    - NAS Jellyfin:
        href: https://jellyfin.home.test/
        mos: { id: 0b5c1f3e-8a2d-4c6b-9e1f-2a3b4c5d6e7f, managedBy: user, proxy: { subdomain: jellyfin, upstream: "http://192.168.1.3:8096" } }
    - Router:
        href: http://192.168.1.1/
`;
  const config = homepageConfig({ async read() { return { content, file: 'services.template.yaml', revision: 'r1' }; } });
  assert.deepEqual([...await config.homeServiceHosts()], [['jellyfin', 'NAS Jellyfin']]);
});

test('anything else under customize asks for a session before it is not found', async () => {
  await withRoutes({}, async (call) => {
    assert.equal((await call('GET', '/customize/unknown', { signedIn: false })).status, 401);
    assert.equal((await call('GET', '/customize/unknown')).status, 404);
    assert.equal((await call('POST', '/customize/status', { body: {} })).status, 404);
  });
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

  await withRoutes({ homepageConfig: homepageConfig(homepageAgent) }, async (call) => {
    const response = await call('POST', '/customize/file/apply', {
      body: { content: '- Links: []\n', expectedRevision: 'sha256:current', file: 'services.template.yaml' },
    });

    assert.equal(response.status, 502);
    assert.deepEqual(response.json(), {
      code: 'HOMEPAGE_RESTART_FAILED',
      error: 'Homepage did not restart successfully.',
    });
  });
});
