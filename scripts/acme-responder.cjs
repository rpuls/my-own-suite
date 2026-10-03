#!/usr/bin/env node

// Provisions the ACME responder on DigitalOcean: the box that holds DNS-01
// challenge tokens for Easy Door certificates. Its only state is tokens minutes
// from expiring, so like the nameserver it is rebuilt rather than repaired.
//
// While MOS is in development the responder runs on the nameserver's Droplet
// (`scripts/nameserver.cjs` includes this payload). This script is the split:
// apply a box of its own, then point `ns-acme.myownsuite.org` at it.

const path = require('node:path');

const { RESOLVED_STUB_OFF, corednsInstallCommands, readConfig, repoRoot, runDropletBox, writeFilesYaml } = require('./droplet-box.cjs');

const configDir = path.join(repoRoot, 'infrastructure', 'acme-responder');
const codeRoot = '/opt/mos-acme';

// The split, in order: set this to false, apply this script, re-point
// `ns-acme.myownsuite.org` at the new box, rebuild the nameserver without it.
const SHARES_NAMESERVER_DROPLET = true;

const ACME_PACKAGES = ['nodejs', 'caddy'];
const ACME_PUBLIC_PORTS = [{ protocol: 'tcp', ports: '80' }, { protocol: 'tcp', ports: '443' }];

function acmeCorefile() {
  return readConfig(path.join(configDir, 'Corefile'));
}

// Everything the responder adds to a box, minus the Corefile and CoreDNS unit,
// which the host box owns.
function acmeWriteFiles() {
  return writeFilesYaml([
    { target: '/etc/systemd/system/mos-acme-responder.service', source: path.join(configDir, 'mos-acme-responder.service') },
    { target: '/etc/systemd/system/caddy.service.d/mos-limits.conf', source: path.join(configDir, 'caddy-limits.conf') },
    { target: `${codeRoot}/infrastructure/acme-responder/responder.cjs`, source: path.join(configDir, 'responder.cjs') },
    { target: `${codeRoot}/infrastructure/acme-responder/responder-core.cjs`, source: path.join(configDir, 'responder-core.cjs') },
    { target: `${codeRoot}/shared/easy-door.cjs`, source: path.join(repoRoot, 'shared', 'easy-door.cjs') },
    // Placed by runcmd once the caddy package exists, so dpkg never sees it as a modified conffile.
    { target: `${codeRoot}/Caddyfile`, source: path.join(configDir, 'Caddyfile') },
    { target: '/etc/nftables.d/mos-acme-responder.conf', source: path.join(configDir, 'nftables-ratelimit.conf') },
  ]);
}

// Runs after CoreDNS is installed and before it starts, so the zone file the
// responder writes exists when CoreDNS first reads it.
function acmeRunCommands() {
  return `  - [ useradd, --system, --no-create-home, --shell, /usr/sbin/nologin, mos-acme ]
  - [ systemctl, daemon-reload ]
  - [ systemctl, enable, --now, mos-acme-responder ]
  - [ install, -m, "0644", ${codeRoot}/Caddyfile, /etc/caddy/Caddyfile ]
  - [ systemctl, restart, caddy ]`;
}

function renderCloudInit() {
  const files = writeFilesYaml([
    { target: '/etc/coredns/Corefile', source: path.join(configDir, 'Corefile') },
    { target: '/etc/systemd/system/coredns.service', source: path.join(configDir, 'coredns.service') },
  ]);

  return `#cloud-config
package_update: true
package_upgrade: true
packages:
  - nftables
  - unattended-upgrades
${ACME_PACKAGES.map((name) => `  - ${name}`).join('\n')}

write_files:
${files}
${acmeWriteFiles()}
${RESOLVED_STUB_OFF}

runcmd:
${corednsInstallCommands()}
${acmeRunCommands()}
  - [ systemctl, enable, --now, coredns ]
`;
}

if (require.main === module) {
  if (SHARES_NAMESERVER_DROPLET && ['apply', 'plan'].includes(process.argv[2])) {
    console.error('[mos-acme] The responder runs on the nameserver Droplet (SHARES_NAMESERVER_DROPLET in scripts/acme-responder.cjs).\n'
      + '           Rebuild it with `npm run nameserver:apply`. A box of its own is the split described beside that constant.');
    process.exit(1);
  }
  runDropletBox({
    label: 'mos-acme',
    title: 'ACME responder',
    script: 'scripts/acme-responder.cjs',
    tag: 'mos-acme-responder',
    envPrefix: 'MOS_ACME',
    defaultName: 'mos-acme1',
    publishedHost: () => 'ns-acme.myownsuite.org',
    publicPorts: [{ protocol: 'udp', ports: '53' }, { protocol: 'tcp', ports: '53' }, ...ACME_PUBLIC_PORTS],
    parentRecords: (ip) => [
      `ns-acme.myownsuite.org  A    ${ip}`,
      'acme.myownsuite.org     NS   ns-acme.myownsuite.org',
    ],
    renderCloudInit,
    verifyScript: path.join(configDir, 'verify.cjs'),
  });
}

module.exports = { ACME_PACKAGES, ACME_PUBLIC_PORTS, SHARES_NAMESERVER_DROPLET, acmeCorefile, acmeRunCommands, acmeWriteFiles };
