const assert = require('node:assert/strict');
const test = require('node:test');

const { withRoutes } = require('./support/route-harness.cjs');

test('the email relay is read, saved, tested and removed through the settings service', async () => {
  const calls = [];
  const smtpSettings = {
    remove: () => { calls.push(['remove']); return { configured: false }; },
    save: async (input) => { calls.push(['save', input]); return { configured: true }; },
    sendTest: async (input) => { calls.push(['test', input]); return { sent: true }; },
    status: () => ({ configured: false }),
  };
  const relay = { host: 'smtp.example.com', password: 'relay-secret', port: 587, security: 'starttls', username: 'mos' };

  await withRoutes({ smtpSettings }, async (call) => {
    assert.deepEqual((await call('GET', '/settings/smtp')).json(), { configured: false });
    assert.deepEqual((await call('POST', '/settings/smtp', { body: relay })).json(), { configured: true });
    assert.deepEqual((await call('POST', '/settings/smtp/test', { body: { subject: 'smuggled', to: 'owner@example.com' } })).json(), { sent: true });
    assert.deepEqual((await call('DELETE', '/settings/smtp')).json(), { configured: false });
    assert.equal((await call('PUT', '/settings/smtp', { body: relay })).status, 404);
  });

  assert.deepEqual(calls, [['save', relay], ['test', { to: 'owner@example.com' }], ['remove']]);
});
