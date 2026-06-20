const crypto = require('node:crypto');

const { renderHttpsCaddyfile } = require('../../infrastructure/control-plane-runtime.cjs');
const { validateHttpsInput } = require('../../shared/https-contract.cjs');

class HttpsAgentCore {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async status() {
    const moduleAvailable = await this.adapter.hasCloudflareModule().catch(() => false);
    return {
      capabilities: moduleAvailable ? ['cloudflare-dns01.apply'] : [],
      moduleAvailable,
      service: 'mos-v2-https-agent',
    };
  }

  async apply(rawInput) {
    const keys = Object.keys(rawInput && typeof rawInput === 'object' ? rawInput : {}).sort();
    if (keys.join(',') !== 'acmeEmail,baseDomain,bootstrapHost,cloudflareApiToken') {
      throw new Error('INVALID_REQUEST_SHAPE');
    }
    const input = validateHttpsInput(rawInput);
    const bootstrapHost = String(rawInput?.bootstrapHost || '').trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(bootstrapHost)) {
      throw new Error('INVALID_BOOTSTRAP_HOST');
    }
    if (!await this.adapter.hasCloudflareModule()) {
      throw new Error('CADDY_MODULE_UNAVAILABLE');
    }
    await this.adapter.verifyCloudflareAccess(input.cloudflareApiToken, input.baseDomain);

    const rollbackId = crypto.randomUUID();
    await this.adapter.createCheckpoint(rollbackId);
    try {
      const caddyfile = renderHttpsCaddyfile({
        acmeEmail: input.acmeEmail,
        baseDomain: input.baseDomain,
        bootstrapHost,
      });
      await this.adapter.installCandidate({ caddyfile, cloudflareApiToken: input.cloudflareApiToken });
      await this.adapter.validateCandidate(input.cloudflareApiToken);
      await this.adapter.reload(input.cloudflareApiToken);
      return { rollbackId, status: 'applied' };
    } catch {
      await this.adapter.restoreCheckpoint(rollbackId);
      await this.adapter.reloadPrevious().catch(() => {});
      await this.adapter.removeCheckpoint(rollbackId).catch(() => {});
      throw new Error('HTTPS_APPLY_FAILED');
    }
  }

  async commit(rollbackId) {
    await this.adapter.removeCheckpoint(rollbackId);
    return { status: 'committed' };
  }

  async rollback(rollbackId) {
    await this.adapter.restoreCheckpoint(rollbackId);
    await this.adapter.reloadPrevious();
    await this.adapter.removeCheckpoint(rollbackId);
    return { status: 'rolled-back' };
  }
}

module.exports = { HttpsAgentCore };
