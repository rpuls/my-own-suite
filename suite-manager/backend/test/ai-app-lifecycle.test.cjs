'use strict';

const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AiConnectionsService } = require('../src/ai/ai-connections-service.cjs');
const { AiStore } = require('../src/ai/ai-store.cjs');
const { AiToolCatalog } = require('../src/ai/ai-tool-catalog.cjs');
const { writeSecretFile } = require('../src/apps/app-package-internals.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const paperlessDir = path.resolve(__dirname, '..', '..', '..', 'apps', 'paperless-ngx');
const manifest = require(path.join(paperlessDir, 'manifest.json'));
const aiTools = require(path.join(paperlessDir, 'ai-tools.json'));

async function harness() {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-ai-lifecycle-'));
  const secretDir = path.join(stateDir, 'app-secrets');
  const instances = [{ displayNameSnapshot: 'Paperless-ngx', enabled: true, id: 'inst-paperless', packageId: 'paperless-ngx', status: 'installed' }];
  writeSecretFile(secretDir, 'inst-paperless', 'aiKey', 'key');
  const fetchImpl = async (_url, init) => {
    const message = JSON.parse(init.body);
    const result = { tools: [{ description: 'Find documents.', inputSchema: { type: 'object' }, name: 'search_documents' }] };
    return new Response(JSON.stringify({ id: message.id, jsonrpc: '2.0', result }), { headers: { 'content-type': 'application/json' } });
  };
  const store = { getAppInstances: () => instances };
  const catalog = new AiToolCatalog({ appPackages: { installedPackageFor: () => ({ aiTools, manifest }) }, fetchImpl, secretDir, store });
  const connections = new AiConnectionsService({ aiStore: new AiStore(new SuiteManagerStore(stateDir)), catalog, fetchImpl, secretDir });
  const { client } = connections.createClient({ name: 'LM Studio' });
  connections.setLevel(client.id, 'paperless-ngx', 'act');
  await connections.setException(client.id, 'paperless_ngx_search_documents', 'block');
  const settings = () => {
    const stored = connections.aiStore.listClients().find((candidate) => candidate.id === client.id);
    return { exception: connections.aiStore.exceptionFor(client.id, 'paperless_ngx_search_documents'), level: stored.levels['paperless-ngx'] ?? null };
  };
  return { catalog, connections, instances, settings };
}

test('stopping an app keeps what each assistant may do in it, and lists it as not running', async () => {
  const h = await harness();
  Object.assign(h.instances[0], { enabled: false, status: 'disabled' });
  const stopped = (await h.connections.status()).sources.find((source) => source.id === 'paperless-ngx');
  assert.equal(stopped.running, false);
  assert.deepEqual(h.settings(), { exception: 'block', level: 'act' });
  Object.assign(h.instances[0], { enabled: true, status: 'installed' });
  await h.connections.status();
  assert.deepEqual(h.settings(), { exception: 'block', level: 'act' });
});

test('an app mid-update or with an unreadable package keeps its assistant settings too', async () => {
  const h = await harness();
  h.instances[0].status = 'updating';
  await h.connections.status();
  assert.deepEqual(h.settings(), { exception: 'block', level: 'act' });
});

test('uninstalling an app forgets what assistants could do in it', async () => {
  const h = await harness();
  h.instances.length = 0;
  await h.connections.status();
  assert.deepEqual(h.settings(), { exception: null, level: null });
});
