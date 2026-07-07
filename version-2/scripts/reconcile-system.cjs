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
  if (contract.MOS_V2_HOME_HOST) return contract.MOS_V2_HOME_HOST;
  if (contract.MOS_V2_HOME_URL) {
    try {
      return new URL(contract.MOS_V2_HOME_URL).hostname;
    } catch {}
  }
  if (contract.MOS_V2_DOMAIN) {
    return contract.MOS_V2_DOMAIN === 'localhost' ? 'home.localhost' : `home.${contract.MOS_V2_DOMAIN}`;
  }
  return 'home.localhost';
}

function resolveRuntimeConfig(env = process.env) {
  const repoRoot = env.MOS_V2_REPO_DIR || path.resolve(__dirname, '..', '..');
  const version2Root = path.join(repoRoot, 'version-2');
  const stateRoot = env.MOS_V2_STATE_ROOT || '/var/lib/mos-v2';
  const bootstrapContract = parseEnvFile(path.join(stateRoot, 'bootstrap-contract.env'));

  return {
    frontDoor: env.MOS_V2_FRONT_DOOR || bootstrapContract.MOS_V2_FRONT_DOOR || 'ssh-bootstrap',
    homeHost: env.MOS_V2_HOME_HOST || homeHostFromContract(bootstrapContract),
    homepagePort: env.MOS_V2_HOMEPAGE_PORT || bootstrapContract.MOS_V2_HOMEPAGE_PORT || '3200',
    repoRoot,
    runtimeUser: env.MOS_V2_RUNTIME_USER || bootstrapContract.MOS_V2_RUNTIME_USER || 'mos',
    stateRoot,
    suiteManagerPort: env.MOS_V2_SUITE_MANAGER_PORT || bootstrapContract.MOS_V2_SUITE_MANAGER_PORT || '3100',
    version2Root,
  };
}

const runtimeConfig = resolveRuntimeConfig();
const {
  frontDoor,
  homeHost,
  homepagePort,
  repoRoot,
  runtimeUser,
  stateRoot,
  suiteManagerPort,
  version2Root,
} = runtimeConfig;
const dryRun = process.argv.includes('--dry-run');

function log(message) {
  process.stdout.write(`[mos-v2:reconcile] ${message}\n`);
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
    log('would ensure mos-v2-agent group');
    return;
  }
  if (!canRun('getent', ['group', 'mos-v2-agent'])) {
    run('groupadd', ['--system', 'mos-v2-agent']);
  }
}

function installSocketDir(dirPath) {
  installDir(dirPath, 0o2770);
  if (!dryRun) {
    run('chown', ['root:mos-v2-agent', dirPath]);
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
Group=mos-v2-agent
UMask=0007
WorkingDirectory=${version2Root}
Environment=NODE_ENV=production
${envLines}
ExecStart=/usr/bin/node ${version2Root}/${script}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
}

function suiteManagerUnit(config = runtimeConfig) {
  return `[Unit]
Description=MOS V2 Suite Manager
After=mos-v2-homepage.service network-online.target
Wants=mos-v2-homepage.service network-online.target

[Service]
Type=simple
User=${config.runtimeUser}
WorkingDirectory=${config.version2Root}
Environment=NODE_ENV=production
Environment=MOS_V2_STATE_DIR=${config.stateRoot}/suite-manager
Environment=MOS_V2_FRONTEND_DIST_DIR=${config.version2Root}/suite-manager/frontend/dist
Environment=MOS_V2_SUITE_MANAGER_HOST=127.0.0.1
Environment=MOS_V2_SUITE_MANAGER_PORT=${config.suiteManagerPort}
Environment=MOS_V2_FRONT_DOOR=${config.frontDoor}
Environment=MOS_V2_HOME_HOST=${config.homeHost}
Environment=MOS_V2_HOMEPAGE_UPSTREAM=http://127.0.0.1:${config.homepagePort}
Environment=MOS_V2_HTTPS_AGENT_SOCKET=/run/mos-v2-https-agent/agent.sock
Environment=MOS_V2_HOMEPAGE_AGENT_SOCKET=/run/mos-v2-homepage-agent/agent.sock
Environment=MOS_V2_APP_AGENT_SOCKET=/run/mos-v2-app-agent/agent.sock
Environment=MOS_V2_BACKUP_AGENT_SOCKET=/run/mos-v2-backup-agent/agent.sock
Environment=MOS_V2_UPDATE_AGENT_SOCKET=/run/mos-v2-update-agent/agent.sock
ExecStart=/usr/bin/node ${config.version2Root}/suite-manager/backend/src/server/start.cjs
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
`;
}

function refreshCaddyBinary() {
  run('docker', ['build', '--file', path.join(version2Root, 'infrastructure/caddy/Dockerfile'), '--tag', 'mos-v2-caddy-builder', version2Root]);
  const container = dryRun ? 'dry-run-container' : run('docker', ['create', 'mos-v2-caddy-builder'], { stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  installDir('/usr/local/libexec/mos-v2', 0o755);
  run('docker', ['cp', `${container}:/caddy`, '/usr/local/libexec/mos-v2/caddy.next']);
  run('docker', ['rm', container]);
  if (!dryRun) {
    fs.chmodSync('/usr/local/libexec/mos-v2/caddy.next', 0o755);
    fs.renameSync('/usr/local/libexec/mos-v2/caddy.next', '/usr/local/libexec/mos-v2/caddy');
  }
}

function main() {
  if (!fs.existsSync(path.join(version2Root, 'package.json'))) {
    throw new Error(`${version2Root} does not look like a V2 checkout.`);
  }
  if (process.platform !== 'linux' && !dryRun) {
    throw new Error('V2 system reconciliation is supported on Linux installs only.');
  }
  if (typeof process.getuid === 'function' && process.getuid() !== 0 && !dryRun) {
    throw new Error('V2 system reconciliation must run as root.');
  }

  log(`reconciling ${version2Root}`);
  ensureAgentGroup();
  installDir('/etc/mos-v2', 0o750);
  installDir('/etc/mos-v2/secrets', 0o750);
  installDir(`${stateRoot}/suite-manager`, 0o755);
  installDir(`${stateRoot}/homepage/config`, 0o755);
  installDir(`${stateRoot}/https-agent/transactions`, 0o700);
  installDir(`${stateRoot}/homepage-agent/transactions`, 0o700);
  installDir(`${stateRoot}/homepage-agent/history`, 0o700);
  installDir(`${stateRoot}/backup-agent`, 0o700);
  installDir(`${stateRoot}/update-agent/jobs`, 0o700);

  for (const socketDir of ['https', 'homepage', 'app', 'backup', 'update']) {
    installSocketDir(`/run/mos-v2-${socketDir}-agent`);
  }

  refreshCaddyBinary();
  writeFile('/etc/systemd/system/caddy.service.d/mos-v2.conf', `[Service]
EnvironmentFile=-/etc/mos-v2/secrets/caddy-cloudflare.env
ExecStart=
ExecStart=/usr/local/libexec/mos-v2/caddy run --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=/usr/local/libexec/mos-v2/caddy reload --config /etc/caddy/Caddyfile --force
`, 0o644);

  const homepageSeedMarker = path.join(stateRoot, 'homepage/config/.mos-v2-defaults-v2');
  if (!fs.existsSync(homepageSeedMarker) || dryRun) {
    for (const name of fs.readdirSync(path.join(version2Root, 'infrastructure/homepage'))) {
      const source = path.join(version2Root, 'infrastructure/homepage', name);
      const target = path.join(stateRoot, 'homepage/config', name);
      if (fs.statSync(source).isFile() && (!fs.existsSync(target) || dryRun)) {
        if (dryRun) log(`would seed ${target}`);
        else fs.copyFileSync(source, target);
      }
    }
    if (!dryRun) fs.writeFileSync(homepageSeedMarker, '');
  }

  unit('mos-v2-homepage.service', renderHomepageSystemdUnit());
  unit('mos-v2-suite-manager.service', suiteManagerUnit());
  unit('mos-v2-https-agent.service', agentUnit({
    after: 'network-online.target caddy.service',
    description: 'MOS V2 narrow HTTPS configuration agent',
    env: { MOS_V2_HTTPS_AGENT_SOCKET: '/run/mos-v2-https-agent/agent.sock', MOS_V2_HTTPS_TRANSACTION_ROOT: `${stateRoot}/https-agent/transactions`, MOS_V2_SUITE_MANAGER_PORT: suiteManagerPort },
    name: 'mos-v2-https-agent.service',
    script: 'system-agents/https/agent.cjs',
  }));
  unit('mos-v2-homepage-agent.service', agentUnit({
    after: 'network-online.target caddy.service mos-v2-homepage.service',
    description: 'MOS V2 narrow Homepage configuration agent',
    env: { MOS_V2_HOMEPAGE_AGENT_SOCKET: '/run/mos-v2-homepage-agent/agent.sock', MOS_V2_HOMEPAGE_CONFIG_ROOT: `${stateRoot}/homepage/config`, MOS_V2_HOMEPAGE_TRANSACTION_ROOT: `${stateRoot}/homepage-agent/transactions`, MOS_V2_HOMEPAGE_HISTORY_ROOT: `${stateRoot}/homepage-agent/history` },
    name: 'mos-v2-homepage-agent.service',
    script: 'system-agents/homepage/agent.cjs',
  }));
  unit('mos-v2-app-agent.service', agentUnit({
    after: 'network-online.target docker.service caddy.service',
    description: 'MOS V2 narrow app runtime agent',
    env: { MOS_V2_APP_AGENT_SOCKET: '/run/mos-v2-app-agent/agent.sock', MOS_V2_APPS_ROOT: `${version2Root}/apps` },
    name: 'mos-v2-app-agent.service',
    script: 'system-agents/apps/agent.cjs',
    wants: 'network-online.target docker.service',
  }));
  unit('mos-v2-backup-agent.service', agentUnit({
    after: 'network-online.target docker.service',
    description: 'MOS V2 backup and restore agent',
    env: { MOS_V2_BACKUP_AGENT_SOCKET: '/run/mos-v2-backup-agent/agent.sock', MOS_V2_BACKUP_AGENT_STATE_DIR: `${stateRoot}/backup-agent`, MOS_V2_REPO_DIR: repoRoot, MOS_V2_STATE_DIR: `${stateRoot}/suite-manager`, MOS_V2_STATE_ROOT: stateRoot },
    name: 'mos-v2-backup-agent.service',
    script: 'system-agents/backup/agent.cjs',
    wants: 'network-online.target docker.service',
  }));
  unit('mos-v2-update-agent.service', agentUnit({
    after: 'network-online.target docker.service',
    description: 'MOS V2 managed update agent',
    env: { MOS_V2_REPO_DIR: repoRoot, MOS_V2_STATE_ROOT: stateRoot, MOS_V2_UPDATE_AGENT_SOCKET: '/run/mos-v2-update-agent/agent.sock' },
    name: 'mos-v2-update-agent.service',
    script: 'system-agents/update/agent.cjs',
    wants: 'network-online.target docker.service',
  }));

  if (!fs.existsSync('/etc/caddy/Caddyfile') || dryRun) writeFile('/etc/caddy/Caddyfile', renderCaddyfile(), 0o644);
  if (!fs.existsSync('/etc/caddy/mos-v2-homepage-routes.caddy') || dryRun) writeFile('/etc/caddy/mos-v2-homepage-routes.caddy', '# No user-managed Homepage routes.\n', 0o644);
  if (!fs.existsSync('/etc/caddy/mos-v2-app-routes.caddy') || dryRun) writeFile('/etc/caddy/mos-v2-app-routes.caddy', '# No app runtime routes.\n', 0o644);

  run('systemctl', ['daemon-reload']);
  for (const service of ['mos-v2-homepage.service', 'mos-v2-suite-manager.service', 'caddy.service', 'mos-v2-https-agent.service', 'mos-v2-homepage-agent.service', 'mos-v2-app-agent.service', 'mos-v2-backup-agent.service', 'mos-v2-update-agent.service']) {
    run('systemctl', ['enable', service]);
    run('systemctl', ['restart', service]);
  }
  log('system reconciliation complete');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mos-v2:reconcile] ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  homeHostFromContract,
  parseEnvFile,
  resolveRuntimeConfig,
  suiteManagerUnit,
};
