'use strict';

// AI services over a real store, a fake provider and fake apps: what an app is
// handed through ${ai.*}, and what the settings service does around it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { materializeRuntimeCompose, resolveConfigTemplate } = require('../src/apps/app-package-internals.cjs');
const { AiServiceError, ask, listModels } = require('../src/ai/ai-service-client.cjs');
const { AiServiceStore } = require('../src/ai/ai-service-store.cjs');
const { AI_TEMPLATE_KEYS, addressLocality, aiTemplateValues, aiValuesForApp } = require('../src/ai/ai-service-values.cjs');
const { AiServices } = require('../src/ai/ai-services.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const KEY = 'sk-test-key-value';
const AI_ENV = { resources: { services: { web: { env: { AI_MODEL: '${ai.model}' } } } } };
const NO_AI_ENV = { resources: { services: { web: { env: { PLAIN: 'value' } } } } };

const input = { apiKey: KEY, baseUrl: 'http://192.168.30.20:1234/v1/', embeddingModel: 'embed-small', model: 'chat-large', name: 'Office PC' };

async function harness({ ask: askImpl = async () => ({ ms: 12 }), restartApp } = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-ai-services-'));
  const suiteStore = new SuiteManagerStore(stateDir);
  const secretDir = path.join(stateDir, 'app-secrets');
  const instances = [
    { displayNameSnapshot: 'Documents', packageId: 'documents', status: 'installed' },
    { displayNameSnapshot: 'Stopped', packageId: 'stopped', status: 'disabled' },
    { displayNameSnapshot: 'Plain', packageId: 'plain', status: 'installed' },
  ];
  const restarted = [];
  const services = new AiServices({
    appPackages: { installedPackageFor: (instance) => ({ manifest: instance.packageId === 'plain' ? NO_AI_ENV : AI_ENV }) },
    client: { ask: askImpl, listModels: async (connection) => [`model-at-${connection.baseUrl}`, connection.apiKey] },
    now: () => new Date('2026-11-22T10:00:00.000Z'),
    restartApp: restartApp || (async (packageId) => { restarted.push(packageId); }),
    secretDir,
    serviceStore: new AiServiceStore(suiteStore),
    store: { getAppInstances: () => instances },
  });
  return { restarted, secretDir, services, suiteStore };
}

test('an address is home only when the address itself says so', () => {
  for (const home of ['http://192.168.30.20:1234/v1', 'http://10.0.0.5/v1', 'http://localhost:11434/v1', 'http://nas.local/v1', 'http://office-pc:1234/v1', 'http://[::1]:8080/v1', 'http://[fd12::5]/v1']) {
    assert.equal(addressLocality(home), 'home', home);
  }
  for (const internet of ['https://api.example.com/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1', 'not a url']) {
    assert.equal(addressLocality(internet), 'internet', internet);
  }
});

test('a service becomes exactly the contract keys, with both address shapes', () => {
  const values = aiTemplateValues({ apiKey: KEY, baseUrl: 'https://ai.example.com/v1', embeddingModel: 'embed-small', model: 'chat-large' });
  assert.deepEqual([...values.keys()].sort(), [...AI_TEMPLATE_KEYS].sort());
  assert.equal(values.get('enabled'), 'true');
  assert.equal(values.get('chatCompletionsUrl'), 'https://ai.example.com/v1/chat/completions');
  assert.equal(values.get('embeddingProtocol'), 'openai');
  assert.equal(aiTemplateValues({ baseUrl: 'http://pc/v1', model: 'm' }).get('embeddingProtocol'), '');
  assert.deepEqual([...new Set(aiTemplateValues(null).values())], ['']);
});

test('an app gets its AI variables resolved, and loses the ones MOS has no value for', () => {
  const compose = { services: [{ id: 'web', environment: {
    AI_BACKEND: '${ai.embeddingProtocol}-like',
    AI_EMBEDDING: '${ai.embeddingModel}',
    AI_ENABLED: '${ai.enabled}',
    AI_KEY: '${ai.apiKey}',
    AI_URL: '${ai.baseUrl}',
    KEEP: 'literal ${HOME}',
  } }] };
  const environment = (service) => materializeRuntimeCompose(compose, [], [], { ai: aiTemplateValues(service) }).services[0].environment;

  assert.deepEqual(environment({ apiKey: KEY, baseUrl: 'http://pc/v1', embeddingModel: 'embed-small', model: 'm' }), {
    AI_BACKEND: 'openai-like', AI_EMBEDDING: 'embed-small', AI_ENABLED: 'true', AI_KEY: KEY, AI_URL: 'http://pc/v1', KEEP: 'literal ${HOME}',
  });
  assert.deepEqual(environment({ baseUrl: 'http://pc/v1', model: 'm' }), { AI_ENABLED: 'true', AI_URL: 'http://pc/v1', KEEP: 'literal ${HOME}' });
  assert.deepEqual(environment(null), { KEEP: 'literal ${HOME}' });
  // The stored projection passes no service at all, so the reference stays literal and out of the digest.
  assert.equal(resolveConfigTemplate('${ai.apiKey}', [], {}), '${ai.apiKey}');
});

test('adding a service stores the key as a secret file and records the test', async () => {
  const { secretDir, services, suiteStore } = await harness();
  const { status, test: tested } = await services.add(input);

  assert.deepEqual(tested, { ms: 12, ok: true });
  const [service] = status.services;
  assert.deepEqual({ ...service, id: 'id' }, {
    baseUrl: 'http://192.168.30.20:1234/v1',
    embeddingModel: 'embed-small',
    id: 'id',
    keyConfigured: true,
    locality: 'home',
    model: 'chat-large',
    name: 'Office PC',
    test: { at: '2026-11-22T10:00:00.000Z', error: null },
  });
  assert.equal(JSON.stringify(status).includes(KEY), false);
  assert.equal(JSON.stringify(new AiServiceStore(suiteStore).list()).includes(KEY), false);
  assert.equal(fs.readFileSync(path.join(secretDir, '_settings', `ai-service-${service.id}.secret`), 'utf8'), KEY);
});

test('a service that fails its test is still saved, with the reason', async () => {
  const { services } = await harness({ ask: async () => { throw new AiServiceError('AI_SERVICE_KEY_REFUSED', 'The service refused this API key.', 502); } });
  const { status, test: tested } = await services.add(input);
  assert.deepEqual(tested, { error: 'The service refused this API key.', ok: false });
  assert.equal(status.services[0].test.error, 'The service refused this API key.');
});

test('input that cannot work is refused before anything is stored', async () => {
  const { services } = await harness();
  await assert.rejects(services.add({ ...input, baseUrl: 'ftp://pc/v1' }), { code: 'AI_SERVICE_ADDRESS_INVALID' });
  await assert.rejects(services.add({ ...input, baseUrl: 'http://user:pass@pc/v1' }), { code: 'AI_SERVICE_ADDRESS_INVALID' });
  await assert.rejects(services.add({ ...input, name: ' ' }), { code: 'AI_SERVICE_NAME_INVALID' });
  await assert.rejects(services.add({ ...input, model: '' }), { code: 'AI_SERVICE_MODEL_INVALID' });
  assert.deepEqual(services.status().services, []);
});

test('only installed apps that read the AI values are offered', async () => {
  const { services } = await harness();
  assert.deepEqual(services.status().apps, [
    { name: 'Documents', packageId: 'documents', running: true, serviceId: null },
    { name: 'Stopped', packageId: 'stopped', running: false, serviceId: null },
  ]);
});

test('turning an app on gives it the service and restarts it; off takes it away', async () => {
  const { restarted, secretDir, services, suiteStore } = await harness();
  const id = (await services.add(input)).status.services[0].id;
  const valuesFor = (packageId) => aiValuesForApp(suiteStore, packageId, (ref) => fs.readFileSync(ref, 'utf8'));

  await services.setAppService('documents', id);
  assert.deepEqual(restarted, ['documents']);
  assert.equal(valuesFor('documents').get('apiKey'), KEY);
  assert.equal(valuesFor('documents').get('model'), 'chat-large');
  assert.equal(valuesFor('stopped').get('enabled'), '');

  // A stopped app keeps the choice and picks it up when it next starts.
  await services.setAppService('stopped', id);
  assert.deepEqual(restarted, ['documents']);

  await services.setAppService('documents', null);
  assert.deepEqual(restarted, ['documents', 'documents']);
  assert.equal(valuesFor('documents').get('enabled'), '');
  await assert.rejects(services.setAppService('plain', id), { code: 'AI_SERVICE_APP_UNSUPPORTED' });
  assert.ok(secretDir);
});

test('a restart that fails puts the choice back', async () => {
  const { services } = await harness({ restartApp: async () => { throw new Error('agent down'); } });
  const id = (await services.add(input)).status.services[0].id;
  await assert.rejects(services.setAppService('documents', id), /agent down/u);
  assert.equal(services.status().apps[0].serviceId, null);
});

test('an edit that leaves the key alone keeps it, and restarts the apps using the service', async () => {
  const { restarted, secretDir, services } = await harness();
  const id = (await services.add(input)).status.services[0].id;
  await services.setAppService('documents', id);

  const { apiKey, ...withoutKey } = input;
  const { status } = await services.update(id, { ...withoutKey, model: 'chat-small' });
  assert.equal(status.services[0].model, 'chat-small');
  assert.equal(status.services[0].keyConfigured, true);
  assert.equal(fs.readFileSync(path.join(secretDir, '_settings', `ai-service-${id}.secret`), 'utf8'), apiKey);
  assert.deepEqual(restarted, ['documents', 'documents']);

  assert.equal((await services.update(id, { ...withoutKey, apiKey: '' })).status.services[0].keyConfigured, false);
});

test('the form can check an address and test with the stored key before saving', async () => {
  const { services } = await harness();
  const id = (await services.add(input)).status.services[0].id;
  assert.deepEqual(await services.check({ baseUrl: 'http://pc/v1/', serviceId: id }), { error: null, locality: 'home', models: ['model-at-http://pc/v1', KEY] });
  assert.deepEqual((await services.check({ apiKey: '', baseUrl: 'https://ai.example.com/v1', serviceId: id })).models, ['model-at-https://ai.example.com/v1', '']);
  assert.deepEqual(await services.test({ baseUrl: 'http://pc/v1', model: 'm' }), { ms: 12 });

  services.client.listModels = async () => { throw new AiServiceError('AI_SERVICE_UNREACHABLE', 'MOS could not reach pc.', 502); };
  assert.deepEqual(await services.check({ baseUrl: 'http://pc/v1' }), { error: 'MOS could not reach pc.', locality: 'home', models: [] });
});

test('removing a service forgets its key, turns its apps off and restarts them', async () => {
  const { restarted, secretDir, services } = await harness();
  const id = (await services.add(input)).status.services[0].id;
  await services.setAppService('documents', id);

  const { status } = await services.remove(id);
  assert.deepEqual(status.services, []);
  assert.equal(status.apps[0].serviceId, null);
  assert.deepEqual(restarted, ['documents', 'documents']);
  assert.equal(fs.existsSync(path.join(secretDir, '_settings', `ai-service-${id}.secret`)), false);
  await assert.rejects(services.remove(id), { code: 'AI_SERVICE_NOT_FOUND' });
});

test('the provider client sends the key, and turns each failure into a sentence for the owner', async () => {
  const calls = [];
  const answering = (status, body) => async (url, options) => {
    calls.push({ options, url });
    return { json: async () => body, ok: status >= 200 && status < 300, status };
  };
  const connection = { apiKey: KEY, baseUrl: 'http://pc:1234/v1' };

  assert.deepEqual(await listModels(connection, { fetchImpl: answering(200, { data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }, {}] }) }), ['a', 'b']);
  assert.equal(calls[0].url, 'http://pc:1234/v1/models');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${KEY}`);

  await ask({ ...connection, model: 'm' }, { fetchImpl: answering(200, { choices: [{ message: { content: 'ok' } }] }) });
  assert.equal(calls[1].url, 'http://pc:1234/v1/chat/completions');
  assert.equal(JSON.parse(calls[1].options.body).model, 'm');

  await assert.rejects(ask({ ...connection, model: 'm' }, { fetchImpl: answering(401, {}) }), { code: 'AI_SERVICE_KEY_REFUSED' });
  await assert.rejects(listModels(connection, { fetchImpl: answering(404, {}) }), { code: 'AI_SERVICE_NOT_FOUND' });
  await assert.rejects(ask({ ...connection, model: 'm' }, { fetchImpl: answering(400, { error: { message: 'model not loaded' } }) }), { message: 'The service answered: model not loaded' });
  await assert.rejects(ask({ ...connection, model: 'm' }, { fetchImpl: answering(200, {}) }), { code: 'AI_SERVICE_REFUSED' });
  await assert.rejects(listModels(connection, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }), { code: 'AI_SERVICE_UNREACHABLE', message: /could not reach pc:1234/u });
});
