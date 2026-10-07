const assert = require('node:assert/strict');
const test = require('node:test');

const { addressForHost } = require('../../../shared/suite-address.cjs');
const { HOMEPAGE_AGENT_TIMEOUT_MS } = require('../src/homepage/homepage-agent-client.cjs');
const { HomepageService } = require('../src/homepage/homepage-service.cjs');
const { withRoutes } = require('./support/route-harness.cjs');

function homepageConfig(agent) {
  const store = {
    completeHomepageOperation() {},
    failHomepageOperation() {},
    recordHomepageRevision() {},
    startHomepageOperation() {},
  };
  return new HomepageService({ agent, store, suiteAddress: { read: () => addressForHost('home.test') } });
}

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
