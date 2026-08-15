#!/usr/bin/env node

// Provisions the Easy Door authoritative nameserver on DigitalOcean.
//
// The box is disposable: it holds no state, and every file that decides its
// behaviour lives in infrastructure/nameserver/ and is injected through
// cloud-init at create time. Rebuilding is `destroy` then `apply`, and the
// Reserved IP survives it, so the NS record in the parent zone never changes.

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const configDir = path.join(repoRoot, 'infrastructure', 'nameserver');
const apiBaseUrl = 'https://api.digitalocean.com/v2';
const envFiles = ['.mos-nameserver.env', path.join('.mos-smoke', 'digitalocean.env')];

const tag = 'mos-nameserver';

const corednsVersion = '1.14.6';
const corednsSha256 = '4402578c8f7b95dac1d8258bfd13e7a9d30f70d7a53f396b02a6d6ca78d56152';

const monthlyCost = { 's-1vcpu-1gb': 6, 's-1vcpu-512mb-10gb': 4, 's-2vcpu-2gb': 18 };

loadEnvFiles();

const config = {
  name: env('MOS_NS_NAME', 'mos-ns1'),
  region: env('MOS_NS_REGION', 'ams3'),
  size: env('MOS_NS_SIZE', 's-1vcpu-1gb'),
  image: env('MOS_NS_IMAGE', 'ubuntu-24-04-x64'),
  sshSource: env('MOS_NS_SSH_SOURCE'),
};

function usage() {
  console.log(`Usage: node scripts/nameserver.cjs <render|plan|apply|status|verify|ssh-open|destroy>

Commands:
  render   Print the cloud-init payload. Creates nothing and needs no token.
  plan     Show what apply would create, and what it costs, against live state.
  apply    Create or complete the Droplet, Reserved IP and firewall. Billable.
  status   Show the current Droplet, Reserved IP and firewall.
  verify   Run the acceptance checks against the live Reserved IP.
  ssh-open Point the firewall's SSH rule at wherever you are now.
  destroy  Destroy the Droplet and firewall. Keeps the Reserved IP by default.

Environment (also read from ${envFiles.join(' or ')}):
  DIGITALOCEAN_ACCESS_TOKEN  Required for plan/apply/status/destroy.
  MOS_NS_NAME                Default: mos-ns1.
  MOS_NS_REGION              Default: ams3.
  MOS_NS_SIZE                Default: s-1vcpu-1gb ($6/mo).
  MOS_NS_IMAGE               Default: ubuntu-24-04-x64.
  MOS_NS_SSH_SOURCE          CIDR allowed to reach SSH. Detected if unset. Set it
                             only if you have a fixed address; on a dynamic one,
                             leave it unset and run ssh-open when you need in.
  MOS_NS_SSH_KEY_ID          SSH key selector; one of id, fingerprint or name.
  MOS_NS_SSH_KEY_FINGERPRINT
  MOS_NS_SSH_KEY_NAME
`);
}

function fail(message) {
  console.error(`[mos-ns] ERROR: ${message}`);
  process.exit(1);
}

function env(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function loadEnvFiles() {
  for (const relative of envFiles) {
    const filePath = path.join(repoRoot, relative);
    if (!fs.existsSync(filePath)) continue;

    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!match || process.env[match[1]]) continue;

      const raw = match[2].trim();
      const quote = raw[0];
      const value = (quote === '"' || quote === "'") && raw.endsWith(quote)
        ? raw.slice(1, -1)
        : raw;

      if (value) process.env[match[1]] = value;
    }
  }
}

function getToken() {
  const token = env('DIGITALOCEAN_ACCESS_TOKEN');
  if (!token) fail('DIGITALOCEAN_ACCESS_TOKEN is not set.');
  return token;
}

async function doRequest(token, method, resourcePath, body = null) {
  const response = await fetch(`${apiBaseUrl}${resourcePath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === null ? undefined : JSON.stringify(body),
  });

  if (response.status === 204) return null;

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload?.message || payload?.id || response.statusText;
    const error = new Error(`${method} ${resourcePath} failed: ${message}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function readConfigFile(relative) {
  const filePath = path.join(configDir, relative);
  if (!fs.existsSync(filePath)) fail(`Missing config file: infrastructure/nameserver/${relative}`);
  return fs.readFileSync(filePath, 'utf8');
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// Config is injected base64-encoded so no Corefile regex or zone-file character
// can be reinterpreted as YAML on the way in.
function renderCloudInit() {
  const files = [
    ['/etc/coredns/Corefile', 'Corefile'],
    ['/etc/coredns/zones/local.myownsuite.org.zone', path.join('zones', 'local.myownsuite.org.zone')],
    ['/etc/systemd/system/coredns.service', 'coredns.service'],
    ['/etc/nftables.d/mos-nameserver.conf', 'nftables-ratelimit.conf'],
  ];

  const writeFiles = files.map(([target, source]) => [
    `  - path: ${target}`,
    '    owner: root:root',
    '    permissions: "0644"',
    '    encoding: b64',
    `    content: ${b64(readConfigFile(source))}`,
  ].join('\n')).join('\n');

  const tarball = `coredns_${corednsVersion}_linux_amd64.tgz`;
  const downloadUrl =
    `https://github.com/coredns/coredns/releases/download/v${corednsVersion}/${tarball}`;

  return `#cloud-config
package_update: true
package_upgrade: true
packages:
  - nftables
  - unattended-upgrades

write_files:
${writeFiles}
  - path: /etc/systemd/resolved.conf.d/mos-nameserver.conf
    owner: root:root
    permissions: "0644"
    content: |
      # CoreDNS binds 0.0.0.0:53, which collides with the resolved stub listener.
      [Resolve]
      DNSStubListener=no
  - path: /etc/apt/apt.conf.d/20auto-upgrades
    owner: root:root
    permissions: "0644"
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";
  - path: /etc/apt/apt.conf.d/51mos-no-auto-reboot
    owner: root:root
    permissions: "0644"
    content: |
      // While this is the only nameserver, an unattended reboot is an outage for
      // every owner using the Easy Door. Reboots stay manual until ns2 exists.
      Unattended-Upgrade::Automatic-Reboot "false";

runcmd:
  - [ systemctl, restart, systemd-resolved ]
  - [ ln, -sf, /run/systemd/resolve/resolv.conf, /etc/resolv.conf ]
  - curl -fsSL -o /tmp/${tarball} ${downloadUrl}
  - echo "${corednsSha256}  /tmp/${tarball}" | sha256sum -c -
  - tar -xzf /tmp/${tarball} -C /usr/local/bin coredns
  - [ chmod, "0755", /usr/local/bin/coredns ]
  - [ rm, -f, /tmp/${tarball} ]
  - [ useradd, --system, --no-create-home, --shell, /usr/sbin/nologin, coredns ]
  - [ chown, -R, "root:coredns", /etc/coredns ]
  - [ chmod, -R, "u=rwX,g=rX,o=", /etc/coredns ]
  - grep -q 'nftables.d' /etc/nftables.conf || echo 'include "/etc/nftables.d/*.conf"' >> /etc/nftables.conf
  - [ systemctl, enable, --now, nftables ]
  - [ systemctl, daemon-reload ]
  - [ systemctl, enable, --now, coredns ]
`;
}

async function findDroplet(token) {
  const payload = await doRequest(token, 'GET', `/droplets?tag_name=${tag}`);
  return payload?.droplets?.[0] || null;
}

// Ours is the one attached to our Droplet. Falling back to any unattached IP in
// the region lets a rebuild reclaim the address the NS record already points at,
// without ever claiming a reserved IP that belongs to another Droplet.
async function findReservedIp(token, droplet) {
  const payload = await doRequest(token, 'GET', '/reserved_ips?per_page=200');
  const reservedIps = payload?.reserved_ips || [];

  if (droplet) {
    const attached = reservedIps.find((entry) => entry.droplet?.id === droplet.id);
    if (attached) return attached;
  }

  return reservedIps.find((entry) => !entry.droplet && entry.region?.slug === config.region) || null;
}

async function findFirewall(token) {
  const payload = await doRequest(token, 'GET', '/firewalls?per_page=200');
  return payload?.firewalls?.find((entry) => entry.name === `${config.name}-fw`) || null;
}

async function resolveSshKeys(token) {
  const id = env('MOS_NS_SSH_KEY_ID');
  if (id) return [Number(id)];

  const fingerprint = env('MOS_NS_SSH_KEY_FINGERPRINT');
  if (fingerprint) return [fingerprint];

  const name = env('MOS_NS_SSH_KEY_NAME');
  const payload = await doRequest(token, 'GET', '/account/keys?per_page=200');
  const keys = payload?.ssh_keys || [];

  if (name) {
    const match = keys.find((key) => key.name === name);
    if (!match) fail(`No DigitalOcean SSH key named ${name}.`);
    return [match.id];
  }

  if (keys.length === 1) return [keys[0].id];

  fail(
    keys.length
      ? `Set MOS_NS_SSH_KEY_NAME to one of: ${keys.map((key) => key.name).join(', ')}`
      : 'The DigitalOcean account has no SSH keys. Add one before provisioning.',
  );
}

async function detectSshSource() {
  if (config.sshSource) return config.sshSource;

  const response = await fetch('https://checkip.amazonaws.com');
  if (!response.ok) fail('Could not detect your public IP. Set MOS_NS_SSH_SOURCE.');

  return `${(await response.text()).trim()}/32`;
}

function firewallRules(sshSource) {
  const anywhere = { addresses: ['0.0.0.0/0', '::/0'] };

  return {
    inbound_rules: [
      { protocol: 'udp', ports: '53', sources: anywhere },
      { protocol: 'tcp', ports: '53', sources: anywhere },
      { protocol: 'tcp', ports: '22', sources: { addresses: [sshSource] } },
    ],
    outbound_rules: [
      { protocol: 'tcp', ports: 'all', destinations: anywhere },
      { protocol: 'udp', ports: 'all', destinations: anywhere },
      { protocol: 'icmp', destinations: anywhere },
    ],
  };
}

async function commandRender() {
  process.stdout.write(renderCloudInit());
}

async function commandPlan() {
  const token = getToken();
  const droplet = await findDroplet(token);
  const [reservedIp, firewall] = await Promise.all([
    findReservedIp(token, droplet),
    findFirewall(token),
  ]);
  const sshSource = await detectSshSource();
  const cost = monthlyCost[config.size];

  console.log(`Easy Door nameserver plan (${config.region})\n`);

  console.log(droplet
    ? `  exists   droplet      ${droplet.name} (${droplet.id})`
    : `  create   droplet      ${config.name}  ${config.size}  ${config.image}   $${cost ?? '?'}.00/mo`);

  console.log(reservedIp
    ? `  exists   reserved ip  ${reservedIp.ip}`
    : '  create   reserved ip  free while attached to a Droplet');

  console.log(firewall
    ? `  exists   firewall     ${firewall.name}`
    : `  create   firewall     ${config.name}-fw  udp/53 tcp/53 from anywhere, ssh from ${sshSource}`);

  const newCost = droplet ? 0 : cost ?? 0;
  console.log(`\n  added monthly cost: $${newCost}.00`);
  console.log('\nRun `node scripts/nameserver.cjs apply` to create it.');
}

async function commandApply() {
  const token = getToken();
  const sshSource = await detectSshSource();

  let droplet = await findDroplet(token);

  if (!droplet) {
    const sshKeys = await resolveSshKeys(token);
    console.log(`[mos-ns] creating droplet ${config.name} in ${config.region}...`);

    const created = await doRequest(token, 'POST', '/droplets', {
      name: config.name,
      region: config.region,
      size: config.size,
      image: config.image,
      ssh_keys: sshKeys,
      tags: [tag],
      backups: false,
      ipv6: true,
      monitoring: true,
      user_data: renderCloudInit(),
    });

    droplet = created.droplet;
    droplet = await waitForNetwork(token, droplet.id);
  } else {
    console.log(`[mos-ns] droplet ${droplet.name} already exists (${droplet.id})`);
  }

  let reservedIp = await findReservedIp(token, droplet);

  if (!reservedIp) {
    console.log('[mos-ns] creating and attaching reserved ip...');
    const created = await doRequest(token, 'POST', '/reserved_ips', { droplet_id: droplet.id });
    reservedIp = created.reserved_ip;
  } else if (reservedIp.droplet?.id !== droplet.id) {
    console.log(`[mos-ns] reassigning reserved ip ${reservedIp.ip} to ${droplet.name}...`);
    await doRequest(token, 'POST', `/reserved_ips/${reservedIp.ip}/actions`, {
      type: 'assign',
      droplet_id: droplet.id,
    });
  } else {
    console.log(`[mos-ns] reserved ip ${reservedIp.ip} already attached`);
  }

  const firewall = await findFirewall(token);

  if (!firewall) {
    console.log('[mos-ns] creating firewall...');
    await doRequest(token, 'POST', '/firewalls', {
      name: `${config.name}-fw`,
      ...firewallRules(sshSource),
      droplet_ids: [droplet.id],
    });
  } else {
    console.log(`[mos-ns] firewall ${firewall.name} already exists`);
  }

  console.log(`
[mos-ns] done. Reserved IP: ${reservedIp.ip}

Next:
  1. Add these two records to the myownsuite.org zone in Cloudflare, DNS only:
       ns1.myownsuite.org      A    ${reservedIp.ip}
       local.myownsuite.org    NS   ns1.myownsuite.org
  2. cloud-init takes a few minutes. Then:
       node scripts/nameserver.cjs verify
`);
}

async function waitForNetwork(token, dropletId) {
  const deadline = Date.now() + 5 * 60 * 1000;

  while (Date.now() < deadline) {
    const payload = await doRequest(token, 'GET', `/droplets/${dropletId}`);
    const droplet = payload.droplet;

    if (droplet.status === 'active' && droplet.networks?.v4?.length) return droplet;

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  fail(`Droplet ${dropletId} did not become active within 5 minutes.`);
}

async function commandStatus() {
  const token = getToken();
  const droplet = await findDroplet(token);
  const [reservedIp, firewall] = await Promise.all([
    findReservedIp(token, droplet),
    findFirewall(token),
  ]);

  console.log(`droplet      ${droplet ? `${droplet.name} ${droplet.status} (${droplet.id})` : 'none'}`);
  console.log(`reserved ip  ${reservedIp ? `${reservedIp.ip} -> ${reservedIp.droplet?.name || 'unattached'}` : 'none'}`);
  console.log(`firewall     ${firewall ? firewall.name : 'none'}`);
}

async function commandVerify() {
  const token = getToken();
  const reservedIp = await findReservedIp(token, await findDroplet(token));
  if (!reservedIp) fail('No reserved IP found. Run `node scripts/nameserver.cjs apply` first.');

  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    process.execPath,
    [path.join(configDir, 'verify.cjs'), reservedIp.ip],
    { stdio: 'inherit' },
  );

  process.exit(result.status ?? 1);
}

// SSH is restricted at the network layer as well as by key, which on a dynamic
// ISP address means the rule goes stale. It can never lock anyone out: this runs
// against the API, not the box, and DigitalOcean's recovery console bypasses the
// firewall entirely.
async function commandSshOpen() {
  const token = getToken();
  const firewall = await findFirewall(token);
  if (!firewall) fail('No firewall found. Run `node scripts/nameserver.cjs apply` first.');

  const sshSource = await detectSshSource();
  const previous = firewall.inbound_rules
    .find((rule) => rule.protocol === 'tcp' && rule.ports === '22')
    ?.sources?.addresses || [];

  if (previous.length === 1 && previous[0] === sshSource) {
    console.log(`[mos-ns] ssh is already open from ${sshSource}`);
    return;
  }

  await doRequest(token, 'PUT', `/firewalls/${firewall.id}`, {
    name: firewall.name,
    ...firewallRules(sshSource),
    droplet_ids: firewall.droplet_ids || [],
    tags: firewall.tags || [],
  });

  console.log(`[mos-ns] ssh now open from ${sshSource}, was ${previous.join(', ') || 'nothing'}`);
}

async function commandDestroy() {
  const token = getToken();
  const droplet = await findDroplet(token);
  const firewall = await findFirewall(token);

  // Droplet first. Deleting the firewall first and then failing to delete the
  // droplet would leave a live nameserver on the internet with nothing in front
  // of it; this order can only ever leave an orphaned firewall, which is free
  // and which the next apply reuses.
  if (droplet) {
    console.log(`[mos-ns] destroying droplet ${droplet.name} (${droplet.id})...`);
    await doRequest(token, 'DELETE', `/droplets/${droplet.id}`);
  } else {
    console.log('[mos-ns] no droplet found');
  }

  if (firewall) {
    console.log(`[mos-ns] deleting firewall ${firewall.name}...`);
    await doRequest(token, 'DELETE', `/firewalls/${firewall.id}`);
  }

  const reservedIp = await findReservedIp(token, null);
  console.log(reservedIp
    ? `\n[mos-ns] reserved ip ${reservedIp.ip} kept, so the NS record stays valid.\n         An unattached reserved IP is billed; run apply to reattach it.`
    : '');
}

const commands = {
  render: commandRender,
  plan: commandPlan,
  apply: commandApply,
  status: commandStatus,
  verify: commandVerify,
  'ssh-open': commandSshOpen,
  destroy: commandDestroy,
};

const command = process.argv[2];

if (!command || !commands[command]) {
  usage();
  process.exit(command ? 1 : 0);
}

commands[command]().catch((error) => fail(error.message));
