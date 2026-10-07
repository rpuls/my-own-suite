const assert = require('node:assert/strict');
const test = require('node:test');

const { withRoutes } = require('./support/route-harness.cjs');

test('the address routes hand the status, a change and a dismissed offer to the address service', async () => {
  const calls = [];
  const addressService = {
    allowedHosts: () => new Set(['home.test']),
    change: async (input) => { calls.push(['change', input]); return { status: 'applying' }; },
    dismissOffer: async () => { calls.push(['dismiss']); return { dismissed: true }; },
    httpsRedirectFor: () => null,
    status: async () => ({ address: { url: 'http://home.test/' } }),
  };
  const change = { acmeEmail: 'owner@example.com', baseDomain: 'mos.example.com', cloudflareApiToken: 'cloudflare_token_1234567890', kind: 'domain' };

  await withRoutes({ addressService }, async (call) => {
    assert.deepEqual((await call('GET', '/settings/address')).json(), { address: { url: 'http://home.test/' } });
    const started = await call('POST', '/settings/address/change', { body: change });
    assert.equal(started.status, 202);
    assert.deepEqual(started.json(), { status: 'applying' });
    assert.deepEqual((await call('POST', '/settings/address/offer/dismiss')).json(), { dismissed: true });
  });

  assert.deepEqual(calls, [['change', change], ['dismiss']]);
});
