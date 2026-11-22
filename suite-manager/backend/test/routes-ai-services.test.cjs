const assert = require('node:assert/strict');
const test = require('node:test');

const { withRoutes } = require('./support/route-harness.cjs');

const ID = '11111111-2222-3333-4444-555555555555';

test('AI services are listed, added, tested, edited, given to apps and removed through the service', async () => {
  const calls = [];
  const aiServices = {
    add: async (input) => { calls.push(['add', input]); return { added: true }; },
    check: async (input) => { calls.push(['check', input]); return { models: ['m'] }; },
    remove: async (id) => { calls.push(['remove', id]); return { removed: true }; },
    setAppService: async (packageId, serviceId) => { calls.push(['app', packageId, serviceId]); return { set: true }; },
    status: () => ({ services: [] }),
    test: async (input) => { calls.push(['test', input]); return { ms: 5 }; },
    testStored: async (id) => { calls.push(['testStored', id]); return { ok: true }; },
    update: async (id, input) => { calls.push(['update', id, input]); return { updated: true }; },
  };
  const service = { baseUrl: 'http://pc/v1', model: 'm', name: 'Office PC' };

  await withRoutes({ aiServices }, async (call) => {
    assert.deepEqual((await call('GET', '/settings/ai-services')).json(), { services: [] });
    assert.deepEqual((await call('POST', '/settings/ai-services', { body: service })).json(), { added: true });
    assert.deepEqual((await call('POST', '/settings/ai-services/check', { body: service })).json(), { models: ['m'] });
    assert.deepEqual((await call('POST', '/settings/ai-services/test', { body: service })).json(), { ms: 5 });
    assert.deepEqual((await call('PUT', `/settings/ai-services/${ID}`, { body: service })).json(), { updated: true });
    assert.deepEqual((await call('POST', `/settings/ai-services/${ID}/test`)).json(), { status: { services: [] }, test: { ok: true } });
    assert.deepEqual((await call('PUT', '/settings/ai-services/apps/paperless-ngx', { body: { serviceId: ID } })).json(), { set: true });
    assert.deepEqual((await call('PUT', '/settings/ai-services/apps/paperless-ngx', { body: { serviceId: null } })).json(), { set: true });
    assert.deepEqual((await call('DELETE', `/settings/ai-services/${ID}`)).json(), { removed: true });
    assert.equal((await call('GET', '/settings/ai-services', { signedIn: false })).status, 401);
  });

  assert.deepEqual(calls, [
    ['add', service], ['check', service], ['test', service], ['update', ID, service], ['testStored', ID],
    ['app', 'paperless-ngx', ID], ['app', 'paperless-ngx', null], ['remove', ID],
  ]);
});
