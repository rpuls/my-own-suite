// The host gate is what turns the Easy Door from a name that resolves into a
// name the machine answers on: DNS already points a browser here, and Suite
// Manager returns 421 for every host it does not recognise.

const assert = require('node:assert/strict');
const test = require('node:test');

const { HttpsSettingsService } = require('../src/settings/https-settings-service.cjs');

function service({ address = '192.168.123.45', settings = {} } = {}) {
  return new HttpsSettingsService({
    agent: {},
    bootstrapHost: 'home.mos.home',
    detectAddress: () => address,
    store: {
      getHttpsSettings: () => ({ baseDomain: null, pendingBaseDomain: null, tlsMode: 'none', ...settings }),
    },
  });
}

test('a private LAN address answers on its Easy Door name as well as the Stealth one', () => {
  const hosts = service().allowedHosts();

  assert.equal(hosts.has('home.192-168-123-45.local.myownsuite.org'), true);
  assert.equal(hosts.has('home.mos.home'), true);
});

test('a public address gets no Easy Door name, which is what keeps cloud installs out', () => {
  assert.deepEqual([...service({ address: '203.0.113.10' }).allowedHosts()], ['home.mos.home']);
  assert.deepEqual([...service({ address: null }).allowedHosts()], ['home.mos.home']);
});

test('applying a real domain with DNS-01 closes the Easy Door name for good', () => {
  const hosts = service({
    settings: { baseDomain: 'mos.example.com', tlsMode: 'cloudflare-dns01' },
  }).allowedHosts();

  assert.deepEqual([...hosts], ['home.mos.home', 'home.mos.example.com']);
  assert.equal(hosts.has('home.192-168-123-45.local.myownsuite.org'), false);
});

test('a domain waiting to be applied is still reachable alongside the Easy Door', () => {
  const hosts = service({ settings: { pendingBaseDomain: 'mos.example.com' } }).allowedHosts();

  assert.deepEqual(
    [...hosts],
    ['home.mos.home', 'home.mos.example.com', 'home.192-168-123-45.local.myownsuite.org'],
  );
});
