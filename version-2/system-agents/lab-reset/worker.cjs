#!/usr/bin/env node

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const stateRoot = process.env.MOS_V2_STATE_ROOT || '/var/lib/mos-v2';
const installRoot = process.env.MOS_V2_INSTALL_ROOT || '/opt/mos-v2';
const repoRoot = process.env.MOS_V2_REPO_DIR || path.join(installRoot, 'repo');
const homepageSource = path.join(repoRoot, 'version-2', 'infrastructure', 'homepage');
const homepageConfig = path.join(stateRoot, 'homepage', 'config');
const bootstrapContract = path.join(stateRoot, 'bootstrap-contract.env');

function parseEnvFile(filePath) {
  try {
    return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return null;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
      if (!match) return null;
      return [match[1], match[2].trim().replace(/^(['"])(.*)\1$/u, '$2')];
    }).filter(Boolean));
  } catch {
    return {};
  }
}

function homeHostFromContract(contract) {
  if (contract.MOS_V2_HOME_HOST) return contract.MOS_V2_HOME_HOST;
  if (contract.MOS_V2_HOME_URL) {
    try {
      return new URL(contract.MOS_V2_HOME_URL).hostname;
    } catch {}
  }
  if (contract.MOS_V2_DOMAIN) return contract.MOS_V2_DOMAIN === 'localhost' ? 'home.localhost' : `home.${contract.MOS_V2_DOMAIN}`;
  return 'home.localhost';
}

function renderBootstrapCaddyfile() {
  const contract = parseEnvFile(bootstrapContract);
  const homeHost = process.env.MOS_V2_HOME_HOST || homeHostFromContract(contract);
  const suiteManagerPort = process.env.MOS_V2_SUITE_MANAGER_PORT || contract.MOS_V2_SUITE_MANAGER_PORT || '3100';
  return `http://${homeHost} {
  reverse_proxy 127.0.0.1:${suiteManagerPort}
}

import /etc/caddy/mos-v2-homepage-routes.caddy
import /etc/caddy/mos-v2-app-routes.caddy
`;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    timeout: options.timeoutMs || 60_000,
  });
}

function tryRun(command, args, options = {}) {
  try {
    return run(command, args, options);
  } catch {
    return '';
  }
}

function dockerList(args) {
  return tryRun('/usr/bin/docker', args)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function resetDockerRuntime() {
  const appContainers = unique([
    ...dockerList(['ps', '-aq', '--filter', 'label=mos-v2.package']),
    ...dockerList(['ps', '-a', '--format', '{{.Names}}']).filter((name) => name.startsWith('mos-v2-app-')),
  ]);
  for (const container of appContainers) tryRun('/usr/bin/docker', ['rm', '-f', container], { timeoutMs: 120_000 });

  const appNetworks = dockerList(['network', 'ls', '--format', '{{.Name}}']).filter((name) => name.startsWith('mos-v2-app-'));
  for (const network of appNetworks) tryRun('/usr/bin/docker', ['network', 'rm', network]);

  const appVolumes = dockerList(['volume', 'ls', '-q']).filter((name) => name.startsWith('mos-v2-app-'));
  for (const volume of appVolumes) tryRun('/usr/bin/docker', ['volume', 'rm', volume], { timeoutMs: 120_000 });
}

function copyDirectory(source, target) {
  fs.rmSync(target, { force: true, recursive: true });
  fs.mkdirSync(target, { mode: 0o755, recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function main() {
  const stoppedServices = [
    'mos-v2-suite-manager.service',
    'mos-v2-app-agent.service',
    'mos-v2-homepage-agent.service',
    'mos-v2-https-agent.service',
    'mos-v2-backup-agent.service',
    'mos-v2-update-agent.service',
    'mos-v2-homepage.service',
  ];
  const startedServices = [
    'caddy.service',
    'mos-v2-homepage.service',
    'mos-v2-homepage-agent.service',
    'mos-v2-suite-manager.service',
    'mos-v2-https-agent.service',
    'mos-v2-app-agent.service',
    'mos-v2-backup-agent.service',
    'mos-v2-update-agent.service',
  ];

  tryRun('/usr/bin/systemctl', ['stop', ...stoppedServices], { timeoutMs: 120_000 });
  resetDockerRuntime();
  fs.rmSync(path.join(stateRoot, 'suite-manager'), { force: true, recursive: true });
  copyDirectory(homepageSource, homepageConfig);
  tryRun('/usr/bin/chown', ['-R', '1000:1000', homepageConfig]);
  fs.writeFileSync('/etc/caddy/Caddyfile', renderBootstrapCaddyfile());
  fs.writeFileSync('/etc/caddy/mos-v2-homepage-routes.caddy', '# No user-managed Homepage routes.\n');
  fs.writeFileSync('/etc/caddy/mos-v2-app-routes.caddy', '# No app runtime routes.\n');
  tryRun('/usr/bin/systemctl', ['restart', ...startedServices], { timeoutMs: 120_000 });
}

main();
