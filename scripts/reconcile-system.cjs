#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  HOMEPAGE_IMAGE,
  renderCaddyfile,
  renderHomepageSystemdUnit,
} = require('../infrastructure/control-plane-runtime.cjs');

function parseEnvFile(filePath) {
  try {
    return Object.fromEntries(fs.readFileSync(filePath, 'utf8').split(/\r?\n/u).map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return null;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u);
      if (!match) return null;
      const rawValue = match[2].trim();
      const value = rawValue.replace(/^(['"])(.*)\1$/u, '$2');
      return [match[1], value];
    }).filter(Boolean));
  } catch {
    return {};
  }
}

function homeHostFromContract(contract) {
  if (contract.MOS_HOME_HOST) return contract.MOS_HOME_HOST;
  if (contract.MOS_HOME_URL) {
    try {
      return new URL(contract.MOS_HOME_URL).hostname;
    } catch {}
  }
  if (contract.MOS_DOMAIN) {
    return contract.MOS_DOMAIN === 'localhost' ? 'home.localhost' : `home.${contract.MOS_DOMAIN}`;
  }
  return 'home.localhost';
}

function resolveRuntimeConfig(env = process.env) {
  const repoRoot = env.MOS_REPO_DIR || path.resolve(__dirname, '..');
  const mosRoot = repoRoot;
  const stateRoot = env.MOS_STATE_ROOT || '/var/lib/mos';
  const bootstrapContract = parseEnvFile(path.join(stateRoot, 'bootstrap-contract.env'));

  return {
    frontDoor: env.MOS_FRONT_DOOR || bootstrapContract.MOS_FRONT_DOOR || 'ssh-bootstrap',
    homeHost: env.MOS_HOME_HOST || homeHostFromContract(bootstrapContract),
    homepagePort: env.MOS_HOMEPAGE_PORT || bootstrapContract.MOS_HOMEPAGE_PORT || '3200',
    disposableLab: env.MOS_DISPOSABLE_LAB || bootstrapContract.MOS_DISPOSABLE_LAB || '0',
    repoRoot,
    runtimeUser: env.MOS_RUNTIME_USER || bootstrapContract.MOS_RUNTIME_USER || 'mos',
    stateRoot,
    suiteManagerPort: env.MOS_SUITE_MANAGER_PORT || bootstrapContract.MOS_SUITE_MANAGER_PORT || '3100',
    mosRoot,
  };
}

const runtimeConfig = resolveRuntimeConfig();
const {
  frontDoor,
  homeHost,
  homepagePort,
  disposableLab,
  repoRoot,
  runtimeUser,
  stateRoot,
  suiteManagerPort,
  mosRoot,
} = runtimeConfig;
const dryRun = process.argv.includes('--dry-run');

function log(message) {
  process.stdout.write(`[mos:reconcile] ${message}\n`);
}

function writeFile(filePath, content, mode) {
  if (dryRun) {
    log(`would write ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, '\n'), 'utf8');
  if (mode) fs.chmodSync(filePath, mode);
}

function run(command, args, options = {}) {
  log(`${command} ${args.join(' ')}`);
  if (dryRun) return '';
  return execFileSync(command, args, { encoding: 'utf8', stdio: options.stdio || 'inherit' });
}

function canRun(command, args) {
  try {
    execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function installDir(dirPath, mode) {
  if (dryRun) {
    log(`would ensure ${dirPath}`);
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true, mode });
  fs.chmodSync(dirPath, mode);
}

function ensureAgentGroup() {
  if (dryRun) {
    log('would ensure mos-agent group');
    return;
  }
  if (!canRun('getent', ['group', 'mos-agent'])) {
    run('groupadd', ['--system', 'mos-agent']);
  }
}

function installSocketDir(dirPath) {
  installDir(dirPath, 0o2770);
  if (!dryRun) {
    run('chown', ['root:mos-agent', dirPath]);
    fs.chmodSync(dirPath, 0o2770);
  }
}

function unit(name, content) {
  writeFile(path.join('/etc/systemd/system', name), content, 0o644);
}

function agentUnit({ after, description, env, name, script, wants = 'network-online.target' }) {
  const envLines = Object.entries(env).map(([key, value]) => `Environment=${key}=${value}`).join('\n');
  return `[Unit]
Description=${description}
After=${after}
Wants=${wants}

[Service]
Type=simple
User=root
Group=mos-agent
UMask=0007
WorkingDirectory=${mosRoot}
Environment=NODE_ENV=production
${envLines}
ExecStart=/usr/bin/node ${mosRoot}/${script}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
}

function suiteManagerUnit(config = runtimeConfig) {
  return `[Unit]
Description=MOS Suite Manager
After=mos-homepage.service network-online.target
Wants=mos-homepage.service network-online.target

[Service]
Type=simple
User=${config.runtimeUser}
WorkingDirectory=${config.mosRoot}
Environment=NODE_ENV=production
Environment=MOS_STATE_DIR=${config.stateRoot}/suite-manager
Environment=MOS_FRONTEND_DIST_DIR=${config.mosRoot}/suite-manager/frontend/dist
Environment=MOS_SUITE_MANAGER_HOST=127.0.0.1
Environment=MOS_SUITE_MANAGER_PORT=${config.suiteManagerPort}
Environment=MOS_FRONT_DOOR=${config.frontDoor}
Environment=MOS_HOME_HOST=${config.homeHost}
Environment=MOS_HOMEPAGE_UPSTREAM=http://127.0.0.1:${config.homepagePort}
Environment=MOS_HTTPS_AGENT_SOCKET=/run/mos-https-agent/agent.sock
Environment=MOS_HOMEPAGE_AGENT_SOCKET=/run/mos-homepage-agent/agent.sock
Environment=MOS_APP_AGENT_SOCKET=/run/mos-app-agent/agent.sock
Environment=MOS_APP_PACKAGE_ROOT=${config.stateRoot}/app-packages
Environment=MOS_BACKUP_AGENT_SOCKET=/run/mos-backup-agent/agent.sock
Environment=MOS_UPDATE_AGENT_SOCKET=/run/mos-update-agent/agent.sock
Environment=MOS_DISPOSABLE_LAB=${config.disposableLab}
Environment=MOS_LAB_RESET_AGENT_SOCKET=/run/mos-lab-reset-agent/agent.sock
EnvironmentFile=-/etc/mos/secrets/owner-claim.env
ExecStart=/usr/bin/node ${config.mosRoot}/suite-manager/backend/src/server/start.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
}

function homepageUnit(config = runtimeConfig) {
  return renderHomepageSystemdUnit({
    homeHost: config.homeHost,
    homepagePort: config.homepagePort,
    stateRoot: config.stateRoot,
  });
}

function refreshCaddyBinary() {
  run('docker', ['build', '--file', path.join(mosRoot, 'infrastructure/caddy/Dockerfile'), '--tag', 'mos-caddy-builder', mosRoot]);
  const container = dryRun ? 'dry-run-container' : run('docker', ['create', 'mos-caddy-builder'], { stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  installDir('/usr/local/libexec/mos', 0o755);
  run('docker', ['cp', `${container}:/caddy`, '/usr/local/libexec/mos/caddy.next']);
  run('docker', ['rm', container]);
  if (!dryRun) {
    fs.chmodSync('/usr/local/libexec/mos/caddy.next', 0o755);
    fs.renameSync('/usr/local/libexec/mos/caddy.next', '/usr/local/libexec/mos/caddy');
  }
}

function main() {
  if (!fs.existsSync(path.join(mosRoot, 'package.json'))) {
    throw new Error(`${mosRoot} does not look like a MOS checkout.`);
  }
  if (process.platform !== 'linux' && !dryRun) {
    throw new Error('MOS system reconciliation is supported on Linux installs only.');
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0 && !dryRun) {
    throw new Error('MOS system reconciliation must run as root.');
  }

  log(`reconciling ${mosRoot}`);
  ensureAgentGroup();
  installDir('/etc/mos', 0o750);
  installDir('/etc/mos/secrets', 0o750);
  installDir(`${stateRoot}/suite-manager`, 0o755);
  installDir(`${stateRoot}/homepage/config`, 0o755);
  installDir(`${stateRoot}/https-agent/transactions`, 0o700);
  installDir(`${stateRoot}/homepage-agent/transactions`, 0o700);
  installDir(`${stateRoot}/homepage-agent/history`, 0o700);
  installDir(`${stateRoot}/backup-agent`, 0o700);
  // Setgid so every snapshot the root app agent writes below inherits
  // mos-agent and stays readable by Suite Manager, which re-verifies
  // snapshot identity on each read. The agent sets the group explicitly too;
  // this keeps a directory created by anything else from losing it.
  installDir(`${stateRoot}/app-packages`, 0o2750);
  if (!dryRun) {
    run('chown', ['root:mos-agent', `${stateRoot}/app-packages`]);
    fs.chmodSync(`${stateRoot}/app-packages`, 0o2750);
  }
  installDir(`${stateRoot}/update-agent/jobs`, 0o700);

  for (const socketDir of ['https', 'homepage', 'app', 'backup', 'update', 'lab-reset']) {
    installSocketDir(`/run/mos-${socketDir}-agent`);
  }

  refreshCaddyBinary();
  writeFile('/etc/systemd/system/caddy.service.d/mos.conf', `[Service]
EnvironmentFile=-/etc/mos/secrets/caddy-cloudflare.env
ExecStart=
ExecStart=/usr/local/libexec/mos/caddy run --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=/usr/local/libexec/mos/caddy reload --config /etc/caddy/Caddyfile --force
`, 0o644);

  const homepageSeedMarker = path.join(stateRoot, 'homepage/config/.mos-defaults');
  if (!fs.existsSync(homepageSeedMarker) || dryRun) {
    for (const name of fs.readdirSync(path.join(mosRoot, 'infrastructure/homepage'))) {
      const source = path.join(mosRoot, 'infrastructure/homepage', name);
      const target = path.join(stateRoot, 'homepage/config', name);
      if (fs.statSync(source).isFile() && (!fs.existsSync(target) || dryRun)) {
        if (dryRun) log(`would seed ${target}`);
        else fs.copyFileSync(source, target);
      }
    }
    if (!dryRun) fs.writeFileSync(homepageSeedMarker, '');
  }

  unit('mos-homepage.service', homepageUnit());
  unit('mos-suite-manager.service', suiteManagerUnit());
  unit('mos-https-agent.service', agentUnit({
    after: 'network-online.target caddy.service',
    description: 'MOS narrow HTTPS configuration agent',
    env: { MOS_HTTPS_AGENT_SOCKET: '/run/mos-https-agent/agent.sock', MOS_HTTPS_TRANSACTION_ROOT: `${stateRoot}/https-agent/transactions`, MOS_SUITE_MANAGER_PORT: suiteManagerPort },
    name: 'mos-https-agent.service',
    script: 'system-agents/https/agent.cjs',
  }));
  unit('mos-homepage-agent.service', agentUnit({
    after: 'network-online.target caddy.service mos-homepage.service',
    description: 'MOS narrow Homepage configuration agent',
    env: { MOS_HOMEPAGE_AGENT_SOCKET: '/run/mos-homepage-agent/agent.sock', MOS_HOMEPAGE_CONFIG_ROOT: `${stateRoot}/homepage/config`, MOS_HOMEPAGE_TRANSACTION_ROOT: `${stateRoot}/homepage-agent/transactions`, MOS_HOMEPAGE_HISTORY_ROOT: `${stateRoot}/homepage-agent/history` },
    name: 'mos-homepage-agent.service',
    script: 'system-agents/homepage/agent.cjs',
  }));
  unit('mos-app-agent.service', agentUnit({
    after: 'network-online.target docker.service caddy.service',
    description: 'MOS narrow app runtime agent',
    env: { MOS_APP_AGENT_SOCKET: '/run/mos-app-agent/agent.sock', MOS_APP_PACKAGE_ROOT: `${stateRoot}/app-packages`, MOS_APPS_ROOT: `${mosRoot}/apps` },
    name: 'mos-app-agent.service',
    script: 'system-agents/apps/agent.cjs',
    wants: 'network-online.target docker.service',
  }));
  unit('mos-backup-agent.service', agentUnit({
    after: 'network-online.target docker.service',
    description: 'MOS backup and restore agent',
    env: { MOS_BACKUP_AGENT_SOCKET: '/run/mos-backup-agent/agent.sock', MOS_BACKUP_AGENT_STATE_DIR: `${stateRoot}/backup-agent`, MOS_REPO_DIR: repoRoot, MOS_STATE_DIR: `${stateRoot}/suite-manager`, MOS_STATE_ROOT: stateRoot },
    name: 'mos-backup-agent.service',
    script: 'system-agents/backup/agent.cjs',
    wants: 'network-online.target docker.service',
  }));
  unit('mos-update-agent.service', agentUnit({
    after: 'network-online.target docker.service',
    description: 'MOS managed update agent',
    env: { MOS_REPO_DIR: repoRoot, MOS_STATE_ROOT: stateRoot, MOS_UPDATE_AGENT_SOCKET: '/run/mos-update-agent/agent.sock' },
    name: 'mos-update-agent.service',
    script: 'system-agents/update/agent.cjs',
    wants: 'network-online.target docker.service',
  }));
  unit('mos-lab-reset-agent.service', agentUnit({
    after: 'network-online.target docker.service',
    description: 'MOS lab reset agent',
    env: { MOS_INSTALL_ROOT: path.dirname(repoRoot), MOS_LAB_RESET_AGENT_SOCKET: '/run/mos-lab-reset-agent/agent.sock', MOS_REPO_DIR: repoRoot, MOS_STATE_ROOT: stateRoot },
    name: 'mos-lab-reset-agent.service',
    script: 'system-agents/lab-reset/agent.cjs',
    wants: 'network-online.target docker.service',
  }));

  if (!fs.existsSync('/etc/caddy/Caddyfile') || dryRun) writeFile('/etc/caddy/Caddyfile', renderCaddyfile(), 0o644);
  if (!fs.existsSync('/etc/caddy/mos-homepage-routes.caddy') || dryRun) writeFile('/etc/caddy/mos-homepage-routes.caddy', '# No user-managed Homepage routes.\n', 0o644);
  if (!fs.existsSync('/etc/caddy/mos-app-routes.caddy') || dryRun) writeFile('/etc/caddy/mos-app-routes.caddy', '# No app runtime routes.\n', 0o644);

  run('systemctl', ['daemon-reload']);
  for (const service of ['mos-homepage.service', 'mos-suite-manager.service', 'caddy.service', 'mos-https-agent.service', 'mos-homepage-agent.service', 'mos-app-agent.service', 'mos-backup-agent.service', 'mos-update-agent.service']) {
    run('systemctl', ['enable', service]);
    run('systemctl', ['restart', service]);
  }
  if (disposableLab === '1') {
    run('systemctl', ['enable', 'mos-lab-reset-agent.service']);
    run('systemctl', ['restart', 'mos-lab-reset-agent.service']);
  }
  log('system reconciliation complete');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mos:reconcile] ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  homeHostFromContract,
  homepageUnit,
  parseEnvFile,
  resolveRuntimeConfig,
  suiteManagerUnit,
};
