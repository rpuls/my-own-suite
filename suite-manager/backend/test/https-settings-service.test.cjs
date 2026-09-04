'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const targetPath = require.resolve('../src/settings/https-settings-service.cjs');
const target = require(targetPath);
const sharedDir = path.resolve(path.dirname(targetPath), '../../../../shared');
const { HttpsSettingsError } = require(path.join(sharedDir, 'https-contract.cjs'));
const { HttpsAgentError } = require('../src/settings/https-agent-client.cjs');

const {
  HttpsSettingsService,
  homeHostFor,
  privateHttpsAvailable,
  publicStatus,
} = target;

function validHttpsInput() {
  return {
    acmeEmail: 'ops@example.com',
    baseDomain: 'example.com',
    cloudflareApiToken: 'test-token-not-real-abcdefghijklmnopqrst',
  };
}

function makeStore(settings = {}) {
  const calls = { begin: [], complete: [], fail: [] };
  const baseSettings = {
    acmeEmail: 'ops@example.com',
    baseDomain: 'example.com',
    lastApplyAt: null,
    lastApplyDiagnostics: null,
    lastApplyErrorCode: null,
    lastApplyStatus: null,
    provider: 'digitalocean',
    tlsMode: 'cloudflare-dns01',
    ...settings,
  };

  return {
    calls,
    store: {
      getHttpsSettings: () => ({ ...baseSettings }),
      beginHttpsApply: (arg) => calls.begin.push(arg),
      completeHttpsApply: (arg) => calls.complete.push(arg),
      failHttpsApply: (arg) => calls.fail.push(arg),
    },
  };
}

function makeAgent(applyResult = { rollbackId: 'rollback-42' }) {
  const calls = { apply: [], rollback: [], commit: [] };

  return {
    calls,
    agent: {
      apply: async (arg) => {
        calls.apply.push(arg);
        return applyResult;
      },
      rollback: async (arg) => calls.rollback.push(arg),
      commit: async (arg) => calls.commit.push(arg),
    },
  };
}

function makeNow(isoValues) {
  let index = 0;
  return () => {
    const iso = isoValues[index] ?? isoValues[isoValues.length - 1];
    if (index < isoValues.length - 1) index += 1;
    return new Date(iso);
  };
}

test('homeHostFor returns a home subdomain or null', () => {
  assert.equal(homeHostFor('example.com'), 'home.example.com');
  assert.equal(homeHostFor(''), null);
  assert.equal(homeHostFor(null), null);
  assert.equal(homeHostFor(undefined), null);
});

test('privateHttpsAvailable blocks cloud-init and digitalocean-smoke front doors', () => {
  assert.equal(privateHttpsAvailable('ssh-bootstrap'), true);
  assert.equal(privateHttpsAvailable('other'), true);
  assert.equal(privateHttpsAvailable('cloud-init'), false);
  assert.equal(privateHttpsAvailable('digitalocean-smoke'), false);
});

test('publicStatus builds the HTTPS settings status payload', () => {
  const settings = {
    acmeEmail: 'ops@example.com',
    baseDomain: 'example.com',
    lastApplyAt: '2024-01-01T00:00:00.000Z',
    lastApplyDiagnostics: 'service became stable',
    lastApplyErrorCode: 'HTTPS_APPLY_FAILED',
    lastApplyStatus: 'failed',
    provider: 'digitalocean',
    tlsMode: 'cloudflare-dns01',
  };

  const status = publicStatus(settings, 'bootstrap.test', true, {
    frontDoor: 'ssh-bootstrap',
    serverAddress: '10.0.0.20',
  });

  assert.deepEqual(status, {
    acmeEmail: 'ops@example.com',
    activeHomeUrl: 'https://home.example.com/',
    agentAvailable: true,
    baseDomain: 'example.com',
    bootstrapUrl: 'http://bootstrap.test/',
    lastApply: {
      at: '2024-01-01T00:00:00.000Z',
      diagnostics: 'service became stable',
      errorCode: 'HTTPS_APPLY_FAILED',
      status: 'failed',
    },
    installContext: 'ssh-bootstrap',
    privateHttpsAvailable: true,
    provider: 'digitalocean',
    serverAddress: '10.0.0.20',
    tlsMode: 'cloudflare-dns01',
    tokenConfigured: true,
  });
});

test('publicStatus falls back to bootstrap HTTP URL when no base domain exists', () => {
  const status = publicStatus(
    {
      acmeEmail: null,
      baseDomain: null,
      lastApplyAt: null,
      lastApplyDiagnostics: null,
      lastApplyErrorCode: null,
      lastApplyStatus: null,
      provider: null,
      tlsMode: 'http',
    },
    'bootstrap.test',
    false,
    { frontDoor: 'digitalocean-smoke', serverAddress: '10.0.0.21' },
  );

  assert.equal(status.activeHomeUrl, 'http://bootstrap.test/');
  assert.equal(status.bootstrapUrl, 'http://bootstrap.test/');
  assert.equal(status.privateHttpsAvailable, false);
  assert.equal(status.tokenConfigured, false);
});

test('easyDoorHost returns null for cloudflare-dns01 TLS mode', () => {
  const settings = { tlsMode: 'cloudflare-dns01' };

  const service = new HttpsSettingsService({
    agent: {},
    bootstrapHost: 'bootstrap.test',
    store: { getHttpsSettings: () => settings },
  });

  assert.equal(service.easyDoorHost(settings), null);
});

test('easyDoorHost is derived from the current detected address for non-cloudflare modes', () => {
  const detectAddress = () => '10.0.1.30';

  const service = new HttpsSettingsService({
    agent: {},
    bootstrapHost: 'bootstrap.test',
    detectAddress,
    store: { getHttpsSettings: () => ({ tlsMode: 'http' }) },
  });

  assert.equal(
    service.easyDoorHost({ tlsMode: 'http' }),
    'home.10-0-1-30.local.myownsuite.org',
  );
});

test('allowedHosts includes bootstrap, active home, pending home, and easy door hosts', () => {
  const detectAddress = () => '10.0.1.40';
  const settings = {
    baseDomain: 'example.com',
    pendingBaseDomain: 'pending.example.com',
    tlsMode: 'http',
  };

  const service = new HttpsSettingsService({
    agent: {},
    bootstrapHost: 'bootstrap.test',
    detectAddress,
    store: { getHttpsSettings: () => settings },
  });

  const expected = [
    'bootstrap.test',
    'home.example.com',
    'home.pending.example.com',
    'home.10-0-1-40.local.myownsuite.org',
  ];

  assert.deepEqual([...service.allowedHosts()].sort(), expected.sort());
});

test('publicUrlSchemeForHost uses HTTPS only for the cloudflare home host', () => {
  const { store } = makeStore({ baseDomain: 'example.com', tlsMode: 'cloudflare-dns01' });

  const service = new HttpsSettingsService({
    agent: {},
    bootstrapHost: 'bootstrap.test',
    store,
  });

  assert.equal(service.publicUrlSchemeForHost('home.example.com'), 'https');
  assert.equal(service.publicUrlSchemeForHost(' HOME.Example.COM '), 'https');
  assert.equal(service.publicUrlSchemeForHost('www.example.com'), 'http');
  assert.equal(service.publicUrlSchemeForHost('www.example.com', 'https'), 'https');
});

test('status reports cloudflare-dns01 apply capability from agent', async () => {
  const { store } = makeStore({ baseDomain: 'example.com', tlsMode: 'cloudflare-dns01' });

  const service = new HttpsSettingsService({
    agent: { status: async () => ({ capabilities: ['cloudflare-dns01.apply'] }) },
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    store,
  });

  const status = await service.status();

  assert.equal(status.agentAvailable, true);
  assert.equal(status.activeHomeUrl, 'https://home.example.com/');
  assert.equal(status.installContext, 'ssh-bootstrap');
  assert.equal(status.privateHttpsAvailable, true);
  assert.equal(status.tokenConfigured, true);
  assert.equal(typeof status.serverAddress, 'string');
});

test('status reports agent unavailable when agent.status throws', async () => {
  const { store } = makeStore({ baseDomain: null, tlsMode: 'http' });

  const service = new HttpsSettingsService({
    agent: { status: async () => { throw new Error('agent down'); } },
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    store,
  });

  const status = await service.status();

  assert.equal(status.agentAvailable, false);
  assert.equal(status.activeHomeUrl, 'http://bootstrap.test/');
});

test('apply begins, completes, commits, and returns the new HTTPS URLs', async () => {
  const { store, calls: storeCalls } = makeStore();
  const { agent, calls: agentCalls } = makeAgent({ rollbackId: 'rollback-42' });
  const now = makeNow([
    '2024-01-01T00:00:00.000Z',
    '2024-01-01T00:01:00.000Z',
  ]);

  const service = new HttpsSettingsService({
    agent,
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    now,
    store,
  });

  const result = await service.apply(validHttpsInput());

  assert.deepEqual(result, {
    appliedAt: '2024-01-01T00:01:00.000Z',
    bootstrapUrl: 'http://bootstrap.test/',
    homeUrl: 'https://home.example.com/',
    status: 'applied',
  });

  assert.equal(storeCalls.begin.length, 1);
  assert.equal(storeCalls.begin[0].acmeEmail, 'ops@example.com');
  assert.equal(storeCalls.begin[0].baseDomain, 'example.com');
  assert.equal(storeCalls.begin[0].at, '2024-01-01T00:00:00.000Z');

  assert.deepEqual(storeCalls.complete, ['2024-01-01T00:01:00.000Z']);

  assert.equal(agentCalls.apply.length, 1);
  assert.equal(agentCalls.apply[0].acmeEmail, 'ops@example.com');
  assert.equal(agentCalls.apply[0].baseDomain, 'example.com');
  assert.equal(agentCalls.apply[0].bootstrapHost, 'bootstrap.test');
  assert.equal(agentCalls.apply[0].cloudflareApiToken, 'test-token-not-real-abcdefghijklmnopqrst');

  assert.deepEqual(agentCalls.commit, ['rollback-42']);
  assert.deepEqual(agentCalls.rollback, []);
  assert.deepEqual(storeCalls.fail, []);
});

test('apply refuses private HTTPS for cloud-init and digitalocean-smoke front doors', async () => {
  for (const frontDoor of ['cloud-init', 'digitalocean-smoke']) {
    const { store } = makeStore();

    const service = new HttpsSettingsService({
      agent: {},
      bootstrapHost: 'bootstrap.test',
      frontDoor,
      store,
    });

    await assert.rejects(
      service.apply(validHttpsInput()),
      (error) =>
        error instanceof HttpsSettingsError &&
        error.code === 'PRIVATE_HTTPS_UNAVAILABLE' &&
        error.statusCode === 409,
    );
  }
});

test('apply rejects payloads that do not only include the three required keys', async () => {
  const { store } = makeStore();

  const service = new HttpsSettingsService({
    agent: {},
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    store,
  });

  await assert.rejects(
    service.apply({ acmeEmail: 'ops@example.com', baseDomain: 'example.com' }),
    (error) =>
      error instanceof HttpsSettingsError &&
      error.code === 'INVALID_HTTPS_REQUEST' &&
      error.message === 'Only the required HTTPS settings are accepted.',
  );

  await assert.rejects(
    service.apply({
      acmeEmail: 'ops@example.com',
      baseDomain: 'example.com',
      cloudflareApiToken: 'token',
      extra: true,
    }),
    (error) =>
      error instanceof HttpsSettingsError &&
      error.code === 'INVALID_HTTPS_REQUEST',
  );

  await assert.rejects(
    service.apply(null),
    (error) =>
      error instanceof HttpsSettingsError &&
      error.code === 'INVALID_HTTPS_REQUEST',
  );
});

test('apply records failure and throws HTTPS_APPLY_FAILED when the agent fails', async () => {
  const { store, calls: storeCalls } = makeStore();
  const { agent, calls: agentCalls } = makeAgent();

  agent.apply = async () => {
    throw new Error('agent unavailable');
  };

  const service = new HttpsSettingsService({
    agent,
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    now: () => new Date('2024-01-01T00:00:00.000Z'),
    store,
  });

  await assert.rejects(
    service.apply(validHttpsInput()),
    (error) => error.code === 'HTTPS_APPLY_FAILED' && error.statusCode === 502,
  );

  assert.equal(storeCalls.begin.length, 1);
  assert.equal(storeCalls.fail.length, 1);
  assert.equal(storeCalls.fail[0].errorCode, 'HTTPS_APPLY_FAILED');
  assert.equal(storeCalls.fail[0].diagnostics, 'HTTPS could not be applied.\n\nDetails:\n- agent unavailable');
  assert.equal(agentCalls.rollback.length, 0);
});

test('a failure the agent explained keeps its code, its sentence, and its reason, minus the token', async () => {
  const { store, calls: storeCalls } = makeStore();
  const { agent } = makeAgent();
  const input = validHttpsInput();

  agent.apply = async () => {
    throw new HttpsAgentError('HTTPS_CADDY_VALIDATION_FAILED', 'Caddy rejected the new configuration.', {
      details: [
        'caddy validate for the new configuration exited with code 1.',
        `Last output:\n  Error: adapting config using caddyfile: /etc/caddy/Caddyfile:14: unrecognized directive: tls_dns\n  environment: CLOUDFLARE_API_TOKEN=${input.cloudflareApiToken}`,
      ],
    });
  };

  const service = new HttpsSettingsService({
    agent,
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    now: () => new Date('2024-01-01T00:00:00.000Z'),
    store,
  });

  await assert.rejects(
    service.apply(input),
    (error) =>
      error instanceof HttpsSettingsError &&
      error.code === 'HTTPS_CADDY_VALIDATION_FAILED' &&
      error.statusCode === 502 &&
      error.message === 'Caddy rejected the new configuration. The previous configuration remains active.',
  );

  const [failure] = storeCalls.fail;
  assert.equal(failure.errorCode, 'HTTPS_CADDY_VALIDATION_FAILED');
  assert.equal(failure.diagnostics, [
    'Caddy rejected the new configuration.',
    '',
    'Details:',
    '- caddy validate for the new configuration exited with code 1.',
    '- Last output:',
    '    Error: adapting config using caddyfile: /etc/caddy/Caddyfile:14: unrecognized directive: tls_dns',
    '    environment: CLOUDFLARE_API_TOKEN=[redacted]',
  ].join('\n'));
  assert.ok(!failure.diagnostics.includes(input.cloudflareApiToken));
});

test('a Cloudflare refusal is the owner\'s to fix, so it comes back as their error rather than a gateway one', async () => {
  const { store, calls: storeCalls } = makeStore();
  const { agent } = makeAgent();

  agent.apply = async () => {
    throw new HttpsAgentError('CLOUDFLARE_ACCESS_DENIED', 'Cloudflare rejected the API token.', {
      details: ['Cloudflare answered the zone lookup for "example.com" with HTTP 400 and error code 6003.', 'Cloudflare said: Invalid request headers'],
      statusCode: 400,
    });
  };

  const service = new HttpsSettingsService({
    agent,
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    now: () => new Date('2024-01-01T00:00:00.000Z'),
    store,
  });

  await assert.rejects(
    service.apply(validHttpsInput()),
    (error) => error.code === 'CLOUDFLARE_ACCESS_DENIED' && error.statusCode === 400,
  );
  assert.equal(storeCalls.fail[0].errorCode, 'CLOUDFLARE_ACCESS_DENIED');
  assert.match(storeCalls.fail[0].diagnostics, /error code 6003/u);
  assert.match(storeCalls.fail[0].diagnostics, /Cloudflare said: Invalid request headers/u);
});

test('apply treats an agent response without a rollback id as a failure', async () => {
  const { store, calls: storeCalls } = makeStore();
  const { agent, calls: agentCalls } = makeAgent({ rollbackId: null });

  const service = new HttpsSettingsService({
    agent,
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    now: () => new Date('2024-01-01T00:00:00.000Z'),
    store,
  });

  await assert.rejects(
    service.apply(validHttpsInput()),
    (error) => error.code === 'HTTPS_APPLY_FAILED' && error.statusCode === 502,
  );

  assert.equal(agentCalls.apply.length, 1);
  assert.equal(agentCalls.rollback.length, 0);
  assert.equal(storeCalls.complete.length, 0);
  assert.equal(storeCalls.fail.length, 1);
  assert.equal(storeCalls.fail[0].errorCode, 'HTTPS_APPLY_FAILED');
});

test('apply rolls back and masks a store completion failure as HTTPS_APPLY_FAILED', async () => {
  const { store, calls: storeCalls } = makeStore();
  const { agent, calls: agentCalls } = makeAgent({ rollbackId: 'rollback-42' });

  store.completeHttpsApply = () => {
    storeCalls.complete.push('called');
    throw new Error('store write failed');
  };

  const now = makeNow([
    '2024-01-01T00:00:00.000Z',
    '2024-01-01T00:01:00.000Z',
  ]);

  const service = new HttpsSettingsService({
    agent,
    bootstrapHost: 'bootstrap.test',
    frontDoor: 'ssh-bootstrap',
    now,
    store,
  });

  await assert.rejects(
    service.apply(validHttpsInput()),
    (error) => error.code === 'HTTPS_APPLY_FAILED',
  );

  assert.deepEqual(agentCalls.rollback, ['rollback-42']);
  assert.deepEqual(agentCalls.commit, []);
  assert.equal(storeCalls.complete.length, 1);
  assert.equal(storeCalls.fail.length, 1);
  assert.equal(storeCalls.fail[0].errorCode, 'HTTPS_APPLY_FAILED');
});

function testService({ address = '192.168.123.45', settings = {} } = {}) {
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
  const hosts = testService().allowedHosts();

  assert.equal(hosts.has('home.192-168-123-45.local.myownsuite.org'), true);
  assert.equal(hosts.has('home.mos.home'), true);
});

test('a public address gets no Easy Door name, which is what keeps cloud installs out', () => {
  assert.deepEqual([...testService({ address: '203.0.113.10' }).allowedHosts()], ['home.mos.home']);
  assert.deepEqual([...testService({ address: null }).allowedHosts()], ['home.mos.home']);
});

test('applying a real domain with DNS-01 closes the Easy Door name for good', () => {
  const hosts = testService({
    settings: { baseDomain: 'mos.example.com', tlsMode: 'cloudflare-dns01' },
  }).allowedHosts();

  assert.deepEqual([...hosts], ['home.mos.home', 'home.mos.example.com']);
  assert.equal(hosts.has('home.192-168-123-45.local.myownsuite.org'), false);
});

test('a domain waiting to be applied is still reachable alongside the Easy Door', () => {
  const hosts = testService({ settings: { pendingBaseDomain: 'mos.example.com' } }).allowedHosts();

  assert.deepEqual(
    [...hosts],
    ['home.mos.home', 'home.mos.example.com', 'home.192-168-123-45.local.myownsuite.org'],
  );
});
