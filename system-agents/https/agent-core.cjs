const crypto = require('node:crypto');

const { renderHttpsCaddyfile } = require('../../infrastructure/control-plane-runtime.cjs');
const { validateHttpsInput } = require('../../shared/https-contract.cjs');
const { describeFailure, maskValues } = require('../lib/command-output.cjs');

// A failure the agent can explain. `message` is a fixed sentence the owner
// reads; `details` is the reason behind it — the failing command's last
// output, or what Cloudflare answered — and never a command line or the token.
class HttpsAgentError extends Error {
  constructor(code, message, { details = [], statusCode = 502 } = {}) {
    super(message);
    this.name = 'HttpsAgentError';
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

function asAgentError(error, what) {
  if (error instanceof HttpsAgentError) return error;
  return new HttpsAgentError('HTTPS_APPLY_FAILED', 'HTTPS could not be applied.', { details: describeFailure(error, what) });
}

function reasons(error) {
  return [error.message, ...error.details];
}

function suiteManagerPort() {
  const port = String(process.env.MOS_SUITE_MANAGER_PORT || '3100').trim();
  if (!/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65535) {
    throw new HttpsAgentError('INVALID_SUITE_MANAGER_PORT', 'The Suite Manager port this agent was started with is not valid.', { statusCode: 500 });
  }
  return port;
}

class HttpsAgentCore {
  constructor(adapter) {
    this.adapter = adapter;
  }

  async status() {
    const moduleAvailable = await this.adapter.hasCloudflareModule().catch(() => false);
    return {
      capabilities: moduleAvailable ? ['cloudflare-dns01.apply'] : [],
      moduleAvailable,
      service: 'mos-https-agent',
    };
  }

  async apply(rawInput) {
    const keys = Object.keys(rawInput && typeof rawInput === 'object' ? rawInput : {}).sort();
    if (keys.join(',') !== 'acmeEmail,baseDomain,bootstrapHost,cloudflareApiToken') {
      throw new HttpsAgentError('INVALID_REQUEST_SHAPE', 'The HTTPS request did not have the expected shape.', { statusCode: 400 });
    }
    const input = validateHttpsInput(rawInput);
    const bootstrapHost = String(rawInput?.bootstrapHost || '').trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(bootstrapHost)) {
      throw new HttpsAgentError('INVALID_BOOTSTRAP_HOST', 'The bootstrap host name is not valid.', { statusCode: 400 });
    }
    if (!await this.adapter.hasCloudflareModule()) {
      throw new HttpsAgentError('CADDY_MODULE_UNAVAILABLE', 'The installed Caddy build has no Cloudflare DNS module.', { statusCode: 503 });
    }
    await this.adapter.verifyCloudflareAccess(input.cloudflareApiToken, input.baseDomain);

    const rollbackId = crypto.randomUUID();
    await this.adapter.createCheckpoint(rollbackId);
    try {
      const caddyfile = renderHttpsCaddyfile({
        acmeEmail: input.acmeEmail,
        baseDomain: input.baseDomain,
        bootstrapHost,
        suiteManagerPort: suiteManagerPort(),
      });
      await this.adapter.installCandidate({ caddyfile, cloudflareApiToken: input.cloudflareApiToken });
      await this.adapter.validateCandidate(input.cloudflareApiToken);
      await this.adapter.reload(input.cloudflareApiToken);
      return { rollbackId, status: 'applied' };
    } catch (caught) {
      const error = await this.restore(rollbackId, asAgentError(caught, 'Applying the HTTPS configuration'));
      // The adapter masks the token out of anything a command wrote; this is
      // the same mask again, for a reason that came from anywhere else.
      error.details = error.details.map((detail) => maskValues(detail, [input.cloudflareApiToken]));
      throw error;
    }
  }

  // Puts the checkpoint back after a failed apply. A restore that fails too
  // keeps the checkpoint on disk and reports both reasons, the apply's first.
  async restore(rollbackId, error) {
    try {
      await this.adapter.restoreCheckpoint(rollbackId);
      await this.adapter.reloadPrevious();
    } catch (restoreError) {
      return new HttpsAgentError('HTTPS_RESTORE_FAILED', 'HTTPS could not be applied, and the previous configuration could not be put back.', {
        details: [...reasons(error), 'Restoring the previous configuration then failed too:', ...reasons(asAgentError(restoreError, 'Restoring the previous configuration'))],
      });
    }
    await this.adapter.removeCheckpoint(rollbackId).catch(() => {});
    return error;
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

module.exports = { HttpsAgentCore, HttpsAgentError };
