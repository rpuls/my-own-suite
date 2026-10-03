#!/usr/bin/env node

// Provisions the Easy Door authoritative nameserver on DigitalOcean.
//
// The box is disposable: it holds no state, and every file that decides its
// behaviour lives in infrastructure/nameserver/ and is injected through
// cloud-init at create time. Rebuilding is `destroy` then `apply`, and the
// Reserved IP survives it, so the NS record in the parent zone never changes.

const path = require('node:path');

const { RESOLVED_STUB_OFF, corednsInstallCommands, readConfig, repoRoot, runDropletBox, writeFilesYaml } = require('./droplet-box.cjs');
const {
  ACME_PACKAGES,
  ACME_PUBLIC_PORTS,
  SHARES_NAMESERVER_DROPLET: HOSTS_ACME_RESPONDER,
  acmeCorefile,
  acmeRunCommands,
  acmeWriteFiles,
} = require('./acme-responder.cjs');

const configDir = path.join(repoRoot, 'infrastructure', 'nameserver');

function corefile() {
  const own = readConfig(path.join(configDir, 'Corefile'));
  return HOSTS_ACME_RESPONDER ? `${own}\n${acmeCorefile()}` : own;
}

function renderCloudInit() {
  const files = writeFilesYaml([
    { target: '/etc/coredns/zones/local.myownsuite.org.zone', source: path.join(configDir, 'zones', 'local.myownsuite.org.zone') },
    { target: '/etc/systemd/system/coredns.service', source: path.join(configDir, 'coredns.service') },
    { target: '/etc/nftables.d/mos-nameserver.conf', source: path.join(configDir, 'nftables-ratelimit.conf') },
  ]);

  return `#cloud-config
package_update: true
package_upgrade: true
packages:
  - nftables
  - unattended-upgrades
${HOSTS_ACME_RESPONDER ? ACME_PACKAGES.map((name) => `  - ${name}\n`).join('') : ''}
write_files:
  - path: /etc/coredns/Corefile
    owner: root:root
    permissions: "0644"
    encoding: b64
    content: ${Buffer.from(corefile(), 'utf8').toString('base64')}
${files}
${HOSTS_ACME_RESPONDER ? `${acmeWriteFiles()}\n` : ''}${RESOLVED_STUB_OFF}
  - path: /etc/apt/apt.conf.d/51mos-no-auto-reboot
    owner: root:root
    permissions: "0644"
    content: |
      // While this is the only nameserver, an unattended reboot is an outage for
      // every owner using the Easy Door. Reboots stay manual until ns2 exists.
      Unattended-Upgrade::Automatic-Reboot "false";

runcmd:
${corednsInstallCommands()}
${HOSTS_ACME_RESPONDER ? `${acmeRunCommands()}\n` : ''}  - [ systemctl, daemon-reload ]
  - [ systemctl, enable, --now, coredns ]
`;
}

runDropletBox({
  label: 'mos-ns',
  title: 'Easy Door nameserver',
  script: 'scripts/nameserver.cjs',
  tag: 'mos-nameserver',
  envPrefix: 'MOS_NS',
  defaultName: 'mos-ns1',
  publishedHost: (name) => `${name.replace(/^mos-/u, '')}.myownsuite.org`,
  publicPorts: [{ protocol: 'udp', ports: '53' }, { protocol: 'tcp', ports: '53' }, ...(HOSTS_ACME_RESPONDER ? ACME_PUBLIC_PORTS : [])],
  parentRecords: (ip) => [
    `ns1.myownsuite.org      A    ${ip}`,
    'local.myownsuite.org    NS   ns1.myownsuite.org',
    ...(HOSTS_ACME_RESPONDER ? [`ns-acme.myownsuite.org  A    ${ip}`, 'acme.myownsuite.org     NS   ns-acme.myownsuite.org'] : []),
  ],
  renderCloudInit,
  verifyScript: path.join(configDir, 'verify.cjs'),
});
