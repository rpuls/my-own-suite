const assert = require('node:assert/strict');
const test = require('node:test');

const { HttpsAgentCore } = require('./agent-core.cjs');

function adapter({ failAt = '' } = {}) {
  const calls = [];
  const make = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    if (failAt === name) throw new Error('sensitive upstream failure');
    return result;
  };
  return {
    calls,
    createCheckpoint: make('createCheckpoint'),
    hasCloudflareModule: make('hasCloudflareModule', true),
    installCandidate: make('installCandidate'),
    reload: make('reload'),
    reloadPrevious: make('reloadPrevious'),
    removeCheckpoint: make('removeCheckpoint'),
    restoreCheckpoint: make('restoreCheckpoint'),
    validateCandidate: make('validateCandidate'),
    verifyCloudflareAccess: make('verifyCloudflareAccess'),
  };
}

const validInput = {
  acmeEmail: 'owner@example.com',
  baseDomain: 'mos.example.com',
  bootstrapHost: 'home.203.0.113.5.sslip.io',
  cloudflareApiToken: 'token_value_1234567890',
};

test('agent applies only rendered configuration and returns an opaque rollback id', async () => {
  const fake = adapter();
  const result = await new HttpsAgentCore(fake).apply(validInput);
  assert.match(result.rollbackId, /^[0-9a-f-]{36}$/u);
  const candidate = fake.calls.find(([name]) => name === 'installCandidate')[1];
  assert.match(candidate.caddyfile, /home\.mos\.example\.com/u);
  assert.match(candidate.caddyfile, /reverse_proxy 127\.0\.0\.1:3100/u);
  assert.doesNotMatch(candidate.caddyfile, /\$MOS_V2_SUITE_MANAGER_PORT/u);
  assert.doesNotMatch(candidate.caddyfile, /token_value/u);
  assert.equal(candidate.cloudflareApiToken, validInput.cloudflareApiToken);
});

test('agent restores and reloads the checkpoint when candidate validation fails', async () => {
  const fake = adapter({ failAt: 'validateCandidate' });
  await assert.rejects(() => new HttpsAgentCore(fake).apply(validInput), /HTTPS_APPLY_FAILED/u);
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.indexOf('restoreCheckpoint') > names.indexOf('validateCandidate'));
  assert.ok(names.indexOf('reloadPrevious') > names.indexOf('restoreCheckpoint'));
  assert.ok(names.includes('removeCheckpoint'));
});

test('agent rejects malformed tokens before creating a checkpoint', async () => {
  const fake = adapter();
  await assert.rejects(() => new HttpsAgentCore(fake).apply({ ...validInput, cloudflareApiToken: 'bad token' }));
  assert.equal(fake.calls.some(([name]) => name === 'createCheckpoint'), false);
});
