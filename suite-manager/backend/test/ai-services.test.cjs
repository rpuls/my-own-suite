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
const { AiServiceError, ask, embed, listModels } = require('../src/ai/ai-service-client.cjs');
const { AiServiceStore } = require('../src/ai/ai-service-store.cjs');
const { AI_TEMPLATE_KEYS, addressAdvice, addressPlace, aiTemplateValues, aiValuesForApp, aiVariablesOf } = require('../src/ai/ai-service-values.cjs');
const { AiServices } = require('../src/ai/ai-services.cjs');
const { SuiteManagerStore } = require('../src/state/suite-manager-store.cjs');

const KEY = 'sk-test-key-value';
const AI_ENV = { resources: { services: { web: { env: { AI_MODEL: '${ai.model}' } } } } };
const SEARCH_ENV = { catalog: { aiFeatures: ' Answers questions about your files. ' }, resources: { services: { web: { env: { AI_KEY: '${ai.apiKey}', AI_SEARCH: '${ai.embeddingModel}', PLAIN: 'value' } } } } };
const NO_AI_ENV = { resources: { services: { web: { env: { PLAIN: 'value' } } } } };

const input = { apiKey: KEY, baseUrl: 'http://192.168.30.20:1234/v1/', embeddingModel: 'embed-small', model: 'chat-large', name: 'Office PC' };

async function harness({ advisories = {}, ask: askImpl = async () => ({ ms: 12 }), embed: embedImpl = async () => {}, hostingTrack = 'home-server', restartApp } = {}) {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mos-ai-services-'));
  const suiteStore = new SuiteManagerStore(stateDir);
  const secretDir = path.join(stateDir, 'app-secrets');
  const instances = [
    { displayNameSnapshot: 'Documents', packageId: 'documents', status: 'installed' },
    { displayNameSnapshot: 'Stopped', packageId: 'stopped', status: 'disabled' },
    { displayNameSnapshot: 'Plain', packageId: 'plain', status: 'installed' },
    { displayNameSnapshot: 'Search', packageId: 'search', sourceKind: 'external-git', status: 'installed' },
  ];
  const manifests = { plain: NO_AI_ENV, search: SEARCH_ENV };
  const restarted = [];
  const services = new AiServices({
    appPackages: {
      installedPackageFor: (instance) => ({ manifest: manifests[instance.packageId] || AI_ENV }),
      packageAdvisoriesFor: (instance) => advisories[instance.packageId] || [],
    },
    client: { ask: askImpl, embed: embedImpl, listModels: async (connection) => [`model-at-${connection.baseUrl}`, connection.apiKey] },
    hostingTrack,
    now: () => new Date('2026-11-22T10:00:00.000Z'),
    restartApp: restartApp || (async (packageId) => { restarted.push(packageId); }),
    secretDir,
    serviceStore: new AiServiceStore(suiteStore),
    store: { getAppInstances: () => instances },
  });
  return { restarted, secretDir, services, suiteStore };
}

test('an address is home only when it is private and the suite runs on the owner\'s own hardware', () => {
  for (const address of ['http://192.168.30.20:1234/v1', 'http://10.0.0.5/v1', 'http://nas.local/v1', 'http://office-pc:1234/v1', 'http://[fd12::5]/v1']) {
    assert.equal(addressPlace(address, 'home-server'), 'home', address);
    assert.equal(addressPlace(address, 'public-server'), 'private', address);
    assert.equal(addressPlace(address, null), 'private', address);
  }
  for (const internet of ['https://api.example.com/v1', 'http://8.8.8.8/v1', 'http://172.32.0.1/v1', 'not a url']) {
    assert.equal(addressPlace(internet, 'home-server'), 'internet', internet);
  }
});

test('the form is warned about addresses that cannot work inside an app', () => {
  for (const loopback of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1', 'http://ollama.localhost/v1']) {
    assert.deepEqual(addressAdvice(loopback), { advice: 'loopback', trimmed: null }, loopback);
  }
  assert.deepEqual(addressAdvice('http://pc:1234/v1/chat/completions'), { advice: 'endpoint', trimmed: 'http://pc:1234/v1' });
  assert.deepEqual(addressAdvice('http://pc:1234/v1/embeddings'), { advice: 'endpoint', trimmed: 'http://pc:1234/v1' });
  assert.deepEqual(addressAdvice('http://nas.local:1234/v1'), { advice: 'local-name', trimmed: null });
  assert.deepEqual(addressAdvice('http://192.168.30.20:1234/v1'), { advice: null, trimmed: null });
});

test('a package\'s AI variables are named with the keys they read', () => {
  assert.deepEqual(aiVariablesOf(SEARCH_ENV), [{ keys: ['apiKey'], name: 'AI_KEY' }, { keys: ['embeddingModel'], name: 'AI_SEARCH' }]);
  assert.deepEqual(aiVariablesOf(NO_AI_ENV), []);
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

  assert.deepEqual(tested, { ms: 12, ok: true, searched: true });
  const [service] = status.services;
  assert.deepEqual({ ...service, id: 'id' }, {
    baseUrl: 'http://192.168.30.20:1234/v1',
    embeddingModel: 'embed-small',
    id: 'id',
    keyConfigured: true,
    model: 'chat-large',
    name: 'Office PC',
    place: 'home',
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
  await assert.rejects(services.add({ ...input, baseUrl: 'http://localhost:11434/v1' }), { code: 'AI_SERVICE_ADDRESS_LOOPBACK' });
  await assert.rejects(services.test({ ...input, baseUrl: 'http://127.0.0.1:1234/v1' }), { code: 'AI_SERVICE_ADDRESS_LOOPBACK' });
  assert.deepEqual(services.status().services, []);
});

test('a search model is tested where apps will ask it, and its failure is named', async () => {
  const asked = [];
  const { services } = await harness({ embed: async (connection) => { asked.push(connection); throw new AiServiceError('AI_SERVICE_NOT_FOUND', 'No AI service answered at this address.', 502); } });
  await assert.rejects(services.test(input), { code: 'AI_SERVICE_SEARCH_MODEL_FAILED', message: 'The search model did not answer: No AI service answered at this address.' });
  assert.deepEqual(asked, [{ apiKey: KEY, baseUrl: 'http://192.168.30.20:1234/v1', model: 'embed-small' }]);
  assert.deepEqual(await services.test({ ...input, embeddingModel: '' }), { ms: 12, searched: false });

  const { status, test: tested } = await services.add(input);
  assert.equal(tested.ok, false);
  assert.equal(status.services[0].test.error, 'The search model did not answer: No AI service answered at this address.');
});

test('only installed apps that read the AI values are offered', async () => {
  const { services } = await harness();
  const ai = { keys: ['model'], name: 'AI_MODEL' };
  assert.deepEqual(services.status().apps, [
    { aiFeatures: '', name: 'Documents', official: true, packageId: 'documents', readsSearchModel: false, reviewInvalidated: false, running: true, serviceId: null, variables: [ai] },
    { aiFeatures: '', name: 'Stopped', official: true, packageId: 'stopped', readsSearchModel: false, reviewInvalidated: false, running: false, serviceId: null, variables: [ai] },
    { aiFeatures: 'Answers questions about your files.', name: 'Search', official: false, packageId: 'search', readsSearchModel: true, reviewInvalidated: false, running: true, serviceId: null, variables: aiVariablesOf(SEARCH_ENV) },
  ]);
});

test('an app whose privacy review an advisory invalidated says so', async () => {
  const { services } = await harness({ advisories: { documents: [{ type: 'privacy-review-invalidated' }], stopped: [{ type: 'security' }] } });
  assert.deepEqual(services.status().apps.map((app) => [app.packageId, app.reviewInvalidated]), [['documents', true], ['stopped', false], ['search', false]]);
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

test('a stored key is never sent to a new address', async () => {
  const asked = [];
  const { secretDir, services } = await harness({ ask: async (connection) => { asked.push(connection.apiKey); return { ms: 12 }; } });
  const id = (await services.add(input)).status.services[0].id;
  const { apiKey, ...withoutKey } = input;

  assert.deepEqual((await services.check({ baseUrl: 'https://ai.example.com/v1', serviceId: id })).models, ['model-at-https://ai.example.com/v1', '']);
  assert.deepEqual((await services.check({ baseUrl: 'http://192.168.30.20:1234/other', serviceId: id })).models, ['model-at-http://192.168.30.20:1234/other', apiKey]);

  const { status } = await services.update(id, { ...withoutKey, baseUrl: 'https://ai.example.com/v1' });
  assert.equal(status.services[0].keyConfigured, false);
  assert.equal(asked.at(-1), '');
  assert.equal(fs.existsSync(path.join(secretDir, '_settings', `ai-service-${id}.secret`)), false);
});

test('the form can check an address and test with the stored key before saving', async () => {
  const { services } = await harness();
  const id = (await services.add(input)).status.services[0].id;
  assert.deepEqual(await services.check({ baseUrl: 'http://192.168.30.20:1234/v1/', serviceId: id }), {
    advice: null, error: null, message: null, models: ['model-at-http://192.168.30.20:1234/v1', KEY], place: 'home', trimmed: null,
  });
  assert.deepEqual((await services.check({ apiKey: '', baseUrl: 'https://ai.example.com/v1', serviceId: id })).models, ['model-at-https://ai.example.com/v1', '']);
  assert.deepEqual(await services.test({ baseUrl: 'http://pc/v1', model: 'm' }), { ms: 12, searched: false });

  // Neither address can work as typed, so MOS asks nothing there.
  const loopback = await services.check({ baseUrl: 'http://localhost:1234/v1' });
  assert.deepEqual({ ...loopback, message: undefined }, { advice: 'loopback', error: null, message: undefined, models: [], place: 'home', trimmed: null });
  await assert.rejects(services.test({ baseUrl: 'http://localhost:1234/v1', model: 'm' }), { message: loopback.message });
  assert.deepEqual(await services.check({ baseUrl: 'https://ai.example.com/v1/models' }), { advice: 'endpoint', error: null, message: null, models: [], place: 'internet', trimmed: 'https://ai.example.com/v1' });

  services.client.listModels = async () => { throw new AiServiceError('AI_SERVICE_UNREACHABLE', 'MOS could not reach pc.', 502); };
  assert.deepEqual(await services.check({ baseUrl: 'http://pc/v1' }), { advice: null, error: 'MOS could not reach pc.', message: null, models: [], place: 'home', trimmed: null });
});

test('apps that did not restart are named by package id', async () => {
  const { services } = await harness({ restartApp: async (packageId) => { if (packageId === 'search') throw new Error('agent down'); } });
  const id = (await services.add(input)).status.services[0].id;
  await services.setAppService('documents', id);
  await assert.rejects(services.setAppService('search', id), /agent down/u);
  services.serviceStore.setAppService('search', id);
  assert.deepEqual((await services.update(id, input)).restartFailures, ['search']);
  assert.deepEqual((await services.remove(id)).restartFailures, ['search']);
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

  await embed({ ...connection, model: 'e' }, { fetchImpl: answering(200, { data: [{ embedding: [0.1] }] }) });
  assert.equal(calls.at(-1).url, 'http://pc:1234/v1/embeddings');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { input: 'ok', model: 'e' });
  await assert.rejects(embed({ ...connection, model: 'e' }, { fetchImpl: answering(200, {}) }), { code: 'AI_SERVICE_REFUSED' });
});
