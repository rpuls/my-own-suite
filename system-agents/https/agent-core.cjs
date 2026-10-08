const crypto = require('node:crypto');

const { hostingTrack, renderMachineCaddyfile } = require('../../infrastructure/control-plane-runtime.cjs');
const { detectServerAddress, easyDoorBaseDomain } = require('../../shared/easy-door.cjs');
const { normalizeBaseDomain, validBaseDomain, validateHttpsInput } = require('../../shared/https-contract.cjs');
const { SuiteAddressFile } = require('../../shared/suite-address.cjs');
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

const APPLY_KEYS = 'acmeEmail,baseDomain';

// What every Caddyfile this agent writes is rendered from. The install contract
// arrives through the unit's environment, which the managed update rewrites.
function machineFacts() {
  return {
    bootstrapHost: String(process.env.MOS_HOME_HOST || '').trim().toLowerCase(),
    frontDoor: process.env.MOS_FRONT_DOOR || 'ssh-bootstrap',
    liveAddress: detectServerAddress(),
    recorded: new SuiteAddressFile().readOrNull(),
    suiteManagerPort: suiteManagerPort(),
  };
}

function easyDoorBaseOf(facts) {
  return hostingTrack(facts.frontDoor) === 'public-server' ? null : easyDoorBaseDomain(facts.liveAddress);
}

class HttpsAgentCore {
  constructor(adapter, { facts = machineFacts } = {}) {
    this.adapter = adapter;
    this.facts = facts;
    this.queue = Promise.resolve();
  }

  // One Caddyfile, one writer at a time: an ensure landing in the middle of an
  // apply would render over the candidate the apply is waiting on.
  exclusive(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  async status() {
    const modules = await this.adapter.caddyModules().catch(() => []);
    const moduleAvailable = modules.includes('dns.providers.cloudflare');
    return {
      capabilities: [
        ...(moduleAvailable ? ['cloudflare-dns01.apply'] : []),
        ...(modules.includes('dns.providers.acmedns') ? ['easy-door-tls'] : []),
      ],
      moduleAvailable,
      service: 'mos-https-agent',
    };
  }

  // Renders the Caddyfile from the machine's facts and reloads Caddy when that
  // changed it. It does not wait for the Easy Door certificate: issuance is
  // Caddy's background job, and Suite Manager watches for it on its own.
  ensure() {
    return this.exclusive(async () => {
      const facts = this.facts();
      const changed = await this.adapter.ensureCaddyfile(renderMachineCaddyfile(facts));
      return { changed, easyDoorBase: easyDoorBaseOf(facts) };
    });
  }

  // Caddy's latest lines about the Easy Door wildcard, which is the only place
  // the reason a certificate has not arrived yet is written down.
  async easyDoorStatus() {
    const base = easyDoorBaseOf(this.facts());
    return { easyDoorBase: base, log: base ? await this.adapter.certificateLog(`*.${base}`) : [] };
  }

  // Serves a domain from this machine. Succeeds only once Caddy runs the new
  // configuration and holds a trusted certificate for the name: "restarted" was
  // reported as "applied" before this, and an owner read success while every
  // device of theirs still failed.
  //
  // A public server is asked for the domain alone: the authority reaches it over
  // HTTP. A home server proves the domain through Cloudflare with either the
  // token in the request or the one a restore parked beside the live file for
  // exactly this moment — so the owner of a recovered suite never has to find a
  // token stored in the password manager they are recovering.
  apply(rawInput) {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    const publicServer = hostingTrack(this.facts().frontDoor) === 'public-server';
    return this.exclusive(() => (publicServer ? this.applyPublicDomain(input) : this.applyCloudflareDomain(input)));
  }

  async applyPublicDomain(input) {
    if (Object.keys(input).join(',') !== 'baseDomain') {
      throw new HttpsAgentError('INVALID_REQUEST_SHAPE', 'The HTTPS request did not have the expected shape.', { statusCode: 400 });
    }
    const baseDomain = validBaseDomain(input.baseDomain);
    if (!baseDomain) throw new HttpsAgentError('INVALID_BASE_DOMAIN', 'The domain is not one a certificate can be issued for.', { statusCode: 400 });
    return this.serveDomain({ acmeEmail: null, baseDomain });
  }

  async applyCloudflareDomain(input) {
    const keys = Object.keys(input).sort().join(',');
    const useParked = input.useParkedCredential === true;
    if (keys !== `${APPLY_KEYS},${useParked ? 'useParkedCredential' : 'cloudflareApiToken'}`) {
      throw new HttpsAgentError('INVALID_REQUEST_SHAPE', 'The HTTPS request did not have the expected shape.', { statusCode: 400 });
    }
    const cloudflareApiToken = useParked ? await this.adapter.readParkedCredential() : input.cloudflareApiToken;
    const valid = validateHttpsInput({ ...input, cloudflareApiToken });
    if (!(await this.adapter.caddyModules()).includes('dns.providers.cloudflare')) {
      throw new HttpsAgentError('CADDY_MODULE_UNAVAILABLE', 'The installed Caddy build has no Cloudflare DNS module.', { statusCode: 503 });
    }
    await this.adapter.verifyCloudflareAccess(valid.cloudflareApiToken, valid.baseDomain);
    return this.serveDomain({ acmeEmail: valid.acmeEmail, baseDomain: normalizeBaseDomain(valid.baseDomain) }, {
      cloudflareApiToken: valid.cloudflareApiToken,
      usesParkedCredential: useParked,
    });
  }

  async serveDomain(domain, { cloudflareApiToken = null, usesParkedCredential = false } = {}) {
    const rollbackId = crypto.randomUUID();
    await this.adapter.createCheckpoint(rollbackId, { usesParkedCredential });
    try {
      const caddyfile = renderMachineCaddyfile({ ...this.facts(), domain });
      await this.adapter.installCandidate({ caddyfile, cloudflareApiToken });
      await this.adapter.validateCandidate(cloudflareApiToken);
      await this.adapter.reload(cloudflareApiToken);
      await this.adapter.awaitCertificate(`home.${domain.baseDomain}`, cloudflareApiToken);
      return { rollbackId, status: 'applied' };
    } catch (caught) {
      const error = await this.restore(rollbackId, asAgentError(caught, 'Applying the HTTPS configuration'));
      // The adapter masks the token out of anything a command wrote; this is
      // the same mask again, for a reason that came from anywhere else.
      error.details = error.details.map((detail) => maskValues(detail, [cloudflareApiToken]));
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
  commit(rollbackId) {
    return this.exclusive(async () => {
      await this.adapter.commitCheckpoint(rollbackId);
      return { status: 'committed' };
    });
  }

  rollback(rollbackId) {
    return this.exclusive(async () => {
      await this.adapter.restoreCheckpoint(rollbackId);
      await this.adapter.reloadPrevious();
      await this.adapter.removeCheckpoint(rollbackId);
      return { status: 'rolled-back' };
    });
  }

  // The owner declined the domain a restore offered, so the credential that
  // came with it is not kept around.
  async discardParkedCredential() {
    await this.adapter.discardParkedCredential();
    return { status: 'discarded' };
  }
}

module.exports = { HttpsAgentCore, HttpsAgentError };
