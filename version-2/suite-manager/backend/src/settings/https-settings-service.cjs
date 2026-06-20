const { HttpsSettingsError, validateHttpsInput } = require('../../../../shared/https-contract.cjs');

function homeHostFor(baseDomain) {
  return baseDomain ? `home.${baseDomain}` : null;
}

function publicStatus(settings, bootstrapHost, agentAvailable) {
  const homeHost = homeHostFor(settings.baseDomain);
  return {
    acmeEmail: settings.acmeEmail,
    activeHomeUrl: homeHost ? `https://${homeHost}/` : `http://${bootstrapHost}/`,
    agentAvailable,
    baseDomain: settings.baseDomain,
    bootstrapUrl: `http://${bootstrapHost}/`,
    lastApply: {
      at: settings.lastApplyAt,
      diagnostics: settings.lastApplyDiagnostics,
      errorCode: settings.lastApplyErrorCode,
      status: settings.lastApplyStatus,
    },
    provider: settings.provider,
    tlsMode: settings.tlsMode,
    tokenConfigured: settings.tlsMode === 'cloudflare-dns01',
  };
}

class HttpsSettingsService {
  constructor({ agent, bootstrapHost, now = () => new Date(), store }) {
    this.agent = agent;
    this.bootstrapHost = bootstrapHost;
    this.now = now;
    this.store = store;
  }

  allowedHosts() {
    const settings = this.store.getHttpsSettings();
    return new Set([
      this.bootstrapHost,
      homeHostFor(settings.baseDomain),
      homeHostFor(settings.pendingBaseDomain),
    ].filter(Boolean));
  }

  async status() {
    let agentAvailable = false;
    try {
      const status = await this.agent.status();
      agentAvailable = status?.capabilities?.includes('cloudflare-dns01.apply') === true;
    } catch {}
    return publicStatus(this.store.getHttpsSettings(), this.bootstrapHost, agentAvailable);
  }

  async apply(rawInput) {
    const keys = Object.keys(rawInput && typeof rawInput === 'object' ? rawInput : {}).sort();
    if (keys.join(',') !== 'acmeEmail,baseDomain,cloudflareApiToken') {
      throw new HttpsSettingsError('INVALID_HTTPS_REQUEST', 'Only the required HTTPS settings are accepted.');
    }
    const input = validateHttpsInput(rawInput);
    const startedAt = this.now().toISOString();
    this.store.beginHttpsApply({ acmeEmail: input.acmeEmail, baseDomain: input.baseDomain, at: startedAt });
    let rollbackId = null;

    try {
      const result = await this.agent.apply({
        acmeEmail: input.acmeEmail,
        baseDomain: input.baseDomain,
        bootstrapHost: this.bootstrapHost,
        cloudflareApiToken: input.cloudflareApiToken,
      });
      rollbackId = typeof result?.rollbackId === 'string' ? result.rollbackId : null;
      if (!rollbackId) throw new Error('HTTPS_AGENT_INVALID_RESPONSE');
      const completedAt = this.now().toISOString();
      try {
        this.store.completeHttpsApply(completedAt);
      } catch (error) {
        try { await this.agent.rollback(rollbackId); } catch {}
        rollbackId = null;
        throw error;
      }
      try { await this.agent.commit(rollbackId); } catch {}
      return {
        appliedAt: completedAt,
        bootstrapUrl: `http://${this.bootstrapHost}/`,
        homeUrl: `https://${homeHostFor(input.baseDomain)}/`,
        status: 'applied',
      };
    } catch {
      if (rollbackId && this.store.getHttpsSettings().lastApplyStatus !== 'applied') {
        try { await this.agent.rollback(rollbackId); } catch {}
      }
      this.store.failHttpsApply({ at: this.now().toISOString(), errorCode: 'HTTPS_APPLY_FAILED' });
      throw new HttpsSettingsError('HTTPS_APPLY_FAILED', 'HTTPS could not be applied. The previous configuration remains active.', 502);
    }
  }
}

module.exports = { HttpsSettingsService, homeHostFor, publicStatus };
