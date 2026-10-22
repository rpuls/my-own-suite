// The Easy Door: the address a MOS box answers on without the owner configuring
// any DNS. `infrastructure/nameserver/` is authoritative for
// `<label>.<lan-ip-with-dashes>-<install id>.local.myownsuite.org` and answers it
// with the encoded address, but only inside RFC1918 space.
//
// Everything that derives or matches that name derives it from here. The door
// only works while Suite Manager's host gate, Caddy's site block and the
// generated app routes agree on one shape and one address, and three
// independently-correct implementations of "this machine's LAN address" is
// exactly how they would stop agreeing.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EASY_DOOR_ZONE = 'local.myownsuite.org';
// Holds the DNS-01 token for each box's wildcard; see infrastructure/acme-responder/.
const EASY_DOOR_ACME_SERVER = 'https://acme.myownsuite.org';
// The line the Caddyfile renderers write above the Easy Door site block, so a
// reader of the live file can see the door in it. Every LAN Caddyfile carries
// the block; only the public-cloud one never did.
const EASY_DOOR_CADDY_MARKER = '# mos-easy-door';

// Letters only, so the id can never be read as an octet, and without i, l and o,
// which are misread aloud and on screen.
const EASY_DOOR_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz';
const EASY_DOOR_ID_LENGTH = 6;
const EASY_DOOR_ID = `[a-hjkmnp-z]{${EASY_DOOR_ID_LENGTH}}`;
// Outside /var/lib/mos, which the vault protects: the console banner names the
// door on a machine still waiting for its password, and Suite Manager, which is
// not root, reads it. Created by root only; the image bake removes it.
const EASY_DOOR_ID_PATH = '/var/lib/mos-easy-door/id';

const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const IPV4_PATTERN = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`, 'u');
// The one label that names a machine: its RFC1918 address, then its install id.
// 192.168.c.d is written `c-d`; 10/8 and 172.16/12 keep all four numbers, so the
// count of numbers tells the forms apart. The nameserver's Corefile spells the
// same three forms out by hand, and the ACME responder holds tokens for nothing else.
const EASY_DOOR_LABEL = `(?:10-${IPV4_OCTET}-${IPV4_OCTET}-${IPV4_OCTET}|172-(?:1[6-9]|2[0-9]|3[01])-${IPV4_OCTET}-${IPV4_OCTET}|${IPV4_OCTET}-${IPV4_OCTET})-${EASY_DOOR_ID}`;
// As a Go RE2 source string for Caddy's `header_regexp`. Caddy matches the name
// by pattern because the Caddyfile is baked into the published disk image, which
// cannot know the address or the id the machine will get. Suite Manager's host
// gate is what admits only this machine's own name.
const EASY_DOOR_HOME_HOST_REGEXP = `^home\\.${EASY_DOOR_LABEL}\\.local\\.myownsuite\\.org$`;
const EASY_DOOR_HOST_PATTERN = new RegExp(`^(?:[^.]+\\.)?(${EASY_DOOR_LABEL})\\.${EASY_DOOR_ZONE.replace(/\./gu, '\\.')}$`, 'u');
const EASY_DOOR_ID_PATTERN = new RegExp(`^${EASY_DOOR_ID}$`, 'u');

function isPrivateIPv4(address) {
  const value = String(address || '');
  if (!IPV4_PATTERN.test(value)) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

function isEasyDoorId(value) {
  return EASY_DOOR_ID_PATTERN.test(String(value || ''));
}

function newEasyDoorId() {
  return Array.from({ length: EASY_DOOR_ID_LENGTH }, () => EASY_DOOR_ID_ALPHABET[crypto.randomInt(EASY_DOOR_ID_ALPHABET.length)]).join('');
}

function easyDoorIdPath() {
  return process.env.MOS_EASY_DOOR_ID_FILE || EASY_DOOR_ID_PATH;
}

// The id, or null while nothing with the right to make it has asked yet.
function readEasyDoorId(file = easyDoorIdPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const id = text.trim();
  if (!isEasyDoorId(id)) throw new Error(`${file} does not hold an Easy Door id.`);
  return id;
}

// This install's id, made the first time anything asks. It tells two households
// on one LAN address apart, so each gets a certificate of its own; it is not a
// secret. Whoever asks first wins: link() refuses to replace a file another
// process created a moment earlier, so a machine never holds two ids.
function easyDoorId({ file = easyDoorIdPath() } = {}) {
  const existing = readEasyDoorId(file);
  if (existing) return existing;
  fs.mkdirSync(path.dirname(file), { mode: 0o755, recursive: true });
  const candidate = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(candidate, `${newEasyDoorId()}\n`, { encoding: 'utf8', mode: 0o644 });
  try {
    fs.linkSync(candidate, file);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    fs.rmSync(candidate, { force: true });
  }
  return readEasyDoorId(file);
}

// One selection rule for the whole platform. Bridge, Docker and veth addresses
// are not reachable from the LAN, and the two Docker defaults are excluded by
// address as well because a bridge can be renamed.
function detectServerAddress() {
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (/^(br-|docker|veth)/u.test(name)) continue;
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (/^172\.(17|18)\./u.test(entry.address)) continue;
      addresses.push(entry.address);
    }
  }
  return addresses[0] || null;
}

function dashedAddress(address) {
  const value = String(address);
  return (value.startsWith('192.168.') ? value.slice('192.168.'.length) : value).replace(/\./gu, '-');
}

// The Easy Door base domain for an address, or null when the nameserver would
// not answer for it — which is also what excludes every cloud and VPS install,
// since those hold a public address. `id` is a string, or a function asked only
// when there is a name to give, so a machine without a door never makes an id;
// a null id is a machine whose id is not made yet, which has no name yet either.
function easyDoorBaseDomain(address, id = easyDoorId) {
  if (!isPrivateIPv4(address)) return null;
  const value = typeof id === 'function' ? id() : id;
  if (value === null) return null;
  if (!isEasyDoorId(value)) throw new Error(`"${value}" is not an Easy Door id.`);
  return `${dashedAddress(address)}-${value}.${EASY_DOOR_ZONE}`;
}

function easyDoorHomeHost(address, id = easyDoorId) {
  const base = easyDoorBaseDomain(address, id);
  return base ? `home.${base}` : null;
}

// The address and id an Easy Door name encodes, or null for any other name.
function parseEasyDoorHost(host) {
  const match = EASY_DOOR_HOST_PATTERN.exec(String(host || ''));
  if (!match) return null;
  const numbers = match[1].split('-');
  const id = numbers.pop();
  return { address: (numbers.length === 2 ? ['192', '168', ...numbers] : numbers).join('.'), id };
}

// The console banner has to print the same address Suite Manager's host gate
// admits, and shell cannot reproduce the selection rule above — a second
// implementation of it is exactly what this module exists to prevent. Both
// subcommands print an empty line when there is no answer, so a caller can read
// the result without inspecting an exit code.
//
//   node shared/easy-door.cjs address              this machine's LAN address
//   node shared/easy-door.cjs home-host <address>  its Easy Door name
function runCli(argv, { id = easyDoorId } = {}) {
  const [command, address] = argv;
  if (command === 'address') return detectServerAddress() || '';
  if (command === 'home-host') return easyDoorHomeHost(address || detectServerAddress(), id) || '';
  throw new Error(`Unknown easy-door command: ${command || '(none)'}`);
}

if (require.main === module) {
  try {
    process.stdout.write(`${runCli(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  EASY_DOOR_ACME_SERVER,
  EASY_DOOR_CADDY_MARKER,
  EASY_DOOR_HOME_HOST_REGEXP,
  EASY_DOOR_LABEL,
  EASY_DOOR_ZONE,
  detectServerAddress,
  easyDoorBaseDomain,
  easyDoorHomeHost,
  easyDoorId,
  easyDoorIdPath,
  isEasyDoorId,
  isPrivateIPv4,
  parseEasyDoorHost,
  readEasyDoorId,
  runCli,
};
