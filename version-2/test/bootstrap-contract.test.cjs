const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  CONTROL_PLANE_COMPONENTS,
  createBootstrapConfig,
  defaultDomainFor,
  renderBootstrapPlan,
  validateBootstrapInput,
} = require('../scripts/installers/bootstrap-contract.cjs');
const { parseArgs, selectOutput } = require('../scripts/installers/render-bootstrap.cjs');
const { DEFAULT_READY_TIMEOUT_MS, smokeConfigFromEnv } = require('../scripts/smoke/digitalocean-v2.cjs');

test('bootstrap contract defaults to a no-preconfig control-plane install', () => {
  const plan = renderBootstrapPlan({});

  assert.equal(plan.config.noPreconfig, true);
  assert.equal(plan.config.repoRef, 'feat/app-platform-v2-lab');
  assert.equal(plan.config.domain, 'localhost');
  assert.deepEqual(plan.config.components, CONTROL_PLANE_COMPONENTS);
  assert.equal(plan.config.publicUrls.home, 'http://home.localhost/');
  assert.equal(plan.config.publicUrls.setup, 'http://home.localhost/suite-manager/');
  assert.equal(plan.config.publicUrls.suiteManager, 'http://home.localhost/suite-manager/');
  assert.doesNotMatch(plan.env, /OWNER_EMAIL|OWNER_PASSWORD|MOS_OWNER/);
  assert.doesNotMatch(plan.env, /SELECTED_APPS|MOS_APPS|STIRLING|VAULTWARDEN/);
  assert.match(plan.env, /MOS_V2_OWNER_SETUP='suite-manager-browser'/);
  assert.match(plan.env, /MOS_V2_APP_SELECTION='suite-manager-after-install'/);
  assert.match(plan.cloudInit, /ExecStart=\/usr\/bin\/node .*suite-manager\/backend\/src\/server\/start\.cjs/);
  assert.match(plan.cloudInit, /reverse_proxy 127\.0\.0\.1:\$MOS_V2_SUITE_MANAGER_PORT/);
  assert.match(plan.cloudInit, /mos-v2-homepage\.service/);
  assert.match(plan.cloudInit, /--publish 127\.0\.0\.1:3200:3000/);
  assert.match(plan.cloudInit, /docker pull 'ghcr\.io\/gethomepage\/homepage@sha256:[a-f0-9]+' &/);
  assert.match(plan.cloudInit, /if ! wait "\$homepage_pull_pid"; then/);
  assert.match(plan.cloudInit, /\.mos-v2-defaults-v2/);
  assert.match(plan.cloudInit, /if \[ ! -e "\$homepage_seed_marker" \] \|\| \[ ! -e "\$target_file" \]; then/);
  assert.match(plan.cloudInit, /systemctl restart mos-v2-homepage\.service/);
  assert.match(plan.cloudInit, /curl -fsS -H "Host: \$MOS_V2_HOME_HOST" "\$MOS_V2_HOMEPAGE_UPSTREAM"/);
  assert.match(plan.cloudInit, /systemctl restart mos-v2-suite-manager\.service/);
  assert.match(plan.cloudInit, /Wants=mos-v2-homepage\.service network-online\.target/);
  assert.doesNotMatch(plan.cloudInit, /Requires=mos-v2-homepage\.service/);
  assert.match(plan.cloudInit, /systemctl restart caddy\.service/);
  assert.match(plan.cloudInit, /infrastructure\/caddy\/Dockerfile/);
  assert.match(plan.cloudInit, /dns\.providers\.cloudflare/);
  assert.match(plan.cloudInit, /mos-v2-https-agent\.service/);
  assert.match(plan.cloudInit, /mos-v2-homepage-agent\.service/);
  assert.match(plan.cloudInit, /MOS_V2_HOMEPAGE_AGENT_SOCKET=\/run\/mos-v2-homepage-agent\/agent\.sock/);
  assert.match(plan.cloudInit, /mos-v2-homepage-routes\.caddy/);
  assert.match(plan.cloudInit, /MOS_V2_HTTPS_AGENT_SOCKET/);
  assert.match(plan.cloudInit, /caddy-cloudflare\.env/);
  assert.ok(
    plan.cloudInit.indexOf('docker pull')
      < plan.cloudInit.indexOf('npm --prefix'),
  );
  assert.ok(
    plan.cloudInit.indexOf('if ! wait "$homepage_pull_pid"; then')
      < plan.cloudInit.indexOf('systemctl restart mos-v2-homepage.service'),
  );
  assert.ok(
    plan.cloudInit.indexOf('systemctl restart mos-v2-homepage.service')
      < plan.cloudInit.indexOf('systemctl restart mos-v2-suite-manager.service'),
  );
  assert.match(plan.cloudInit, /\/usr\/share\/keyrings\/caddy-stable-archive-keyring\.gpg/);
  assert.match(plan.cloudInit, /http:\/\/\$MOS_V2_HOME_HOST/);
  assert.doesNotMatch(plan.cloudInit, /MOS_V2_SUITE_MANAGER_HOSTNAME|suite-manager\.\$MOS_V2_DOMAIN/);
  assert.doesNotMatch(plan.cloudInit, /reverse_proxy 127\.0\.0\.1:3200/);
  assert.ok(
    plan.cloudInit.indexOf('rm -f /etc/apt/sources.list.d/caddy-stable.list')
      < plan.cloudInit.indexOf('apt-get update'),
  );
  assert.doesNotMatch(plan.cloudInit, /\r/);
  assert.doesNotMatch(plan.sshBootstrap, /\r/);
});

test('bootstrap contract derives sslip.io domain for cloud smoke installs', () => {
  const config = createBootstrapConfig({
    frontDoor: 'digitalocean-smoke',
    publicIpv4: '203.0.113.42',
    repoRef: 'feature/test-ref',
  });

  assert.equal(defaultDomainFor({ publicIpv4: '203.0.113.42' }), '203.0.113.42.sslip.io');
  assert.equal(config.domain, '203.0.113.42.sslip.io');
  assert.equal(config.publicUrls.home, 'http://home.203.0.113.42.sslip.io/');
  assert.equal(config.publicUrls.setup, 'http://home.203.0.113.42.sslip.io/suite-manager/');
  assert.equal(config.publicUrls.suiteManager, 'http://home.203.0.113.42.sslip.io/suite-manager/');
  assert.equal(config.repoRef, 'feature/test-ref');
});

test('Hyper-V smoke derives its private DHCP address at first boot', () => {
  const plan = renderBootstrapPlan({ frontDoor: 'hyperv-smoke' });

  assert.equal(plan.config.domain, 'localhost');
  assert.match(plan.cloudInit, /MOS_V2_FRONT_DOOR='hyperv-smoke'/);
  assert.match(plan.cloudInit, /private_ip="\$\(hostname -I \| awk '\{print \$1\}'\)"/);
  assert.match(plan.cloudInit, /MOS_V2_DOMAIN="\$private_ip\.sslip\.io"/);
});

test('DigitalOcean smoke allows slow first-machine builds to reach readiness', () => {
  assert.equal(DEFAULT_READY_TIMEOUT_MS, 30 * 60 * 1000);
});

test('Hyper-V smoke is pinned, guarded, and does not add owner or DNS inputs', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'smoke', 'hyperv-v2.ps1'), 'utf8');

  assert.match(script, /release-20260615\/\$ImageName/u);
  assert.match(script, /99e8fc9be8fe4f805a1ca06349b21377f8d79ef8c02c44f89515ef6557b449b1/u);
  assert.match(script, /Test-Administrator/u);
  assert.match(script, /\$VmName = 'mos-v2-smoke'/u);
  assert.match(script, /\$source\.CopyTo\(\$target, 8MB\)/u);
  assert.match(script, /ubuntu-24\.04-materialized\.vhd/u);
  assert.match(script, /Convert-VHD .* -VHDType Dynamic/u);
  assert.match(script, /MemoryStartupBytes 2GB/u);
  assert.match(script, /Set-VMMemory .* -DynamicMemoryEnabled \$true .* -MaximumBytes 4GB/u);
  assert.match(script, /--resolve "\$\{hostName\}:80:\$ip"/u);
  assert.doesNotMatch(script, /OWNER_PASSWORD|CLOUDFLARE|DNS01/u);
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
    repoRef: 'refs/heads/v2-smoke',
    repoUrl: 'https://example.test/mos.git',
  });

  for (const rendered of [plan.cloudInit, plan.sshBootstrap]) {
    assert.match(rendered, /MOS_V2_REPO_URL='https:\/\/example.test\/mos.git'/);
    assert.match(rendered, /MOS_V2_REPO_REF='refs\/heads\/v2-smoke'/);
    assert.match(rendered, /MOS_V2_DOMAIN='mos.example.test'/);
    assert.match(rendered, /MOS_V2_HOME_HOST="home\.\$MOS_V2_DOMAIN"/);
    assert.match(rendered, /MOS_V2_HOME_URL="http:\/\/\$MOS_V2_HOME_HOST\/"/);
    assert.match(rendered, /MOS_V2_SETUP_URL="http:\/\/\$MOS_V2_HOME_HOST\/suite-manager\/"/);
    assert.match(rendered, /MOS_V2_SUITE_MANAGER_URL="\$MOS_V2_SETUP_URL"/);
    assert.doesNotMatch(rendered, /MOS_OWNER_PASSWORD|MOS_SMOKE_OWNER_PASSWORD|MOS_SELECTED_APPS/);
  }

  assert.match(plan.usbSeed, /MOS_V2_REPO_URL='https:\/\/example.test\/mos.git'/);
  assert.match(plan.usbSeed, /MOS_V2_FRONT_DOOR='usb-autoinstall'/);
  assert.match(plan.usbSeed, /MOS_V2_SUITE_MANAGER_URL='http:\/\/home.mos.example.test\/suite-manager\/'/);
  assert.match(plan.usbSeed, /MOS_V2_HOMEPAGE_URL='http:\/\/home.mos.example.test\/'/);
  assert.doesNotMatch(plan.usbSeed, /MOS_OWNER_PASSWORD|MOS_SMOKE_OWNER_PASSWORD|MOS_SELECTED_APPS/);
});

test('render CLI parses dry-run target inputs without requiring an env file', () => {
  const parsed = parseArgs([
    '--target',
    'cloud-init',
    '--public-ipv4',
    '198.51.100.17',
    '--repo-ref',
    'test-ref',
  ]);
  const plan = renderBootstrapPlan(parsed.input);

  assert.equal(parsed.target, 'cloud-init');
  assert.equal(plan.config.domain, '198.51.100.17.sslip.io');
  assert.match(selectOutput(plan, parsed.target), /^#cloud-config/);
  assert.match(selectOutput(plan, 'json'), /"suiteManager": "http:\/\/home.198.51.100.17.sslip.io\/suite-manager\/"/);
  assert.match(selectOutput(plan, 'json'), /"setup": "http:\/\/home.198.51.100.17.sslip.io\/suite-manager\/"/);
});

test('DigitalOcean smoke config defaults to a real V2 branch install without owner inputs', () => {
  const previous = {
    MOS_V2_SMOKE_REPO_REF: process.env.MOS_V2_SMOKE_REPO_REF,
    MOS_V2_SMOKE_REPO_URL: process.env.MOS_V2_SMOKE_REPO_URL,
    MOS_SMOKE_OWNER_EMAIL: process.env.MOS_SMOKE_OWNER_EMAIL,
    MOS_SMOKE_OWNER_PASSWORD: process.env.MOS_SMOKE_OWNER_PASSWORD,
  };

  try {
    delete process.env.MOS_V2_SMOKE_REPO_REF;
    delete process.env.MOS_V2_SMOKE_REPO_URL;
    process.env.MOS_SMOKE_OWNER_EMAIL = 'old-owner@example.com';
    process.env.MOS_SMOKE_OWNER_PASSWORD = 'old-password';

    const config = smokeConfigFromEnv();
    const plan = renderBootstrapPlan({
      frontDoor: 'digitalocean-smoke',
      repoRef: config.repoRef,
      repoUrl: config.repoUrl,
    });

    assert.equal(config.repoRef, 'feat/app-platform-v2-lab');
    assert.equal(config.repoUrl, 'https://github.com/rpuls/my-own-suite.git');
    assert.match(plan.cloudInit, /MOS_V2_FRONT_DOOR='digitalocean-smoke'/);
    assert.match(plan.cloudInit, /169\.254\.169\.254\/metadata\/v1\/interfaces\/public\/0\/ipv4\/address/);
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
