const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTROL_PLANE_COMPONENTS,
  createBootstrapConfig,
  defaultDomainFor,
  renderBootstrapPlan,
  validateBootstrapInput,
} = require('../../scripts/installers/bootstrap-contract.cjs');
const { parseArgs, selectOutput } = require('../../scripts/installers/render-bootstrap.cjs');
const { DEFAULT_READY_TIMEOUT_MS, bootstrapPlanFor, ownerClaimUrl, preflightInstaller, renderPublicInstallerCloudInit, smokeConfigFromEnv } = require('../../scripts/smoke/digitalocean.cjs');

function installerResponse({ body, ok = true, status = 200, headers = {} }) {
  return async () => ({
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    ok,
    status,
    statusText: '',
    text: async () => body,
  });
}

test('bootstrap contract defaults to a no-preconfig control-plane install', () => {
  const plan = renderBootstrapPlan({});

  assert.equal(plan.config.noPreconfig, true);
  assert.equal(plan.config.repoRef, 'staging');
  assert.equal(plan.config.domain, 'localhost');
  assert.deepEqual(plan.config.components, CONTROL_PLANE_COMPONENTS);
  assert.equal(plan.config.publicUrls.home, 'http://home.localhost/');
  assert.equal(plan.config.publicUrls.setup, 'http://home.localhost/suite-manager/');
  assert.equal(plan.config.publicUrls.suiteManager, 'http://home.localhost/suite-manager/');
  assert.doesNotMatch(plan.env, /OWNER_EMAIL|OWNER_PASSWORD|MOS_OWNER_(?:EMAIL|PASSWORD)/);
  assert.doesNotMatch(plan.env, /SELECTED_APPS|MOS_APPS|STIRLING|VAULTWARDEN/);
  assert.match(plan.env, /MOS_OWNER_SETUP='suite-manager-browser'/);
  assert.match(plan.env, /MOS_APP_SELECTION='suite-manager-after-install'/);
  assert.match(plan.env, /MOS_DISPOSABLE_LAB='0'/);
  assert.match(plan.cloudInit, /ExecStart=\/usr\/bin\/node .*suite-manager\/backend\/src\/server\/start\.cjs/);
  assert.match(plan.cloudInit, /reverse_proxy 127\.0\.0\.1:\$MOS_SUITE_MANAGER_PORT/);
  assert.match(plan.cloudInit, /mos-homepage\.service/);
  assert.match(plan.cloudInit, /--publish 127\.0\.0\.1:3200:3000/);
  assert.match(plan.cloudInit, /docker pull 'ghcr\.io\/gethomepage\/homepage@sha256:[a-f0-9]+' &/);
  assert.match(plan.cloudInit, /if ! wait "\$homepage_pull_pid"; then/);
  assert.match(plan.cloudInit, /\.mos-defaults/);
  assert.match(plan.cloudInit, /if \[ ! -e "\$homepage_seed_marker" \] \|\| \[ ! -e "\$target_file" \]; then/);
  assert.match(plan.cloudInit, /systemctl restart mos-homepage\.service/);
  assert.match(plan.cloudInit, /curl -fsS -H "Host: \$MOS_HOME_HOST" "\$MOS_HOMEPAGE_UPSTREAM"/);
  assert.match(plan.cloudInit, /systemctl restart mos-suite-manager\.service/);
  assert.match(plan.cloudInit, /Wants=mos-homepage\.service network-online\.target/);
  assert.doesNotMatch(plan.cloudInit, /Requires=mos-homepage\.service/);
  assert.match(plan.cloudInit, /systemctl restart caddy\.service/);
  assert.doesNotMatch(plan.cloudInit, /caddy run --environ/);
  assert.match(plan.cloudInit, /infrastructure\/caddy\/Dockerfile/);
  assert.match(plan.cloudInit, /dns\.providers\.cloudflare/);
  assert.match(plan.cloudInit, /mos-https-agent\.service/);
  assert.match(plan.cloudInit, /Environment=MOS_SUITE_MANAGER_PORT=\$MOS_SUITE_MANAGER_PORT/);
  assert.match(plan.cloudInit, /mos-homepage-agent\.service/);
  assert.match(plan.cloudInit, /MOS_HOMEPAGE_AGENT_SOCKET=\/run\/mos-homepage-agent\/agent\.sock/);
  assert.match(plan.cloudInit, /install -d -m 0750 .*"\$MOS_STATE_ROOT\/app-packages"/);
  assert.match(plan.cloudInit, /chown root:mos-agent "\$MOS_STATE_ROOT\/app-packages"/);
  // Setgid, so snapshots the root app agent writes below inherit mos-agent
  // and stay readable by Suite Manager, which re-verifies each one on read.
  // Without it a bootstrap provisions a root no installed app can be read from.
  assert.match(plan.cloudInit, /chmod 2750 "\$MOS_STATE_ROOT\/app-packages"/);
  assert.match(plan.cloudInit, /Environment=MOS_APP_PACKAGE_ROOT=\$MOS_STATE_ROOT\/app-packages/);
  assert.match(plan.cloudInit, /mos-backup-agent\.service/);
  assert.match(plan.cloudInit, /MOS_BACKUP_AGENT_SOCKET=\/run\/mos-backup-agent\/agent\.sock/);
  assert.match(plan.cloudInit, /mos-lab-reset-agent\.service/);
  assert.match(plan.cloudInit, /MOS_LAB_RESET_AGENT_SOCKET=\/run\/mos-lab-reset-agent\/agent\.sock/);
  assert.match(plan.cloudInit, /if \[ "\$MOS_DISPOSABLE_LAB" = '1' \]; then/);
  assert.match(plan.cloudInit, /mos-homepage-routes\.caddy/);
  assert.match(plan.cloudInit, /MOS_HTTPS_AGENT_SOCKET/);
  assert.match(plan.cloudInit, /caddy-cloudflare\.env/);
  assert.ok(
    plan.cloudInit.indexOf('docker pull')
      < plan.cloudInit.indexOf('npm --prefix'),
  );
  assert.ok(
    plan.cloudInit.indexOf('if ! wait "$homepage_pull_pid"; then')
      < plan.cloudInit.indexOf('systemctl restart mos-homepage.service'),
  );
  assert.ok(
    plan.cloudInit.indexOf('systemctl restart mos-homepage.service')
      < plan.cloudInit.indexOf('systemctl restart mos-suite-manager.service'),
  );
  assert.match(plan.cloudInit, /\/usr\/share\/keyrings\/caddy-stable-archive-keyring\.gpg/);
  assert.match(plan.cloudInit, /http:\/\/\$MOS_HOME_HOST/);
  assert.doesNotMatch(plan.cloudInit, /MOS_SUITE_MANAGER_HOSTNAME|suite-manager\.\$MOS_DOMAIN/);
  assert.doesNotMatch(plan.cloudInit, /reverse_proxy 127\.0\.0\.1:3200/);
  assert.ok(
    plan.cloudInit.indexOf('rm -f /etc/apt/sources.list.d/caddy-stable.list')
      < plan.cloudInit.indexOf('apt-get update'),
  );
  assert.doesNotMatch(plan.cloudInit, /\r/);
  assert.match(plan.shell, /^#!\/usr\/bin\/env bash/);
  assert.doesNotMatch(plan.sshBootstrap, /\r/);
  // Local installs must show the LAN IP and the DNS override to add, because
  // home.<domain> only resolves once the user configures local DNS.
  assert.match(plan.shell, /mos_lan_ip="\$\(ip -4 route get/);
  assert.match(plan.shell, /LAN IP/);
  assert.match(plan.shell, /add a DNS override in your router/);
});

test('bootstrap contract derives sslip.io domain for cloud smoke installs', () => {
  const config = createBootstrapConfig({
    frontDoor: 'digitalocean-smoke',
    publicIpv4: '203.0.113.42',
    repoRef: 'feature/test-ref',
  });

  assert.equal(defaultDomainFor({ publicIpv4: '203.0.113.42' }), '203.0.113.42.sslip.io');
  assert.equal(config.domain, '203.0.113.42.sslip.io');
  assert.equal(config.publicUrls.home, 'https://home.203.0.113.42.sslip.io/');
  assert.equal(config.publicUrls.setup, 'https://home.203.0.113.42.sslip.io/suite-manager/');
  assert.equal(config.publicUrls.suiteManager, 'https://home.203.0.113.42.sslip.io/suite-manager/');
  assert.equal(config.repoRef, 'feature/test-ref');
});

test('public VPS installs use the protected HTTPS cloud contract', () => {
  const plan = renderBootstrapPlan({
    frontDoor: 'public-vps',
    publicIpv4: '159.65.197.98',
  });

  assert.equal(plan.config.publicUrls.setup, 'https://home.159.65.197.98.sslip.io/suite-manager/');
  assert.match(plan.shell, /MOS_FRONT_DOOR='public-vps'/);
  assert.match(plan.shell, /OWNER_CLAIM_TOKEN=/);
  assert.match(plan.shell, /https:\/\/\$MOS_HOME_HOST/);
  // Cloud installs use a public sslip.io domain; a LAN IP hint would mislead.
  assert.doesNotMatch(plan.shell, /mos_lan_ip="\$\(ip -4 route get/);
});

test('DigitalOcean smoke allows slow first-machine builds to reach readiness', () => {
  assert.equal(DEFAULT_READY_TIMEOUT_MS, 30 * 60 * 1000);
});

test('bootstrap contract rejects owner credentials and app config at installer time', () => {
  assert.deepEqual(validateBootstrapInput({
    MOS_OWNER_EMAIL: 'owner@example.com',
    ownerPassword: 'secret',
    selectedApps: ['vaultwarden'],
    MOS_APPS: 'stirling-pdf',
  }), [
    'Owner credential input is not allowed before first boot: ownerPassword.',
    'Owner credential input is not allowed before first boot: MOS_OWNER_EMAIL.',
    'App selection/config input is not allowed during control-plane bootstrap: selectedApps.',
    'App selection/config input is not allowed during control-plane bootstrap: MOS_APPS.',
  ]);

  assert.throws(() => renderBootstrapPlan({ MOS_SMOKE_OWNER_PASSWORD: 'secret' }), /Owner credential input/);
});

test('rendered cloud, SSH, and USB payloads share the same bootstrap contract', () => {
  const plan = renderBootstrapPlan({
    domain: 'mos.example.test',
    repoRef: 'refs/heads/smoke',
    repoUrl: 'https://example.test/mos.git',
  });

  for (const rendered of [plan.cloudInit, plan.sshBootstrap]) {
    assert.match(rendered, /MOS_REPO_URL='https:\/\/example.test\/mos.git'/);
    assert.match(rendered, /MOS_REPO_REF='refs\/heads\/smoke'/);
    assert.match(rendered, /MOS_DOMAIN='mos.example.test'/);
    assert.match(rendered, /MOS_HOME_HOST="home\.\$MOS_DOMAIN"/);
    assert.match(rendered, /MOS_HOME_URL="http:\/\/\$MOS_HOME_HOST\/"/);
    assert.match(rendered, /MOS_SETUP_URL="http:\/\/\$MOS_HOME_HOST\/suite-manager\/"/);
    assert.match(rendered, /MOS_SUITE_MANAGER_URL="\$MOS_SETUP_URL"/);
    assert.doesNotMatch(rendered, /MOS_OWNER_PASSWORD|MOS_SMOKE_OWNER_PASSWORD|MOS_SELECTED_APPS/);
  }

  assert.match(plan.usbSeed, /MOS_REPO_URL='https:\/\/example.test\/mos.git'/);
  assert.match(plan.usbSeed, /MOS_FRONT_DOOR='usb-autoinstall'/);
  assert.match(plan.usbSeed, /MOS_DISPOSABLE_LAB='0'/);
  assert.match(plan.usbSeed, /MOS_SUITE_MANAGER_URL='http:\/\/home.mos.example.test\/suite-manager\/'/);
  assert.match(plan.usbSeed, /MOS_HOMEPAGE_URL='http:\/\/home.mos.example.test\/'/);
  assert.doesNotMatch(plan.usbSeed, /MOS_OWNER_PASSWORD|MOS_SMOKE_OWNER_PASSWORD|MOS_SELECTED_APPS/);
});

test('the USB front door alone does not enable the lab reset agent', () => {
  const plan = renderBootstrapPlan({ domain: 'mos.home', frontDoor: 'usb-autoinstall' });
  assert.equal(plan.config.disposableLab, false);
  assert.match(plan.env, /MOS_DISPOSABLE_LAB='0'/);
  assert.match(plan.usbSeed, /MOS_DISPOSABLE_LAB='0'/);
  assert.match(plan.cloudInit, /MOS_DISPOSABLE_LAB='0'/);
});

test('the lab reset agent is enabled only when asked for explicitly', () => {
  const plan = renderBootstrapPlan({ domain: 'mos.home', frontDoor: 'usb-autoinstall', disposableLab: true });
  assert.equal(plan.config.disposableLab, true);
  assert.match(plan.env, /MOS_DISPOSABLE_LAB='1'/);
  assert.match(plan.cloudInit, /MOS_DISPOSABLE_LAB='1'/);
});

test('render CLI parses dry-run target inputs without requiring an env file', () => {
  const parsed = parseArgs([
    '--target',
    'cloud-init',
    '--public-ipv4',
    '198.51.100.17',
    '--front-door',
    'cloud-init',
    '--repo-ref',
    'test-ref',
  ]);
  const plan = renderBootstrapPlan(parsed.input);

  assert.equal(parsed.target, 'cloud-init');
  assert.equal(plan.config.domain, '198.51.100.17.sslip.io');
  assert.match(selectOutput(plan, parsed.target), /^#cloud-config/);
  assert.match(selectOutput(plan, 'json'), /"suiteManager": "https:\/\/home.198.51.100.17.sslip.io\/suite-manager\/"/);
  assert.match(selectOutput(plan, 'json'), /"setup": "https:\/\/home.198.51.100.17.sslip.io\/suite-manager\/"/);
  assert.match(selectOutput(plan, 'shell'), /^#!\/usr\/bin\/env bash/);
});

test('DigitalOcean smoke defaults to the public installer without owner inputs', () => {
  const previous = {
    MOS_SMOKE_REPO_REF: process.env.MOS_SMOKE_REPO_REF,
    MOS_SMOKE_REPO_URL: process.env.MOS_SMOKE_REPO_URL,
    MOS_SMOKE_OWNER_EMAIL: process.env.MOS_SMOKE_OWNER_EMAIL,
    MOS_SMOKE_OWNER_PASSWORD: process.env.MOS_SMOKE_OWNER_PASSWORD,
  };

  try {
    delete process.env.MOS_SMOKE_REPO_REF;
    delete process.env.MOS_SMOKE_REPO_URL;
    process.env.MOS_SMOKE_OWNER_EMAIL = 'old-owner@example.com';
    process.env.MOS_SMOKE_OWNER_PASSWORD = 'old-password';

    const config = smokeConfigFromEnv();
    const plan = bootstrapPlanFor(config);

    assert.equal(config.installerUrl, 'https://get-dev.myownsuite.org/install.sh');
    const cloudInit = renderPublicInstallerCloudInit(config.installerUrl);
    assert.match(cloudInit, /curl .*--proto '=https'.*get-dev\.myownsuite\.org\/install\.sh.*bash \/root\/mos-install\.sh/);
    assert.doesNotMatch(cloudInit, /render-bootstrap\.cjs|git clone/);
    assert.match(plan.cloudInit, /MOS_FRONT_DOOR='public-vps'/);
    assert.doesNotMatch(plan.cloudInit, /old-owner@example.com|old-password|MOS_SMOKE_OWNER/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('DigitalOcean cloud-init fails the install and keeps what the endpoint said', () => {
  const cloudInit = renderPublicInstallerCloudInit('https://get-dev.myownsuite.org/install.sh');
  assert.match(cloudInit, /--fail-with-body/);
  assert.match(cloudInit, /installer download failed:'; cat \/root\/mos-install\.sh; exit 1/);
  // Never piped into bash: an empty stream from a failed download exits 0.
  assert.doesNotMatch(cloudInit, /install\.sh' \| bash/);
});

test('DigitalOcean smoke refuses to create a Droplet when the installer endpoint is down', async () => {
  await assert.rejects(
    preflightInstaller('https://get-dev.myownsuite.org/install.sh', installerResponse({
      body: 'Installer unavailable: GitHub could not resolve INSTALL_BRANCH (422).\n',
      ok: false,
      status: 503,
    })),
    /returned 503.*INSTALL_BRANCH.*installer-endpoint\/README\.md/su,
  );
});

test('DigitalOcean smoke refuses an installer endpoint that is not serving a script', async () => {
  await assert.rejects(
    preflightInstaller('https://get-dev.myownsuite.org/install.sh', installerResponse({ body: '<html>nope</html>' })),
    /did not return a shell script/u,
  );
});

test('DigitalOcean smoke records the exact commit the installer endpoint is serving', async () => {
  assert.deepEqual(
    await preflightInstaller('https://get-dev.myownsuite.org/install.sh', installerResponse({
      body: '#!/usr/bin/env bash\nset -euo pipefail\n',
      headers: { 'x-mos-install-source': 'staging', 'x-mos-install-ref': 'a'.repeat(40) },
    })),
    { installSource: 'staging', installRef: 'a'.repeat(40) },
  );
});

test('DigitalOcean smoke builds the owner setup URL without persisting token state', () => {
  assert.equal(
    ownerClaimUrl('https://home.203.0.113.42.sslip.io/suite-manager/', 'abc123'),
    'https://home.203.0.113.42.sslip.io/suite-manager/?claim=abc123',
  );
});

test('DigitalOcean public installer cloud-init rejects non-HTTPS endpoints', () => {
  assert.throws(() => renderPublicInstallerCloudInit('http://example.test/install.sh'), /must use HTTPS/);
});
