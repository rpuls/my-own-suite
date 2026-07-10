const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    waitForPublicRoute: make('waitForPublicRoute'),
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
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.indexOf('waitForPublicRoute') > names.indexOf('reload'));
  assert.equal(fake.calls.find(([name]) => name === 'waitForPublicRoute')[1], 'https://home.mos.example.com/');
});

test('agent restores and reloads the checkpoint when candidate validation fails', async () => {
  const fake = adapter({ failAt: 'validateCandidate' });
  await assert.rejects(() => new HttpsAgentCore(fake).apply(validInput), /HTTPS_APPLY_FAILED/u);
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.indexOf('restoreCheckpoint') > names.indexOf('validateCandidate'));
  assert.ok(names.indexOf('reloadPrevious') > names.indexOf('restoreCheckpoint'));
  assert.ok(names.includes('removeCheckpoint'));
});

test('agent restores and reloads the checkpoint when public HTTPS readiness fails', async () => {
  const fake = adapter({ failAt: 'waitForPublicRoute' });
  await assert.rejects(() => new HttpsAgentCore(fake).apply(validInput), /HTTPS_APPLY_FAILED/u);
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.indexOf('waitForPublicRoute') > names.indexOf('reload'));
  assert.ok(names.indexOf('restoreCheckpoint') > names.indexOf('waitForPublicRoute'));
  assert.ok(names.indexOf('reloadPrevious') > names.indexOf('restoreCheckpoint'));
});

test('agent rejects malformed tokens before creating a checkpoint', async () => {
  const fake = adapter();
  await assert.rejects(() => new HttpsAgentCore(fake).apply({ ...validInput, cloudflareApiToken: 'bad token' }));
  assert.equal(fake.calls.some(([name]) => name === 'createCheckpoint'), false);
});

test('agent treats Cloudflare zone lookup as the token preflight', async () => {
  const fake = adapter();
  await new HttpsAgentCore(fake).apply(validInput);
  const names = fake.calls.map(([name]) => name);

  assert.ok(names.includes('verifyCloudflareAccess'));
  assert.ok(names.indexOf('verifyCloudflareAccess') < names.indexOf('createCheckpoint'));
});

test('system adapter does not require user-owned token verification before zone lookup', () => {
  const source = fs.readFileSync(path.join(__dirname, 'system-adapter.cjs'), 'utf8');
  assert.doesNotMatch(source, /\/user\/tokens\/verify/u);
  assert.match(source, /\/zones\?name=/u);
});

test('system adapter restarts Caddy so the Cloudflare secret env is reloaded', () => {
  const source = fs.readFileSync(path.join(__dirname, 'system-adapter.cjs'), 'utf8');
  assert.match(source, /systemctl', \['restart', 'caddy\.service'\]/u);
  assert.doesNotMatch(source, /CADDY_BINARY, \['reload'/u);
});
