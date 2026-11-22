'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AiConnectionsService } = require('../src/ai/ai-connections-service.cjs');
const { AiStore } = require('../src/ai/ai-store.cjs');
const { ChatGptTunnel } = require('../src/ai/chatgpt-tunnel.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const TUNNEL_ID = 'tunnel_6afcd9b631d88191952917b488188465';
const RUNTIME_KEY = 'sk-proj-runtime-key-for-tests';

async function harness({ agentFails = false, health = { status: 'ok' } } = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-tunnel-'));
  const store = new SuiteManagerStore(stateDir);
  const secretDir = path.join(stateDir, 'app-secrets');
  const aiConnections = new AiConnectionsService({ aiStore: new AiStore(store), catalog: { sources: () => [] }, secretDir });
  const agentCalls = [];
  const appAgent = {
    async request(method, requestPath, body) {
      agentCalls.push({ body, path: requestPath });
      if (agentFails) throw Object.assign(new Error('App runtime system agent is unavailable.'), { statusCode: 503 });
      return {};
    },
  };
  const fetchImpl = async () => {
    if (!health) throw new Error('connection refused');
    return new Response(JSON.stringify(health));
  };
  const tunnel = new ChatGptTunnel({ aiConnections, appAgent, fetchImpl, secretDir, suiteManagerPort: 3100 });
  return { agentCalls, aiConnections, tunnel };
}

test('connecting ChatGPT makes one tunnel AI and hands the agent its keys', async () => {
  const h = await harness();
  const client = await h.tunnel.connect({ runtimeKey: ` ${RUNTIME_KEY} `, tunnelId: TUNNEL_ID });

  assert.equal(client.route, 'tunnel');
  assert.equal(client.name, 'ChatGPT');
  const [start] = h.agentCalls;
  assert.equal(start.path, '/v1/ai-tunnel/start');
  assert.deepEqual({ ...start.body, gatewayKey: 'hidden' }, { gatewayKey: 'hidden', runtimeKey: RUNTIME_KEY, suiteManagerPort: 3100, tunnelId: TUNNEL_ID });
  // The key the tunnel presents is the AI's own token.
  assert.equal(h.aiConnections.authenticate(start.body.gatewayKey).id, client.id);
  assert.deepEqual(await h.tunnel.status(), { clientId: client.id, state: 'connected', tunnelId: TUNNEL_ID });

  await assert.rejects(h.tunnel.connect({ runtimeKey: RUNTIME_KEY, tunnelId: TUNNEL_ID }), { code: 'AI_TUNNEL_EXISTS' });
  assert.throws(() => h.aiConnections.rotateClientToken(client.id), { code: 'AI_TUNNEL_TOKEN' });
});

test('a tunnel ID or key that is not one is refused before anything starts', async () => {
  const h = await harness();
  await assert.rejects(h.tunnel.connect({ runtimeKey: RUNTIME_KEY, tunnelId: 'my-tunnel' }), { code: 'AI_TUNNEL_ID_INVALID' });
  // The tunnel client refuses these and restarts forever, so MOS must refuse them first.
  for (const tunnelId of ['tunnel_ekwrqcdobdng27r0mjmtsx9v', 'tunnel_6AFCD9B631D88191952917B488188465', 'tunnel_ab_6afcd9b631d88191952917b488188465']) {
    await assert.rejects(h.tunnel.connect({ runtimeKey: RUNTIME_KEY, tunnelId }), { code: 'AI_TUNNEL_ID_INVALID' }, tunnelId);
  }
  await assert.rejects(h.tunnel.connect({ runtimeKey: 'sk short', tunnelId: TUNNEL_ID }), { code: 'AI_TUNNEL_KEY_INVALID' });
  assert.equal(h.agentCalls.length, 0);
  assert.equal(h.aiConnections.aiStore.listClients().length, 0);
});

test('a tunnel that cannot start leaves no AI behind', async () => {
  const h = await harness({ agentFails: true });
  await assert.rejects(h.tunnel.connect({ runtimeKey: RUNTIME_KEY, tunnelId: TUNNEL_ID }), { statusCode: 503 });
  assert.equal(h.aiConnections.aiStore.listClients().length, 0);
  assert.equal(await h.tunnel.status(), null);
});

test('the tunnel state comes from its health, and off when it does not answer', async () => {
  for (const [health, state] of [[{ status: 'unknown' }, 'starting'], [{ status: 'degraded' }, 'refused'], [null, 'off']]) {
    const h = await harness({ health });
    await h.tunnel.connect({ runtimeKey: RUNTIME_KEY, tunnelId: TUNNEL_ID });
    assert.equal((await h.tunnel.status()).state, state);
  }
});

test('removing the ChatGPT AI stops the tunnel and forgets its keys; other AIs leave it alone', async () => {
  const h = await harness();
  const client = await h.tunnel.connect({ runtimeKey: RUNTIME_KEY, tunnelId: TUNNEL_ID });
  const { client: other } = h.aiConnections.createClient({ name: 'Claude Code' });

  await h.tunnel.clientRemoved(other.id);
  assert.equal(h.agentCalls.length, 1);

  h.aiConnections.deleteClient(client.id);
  await h.tunnel.clientRemoved(client.id);
  assert.equal(h.agentCalls.at(-1).path, '/v1/ai-tunnel/stop');
  assert.equal(h.tunnel.stored(), null);
  await assert.rejects(h.tunnel.start(), { code: 'AI_TUNNEL_NOT_CONNECTED' });
});
