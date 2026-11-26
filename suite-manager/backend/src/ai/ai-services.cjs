'use strict';

// The AI services an owner added for their apps to call: storing them, proving
// they answer, and choosing which app asks which. An app reads its service
// through the ${ai.*} template namespace, so a change here reaches an app by
// restarting it.

const crypto = require('node:crypto');
const fs = require('node:fs');

const { readSecretValue, secretFilePath, writeSecretFile } = require('../apps/app-package-internals.cjs');
const aiServiceClient = require('./ai-service-client.cjs');
const { AiServiceError } = aiServiceClient;
const { addressAdvice, addressPlace, aiVariablesOf } = require('./ai-service-values.cjs');

// Beside the email relay's password, under the segment no app instance id can take.
const SECRET_INSTANCE = '_settings';
const NAME_MAX = 60;
const MODEL_MAX = 200;
const KEY_MAX = 1000;
const LOOPBACK_REFUSED = "This address means the app itself once it runs in its own container. Use this server's address on your network instead, such as 192.168.1.20. A model server on this server must listen on that address, not only on localhost.";

function text(value, max) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length <= max ? trimmed : null;
}

function baseUrlOf(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

function originOf(baseUrl) {
  try { return new URL(baseUrl).origin; } catch { return null; }
}

function refuseLoopback(baseUrl) {
  if (addressAdvice(baseUrl).advice === 'loopback') throw new AiServiceError('AI_SERVICE_ADDRESS_LOOPBACK', LOOPBACK_REFUSED);
}

function invalidatesReview(advisory) {
  return advisory?.type === 'privacy-review-invalidated';
}

class AiServices {
  // hostingTrack is 'home-server' or 'public-server'; without it no address is called home.
  constructor({ appPackages, client = aiServiceClient, hostingTrack = null, now = () => new Date(), restartApp, secretDir, serviceStore, store }) {
    this.appPackages = appPackages;
    this.client = client;
    this.hostingTrack = hostingTrack;
    this.now = now;
    this.restartApp = restartApp;
    this.secretDir = secretDir;
    this.serviceStore = serviceStore;
    this.store = store;
  }

  // Installed apps whose package reads ${ai.*}: the only ones a service can be given to.
  apps() {
    const uses = new Map(this.serviceStore.appUses().map((use) => [use.packageId, use.serviceId]));
    const apps = [];
    for (const instance of this.store.getAppInstances()) {
      let manifest;
      try { ({ manifest } = this.appPackages.installedPackageFor(instance)); } catch { continue; }
      const variables = aiVariablesOf(manifest);
      if (!variables.length) continue;
      apps.push({
        aiFeatures: typeof manifest.catalog?.aiFeatures === 'string' ? manifest.catalog.aiFeatures.trim() : '',
        name: instance.displayNameSnapshot || manifest.name || instance.packageId,
        official: instance.sourceKind !== 'external-git',
        packageId: instance.packageId,
        readsSearchModel: variables.some((variable) => variable.keys.includes('embeddingModel')),
        reviewInvalidated: this.appPackages.packageAdvisoriesFor(instance, instance.packageId).some(invalidatesReview),
        running: instance.status === 'installed',
        serviceId: uses.get(instance.packageId) || null,
        variables,
      });
    }
    return apps;
  }

  status() {
    return {
      apps: this.apps(),
      services: this.serviceStore.list().map((service) => ({
        baseUrl: service.baseUrl,
        embeddingModel: service.embeddingModel,
        id: service.id,
        keyConfigured: Boolean(service.keyRef),
        model: service.model,
        name: service.name,
        place: addressPlace(service.baseUrl, this.hostingTrack),
        test: { at: service.testedAt, error: service.testError },
      })),
    };
  }

  storedKey(service) {
    return service?.keyRef ? readSecretValue(this.secretDir, service.keyRef) : '';
  }

  // What the form holds. An edit that leaves the key field alone keeps the stored
  // key, but only for the origin it was saved with: an old key never goes to a new address.
  connectionOf(input = {}) {
    const baseUrl = baseUrlOf(input.baseUrl);
    if (!baseUrl) throw new AiServiceError('AI_SERVICE_ADDRESS_INVALID', 'Enter the address of the AI service, starting with http:// or https://.');
    const typed = typeof input.apiKey === 'string';
    const saved = typed ? null : this.serviceStore.byId(String(input.serviceId || ''));
    const keyKept = Boolean(saved?.keyRef) && originOf(saved.baseUrl) === originOf(baseUrl);
    const apiKey = typed ? text(input.apiKey, KEY_MAX) : keyKept ? this.storedKey(saved) : '';
    if (apiKey === null) throw new AiServiceError('AI_SERVICE_KEY_INVALID', 'That API key is too long.');
    return { apiKey, baseUrl, keyKept };
  }

  fieldsOf(input = {}) {
    const name = text(input.name, NAME_MAX);
    if (!name) throw new AiServiceError('AI_SERVICE_NAME_INVALID', `Give the service a name of at most ${NAME_MAX} characters.`);
    const connection = this.connectionOf(input);
    refuseLoopback(connection.baseUrl);
    return { ...connection, ...this.modelsOf(input), name };
  }

  modelsOf(input) {
    const model = text(input.model, MODEL_MAX);
    if (!model) throw new AiServiceError('AI_SERVICE_MODEL_INVALID', 'Choose a model.');
    const embeddingModel = text(input.embeddingModel, MODEL_MAX);
    if (embeddingModel === null) throw new AiServiceError('AI_SERVICE_MODEL_INVALID', 'That search model name is too long.');
    return { embeddingModel: embeddingModel || null, model };
  }

  // What the form learns from an address before saving: where it is, what to warn
  // about, and which models answer there. An address that cannot be reached still says where it is.
  async check(input) {
    const { apiKey, baseUrl } = this.connectionOf(input);
    const { advice, trimmed } = addressAdvice(baseUrl);
    const found = { advice, error: null, message: advice === 'loopback' ? LOOPBACK_REFUSED : null, models: [], place: addressPlace(baseUrl, this.hostingTrack), trimmed };
    if (advice === 'loopback' || advice === 'endpoint') return found;
    try {
      return { ...found, models: await this.client.listModels({ apiKey, baseUrl }) };
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error;
      return { ...found, error: error.message };
    }
  }

  // Tests what is in the form, saved or not.
  async test(input = {}) {
    const { apiKey, baseUrl } = this.connectionOf(input);
    refuseLoopback(baseUrl);
    return this.probe({ apiKey, baseUrl, ...this.modelsOf(input) });
  }

  // The chat model answers one question, then the search model, when there is one, makes one embedding.
  async probe({ apiKey, baseUrl, embeddingModel, model }) {
    const { ms } = await this.client.ask({ apiKey, baseUrl, model });
    if (!embeddingModel) return { ms, searched: false };
    try {
      await this.client.embed({ apiKey, baseUrl, model: embeddingModel });
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error;
      throw new AiServiceError('AI_SERVICE_SEARCH_MODEL_FAILED', `The search model did not answer: ${error.message}`, error.statusCode);
    }
    return { ms, searched: true };
  }

  async testStored(id) {
    const service = this.require(id);
    let test;
    try {
      test = { ...await this.probe({ ...service, apiKey: this.storedKey(service) }), ok: true };
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error;
      test = { error: error.message, ok: false };
    }
    this.serviceStore.recordTest(id, { at: this.now().toISOString(), error: test.ok ? null : test.error });
    return test;
  }

  // Saved whether or not the test passes: the owner may be right where the probe is wrong.
  async add(input) {
    const { keyKept, ...fields } = this.fieldsOf(input);
    const id = crypto.randomUUID();
    this.serviceStore.create({ ...fields, at: this.now().toISOString(), id, keyRef: this.writeKey(id, fields.apiKey) });
    const test = await this.testStored(id);
    return { status: this.status(), test };
  }

  async update(id, input) {
    const service = this.require(id);
    const { keyKept, ...fields } = this.fieldsOf({ ...input, serviceId: id });
    const keyRef = keyKept ? service.keyRef : this.writeKey(id, fields.apiKey);
    this.serviceStore.update(id, { ...fields, keyRef });
    const test = await this.testStored(id);
    const restartFailures = await this.restartAll(this.appsUsing(id));
    return { restartFailures, status: this.status(), test };
  }

  async remove(id) {
    this.require(id);
    const apps = this.appsUsing(id);
    this.serviceStore.remove(id);
    fs.rmSync(secretFilePath(this.secretDir, SECRET_INSTANCE, `ai-service-${id}`), { force: true });
    const restartFailures = await this.restartAll(apps);
    return { restartFailures, status: this.status() };
  }

  // A failed restart puts the choice back, so the switch never shows what the app is not running with.
  async setAppService(packageId, serviceId) {
    const app = this.apps().find((candidate) => candidate.packageId === packageId);
    if (!app) throw new AiServiceError('AI_SERVICE_APP_UNSUPPORTED', 'This app has no AI features that ask an AI service.', 404);
    if (serviceId) this.require(serviceId);
    this.serviceStore.setAppService(packageId, serviceId || null);
    if (app.running) {
      try {
        await this.restartApp(packageId);
      } catch (error) {
        this.serviceStore.setAppService(packageId, app.serviceId);
        throw error;
      }
    }
    return this.status();
  }

  appsUsing(id) {
    return this.apps().filter((app) => app.serviceId === id);
  }

  // The package ids of the apps that did not restart.
  async restartAll(apps) {
    const failures = [];
    for (const app of apps.filter((candidate) => candidate.running)) {
      try { await this.restartApp(app.packageId); } catch { failures.push(app.packageId); }
    }
    return failures;
  }

  require(id) {
    const service = this.serviceStore.byId(String(id || ''));
    if (!service) throw new AiServiceError('AI_SERVICE_NOT_FOUND', 'That AI service no longer exists.', 404);
    return service;
  }

  writeKey(id, apiKey) {
    if (apiKey) return writeSecretFile(this.secretDir, SECRET_INSTANCE, `ai-service-${id}`, apiKey);
    fs.rmSync(secretFilePath(this.secretDir, SECRET_INSTANCE, `ai-service-${id}`), { force: true });
    return null;
  }
}

module.exports = { AiServices };
