const { HttpsSettingsError, validateHttpsInput } = require('../../../../shared/https-contract.cjs');
const { detectServerAddress, easyDoorHomeHost } = require('../../../../shared/easy-door.cjs');
const { buildOperationDiagnostics } = require('../diagnostics/operation-diagnostics.cjs');
const { HttpsAgentError } = require('./https-agent-client.cjs');

function homeHostFor(baseDomain) {
  return baseDomain ? `home.${baseDomain}` : null;
}

function privateHttpsAvailable(frontDoor) {
  return !['cloud-init', 'digitalocean-smoke'].includes(frontDoor);
}

function publicStatus(settings, bootstrapHost, agentAvailable, {
  frontDoor = 'ssh-bootstrap',
  serverAddress = detectServerAddress(),
} = {}) {
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
    installContext: frontDoor,
    privateHttpsAvailable: privateHttpsAvailable(frontDoor),
    provider: settings.provider,
    serverAddress,
    tlsMode: settings.tlsMode,
    tokenConfigured: settings.tlsMode === 'cloudflare-dns01',
  };
}

class HttpsSettingsService {
  constructor({ agent, bootstrapHost, detectAddress = detectServerAddress, frontDoor = process.env.MOS_FRONT_DOOR || 'ssh-bootstrap', now = () => new Date(), store }) {
    this.agent = agent;
    this.bootstrapHost = bootstrapHost;
    this.detectAddress = detectAddress;
    this.frontDoor = frontDoor;
    this.now = now;
    this.store = store;
  }

  // The Easy Door name this machine answers on right now, or null. Derived on
  // every call and stored nowhere: it follows the machine's address, and it has
  // to stop being served the moment a real domain takes over, which is the same
  // moment Caddy stops serving the door.
  easyDoorHost(settings = this.store.getHttpsSettings()) {
    if (settings.tlsMode === 'cloudflare-dns01') return null;
    return easyDoorHomeHost(this.detectAddress());
  }

  allowedHosts() {
    const settings = this.store.getHttpsSettings();
    return new Set([
      this.bootstrapHost,
      homeHostFor(settings.baseDomain),
      homeHostFor(settings.pendingBaseDomain),
      this.easyDoorHost(settings),
    ].filter(Boolean));
  }

  publicUrlSchemeForHost(host, fallback = 'http') {
    const settings = this.store.getHttpsSettings();
    const normalizedHost = String(host || '').trim().toLowerCase();
    if (settings.tlsMode === 'cloudflare-dns01' && normalizedHost === homeHostFor(settings.baseDomain)) {
      return 'https';
    }
    return fallback === 'https' ? 'https' : 'http';
  }

  async status() {
    let agentAvailable = false;
    try {
      const status = await this.agent.status();
      agentAvailable = status?.capabilities?.includes('cloudflare-dns01.apply') === true;
    } catch {}
    return publicStatus(this.store.getHttpsSettings(), this.bootstrapHost, agentAvailable, { frontDoor: this.frontDoor });
  }

  async apply(rawInput) {
    if (!privateHttpsAvailable(this.frontDoor)) {
      throw new HttpsSettingsError(
        'PRIVATE_HTTPS_UNAVAILABLE',
        'Private LAN HTTPS setup is only available for self-host installs.',
        409,
      );
    }
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
    } catch (error) {
      if (rollbackId && this.store.getHttpsSettings().lastApplyStatus !== 'applied') {
        try { await this.agent.rollback(rollbackId); } catch {}
      }
      // The agent explains its own failures in fixed sentences. Anything else —
      // a store write, a malformed reply — stays behind the generic message,
      // with what went wrong kept for the record.
      const failure = error instanceof HttpsAgentError
        ? error
        : Object.assign(new Error('HTTPS could not be applied.'), { code: 'HTTPS_APPLY_FAILED', details: [String(error?.message || error)] });
      this.store.failHttpsApply({
        at: this.now().toISOString(),
        ...buildOperationDiagnostics(failure, { fallbackCode: 'HTTPS_APPLY_FAILED', secrets: [input.cloudflareApiToken] }),
      });
      throw new HttpsSettingsError(failure.code, `${failure.message} The previous configuration remains active.`, failure.statusCode || 502);
    }
  }
}

module.exports = { HttpsSettingsService, detectServerAddress, homeHostFor, privateHttpsAvailable, publicStatus };
