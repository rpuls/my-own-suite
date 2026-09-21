// The suite's one recorded address: where this machine publishes its apps and
// Homepage. It is a fact written down at the moment a request reveals it, not
// something derived on demand from a settings row, an environment variable or a
// request header — three derivations of "where is this suite" is how a restored
// machine ended up serving a name its own Suite Manager refused.
//
// The file lives beside the state a restore replaces and is never part of a
// backup: the address belongs to the machine, not to the data. Suite Manager
// writes it — the install-time name the first time it starts on a machine with
// none, the door the owner came in through when they finish setup, and the new
// address at the end of a change — and every other module only reads it.
//
// A door is not an address. The Easy Door and the install-time name are always
// answered for Suite Manager whatever this file says; only what is published in
// app configuration, app routes and Homepage links is single-valued, and that
// is what this file holds.
//
// An offer is the address a restored backup was on, kept in its own file next
// to the address so the restore never touches the address itself. Settings
// turns it into a change when the owner asks.

const fs = require('node:fs');
const path = require('node:path');

const { EASY_DOOR_HOME_HOST_REGEXP } = require('./easy-door.cjs');

const SUITE_ADDRESS_DIRNAME = 'suite-address';
const ADDRESS_FILENAME = 'address.json';
const OFFER_FILENAME = 'offered.json';
const ADDRESS_KINDS = Object.freeze(['lan-name', 'easy-door', 'domain']);
const DEFAULT_STATE_ROOT = '/var/lib/mos';
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const EASY_DOOR_HOST = new RegExp(EASY_DOOR_HOME_HOST_REGEXP, 'u');

class SuiteAddressError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = 'SuiteAddressError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function suiteAddressDir(stateRoot = process.env.MOS_STATE_ROOT || DEFAULT_STATE_ROOT) {
  return process.env.MOS_SUITE_ADDRESS_DIR || path.join(stateRoot, SUITE_ADDRESS_DIRNAME);
}

function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/:\d+$/u, '').replace(/\.$/u, '');
}

// The address a request through a door records: the Easy Door by its shape,
// anything else as the name this machine was installed with.
function addressForHost(host, { scheme = 'http' } = {}) {
  const normalized = normalizeHost(host);
  if (!HOST_PATTERN.test(normalized)) throw new SuiteAddressError('SUITE_ADDRESS_INVALID_HOST', `"${host}" is not a host name this suite can be published on.`, 400);
  return { host: normalized, kind: EASY_DOOR_HOST.test(normalized) ? 'easy-door' : 'lan-name', scheme: scheme === 'https' ? 'https' : 'http' };
}

// A domain the owner applied. The provider is recorded for the domain module's
// own use and is not a predicate anywhere else.
function domainAddress({ acmeEmail, baseDomain, provider }) {
  const domain = normalizeHost(baseDomain);
  if (!HOST_PATTERN.test(domain) || !domain.includes('.')) throw new SuiteAddressError('SUITE_ADDRESS_INVALID_HOST', `"${baseDomain}" is not a domain this suite can be published on.`, 400);
  return { acmeEmail: String(acmeEmail || '').trim().toLowerCase() || null, baseDomain: domain, host: `home.${domain}`, kind: 'domain', provider: provider || null, scheme: 'https' };
}

// The base every app and Homepage host hangs under: the recorded host without
// its `home.` label, so `vaultwarden.<base>` is a sibling of `home.<base>`.
function baseHostOf(address) {
  const host = String(address?.host || '');
  return host.startsWith('home.') ? host.slice(5) : host;
}

function validateAddress(value) {
  if (!value || typeof value !== 'object') throw new SuiteAddressError('SUITE_ADDRESS_INVALID', 'The recorded suite address is not readable.');
  if (!ADDRESS_KINDS.includes(value.kind)) throw new SuiteAddressError('SUITE_ADDRESS_INVALID', `The recorded suite address has an unknown kind "${value.kind}".`);
  const host = normalizeHost(value.host);
  if (!HOST_PATTERN.test(host)) throw new SuiteAddressError('SUITE_ADDRESS_INVALID', 'The recorded suite address has no usable host.');
  if (!['http', 'https'].includes(value.scheme)) throw new SuiteAddressError('SUITE_ADDRESS_INVALID', 'The recorded suite address has no usable scheme.');
  if (value.kind === 'domain' && host !== `home.${normalizeHost(value.baseDomain)}`) throw new SuiteAddressError('SUITE_ADDRESS_INVALID', 'The recorded domain and its host disagree.');
  return {
    host,
    kind: value.kind,
    scheme: value.scheme,
    ...(value.kind === 'domain' ? { acmeEmail: value.acmeEmail || null, baseDomain: normalizeHost(value.baseDomain), provider: value.provider || null } : {}),
    ...(value.recordedAt ? { recordedAt: value.recordedAt } : {}),
    ...(value.by ? { by: value.by } : {}),
  };
}

function validateOffer(value) {
  if (!value || typeof value !== 'object') return null;
  const baseDomain = normalizeHost(value.baseDomain);
  if (!HOST_PATTERN.test(baseDomain) || !baseDomain.includes('.')) return null;
  return { acmeEmail: value.acmeEmail || null, at: value.at || null, baseDomain, from: value.from || null };
}

function writeJsonAtomic(file, value, mode) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, file);
}

function readJsonOrNull(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SuiteAddressError('SUITE_ADDRESS_INVALID', `${path.basename(file)} is not readable: ${error.message}`);
  }
}

// The two files in the suite-address directory, read and written from one
// place so that nothing else has to know their names or shape.
class SuiteAddressFile {
  constructor({ dir = suiteAddressDir() } = {}) {
    this.dir = dir;
    this.addressPath = path.join(dir, ADDRESS_FILENAME);
    this.offerPath = path.join(dir, OFFER_FILENAME);
  }

  exists() {
    return fs.existsSync(this.addressPath);
  }

  // The recorded address. A machine always has one once Suite Manager has
  // started on it; a caller that runs before then has nothing to publish on and
  // is told so rather than handed a guess.
  read() {
    const value = readJsonOrNull(this.addressPath);
    if (!value) throw new SuiteAddressError('SUITE_ADDRESS_MISSING', `This machine has no recorded suite address yet (${this.addressPath}).`, 503);
    return validateAddress(value);
  }

  readOrNull() {
    try { return this.read(); } catch { return null; }
  }

  write(address, { at = new Date().toISOString(), by }) {
    const validated = validateAddress({ ...address, by, recordedAt: at });
    fs.mkdirSync(this.dir, { recursive: true });
    writeJsonAtomic(this.addressPath, validated, 0o644);
    return validated;
  }

  readOffer() {
    return validateOffer(readJsonOrNull(this.offerPath));
  }

  writeOffer({ acmeEmail = null, at = new Date().toISOString(), baseDomain, from }) {
    const offer = validateOffer({ acmeEmail, at, baseDomain, from });
    if (!offer) throw new SuiteAddressError('SUITE_ADDRESS_INVALID_HOST', `"${baseDomain}" is not a domain this suite can be offered.`, 400);
    fs.mkdirSync(this.dir, { recursive: true });
    writeJsonAtomic(this.offerPath, offer, 0o644);
    return offer;
  }

  clearOffer() {
    fs.rmSync(this.offerPath, { force: true });
  }
}

module.exports = {
  ADDRESS_FILENAME,
  ADDRESS_KINDS,
  OFFER_FILENAME,
  SUITE_ADDRESS_DIRNAME,
  SuiteAddressError,
  SuiteAddressFile,
  addressForHost,
  baseHostOf,
  domainAddress,
  suiteAddressDir,
  validateAddress,
};
