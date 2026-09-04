const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HttpsAgentCore, HttpsAgentError } = require('./agent-core.cjs');

// `failures` maps an adapter method to what it throws: an HttpsAgentError the
// way the real adapter explains a command, or a bare Error the way a file
// system call fails underneath it.
function adapter(failures = {}) {
  const calls = [];
  const make = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    if (failures[name]) throw failures[name]();
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

const validationFailure = () => new HttpsAgentError('HTTPS_CADDY_VALIDATION_FAILED', 'Caddy rejected the new configuration.', {
  details: [
    'caddy validate for the new configuration exited with code 1.',
    'Last output:\n  Error: adapting config using caddyfile: /etc/caddy/Caddyfile:14: unrecognized directive: tls_dns\n  env: CLOUDFLARE_API_TOKEN=token_value_1234567890',
  ],
});

test('agent applies only rendered configuration and returns an opaque rollback id', async () => {
  const fake = adapter();
  const result = await new HttpsAgentCore(fake).apply(validInput);
  assert.match(result.rollbackId, /^[0-9a-f-]{36}$/u);
  const candidate = fake.calls.find(([name]) => name === 'installCandidate')[1];
  assert.match(candidate.caddyfile, /home\.mos\.example\.com/u);
  assert.match(candidate.caddyfile, /reverse_proxy 127\.0\.0\.1:3100/u);
  assert.doesNotMatch(candidate.caddyfile, /\$MOS_SUITE_MANAGER_PORT/u);
  assert.doesNotMatch(candidate.caddyfile, /token_value/u);
  assert.equal(candidate.cloudflareApiToken, validInput.cloudflareApiToken);
});

test('agent restores and reloads the checkpoint when candidate validation fails, and says why', async () => {
  const fake = adapter({ validateCandidate: validationFailure });
  await assert.rejects(() => new HttpsAgentCore(fake).apply(validInput), (error) => {
    assert.equal(error.code, 'HTTPS_CADDY_VALIDATION_FAILED');
    assert.equal(error.message, 'Caddy rejected the new configuration.');
    assert.match(error.details.join('\n'), /unrecognized directive: tls_dns/u);
    assert.match(error.details.join('\n'), /CLOUDFLARE_API_TOKEN=\[redacted\]/u);
    assert.ok(!JSON.stringify(error.details).includes(validInput.cloudflareApiToken));
    return true;
  });
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.indexOf('restoreCheckpoint') > names.indexOf('validateCandidate'));
  assert.ok(names.indexOf('reloadPrevious') > names.indexOf('restoreCheckpoint'));
  assert.ok(names.includes('removeCheckpoint'));
});

test('a failure the adapter did not explain is reported as the apply failure with its reason, minus the token', async () => {
  const fake = adapter({ installCandidate: () => new Error(`EACCES: permission denied, open '/etc/caddy/Caddyfile.tmp-1' (token_value_1234567890)`) });
  await assert.rejects(() => new HttpsAgentCore(fake).apply(validInput), (error) => {
    assert.equal(error.code, 'HTTPS_APPLY_FAILED');
    assert.deepEqual(error.details, [`EACCES: permission denied, open '/etc/caddy/Caddyfile.tmp-1' ([redacted])`]);
    return true;
  });
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.includes('restoreCheckpoint'));
  assert.ok(names.includes('removeCheckpoint'));
});

test('a restore that fails too keeps the checkpoint and reports both reasons, the apply first', async () => {
  const fake = adapter({
    reloadPrevious: () => new HttpsAgentError('HTTPS_CADDY_RELOAD_FAILED', 'Caddy did not start with the new configuration.', {
      details: ['systemctl restart caddy.service exited with code 1.', 'Last output:\n  Job for caddy.service failed because the control process exited with error code.'],
    }),
    validateCandidate: validationFailure,
  });
  await assert.rejects(() => new HttpsAgentCore(fake).apply(validInput), (error) => {
    assert.equal(error.code, 'HTTPS_RESTORE_FAILED');
    assert.deepEqual(error.details, [
      'Caddy rejected the new configuration.',
      'caddy validate for the new configuration exited with code 1.',
      'Last output:\n  Error: adapting config using caddyfile: /etc/caddy/Caddyfile:14: unrecognized directive: tls_dns\n  env: CLOUDFLARE_API_TOKEN=[redacted]',
      'Restoring the previous configuration then failed too:',
      'Caddy did not start with the new configuration.',
      'systemctl restart caddy.service exited with code 1.',
      'Last output:\n  Job for caddy.service failed because the control process exited with error code.',
    ]);
    return true;
  });
  assert.equal(fake.calls.some(([name]) => name === 'removeCheckpoint'), false);
});

test('agent rejects malformed tokens before creating a checkpoint', async () => {
  const fake = adapter();
  await assert.rejects(() => new HttpsAgentCore(fake).apply({ ...validInput, cloudflareApiToken: 'bad token' }));
  assert.equal(fake.calls.some(([name]) => name === 'createCheckpoint'), false);
});

test('agent treats Cloudflare zone lookup as the token preflight and passes its verdict through', async () => {
  const fake = adapter();
  await new HttpsAgentCore(fake).apply(validInput);
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.includes('verifyCloudflareAccess'));
  assert.ok(names.indexOf('verifyCloudflareAccess') < names.indexOf('createCheckpoint'));

  const denied = adapter({
    verifyCloudflareAccess: () => new HttpsAgentError('CLOUDFLARE_ACCESS_DENIED', 'Cloudflare rejected the API token.', {
      details: ['Cloudflare answered the zone lookup for "mos.example.com" with HTTP 400 and error code 6003.'],
      statusCode: 400,
    }),
  });
  await assert.rejects(() => new HttpsAgentCore(denied).apply(validInput), (error) => error.code === 'CLOUDFLARE_ACCESS_DENIED' && error.statusCode === 400);
  assert.equal(denied.calls.some(([name]) => name === 'createCheckpoint'), false);
});

test('system adapter does not require user-owned token verification before zone lookup', () => {
  const source = fs.readFileSync(path.join(__dirname, 'system-adapter.cjs'), 'utf8');
  assert.doesNotMatch(source, /\/user\/tokens\/verify/u);
  assert.match(source, /\/zones\?name=/u);
});

test('system adapter restarts Caddy so the Cloudflare secret env is reloaded', () => {
  const source = fs.readFileSync(path.join(__dirname, 'system-adapter.cjs'), 'utf8');
  assert.match(source, /SYSTEMCTL_BINARY, \['restart', 'caddy\.service'\]/u);
  assert.doesNotMatch(source, /\['reload'/u);
});
