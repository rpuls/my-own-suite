const crypto = require('node:crypto');

const { renderHttpsCaddyfile } = require('../../infrastructure/control-plane-runtime.cjs');
const { normalizeBaseDomain, validateHttpsInput } = require('../../shared/https-contract.cjs');
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

const APPLY_KEYS = 'acmeEmail,baseDomain,bootstrapHost';

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

  // Serves a domain from this machine. Succeeds only once Caddy runs the new
  // configuration and holds a trusted certificate for the name: "restarted" was
  // reported as "applied" before this, and an owner read success while every
  // device of theirs still failed.
  //
  // The credential is either the token in the request or the one a restore
  // parked beside the live file for exactly this moment — so the owner of a
  // recovered suite never has to find a token stored in the password manager
  // they are recovering.
  async apply(rawInput) {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const keys = Object.keys(input).sort().join(',');
    const useParked = input.useParkedCredential === true;
    if (keys !== `${APPLY_KEYS},${useParked ? 'useParkedCredential' : 'cloudflareApiToken'}`) {
      throw new HttpsAgentError('INVALID_REQUEST_SHAPE', 'The HTTPS request did not have the expected shape.', { statusCode: 400 });
    }
    const bootstrapHost = String(input.bootstrapHost || '').trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(bootstrapHost)) {
      throw new HttpsAgentError('INVALID_BOOTSTRAP_HOST', 'The bootstrap host name is not valid.', { statusCode: 400 });
    }
    const cloudflareApiToken = useParked ? await this.adapter.readParkedCredential() : input.cloudflareApiToken;
    const valid = validateHttpsInput({ ...input, cloudflareApiToken });
    if (!await this.adapter.hasCloudflareModule()) {
      throw new HttpsAgentError('CADDY_MODULE_UNAVAILABLE', 'The installed Caddy build has no Cloudflare DNS module.', { statusCode: 503 });
    }
    await this.adapter.verifyCloudflareAccess(valid.cloudflareApiToken, valid.baseDomain);

    const rollbackId = crypto.randomUUID();
    await this.adapter.createCheckpoint(rollbackId, { usesParkedCredential: useParked });
    try {
      const caddyfile = renderHttpsCaddyfile({
        acmeEmail: valid.acmeEmail,
        baseDomain: valid.baseDomain,
        bootstrapHost,
        suiteManagerPort: suiteManagerPort(),
      });
      await this.adapter.installCandidate({ caddyfile, cloudflareApiToken: valid.cloudflareApiToken });
      await this.adapter.validateCandidate(valid.cloudflareApiToken);
      await this.adapter.reload(valid.cloudflareApiToken);
      await this.adapter.awaitCertificate(`home.${normalizeBaseDomain(valid.baseDomain)}`, valid.cloudflareApiToken);
      return { rollbackId, status: 'applied' };
    } catch (caught) {
      const error = await this.restore(rollbackId, asAgentError(caught, 'Applying the HTTPS configuration'));
      // The adapter masks the token out of anything a command wrote; this is
      // the same mask again, for a reason that came from anywhere else.
      error.details = error.details.map((detail) => maskValues(detail, [valid.cloudflareApiToken]));
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

  // The change is final: the checkpoint goes, and so does a parked credential
  // the apply consumed, because the live file now holds it.
  async commit(rollbackId) {
    await this.adapter.commitCheckpoint(rollbackId);
    return { status: 'committed' };
  }

  async rollback(rollbackId) {
    await this.adapter.restoreCheckpoint(rollbackId);
    await this.adapter.reloadPrevious();
    await this.adapter.removeCheckpoint(rollbackId);
    return { status: 'rolled-back' };
  }

  // The owner declined the domain a restore offered, so the credential that
  // came with it is not kept around.
  async discardParkedCredential() {
    await this.adapter.discardParkedCredential();
    return { status: 'discarded' };
  }
}

module.exports = { HttpsAgentCore, HttpsAgentError };
