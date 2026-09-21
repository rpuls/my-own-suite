// Where this suite is, and how it moves. Reads the one recorded address, decides
// which hosts Suite Manager answers on, and runs the single transaction that
// changes the address — for a domain the owner applies, for a domain a restored
// backup offered, and for an Easy Door name that moved under the machine.
//
// A change is fire-then-poll: the request that starts it gets an answer at once,
// the stages are written to the store as they are reached, and the screen reads
// them back — because a domain change restarts the web server under the very
// connection that asked for it, so the reply to that request is lost by design.

const dns = require('node:dns');
const os = require('node:os');

const { HttpsSettingsError, normalizeBaseDomain, validateHttpsInput } = require('../../../../shared/https-contract.cjs');
const { detectServerAddress, easyDoorHomeHost } = require('../../../../shared/easy-door.cjs');
const { SuiteAddressError, addressForHost, domainAddress } = require('../../../../shared/suite-address.cjs');
const { buildOperationDiagnostics } = require('../diagnostics/operation-diagnostics.cjs');
const { HttpsAgentError } = require('../settings/https-agent-client.cjs');

// The stages of a change, in order. `caddy` only exists for a domain: it is the
// web server rewrite, restart and the wait for the certificate, all inside the
// HTTPS agent's own transaction. `recorded` is the point of no return — after it
// every URL-builder answers with the new address — and `apps` is the rebuild of
// everything that baked the old one in.
const CHANGE_STAGES = Object.freeze(['caddy', 'recorded', 'apps']);
const CHANGE_KINDS = Object.freeze(['domain', 'easy-door']);

function privateHttpsAvailable(frontDoor) {
  return !['cloud-init', 'digitalocean-smoke'].includes(frontDoor);
}

function localAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((entry) => entry && entry.family === 'IPv4').map((entry) => entry.address);
}

// Whether a name points at this machine: true, false, or null when DNS could not
// be asked. Reported, never enforced — the owner creates the override after the
// certificate exists, and MOS reads DNS without ever writing it.
async function resolvesHere(host, resolveHost) {
  let addresses;
  try {
    addresses = await resolveHost(host);
  } catch (error) {
    return ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(error?.code) ? false : null;
  }
  const local = new Set(localAddresses());
  return (addresses || []).some((address) => local.has(address));
}

function defaultResolver() {
  const resolver = new dns.promises.Resolver({ timeout: 2_000, tries: 1 });
  return (host) => resolver.resolve4(host);
}

class SuiteAddressService {
  constructor({
    agent,
    bootstrapHost,
    bootstrapScheme = 'http',
    detectAddress = detectServerAddress,
    frontDoor = process.env.MOS_FRONT_DOOR || 'ssh-bootstrap',
    logger = null,
    now = () => new Date(),
    rebake = async () => ({ skipped: true }),
    resolveHost = defaultResolver(),
    store,
    suiteAddress,
  }) {
    this.agent = agent;
    this.bootstrapHost = String(bootstrapHost || '').toLowerCase().replace(/:\d+$/u, '');
    this.bootstrapScheme = bootstrapScheme === 'https' ? 'https' : 'http';
    this.detectAddress = detectAddress;
    this.frontDoor = frontDoor;
    this.logger = logger;
    this.now = now;
    this.rebake = rebake;
    this.resolveHost = resolveHost;
    this.store = store;
    this.suiteAddress = suiteAddress;
    this.running = null;
  }

  // A machine always has a recorded address once Suite Manager has started on
  // it. The first start records the install-time name; onboarding replaces it
  // with the door the owner actually came through. A change that was running
  // when the process died is closed as failed, because nothing will finish it.
  start() {
    if (!this.suiteAddress.exists()) {
      this.suiteAddress.write(addressForHost(this.bootstrapHost, { scheme: this.bootstrapScheme }), { at: this.now().toISOString(), by: 'install' });
    }
    if (this.store.getAddressChange().status === 'applying') {
      this.store.failAddressChange({ at: this.now().toISOString(), diagnostics: 'Suite Manager restarted while the address was being changed, so the change did not finish. The address it reached is the one recorded now.', errorCode: 'ADDRESS_CHANGE_INTERRUPTED' });
    }
    return this.address();
  }

  address() {
    return this.suiteAddress.read();
  }

  // The Easy Door name this machine answers on right now, or null off a private
  // network. Derived from the live address on every call because that is what
  // it follows; a domain does not close it, because a door is not an address.
  easyDoorHost() {
    return easyDoorHomeHost(this.detectAddress());
  }

  // Every name Suite Manager itself answers on: the recorded address, both
  // doors, and the name a change in flight is moving to — so the screen polling
  // through the new name is admitted the moment Caddy serves it.
  allowedHosts() {
    const change = this.store.getAddressChange();
    return new Set([
      this.bootstrapHost,
      this.suiteAddress.readOrNull()?.host,
      this.easyDoorHost(),
      change.status === 'applying' ? change.target?.host : null,
    ].filter(Boolean));
  }

  // Onboarding: the owner completed setup through this door, so this is where
  // the suite is published from now on.
  recordDoor(host, { scheme }) {
    return this.suiteAddress.write(addressForHost(host, { scheme }), { at: this.now().toISOString(), by: 'onboarding' });
  }

  // The recorded kind is `easy-door` but the machine's live Easy Door name is
  // another: its address moved under it, and everything published still names
  // the old one.
  drift(address = this.address()) {
    if (address.kind !== 'easy-door') return null;
    const live = this.easyDoorHost();
    return live && live !== address.host ? { from: address.host, to: live } : null;
  }

  async status() {
    let agentAvailable = false;
    try {
      const status = await this.agent.status();
      agentAvailable = status?.capabilities?.includes('cloudflare-dns01.apply') === true;
    } catch {}
    const address = this.address();
    const easyDoorHost = this.easyDoorHost();
    const change = this.store.getAddressChange();
    return {
      address: {
        ...address,
        resolvesHere: address.kind === 'domain' ? await resolvesHere(address.host, this.resolveHost) : null,
        url: `${address.scheme}://${address.host}/`,
      },
      agentAvailable,
      bootstrapUrl: `${this.bootstrapScheme}://${this.bootstrapHost}/`,
      drifted: this.drift(address),
      easyDoorUrl: easyDoorHost ? `http://${easyDoorHost}/` : null,
      installContext: this.frontDoor,
      lastChange: {
        at: change.finishedAt || change.startedAt,
        diagnostics: change.diagnostics,
        errorCode: change.errorCode,
        result: change.result,
        stage: change.stage,
        stages: CHANGE_STAGES,
        status: change.status,
        target: change.target,
      },
      offered: this.suiteAddress.readOffer(),
      privateHttpsAvailable: privateHttpsAvailable(this.frontDoor),
      serverAddress: this.detectAddress(),
    };
  }

  // Starts a change and answers before it finishes. Accepted shapes:
  //   { kind: 'domain', baseDomain, acmeEmail, cloudflareApiToken }  the owner's own domain
  //   { kind: 'domain', useOffered: true }                            the domain a restore offered, with its parked credential
  //   { kind: 'easy-door' }                                           follow the machine's live Easy Door name
  async change(rawInput) {
    const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
    if (!CHANGE_KINDS.includes(input.kind)) throw new HttpsSettingsError('INVALID_ADDRESS_CHANGE', 'Only a domain or the Easy Door can be the suite address.');
    const { credential, target } = input.kind === 'domain' ? this.domainTarget(input) : this.easyDoorTarget();
    const startedAt = this.now().toISOString();
    if (!this.store.beginAddressChange({ at: startedAt, target: { host: target.host, kind: target.kind, ...(target.baseDomain ? { baseDomain: target.baseDomain } : {}) } })) {
      throw new HttpsSettingsError('ADDRESS_CHANGE_IN_PROGRESS', 'The suite address is already being changed. Wait for that change to finish.', 409);
    }
    this.running = this.run(target, credential).finally(() => { this.running = null; });
    return { startedAt, status: 'applying', target: { host: target.host, kind: target.kind } };
  }

  domainTarget(input) {
    if (!privateHttpsAvailable(this.frontDoor)) {
      throw new HttpsSettingsError('PRIVATE_HTTPS_UNAVAILABLE', 'Private LAN HTTPS setup is only available for self-host installs.', 409);
    }
    if (input.useOffered === true) {
      const offer = this.suiteAddress.readOffer();
      if (!offer) throw new HttpsSettingsError('NO_OFFERED_ADDRESS', 'No restored backup has offered a domain to this machine.', 409);
      const acmeEmail = String(input.acmeEmail || offer.acmeEmail || '').trim().toLowerCase();
      if (!acmeEmail) throw new HttpsSettingsError('INVALID_ACME_EMAIL', 'Enter a valid ACME contact email address.');
      return { credential: { parked: true }, target: domainAddress({ acmeEmail, baseDomain: offer.baseDomain, provider: 'cloudflare' }) };
    }
    const keys = Object.keys(input).filter((key) => key !== 'kind').sort();
    if (keys.join(',') !== 'acmeEmail,baseDomain,cloudflareApiToken') {
      throw new HttpsSettingsError('INVALID_HTTPS_REQUEST', 'Only the required HTTPS settings are accepted.');
    }
    const valid = validateHttpsInput(input);
    return { credential: { cloudflareApiToken: valid.cloudflareApiToken }, target: domainAddress({ acmeEmail: valid.acmeEmail, baseDomain: valid.baseDomain, provider: 'cloudflare' }) };
  }

  easyDoorTarget() {
    const host = this.easyDoorHost();
    if (!host) throw new HttpsSettingsError('EASY_DOOR_UNAVAILABLE', 'This machine has no Easy Door name: it is not on a private network.', 409);
    return { credential: null, target: addressForHost(host, { scheme: 'http' }) };
  }

  async run(target, credential) {
    const at = () => this.now().toISOString();
    const secrets = credential?.cloudflareApiToken ? [credential.cloudflareApiToken] : [];
    let rollbackId = null;
    try {
      if (target.kind === 'domain') {
        this.store.advanceAddressChange({ stage: 'caddy' });
        const result = await this.agent.apply({
          acmeEmail: target.acmeEmail,
          baseDomain: target.baseDomain,
          bootstrapHost: this.bootstrapHost,
          ...(credential.parked ? { useParkedCredential: true } : { cloudflareApiToken: credential.cloudflareApiToken }),
        });
        rollbackId = typeof result?.rollbackId === 'string' ? result.rollbackId : null;
        if (!rollbackId) throw new Error('HTTPS_AGENT_INVALID_RESPONSE');
      }

      this.store.advanceAddressChange({ stage: 'recorded' });
      try {
        this.suiteAddress.write(target, { at: at(), by: 'change-suite-address' });
      } catch (error) {
        if (rollbackId) { try { await this.agent.rollback(rollbackId); } catch {} }
        rollbackId = null;
        throw error;
      }
      // From here the suite is on the new address. A commit that fails leaves a
      // checkpoint directory behind, nothing more, and must not undo a change
      // the owner may already be looking at through the new name.
      if (rollbackId) { try { await this.agent.commit(rollbackId); } catch {} }
      const offer = this.suiteAddress.readOffer();
      if (target.kind === 'domain' && offer && offer.baseDomain === target.baseDomain) this.suiteAddress.clearOffer();

      this.store.advanceAddressChange({ stage: 'apps' });
      let rebake;
      try {
        rebake = await this.rebake(this.suiteAddress.read());
      } catch (error) {
        this.logger?.error('suite-address-rebake-failed', { error });
        rebake = { errorCode: error?.code || 'APP_PUBLIC_URL_RECONCILE_FAILED', skipped: false, status: 'failed' };
      }
      this.store.completeAddressChange({ at: at(), result: rebake });
    } catch (error) {
      if (rollbackId) { try { await this.agent.rollback(rollbackId); } catch {} }
      // The agent explains its own failures in fixed sentences under a code.
      // Anything else — a store write, a malformed reply — stays behind the
      // generic message, with what went wrong kept for the record.
      const failure = error instanceof HttpsAgentError || error instanceof SuiteAddressError || typeof error?.code === 'string'
        ? error
        : Object.assign(new Error('The suite address could not be changed.'), { code: 'ADDRESS_CHANGE_FAILED', details: [String(error?.message || error)] });
      this.logger?.error('suite-address-change-failed', { code: failure.code, target: target.host });
      this.store.failAddressChange({ at: at(), ...buildOperationDiagnostics(failure, { fallbackCode: 'ADDRESS_CHANGE_FAILED', secrets }) });
    }
  }

  // The offer is gone from Settings and its parked credential is gone from the
  // machine: an owner who says no to a domain is not left holding its token.
  async dismissOffer() {
    const offer = this.suiteAddress.readOffer();
    if (!offer) return { dismissed: false };
    this.suiteAddress.clearOffer();
    try { await this.agent.discardParkedCredential(); } catch (error) { this.logger?.warn('parked-credential-discard-failed', { error }); }
    return { dismissed: true, offer: { baseDomain: normalizeBaseDomain(offer.baseDomain) } };
  }
}

module.exports = { CHANGE_STAGES, SuiteAddressService, privateHttpsAvailable, resolvesHere };
