const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DISTRO_CONFIG_PATH,
  ownerManagedReason,
  renderHoldsConfig,
  renderPeriodicConfig,
  renderPostPatchUnit,
  renderSecurityConfig,
} = require('../../infrastructure/host-patching.cjs');

const STOCK = `// Unattended-Upgrade::Origins-Pattern controls which packages are
Unattended-Upgrade::Allowed-Origins {
        "\${distro_id}:\${distro_codename}";
        "\${distro_id}:\${distro_codename}-security";
};
`;

test('the policy installs from the security pocket and from nothing else', () => {
  const config = renderSecurityConfig();
  assert.match(config, /Unattended-Upgrade::Allowed-Origins \{\s*"\$\{distro_id\}:\$\{distro_codename\}-security";\s*\};/u);
  // Without both clears the distro's own list is unioned with this one, which
  // would quietly reinstate -updates and the ESM pockets.
  assert.match(config, /#clear Unattended-Upgrade::Allowed-Origins;/u);
  assert.match(config, /#clear Unattended-Upgrade::Origins-Pattern;/u);
  const directives = config.split('\n').filter((line) => line.trim() && !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(directives, /-updates|-backports|-proposed|ESM/u);
});

test('MOS never restarts the server on its own', () => {
  assert.match(renderSecurityConfig(), /Unattended-Upgrade::Automatic-Reboot "false";/u);
  assert.match(renderSecurityConfig(), /Unattended-Upgrade::Automatic-Reboot-WithUsers "false";/u);
});

// Decision 4: the kernel is the scariest package and also the one where being
// behind gets an owner owned. Container escapes are kernel bugs.
test('nothing is held back by the policy itself', () => {
  assert.doesNotMatch(renderSecurityConfig(), /Package-Blacklist/u);
});

test('the periodic settings turn the unattended run on', () => {
  const periodic = renderPeriodicConfig();
  assert.match(periodic, /APT::Periodic::Update-Package-Lists "1";/u);
  assert.match(periodic, /APT::Periodic::Unattended-Upgrade "1";/u);
});

test('an untouched distro config is not evidence that the owner chose anything', () => {
  assert.equal(ownerManagedReason({ distroConfig: STOCK, otherConfigs: [], stockConfig: STOCK }), null);
  // Line endings and a trailing newline are not an edit.
  assert.equal(ownerManagedReason({ distroConfig: `${STOCK.replace(/\n/gu, '\r\n')}\n`, otherConfigs: [], stockConfig: STOCK }), null);
});

test('an edited distro config is left alone and reported', () => {
  const reason = ownerManagedReason({
    distroConfig: STOCK.replace('-security";', '-security";\n        "${distro_id}:${distro_codename}-updates";'),
    otherConfigs: [],
    stockConfig: STOCK,
  });
  assert.ok(reason);
  assert.match(reason, new RegExp(DISTRO_CONFIG_PATH.replace(/[.]/gu, '\\.'), 'u'));
});

// Verbatim from a stock Ubuntu 24.04 server. Every install has this file, so
// treating it as an owner's policy would leave every server unpatched.
test('the list-refresh cadence Ubuntu ships in 10periodic is not an owner policy', () => {
  const reason = ownerManagedReason({
    distroConfig: STOCK,
    otherConfigs: [{ path: '/etc/apt/apt.conf.d/10periodic', text: 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Download-Upgradeable-Packages "0";\nAPT::Periodic::AutocleanInterval "0";\n' }],
    stockConfig: STOCK,
  });
  assert.equal(reason, null);
});

test('an owner who turned unattended upgrades off has made a choice too', () => {
  const reason = ownerManagedReason({
    distroConfig: STOCK,
    otherConfigs: [{ path: '/etc/apt/apt.conf.d/99no-auto', text: 'APT::Periodic::Unattended-Upgrade "0";\n' }],
    stockConfig: STOCK,
  });
  assert.match(reason, /99no-auto already sets/u);
});

test('a policy the owner put in another file is found wherever they put it', () => {
  const reason = ownerManagedReason({
    distroConfig: STOCK,
    otherConfigs: [
      { path: '/etc/apt/apt.conf.d/99local-proxy', text: 'Acquire::http::Proxy "http://proxy:3128";\n' },
      { path: '/etc/apt/apt.conf.d/99my-policy', text: 'Unattended-Upgrade::Automatic-Reboot "true";\n' },
    ],
    stockConfig: STOCK,
  });
  assert.equal(reason, '/etc/apt/apt.conf.d/99my-policy already sets an unattended-upgrades policy, so MOS left it alone.');
});

test('a server with no unattended-upgrades installed at all is MOS’s to set up', () => {
  assert.equal(ownerManagedReason({ distroConfig: null, otherConfigs: [], stockConfig: null }), null);
});

test('a held package is anchored and escaped, so a hold names one package', () => {
  const config = renderHoldsConfig(['linux-image-generic', 'g++-13']);
  assert.match(config, /"\^linux-image-generic\$";/u);
  assert.match(config, /"\^g\\\+\\\+-13\$";/u);
  assert.match(config, /#clear Unattended-Upgrade::Package-Blacklist;/u);
});

// The empty list is the expected steady state, and it has to clear a hold that
// was published and then withdrawn rather than leave the last one in place.
test('an empty hold list is written, not skipped', () => {
  const config = renderHoldsConfig([]);
  assert.match(config, /#clear Unattended-Upgrade::Package-Blacklist;/u);
  assert.match(config, /Unattended-Upgrade::Package-Blacklist \{\s*\};/u);
});

test('the post-patch check runs at boot and after an unattended run', () => {
  const unit = renderPostPatchUnit('/opt/mos/repo', '/var/lib/mos');
  // It writes its report under the state root, which the vault mounts over, so
  // it waits for the gate like everything else that touches owner data: on a
  // locked boot it would otherwise write a false "everything is down" report to
  // the plaintext side, which is what the first hardware install found.
  assert.match(unit, /^Requires=mos-vault\.service$/mu);
  assert.match(unit, /After=mos-vault\.service network-online\.target docker\.service apt-daily-upgrade\.service/u);
  assert.match(unit, /WantedBy=multi-user\.target apt-daily-upgrade\.service/u);
  // Wanted by a target and ordered after it is an ordering cycle, which systemd
  // resolves by dropping a job from the boot.
  assert.doesNotMatch(unit, /After=.*multi-user\.target/u);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/mos\/repo\/system-agents\/host-patches\/post-patch-check\.cjs/u);
  assert.match(unit, /Environment=MOS_STATE_ROOT=\/var\/lib\/mos/u);
});
