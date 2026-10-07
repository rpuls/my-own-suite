const assert = require('node:assert/strict');
const test = require('node:test');

const { withRoutes } = require('./support/route-harness.cjs');

test('lab reset endpoint is disabled unless explicitly enabled by the install', async () => {
  await withRoutes({ disposableLab: false }, async (call) => {
    for (const [method, routePath] of [['POST', '/lab/reset'], ['GET', '/lab/reset/reset-one']]) {
      const response = await call(method, routePath, { signedIn: false });
      assert.equal(response.status, 404);
      assert.equal(response.json().code, 'LAB_RESET_DISABLED');
    }
  });
});

test('lab reset endpoint schedules the narrow lab agent when enabled', async () => {
  const calls = [];
  const labResetAgent = {
    async reset(input) {
      calls.push(input);
      return { resetId: 'reset-one', scheduled: true };
    },
  };

  await withRoutes({ disposableLab: true, labResetAgent }, async (call) => {
    const response = await call('POST', '/lab/reset', { signedIn: false });

    assert.equal(response.status, 202);
    assert.deepEqual(response.json(), { resetId: 'reset-one', scheduled: true });
    assert.match(String(response.headers['set-cookie']), /mos_session=/u);
  });

  assert.deepEqual(calls, [{ reason: 'hyperv-e2e' }]);
});

test('lab reset status endpoint proxies the scheduled reset job when enabled', async () => {
  const labResetAgent = {
    async resetStatus(resetId) {
      assert.equal(resetId, 'reset-one');
      return { resetId, status: 'completed' };
    },
  };

  await withRoutes({ disposableLab: true, labResetAgent }, async (call) => {
    const response = await call('GET', '/lab/reset/reset-one', { signedIn: false });

    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { resetId: 'reset-one', status: 'completed' });
  });
});
