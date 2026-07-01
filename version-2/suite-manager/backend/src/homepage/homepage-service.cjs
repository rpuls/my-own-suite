const crypto = require('node:crypto');
const { HOMEPAGE_FILES, HomepageConfigError, publicUrlFor, validateProxy } = require('../../../../shared/homepage-contract.cjs');

function domainStateFor(settings, bootstrapHost) {
  const bootstrapBase = bootstrapHost.startsWith('home.') ? bootstrapHost.slice(5) : bootstrapHost;
  return {
    baseDomain: settings.baseDomain || bootstrapBase,
    tlsMode: settings.tlsMode,
  };
}

class HomepageService {
  constructor({ agent, bootstrapHost, now = () => new Date(), store }) {
    this.agent = agent;
    this.bootstrapHost = bootstrapHost;
    this.now = now;
    this.store = store;
  }

  domainState() { return domainStateFor(this.store.getHttpsSettings(), this.bootstrapHost); }

  async status() {
    try {
      const status = await this.agent.status();
      return { agentAvailable: status?.capabilities?.includes('homepage.apply') === true, files: HOMEPAGE_FILES };
    } catch { return { agentAvailable: false, files: HOMEPAGE_FILES }; }
  }

  async read(body) {
    const result = await this.agent.read(body?.file);
    this.store.recordHomepageRevision({ at: this.now().toISOString(), file: result.file, revision: result.revision });
    return result;
  }

  validate(body) { return this.agent.validate(body?.file, body?.content); }

  async apply(body) {
    return this.runOperation('raw-save', () => this.agent.apply({
      content: body?.content,
      domainState: this.domainState(),
      expectedRevision: body?.expectedRevision,
      file: body?.file,
    }));
  }

  async add(body, homeService) {
    const requestId = typeof body?.requestId === 'string' && body.requestId ? body.requestId : crypto.randomUUID();
    const result = await this.runOperation(homeService ? 'add-home-service' : 'add-link', () => {
      const input = { domainState: this.domainState(), entry: body?.entry, expectedRevision: body?.expectedRevision, requestId };
      return homeService ? this.agent.addHomeService(input) : this.agent.addLink(input);
    });
    return { ...result, requestId };
  }

  async removeLink(body) {
    return this.runOperation('remove-link', () => this.agent.removeLink({
      domainState: this.domainState(),
      expectedRevision: body?.expectedRevision,
      id: body?.id,
    }));
  }

  previewHomeService(body) {
    const proxy = validateProxy({
      subdomain: body?.subdomain,
      upstream: `${body?.protocol}://${body?.host}:${body?.port}`,
    });
    return { publicUrl: publicUrlFor(proxy, this.domainState()), upstream: proxy.upstream };
  }

  async runOperation(kind, operation) {
    const id = crypto.randomUUID();
    const startedAt = this.now().toISOString();
    this.store.startHomepageOperation({ at: startedAt, id, kind });
    try {
      const result = await operation();
      const completedAt = this.now().toISOString();
      this.store.completeHomepageOperation({ at: completedAt, file: result.file, id, revision: result.revision });
      return { ...result, operationId: id };
    } catch (error) {
      this.store.failHomepageOperation({ at: this.now().toISOString(), errorCode: error.code || 'HOMEPAGE_APPLY_FAILED', id });
      if (error instanceof HomepageConfigError || error.statusCode) throw error;
      throw new HomepageConfigError('HOMEPAGE_APPLY_FAILED', 'Homepage could not be applied. The previous dashboard remains active.', 502);
    }
  }
}

module.exports = { HomepageService, domainStateFor };
