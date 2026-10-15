const assert = require('node:assert/strict');
const test = require('node:test');

const { withRoutes } = require('./support/route-harness.cjs');

function supportServices(diagnosticsAgent) {
  return {
    appAgent: { status: async () => ({}) },
    appPackages: { secretDir: undefined },
    catalogService: { platformVersion: '0.22.0', status: () => null },
    diagnosticsAgent,
    frontDoor: 'usb-autoinstall',
    homeHost: 'home.test',
    setup: { store: { getAddressChange: () => ({ status: 'never' }), getAppInstances: () => [] } },
    suiteAddress: { readOrNull: () => null },
    updates: { status: async () => null },
  };
}

test('the diagnostics export is one downloadable text file that leads with the problem', async () => {
  const diagnosticsAgent = {
    async collect() {
      return {
        collectedAt: '2026-09-01T12:00:00.000Z',
        containers: [{ image: 'mos-app-example:1', labels: {}, log: 'boom', name: 'mos-app-example', state: 'exited', status: 'Exited (1)', troubled: true }],
        host: {},
        incomplete: [],
        units: [{ active: 'active', enabled: 'enabled', log: 'ready', name: 'mos-suite-manager.service', sub: 'running', troubled: false }],
      };
    },
  };

  await withRoutes(supportServices(diagnosticsAgent), async (call) => {
    const response = await call('GET', '/support/bundle');

    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^text\/plain/u);
    assert.match(response.headers['content-disposition'], /^attachment; filename="mos-diagnostics-[\d-]+\.txt"$/u);
    assert.ok(response.body.startsWith('MY OWN SUITE — DIAGNOSTICS'));
    assert.ok(response.body.includes('WHAT LOOKS WRONG'));
    assert.ok(response.body.includes('COLLECTION NOTES'));
  });
});

// The owner asking for this file is the one most likely to have a machine too
// broken to answer, so an unreachable agent is a line in the file, not an error.
test('the diagnostics export still produces a file when the agent is unreachable', async () => {
  const diagnosticsAgent = {
    async collect() {
      throw Object.assign(new Error('The diagnostics system agent is unavailable.'), { code: 'DIAGNOSTICS_AGENT_UNAVAILABLE' });
    },
  };

  await withRoutes(supportServices(diagnosticsAgent), async (call) => {
    const response = await call('GET', '/support/bundle');

    assert.equal(response.status, 200);
    assert.ok(response.body.includes('diagnostics agent unreachable (DIAGNOSTICS_AGENT_UNAVAILABLE)'));
    assert.ok(response.body.includes('Some information could not be collected'));
  });
});
