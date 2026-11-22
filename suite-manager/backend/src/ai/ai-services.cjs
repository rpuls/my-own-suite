'use strict';

// The AI services an owner added for their apps to call: storing them, proving
// they answer, and choosing which app uses which. An app reads its service
// through the ${ai.*} template namespace, so a change here reaches an app by
// restarting it.

const crypto = require('node:crypto');
const fs = require('node:fs');

const { readSecretValue, secretFilePath, writeSecretFile } = require('../apps/app-package-internals.cjs');
const aiServiceClient = require('./ai-service-client.cjs');
const { AiServiceError } = aiServiceClient;
const { addressLocality, manifestUsesAi } = require('./ai-service-values.cjs');

// Beside the email relay's password, under the segment no app instance id can take.
const SECRET_INSTANCE = '_settings';
const NAME_MAX = 60;
const MODEL_MAX = 200;
const KEY_MAX = 1000;

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

class AiServices {
  constructor({ appPackages, client = aiServiceClient, now = () => new Date(), restartApp, secretDir, serviceStore, store }) {
    this.appPackages = appPackages;
    this.client = client;
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
      if (!manifestUsesAi(manifest)) continue;
      apps.push({
        name: instance.displayNameSnapshot || manifest.name || instance.packageId,
        packageId: instance.packageId,
        running: instance.status === 'installed',
        serviceId: uses.get(instance.packageId) || null,
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
        locality: addressLocality(service.baseUrl),
        model: service.model,
        name: service.name,
        test: { at: service.testedAt, error: service.testError },
      })),
    };
  }

  storedKey(service) {
    return service?.keyRef ? readSecretValue(this.secretDir, service.keyRef) : '';
  }

  // What the form holds, with the stored key standing in when an edit leaves the key field alone.
  connectionOf(input = {}) {
    const baseUrl = baseUrlOf(input.baseUrl);
    if (!baseUrl) throw new AiServiceError('AI_SERVICE_ADDRESS_INVALID', 'Enter the address of the AI service, starting with http:// or https://.');
    const apiKey = typeof input.apiKey === 'string' ? text(input.apiKey, KEY_MAX) : this.storedKey(this.serviceStore.byId(String(input.serviceId || '')));
    if (apiKey === null) throw new AiServiceError('AI_SERVICE_KEY_INVALID', 'That API key is too long.');
    return { apiKey, baseUrl };
  }

  fieldsOf(input = {}) {
    const name = text(input.name, NAME_MAX);
    if (!name) throw new AiServiceError('AI_SERVICE_NAME_INVALID', `Give the service a name of at most ${NAME_MAX} characters.`);
    const model = text(input.model, MODEL_MAX);
    if (!model) throw new AiServiceError('AI_SERVICE_MODEL_INVALID', 'Choose a model.');
    const embeddingModel = text(input.embeddingModel, MODEL_MAX);
    if (embeddingModel === null) throw new AiServiceError('AI_SERVICE_MODEL_INVALID', 'That search model name is too long.');
    return { ...this.connectionOf(input), embeddingModel: embeddingModel || null, model, name };
  }

  // What the form learns from an address before saving: where it is, and which
  // models answer there. A service that cannot be reached still says where it is.
  async check(input) {
    const connection = this.connectionOf(input);
    const locality = addressLocality(connection.baseUrl);
    try {
      return { error: null, locality, models: await this.client.listModels(connection) };
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error;
      return { error: error.message, locality, models: [] };
    }
  }

  // Tests what is in the form, saved or not.
  test(input = {}) {
    const model = text(input.model, MODEL_MAX);
    if (!model) throw new AiServiceError('AI_SERVICE_MODEL_INVALID', 'Choose a model.');
    return this.client.ask({ ...this.connectionOf(input), model });
  }

  async testStored(id) {
    const service = this.require(id);
    let test;
    try {
      test = { ...await this.client.ask({ apiKey: this.storedKey(service), baseUrl: service.baseUrl, model: service.model }), ok: true };
    } catch (error) {
      if (!(error instanceof AiServiceError)) throw error;
      test = { error: error.message, ok: false };
    }
    this.serviceStore.recordTest(id, { at: this.now().toISOString(), error: test.ok ? null : test.error });
    return test;
  }

  // Saved whether or not the test passes: the owner may be right where the probe is wrong.
  async add(input) {
    const fields = this.fieldsOf(input);
    const id = crypto.randomUUID();
    this.serviceStore.create({ ...fields, at: this.now().toISOString(), id, keyRef: this.writeKey(id, fields.apiKey) });
    const test = await this.testStored(id);
    return { status: this.status(), test };
  }

  async update(id, input) {
    const service = this.require(id);
    const fields = this.fieldsOf({ ...input, serviceId: id });
    const keyRef = typeof input.apiKey === 'string' ? this.writeKey(id, fields.apiKey) : service.keyRef;
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
    if (!app) throw new AiServiceError('AI_SERVICE_APP_UNSUPPORTED', 'This app cannot use an AI service.', 404);
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

  async restartAll(apps) {
    const failures = [];
    for (const app of apps.filter((candidate) => candidate.running)) {
      try { await this.restartApp(app.packageId); } catch { failures.push(app.name); }
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
