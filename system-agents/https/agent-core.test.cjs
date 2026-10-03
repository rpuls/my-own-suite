const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { HttpsAgentCore, HttpsAgentError } = require('./agent-core.cjs');

// `failures` maps an adapter method to what it throws: an HttpsAgentError the
// way the real adapter explains a command, or a bare Error the way a file
// system call fails underneath it.
function adapter(failures = {}, { parkedToken = 'parked_token_value_0987654321' } = {}) {
  const calls = [];
  const make = (name, result) => async (...args) => {
    calls.push([name, ...args]);
    if (failures[name]) throw failures[name]();
    return result;
  };
  return {
    calls,
    awaitCertificate: make('awaitCertificate'),
    commitCheckpoint: make('commitCheckpoint'),
    createCheckpoint: make('createCheckpoint'),
    discardParkedCredential: make('discardParkedCredential'),
    caddyModules: make('caddyModules', ['dns.providers.acmedns', 'dns.providers.cloudflare', 'http.handlers.reverse_proxy']),
    certificateLog: make('certificateLog', ['{"msg":"will retry","identifier":"*.192-168-1-5.local.myownsuite.org"}']),
    ensureCaddyfile: make('ensureCaddyfile', true),
    installCandidate: make('installCandidate'),
    readParkedCredential: make('readParkedCredential', parkedToken),
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
  cloudflareApiToken: 'token_value_1234567890',
};

const lanFacts = (overrides = {}) => () => ({
  bootstrapHost: 'home.mos.home',
  frontDoor: 'usb-autoinstall',
  liveAddress: '192.168.1.5',
  recorded: { host: 'home.192-168-1-5.local.myownsuite.org', kind: 'easy-door', scheme: 'http' },
  suiteManagerPort: '3100',
  ...overrides,
});

const validationFailure = () => new HttpsAgentError('HTTPS_CADDY_VALIDATION_FAILED', 'Caddy rejected the new configuration.', {
  details: [
    'caddy validate for the new configuration exited with code 1.',
    'Last output:\n  Error: adapting config using caddyfile: /etc/caddy/Caddyfile:14: unrecognized directive: tls_dns\n  env: CLOUDFLARE_API_TOKEN=token_value_1234567890',
  ],
});

test('agent applies only rendered configuration and returns an opaque rollback id', async () => {
  const fake = adapter();
  const result = await new HttpsAgentCore(fake, { facts: lanFacts() }).apply(validInput);
  assert.match(result.rollbackId, /^[0-9a-f-]{36}$/u);
  const candidate = fake.calls.find(([name]) => name === 'installCandidate')[1];
  assert.match(candidate.caddyfile, /home\.mos\.example\.com/u);
  assert.match(candidate.caddyfile, /reverse_proxy 127\.0\.0\.1:3100/u);
  assert.doesNotMatch(candidate.caddyfile, /\$MOS_SUITE_MANAGER_PORT/u);
  assert.doesNotMatch(candidate.caddyfile, /token_value/u);
  assert.equal(candidate.cloudflareApiToken, validInput.cloudflareApiToken);
  // The domain joins the door: the Easy Door wildcard is still in the rendering.
  assert.match(candidate.caddyfile, /https:\/\/\*\.192-168-1-5\.local\.myownsuite\.org/u);
  assert.match(candidate.caddyfile, /http:\/\/home\.mos\.home \{/u);
});

// "Restarted" used to be reported as "applied", and an owner read success while
// the certificate had not been issued and every device of theirs still failed.
test('an apply succeeds only once the name is served with a trusted certificate, and a name that never gets one is rolled back', async () => {
  const fake = adapter();
  await new HttpsAgentCore(fake, { facts: lanFacts() }).apply(validInput);
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.indexOf('awaitCertificate') > names.indexOf('reload'));
  assert.deepEqual(fake.calls.find(([name]) => name === 'awaitCertificate').slice(1), ['home.mos.example.com', validInput.cloudflareApiToken]);

  const unissued = adapter({
    awaitCertificate: () => new HttpsAgentError('HTTPS_CERTIFICATE_NOT_ISSUED', 'No trusted certificate for home.mos.example.com was issued in time.', {
      details: ['The web server did not present a trusted certificate for home.mos.example.com within 180 seconds.'],
    }),
  });
  await assert.rejects(() => new HttpsAgentCore(unissued, { facts: lanFacts() }).apply(validInput), (error) => error.code === 'HTTPS_CERTIFICATE_NOT_ISSUED');
  const after = unissued.calls.map(([name]) => name);
  assert.ok(after.indexOf('restoreCheckpoint') > after.indexOf('awaitCertificate'));
  assert.ok(after.includes('reloadPrevious'));
});

// The credential a restore parked is what lets the owner of a recovered suite
// serve its domain without finding a token in the password manager they are
// recovering. It is consumed on commit and left alone by a rollback.
test('an apply can use the parked credential, which a commit consumes and a rollback keeps', async () => {
  const fake = adapter();
  const core = new HttpsAgentCore(fake, { facts: lanFacts() });
  const { acmeEmail, baseDomain } = validInput;
  const result = await core.apply({ acmeEmail, baseDomain, useParkedCredential: true });
  const candidate = fake.calls.find(([name]) => name === 'installCandidate')[1];
  assert.equal(candidate.cloudflareApiToken, 'parked_token_value_0987654321');
  assert.deepEqual(fake.calls.find(([name]) => name === 'createCheckpoint').slice(2), [{ usesParkedCredential: true }]);
  assert.deepEqual(fake.calls.find(([name]) => name === 'verifyCloudflareAccess').slice(1), ['parked_token_value_0987654321', 'mos.example.com']);

  await core.commit(result.rollbackId);
  assert.deepEqual(fake.calls.at(-1), ['commitCheckpoint', result.rollbackId]);

  // Both credentials at once is not a shape the agent accepts.
  await assert.rejects(() => core.apply({ ...validInput, useParkedCredential: true }), (error) => error.code === 'INVALID_REQUEST_SHAPE');

  const missing = adapter({
    readParkedCredential: () => new HttpsAgentError('HTTPS_PARKED_CREDENTIAL_MISSING', 'No credential for that domain is kept on this machine. Enter its API token to serve it here.', { statusCode: 409 }),
  });
  await assert.rejects(() => new HttpsAgentCore(missing, { facts: lanFacts() }).apply({ acmeEmail, baseDomain, useParkedCredential: true }), (error) => error.code === 'HTTPS_PARKED_CREDENTIAL_MISSING' && error.statusCode === 409);
  assert.equal(missing.calls.some(([name]) => name === 'createCheckpoint'), false);
});

test('agent restores and reloads the checkpoint when candidate validation fails, and says why', async () => {
  const fake = adapter({ validateCandidate: validationFailure });
  await assert.rejects(() => new HttpsAgentCore(fake, { facts: lanFacts() }).apply(validInput), (error) => {
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
  assert.equal(names.includes('awaitCertificate'), false);
});

test('a failure the adapter did not explain is reported as the apply failure with its reason, minus the token', async () => {
  const fake = adapter({ installCandidate: () => new Error(`EACCES: permission denied, open '/etc/caddy/Caddyfile.tmp-1' (token_value_1234567890)`) });
  await assert.rejects(() => new HttpsAgentCore(fake, { facts: lanFacts() }).apply(validInput), (error) => {
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
  await assert.rejects(() => new HttpsAgentCore(fake, { facts: lanFacts() }).apply(validInput), (error) => {
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
  await assert.rejects(() => new HttpsAgentCore(fake, { facts: lanFacts() }).apply({ ...validInput, cloudflareApiToken: 'bad token' }));
  assert.equal(fake.calls.some(([name]) => name === 'createCheckpoint'), false);
});

test('agent treats Cloudflare zone lookup as the token preflight and passes its verdict through', async () => {
  const fake = adapter();
  await new HttpsAgentCore(fake, { facts: lanFacts() }).apply(validInput);
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.includes('verifyCloudflareAccess'));
  assert.ok(names.indexOf('verifyCloudflareAccess') < names.indexOf('createCheckpoint'));

  const denied = adapter({
    verifyCloudflareAccess: () => new HttpsAgentError('CLOUDFLARE_ACCESS_DENIED', 'Cloudflare rejected the API token.', {
      details: ['Cloudflare answered the zone lookup for "mos.example.com" with HTTP 400 and error code 6003.'],
      statusCode: 400,
    }),
  });
  await assert.rejects(() => new HttpsAgentCore(denied, { facts: lanFacts() }).apply(validInput), (error) => error.code === 'CLOUDFLARE_ACCESS_DENIED' && error.statusCode === 400);
  assert.equal(denied.calls.some(([name]) => name === 'createCheckpoint'), false);
});

test('system adapter does not require user-owned token verification before zone lookup', () => {
  const source = fs.readFileSync(path.join(__dirname, 'system-adapter.cjs'), 'utf8');
  assert.doesNotMatch(source, /\/user\/tokens\/verify/u);
  assert.match(source, /\/zones\?name=/u);
});

test('an apply restarts Caddy so the Cloudflare secret env is re-read', () => {
  const source = fs.readFileSync(path.join(__dirname, 'system-adapter.cjs'), 'utf8');
  const reload = source.slice(source.indexOf('  async reload(token)'), source.indexOf('  async caddyLog('));
  assert.match(reload, /SYSTEMCTL_BINARY, \['restart', 'caddy\.service'\]/u);
  assert.doesNotMatch(reload, /'reload'/u);
});

test('ensure renders the machine\'s Caddyfile from its facts and does not wait for the certificate', async () => {
  const fake = adapter();
  const result = await new HttpsAgentCore(fake, { facts: lanFacts() }).ensure();
  assert.deepEqual(result, { changed: true, easyDoorBase: '192-168-1-5.local.myownsuite.org' });
  const caddyfile = fake.calls.find(([name]) => name === 'ensureCaddyfile')[1];
  assert.match(caddyfile, /https:\/\/\*\.192-168-1-5\.local\.myownsuite\.org \{/u);
  assert.match(caddyfile, /reverse_proxy 127\.0\.0\.1:3100/u);
  assert.equal(fake.calls.some(([name]) => name === 'awaitCertificate'), false);

  const cloud = adapter();
  const onCloud = await new HttpsAgentCore(cloud, { facts: lanFacts({ frontDoor: 'cloud-init', liveAddress: '10.0.0.5', recorded: null }) }).ensure();
  assert.equal(onCloud.easyDoorBase, null);
  assert.doesNotMatch(cloud.calls.find(([name]) => name === 'ensureCaddyfile')[1], /myownsuite\.org/u);
});

test('an ensure waits for an apply in flight instead of rendering over its candidate', async () => {
  let release;
  const fake = adapter();
  fake.awaitCertificate = async () => { fake.calls.push(['awaitCertificate']); await new Promise((resolve) => { release = resolve; }); };
  const core = new HttpsAgentCore(fake, { facts: lanFacts() });
  const applying = core.apply(validInput);
  const ensuring = core.ensure();
  await new Promise((resolve) => setImmediate(resolve));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.some(([name]) => name === 'ensureCaddyfile'), false);
  release();
  await applying;
  await ensuring;
  const names = fake.calls.map(([name]) => name);
  assert.ok(names.indexOf('ensureCaddyfile') > names.indexOf('awaitCertificate'));
});

test('the Easy Door status carries Caddy\'s own lines about the wildcard, and nothing off a private network', async () => {
  const fake = adapter();
  const status = await new HttpsAgentCore(fake, { facts: lanFacts() }).easyDoorStatus();
  assert.equal(status.easyDoorBase, '192-168-1-5.local.myownsuite.org');
  assert.deepEqual(fake.calls.find(([name]) => name === 'certificateLog').slice(1), ['*.192-168-1-5.local.myownsuite.org']);
  assert.equal(status.log.length, 1);
  assert.deepEqual(await new HttpsAgentCore(adapter(), { facts: lanFacts({ liveAddress: '203.0.113.9' }) }).easyDoorStatus(), { easyDoorBase: null, log: [] });
});

test('status names each DNS module the Caddy build carries as a capability', async () => {
  assert.deepEqual((await new HttpsAgentCore(adapter(), { facts: lanFacts() }).status()).capabilities, ['cloudflare-dns01.apply', 'easy-door-tls']);
});

// The wait is a handshake against the local web server for exactly the new
// name, verified against the system trust store, so it cannot be satisfied by
// a self-signed placeholder or by the certificate of another site.
test('the certificate wait polls a verified handshake for the name and gives up with Caddy\'s log', async () => {
  const { SystemHttpsAdapter } = require('./system-adapter.cjs');
  const attempts = [];
  let ready = false;
  const executed = [];
  const adapterUnderTest = new SystemHttpsAdapter({
    certificateWaitMs: 1,
    execute: async (file, args) => { executed.push([file, ...args]); return { stdout: 'obtaining certificate\nchallenge failed: DNS problem\n' }; },
    handshake: async ({ servername }) => { attempts.push(servername); if (!ready) throw new Error('certificate not yet available'); },
  });
  await assert.rejects(() => adapterUnderTest.awaitCertificate('home.mos.example.com', 'token_value_1234567890'), (error) => {
    assert.equal(error.code, 'HTTPS_CERTIFICATE_NOT_ISSUED');
    assert.match(error.details[0], /home\.mos\.example\.com/u);
    assert.match(error.details[1], /challenge failed: DNS problem/u);
    return true;
  });
  assert.deepEqual(attempts, ['home.mos.example.com']);
  assert.ok(executed.some(([file, ...args]) => file.endsWith('journalctl') && args.includes('caddy.service')));

  ready = true;
  await adapterUnderTest.awaitCertificate('home.mos.example.com', 'token_value_1234567890');
});

// The parked credential is read the way Caddy reads the live one, and is
// deleted only by a commit that used it or by an owner dismissing the offer.
test('the parked credential is read from the env file and removed by a commit that consumed it', async () => {
  const os = require('node:os');
  const { SystemHttpsAdapter } = require('./system-adapter.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mos-https-parked-'));
  const parked = path.join(root, 'caddy-cloudflare.env.parked');
  const transactionRoot = path.join(root, 'transactions');
  fs.mkdirSync(transactionRoot);
  const adapterUnderTest = new SystemHttpsAdapter({ caddyfilePath: path.join(root, 'Caddyfile'), parkedSecretEnvPath: parked, secretEnvPath: path.join(root, 'caddy-cloudflare.env'), transactionRoot });

  await assert.rejects(() => adapterUnderTest.readParkedCredential(), (error) => error.code === 'HTTPS_PARKED_CREDENTIAL_MISSING' && error.statusCode === 409);
  fs.writeFileSync(parked, 'CLOUDFLARE_API_TOKEN=parked_token_value_0987654321\n');
  assert.equal(await adapterUnderTest.readParkedCredential(), 'parked_token_value_0987654321');

  const kept = '11111111-1111-4111-8111-111111111111';
  await adapterUnderTest.createCheckpoint(kept, { usesParkedCredential: false });
  await adapterUnderTest.commitCheckpoint(kept);
  assert.equal(fs.existsSync(parked), true);

  const consumed = '22222222-2222-4222-8222-222222222222';
  await adapterUnderTest.createCheckpoint(consumed, { usesParkedCredential: true });
  await adapterUnderTest.removeCheckpoint(consumed);
  assert.equal(fs.existsSync(parked), true, 'a rolled-back apply leaves the parked credential where the restore put it');
  await adapterUnderTest.createCheckpoint(consumed, { usesParkedCredential: true });
  await adapterUnderTest.commitCheckpoint(consumed);
  assert.equal(fs.existsSync(parked), false);
  assert.equal(fs.existsSync(path.join(transactionRoot, consumed)), false);
});
