// The DigitalOcean plumbing shared by MOS's disposable public boxes (the Easy
// Door nameserver and the ACME responder). Each box is a Droplet, a firewall and
// a Reserved IP, configured entirely by cloud-init; a provisioner script supplies
// what differs and calls runDropletBox.

const dns = require('node:dns/promises');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const apiBaseUrl = 'https://api.digitalocean.com/v2';
const envFiles = ['.mos-nameserver.env', path.join('.mos-smoke', 'digitalocean.env')];
const monthlyCost = { 's-1vcpu-1gb': 6, 's-1vcpu-512mb-10gb': 4, 's-2vcpu-2gb': 18 };

const COREDNS_VERSION = '1.14.6';
const COREDNS_SHA256 = '4402578c8f7b95dac1d8258bfd13e7a9d30f70d7a53f396b02a6d6ca78d56152';

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

// A Windows checkout holds these files with CRLF endings, and nftables rejects
// a config containing a carriage return.
function readConfig(source) {
  return fs.readFileSync(source, 'utf8').replace(/\r\n/gu, '\n');
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

// Config is injected base64-encoded so no Corefile regex or zone-file character
// can be reinterpreted as YAML on the way in.
function writeFilesYaml(files) {
  return files.map(({ target, source, permissions = '0644' }) => {
    if (!fs.existsSync(source)) throw new Error(`Missing config file: ${path.relative(repoRoot, source)}`);
    return [
      `  - path: ${target}`,
      '    owner: root:root',
      `    permissions: "${permissions}"`,
      '    encoding: b64',
      `    content: ${b64(readConfig(source))}`,
    ].join('\n');
  }).join('\n');
}

// CoreDNS binds 0.0.0.0:53, which collides with the resolved stub listener.
const RESOLVED_STUB_OFF = `  - path: /etc/systemd/resolved.conf.d/mos-no-stub.conf
    owner: root:root
    permissions: "0644"
    content: |
      [Resolve]
      DNSStubListener=no
  - path: /etc/apt/apt.conf.d/20auto-upgrades
    owner: root:root
    permissions: "0644"
    content: |
      APT::Periodic::Update-Package-Lists "1";
      APT::Periodic::Unattended-Upgrade "1";`;

function corednsInstallCommands() {
  const tarball = `coredns_${COREDNS_VERSION}_linux_amd64.tgz`;
  const downloadUrl = `https://github.com/coredns/coredns/releases/download/v${COREDNS_VERSION}/${tarball}`;
  return `  - [ systemctl, restart, systemd-resolved ]
  - [ ln, -sf, /run/systemd/resolve/resolv.conf, /etc/resolv.conf ]
  - curl -fsSL --retry 8 --retry-delay 10 --retry-all-errors -o /tmp/${tarball} ${downloadUrl}
  - echo "${COREDNS_SHA256}  /tmp/${tarball}" | sha256sum -c -
  - tar -xzf /tmp/${tarball} -C /usr/local/bin coredns
  - [ chmod, "0755", /usr/local/bin/coredns ]
  - [ rm, -f, /tmp/${tarball} ]
  - [ useradd, --system, --no-create-home, --shell, /usr/sbin/nologin, coredns ]
  - [ chown, -R, "root:coredns", /etc/coredns ]
  - [ chmod, -R, "u=rwX,g=rX,o=", /etc/coredns ]
  - grep -q 'nftables.d' /etc/nftables.conf || echo 'include "/etc/nftables.d/*.conf"' >> /etc/nftables.conf
  - [ systemctl, enable, --now, nftables ]`;
}

function runDropletBox(box) {
  loadEnvFiles();

  const prefix = `[${box.label}]`;
  const config = {
    name: env(`${box.envPrefix}_NAME`, box.defaultName),
    region: env(`${box.envPrefix}_REGION`, 'ams3'),
    size: env(`${box.envPrefix}_SIZE`, 's-1vcpu-1gb'),
    image: env(`${box.envPrefix}_IMAGE`, 'ubuntu-24-04-x64'),
    sshSource: env(`${box.envPrefix}_SSH_SOURCE`),
  };

  function fail(message) {
    console.error(`${prefix} ERROR: ${message}`);
    process.exit(1);
  }

  function usage() {
    console.log(`Usage: node ${box.script} <render|plan|apply|status|verify|ssh-open|destroy>

Commands:
  render   Print the cloud-init payload. Creates nothing and needs no token.
  plan     Show what apply would create, and what it costs, against live state.
  apply    Create or complete the Droplet, Reserved IP and firewall. Billable.
  status   Show the current Droplet, Reserved IP and firewall.
  verify   Run the acceptance checks against the live Reserved IP.
  ssh-open Point the firewall's SSH rule at wherever you are now.
  destroy  Destroy the Droplet and firewall. Keeps the Reserved IP by default.

Environment (also read from ${envFiles.join(' or ')}):
  DIGITALOCEAN_ACCESS_TOKEN   Required for plan/apply/status/destroy.
  ${box.envPrefix}_NAME        Default: ${box.defaultName}.
  ${box.envPrefix}_REGION      Default: ams3.
  ${box.envPrefix}_SIZE        Default: s-1vcpu-1gb ($6/mo).
  ${box.envPrefix}_IMAGE       Default: ubuntu-24-04-x64.
  ${box.envPrefix}_SSH_SOURCE  CIDR allowed to reach SSH. Detected if unset. Set it
                only if you have a fixed address; on a dynamic one, leave it
                unset and run ssh-open when you need in.
  ${box.envPrefix}_SSH_KEY_ID, _SSH_KEY_FINGERPRINT or _SSH_KEY_NAME
                Which DigitalOcean SSH key to install.
`);
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

  async function findDroplet(token) {
    const payload = await doRequest(token, 'GET', `/droplets?tag_name=${box.tag}`);
    return payload?.droplets?.find((droplet) => droplet.name === config.name) || null;
  }

  async function publishedAddress() {
    try {
      return (await dns.resolve4(box.publishedHost(config.name)))[0] || null;
    } catch {
      return null;
    }
  }

  // Ours is the one attached to our Droplet, or the parked one the parent zone
  // already points this box's host at. Never just any unattached address: two
  // boxes share a region, and claiming the other's parked IP would re-point it.
  async function findReservedIp(token, droplet) {
    const payload = await doRequest(token, 'GET', '/reserved_ips?per_page=200');
    const reservedIps = payload?.reserved_ips || [];

    if (droplet) {
      const attached = reservedIps.find((entry) => entry.droplet?.id === droplet.id);
      if (attached) return attached;
    }

    const published = await publishedAddress();
    return reservedIps.find((entry) => !entry.droplet && entry.ip === published) || null;
  }

  async function findFirewall(token) {
    const payload = await doRequest(token, 'GET', '/firewalls?per_page=200');
    return payload?.firewalls?.find((entry) => entry.name === `${config.name}-fw`) || null;
  }

  async function resolveSshKeys(token) {
    const id = env(`${box.envPrefix}_SSH_KEY_ID`);
    if (id) return [Number(id)];

    const fingerprint = env(`${box.envPrefix}_SSH_KEY_FINGERPRINT`);
    if (fingerprint) return [fingerprint];

    const name = env(`${box.envPrefix}_SSH_KEY_NAME`);
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
        ? `Set ${box.envPrefix}_SSH_KEY_NAME to one of: ${keys.map((key) => key.name).join(', ')}`
        : 'The DigitalOcean account has no SSH keys. Add one before provisioning.',
    );
  }

  async function detectSshSource() {
    if (config.sshSource) return config.sshSource;

    const response = await fetch('https://checkip.amazonaws.com');
    if (!response.ok) fail(`Could not detect your public IP. Set ${box.envPrefix}_SSH_SOURCE.`);

    return `${(await response.text()).trim()}/32`;
  }

  function firewallRules(sshSource) {
    const anywhere = { addresses: ['0.0.0.0/0', '::/0'] };

    return {
      inbound_rules: [
        ...box.publicPorts.map(({ protocol, ports }) => ({ protocol, ports, sources: anywhere })),
        { protocol: 'tcp', ports: '22', sources: { addresses: [sshSource] } },
      ],
      outbound_rules: [
        { protocol: 'tcp', ports: 'all', destinations: anywhere },
        { protocol: 'udp', ports: 'all', destinations: anywhere },
        { protocol: 'icmp', destinations: anywhere },
      ],
    };
  }

  const publicPortsText = box.publicPorts.map(({ protocol, ports }) => `${protocol}/${ports}`).join(' ');

  async function commandRender() {
    process.stdout.write(box.renderCloudInit());
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

    console.log(`${box.title} plan (${config.region})\n`);

    console.log(droplet
      ? `  exists   droplet      ${droplet.name} (${droplet.id})`
      : `  create   droplet      ${config.name}  ${config.size}  ${config.image}   $${cost ?? '?'}.00/mo`);

    console.log(reservedIp
      ? `  exists   reserved ip  ${reservedIp.ip}`
      : '  create   reserved ip  free while attached to a Droplet');

    console.log(firewall
      ? `  exists   firewall     ${firewall.name}`
      : `  create   firewall     ${config.name}-fw  ${publicPortsText} from anywhere, ssh from ${sshSource}`);

    const newCost = droplet ? 0 : cost ?? 0;
    console.log(`\n  added monthly cost: $${newCost}.00`);
    console.log(`\nRun \`node ${box.script} apply\` to create it.`);
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

  async function commandApply() {
    const token = getToken();
    const sshSource = await detectSshSource();

    let droplet = await findDroplet(token);

    if (!droplet) {
      const sshKeys = await resolveSshKeys(token);
      console.log(`${prefix} creating droplet ${config.name} in ${config.region}...`);

      const created = await doRequest(token, 'POST', '/droplets', {
        name: config.name,
        region: config.region,
        size: config.size,
        image: config.image,
        ssh_keys: sshKeys,
        tags: [box.tag],
        backups: false,
        ipv6: true,
        monitoring: true,
        user_data: box.renderCloudInit(),
      });

      droplet = created.droplet;
      droplet = await waitForNetwork(token, droplet.id);
    } else {
      console.log(`${prefix} droplet ${droplet.name} already exists (${droplet.id})`);
    }

    let reservedIp = await findReservedIp(token, droplet);

    if (!reservedIp) {
      console.log(`${prefix} creating and attaching reserved ip...`);
      const created = await doRequest(token, 'POST', '/reserved_ips', { droplet_id: droplet.id });
      reservedIp = created.reserved_ip;
    } else if (reservedIp.droplet?.id !== droplet.id) {
      console.log(`${prefix} reassigning reserved ip ${reservedIp.ip} to ${droplet.name}...`);
      await doRequest(token, 'POST', `/reserved_ips/${reservedIp.ip}/actions`, {
        type: 'assign',
        droplet_id: droplet.id,
      });
    } else {
      console.log(`${prefix} reserved ip ${reservedIp.ip} already attached`);
    }

    const firewall = await findFirewall(token);

    if (!firewall) {
      console.log(`${prefix} creating firewall...`);
      await doRequest(token, 'POST', '/firewalls', {
        name: `${config.name}-fw`,
        ...firewallRules(sshSource),
        droplet_ids: [droplet.id],
      });
    } else {
      console.log(`${prefix} firewall ${firewall.name} already exists`);
    }

    console.log(`
${prefix} done. Reserved IP: ${reservedIp.ip}

Next:
  1. Make sure these records exist in the myownsuite.org zone in Cloudflare, DNS only
     (add the missing ones; those already there stay as they are):
${box.parentRecords(reservedIp.ip).map((record) => `       ${record}`).join('\n')}
  2. cloud-init takes a few minutes. Then:
       node ${box.script} verify
`);
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
    if (!reservedIp) fail(`No reserved IP found. Run \`node ${box.script} apply\` first.`);

    const result = spawnSync(process.execPath, [box.verifyScript, reservedIp.ip], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
  }

  // SSH is restricted at the network layer as well as by key, which on a dynamic
  // ISP address means the rule goes stale. This runs against the API, not the
  // box, and DigitalOcean's recovery console bypasses the firewall entirely.
  async function commandSshOpen() {
    const token = getToken();
    const firewall = await findFirewall(token);
    if (!firewall) fail(`No firewall found. Run \`node ${box.script} apply\` first.`);

    const sshSource = await detectSshSource();
    const previous = firewall.inbound_rules
      .find((rule) => rule.protocol === 'tcp' && rule.ports === '22')
      ?.sources?.addresses || [];

    if (previous.length === 1 && previous[0] === sshSource) {
      console.log(`${prefix} ssh is already open from ${sshSource}`);
      return;
    }

    await doRequest(token, 'PUT', `/firewalls/${firewall.id}`, {
      name: firewall.name,
      ...firewallRules(sshSource),
      droplet_ids: firewall.droplet_ids || [],
      tags: firewall.tags || [],
    });

    console.log(`${prefix} ssh now open from ${sshSource}, was ${previous.join(', ') || 'nothing'}`);
  }

  async function commandDestroy() {
    const token = getToken();
    const droplet = await findDroplet(token);
    const firewall = await findFirewall(token);

    // Droplet first: the other order can leave a live box on the internet with
    // nothing in front of it, this one only an orphaned firewall the next apply reuses.
    if (droplet) {
      console.log(`${prefix} destroying droplet ${droplet.name} (${droplet.id})...`);
      await doRequest(token, 'DELETE', `/droplets/${droplet.id}`);
    } else {
      console.log(`${prefix} no droplet found`);
    }

    if (firewall) {
      console.log(`${prefix} deleting firewall ${firewall.name}...`);
      await doRequest(token, 'DELETE', `/firewalls/${firewall.id}`);
    }

    const reservedIp = await findReservedIp(token, null);
    console.log(reservedIp
      ? `\n${prefix} reserved ip ${reservedIp.ip} kept, so the parent-zone records stay valid.\n         An unattached reserved IP is billed; run apply to reattach it.`
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
}

module.exports = {
  RESOLVED_STUB_OFF,
  corednsInstallCommands,
  readConfig,
  repoRoot,
  runDropletBox,
  writeFilesYaml,
};
