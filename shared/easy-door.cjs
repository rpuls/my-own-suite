// The Easy Door: the address a MOS box answers on without the owner configuring
// any DNS. `infrastructure/nameserver/` is authoritative for
// `<label>.<lan-ip-with-dashes>.local.myownsuite.org` and answers it with the
// encoded address, but only inside RFC1918 space.
//
// Everything that derives or matches that name derives it from here. The door
// only works while Suite Manager's host gate, Caddy's site block and the
// generated app routes agree on one shape and one address, and three
// independently-correct implementations of "this machine's LAN address" is
// exactly how they would stop agreeing.

const fs = require('node:fs');
const os = require('node:os');

const EASY_DOOR_ZONE = 'local.myownsuite.org';
// The line `renderCaddyfile()` writes above the Easy Door site block. Its
// presence in the live Caddyfile is what "the Easy Door is open on this box"
// means, and it is the only signal an agent needs: applying a real domain with
// DNS-01 replaces the whole file with `renderHttpsCaddyfile()` output, and the
// public-cloud Caddyfile never carried it.
const EASY_DOOR_CADDY_MARKER = '# mos-easy-door';
const CADDYFILE_PATH = process.env.MOS_CADDYFILE_PATH || '/etc/caddy/Caddyfile';

const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const IPV4_PATTERN = new RegExp(`^${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}$`, 'u');
// The three RFC1918 ranges the nameserver's Corefile answers for, in the dashed
// form the name carries, as a Go RE2 source string for Caddy's `header_regexp`.
// Caddy matches the name by pattern rather than binding one address because the
// Caddyfile is baked into the published disk image, which cannot know the
// address the machine it boots on will be given.
const EASY_DOOR_HOME_HOST_REGEXP = `^home\\.(?:10-${IPV4_OCTET}|172-(?:1[6-9]|2[0-9]|3[01])|192-168)-${IPV4_OCTET}-${IPV4_OCTET}\\.local\\.myownsuite\\.org$`;

function isPrivateIPv4(address) {
  const value = String(address || '');
  if (!IPV4_PATTERN.test(value)) return false;
  const [first, second] = value.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
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

// The Easy Door base domain for an address, or null when the nameserver would
// not answer for it — which is also what excludes every cloud and VPS install,
// since those hold a public address.
function easyDoorBaseDomain(address) {
  return isPrivateIPv4(address) ? `${String(address).replace(/\./gu, '-')}.${EASY_DOOR_ZONE}` : null;
}

function easyDoorHomeHost(address) {
  const base = easyDoorBaseDomain(address);
  return base ? `home.${base}` : null;
}

function easyDoorOpen(caddyfilePath = CADDYFILE_PATH) {
  try {
    return fs.readFileSync(caddyfilePath, 'utf8').includes(EASY_DOOR_CADDY_MARKER);
  } catch {
    return false;
  }
}

// The base domain generated app routes should alias, or null when this box is
// not serving the Easy Door. Unlike Suite Manager's own site block, an app route
// names one exact host, so it has to be re-derived on every apply.
function detectEasyDoorBase({ caddyfilePath = CADDYFILE_PATH, serverAddress = null } = {}) {
  if (!easyDoorOpen(caddyfilePath)) return null;
  return easyDoorBaseDomain(serverAddress || detectServerAddress());
}

// The console banner has to print the same address Suite Manager's host gate
// admits, and shell cannot reproduce the selection rule above — a second
// implementation of it is exactly what this module exists to prevent. Both
// subcommands print an empty line when there is no answer, so a caller can read
// the result without inspecting an exit code.
//
//   node shared/easy-door.cjs address              this machine's LAN address
//   node shared/easy-door.cjs home-host <address>  its Easy Door name, while the door is open
function runCli(argv) {
  const [command, address] = argv;
  if (command === 'address') return detectServerAddress() || '';
  if (command === 'home-host') {
    const base = detectEasyDoorBase({ serverAddress: address || null });
    return base ? `home.${base}` : '';
  }
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
  EASY_DOOR_CADDY_MARKER,
  EASY_DOOR_HOME_HOST_REGEXP,
  EASY_DOOR_ZONE,
  detectEasyDoorBase,
  detectServerAddress,
  easyDoorBaseDomain,
  easyDoorHomeHost,
  easyDoorOpen,
  isPrivateIPv4,
  runCli,
};
