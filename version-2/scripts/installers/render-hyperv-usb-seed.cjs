#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const { renderBootstrapPlan } = require('./bootstrap-contract.cjs');

const v2Root = path.resolve(__dirname, '..', '..');
const repoRoot = path.resolve(v2Root, '..');
const defaultConfigPath = path.join(repoRoot, 'deploy', 'self-host', 'autoinstall', 'installer-config', 'selfhost-installer.env');
const defaultOutputDir = path.join(v2Root, '.mos-smoke', 'hyperv-usb', 'v2-seed');
const smokeRepoRef = 'feat/app-platform-v2-lab';

function parseEnvFile(filePath) {
  const values = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function renderSeed(config) {
  const hostname = config.HOSTNAME || 'mos';
  const username = config.USERNAME || 'mos';
  const realname = config.REALNAME || 'My Own Suite';
  const timezone = config.TIMEZONE || 'Europe/Copenhagen';
  const domain = config.STACK_DOMAIN || 'mos.home';
  const linuxPassword = config.LINUX_PASSWORD || '';

  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/u.test(hostname)) throw new Error('HOSTNAME is invalid.');
  if (!/^[a-z_][a-z0-9_-]*[$]?$/u.test(username)) throw new Error('USERNAME is invalid.');
  if (!linuxPassword) throw new Error('LINUX_PASSWORD is required for Hyper-V smoke console access.');

  const plan = renderBootstrapPlan({
    domain,
    frontDoor: 'usb-autoinstall',
    repoRef: smokeRepoRef,
  });
  const firstBoot = YAML.parse(plan.cloudInit);
  firstBoot.runcmd = [
    `printf '%s:%s\\n' ${shellQuote(username)} ${shellQuote(linuxPassword)} | chpasswd`,
    ...(firstBoot.runcmd || []),
  ];

  const userData = {
    autoinstall: {
      version: 1,
      identity: {
        hostname,
        realname,
        username,
        password: '$6$rounds=4096$mosdefault$0LAtw7Jx1xvO2K6f8P4K2Y4d6I3K1d6jK8w0tL6vIYx7f7C2QzB4uQ4QKzLkAKQsiM0qPThG0p2uQqV5sK3kP0',
      },
      locale: 'en_US.UTF-8',
      keyboard: { layout: 'us' },
      timezone,
      ssh: { 'install-server': true, 'allow-pw': true },
      packages: ['qemu-guest-agent'],
      storage: { layout: { name: 'direct' } },
      'user-data': firstBoot,
    },
  };

  return {
    metaData: `instance-id: mos-v2-hyperv-usb\nlocal-hostname: ${hostname}\n`,
    plan,
    userData: `#cloud-config\n${YAML.stringify(userData, { lineWidth: 0 })}`,
  };
}

function main() {
  if (!fs.existsSync(defaultConfigPath)) throw new Error(`Installer config not found: ${defaultConfigPath}`);
  const rendered = renderSeed(parseEnvFile(defaultConfigPath));
  fs.rmSync(defaultOutputDir, { force: true, recursive: true });
  fs.mkdirSync(defaultOutputDir, { recursive: true });
  fs.writeFileSync(path.join(defaultOutputDir, 'user-data'), rendered.userData, 'utf8');
  fs.writeFileSync(path.join(defaultOutputDir, 'meta-data'), rendered.metaData, 'utf8');
  console.log(`[mos-v2-smoke:hyperv-usb] Rendered V2 Ubuntu autoinstall seed for ${smokeRepoRef}.`);
  console.log(`  Home: ${rendered.plan.config.publicUrls.home}`);
  console.log(`  Seed: ${defaultOutputDir}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[mos-v2-smoke:hyperv-usb] ${error.message || String(error)}`);
    process.exit(1);
  }
}

module.exports = { parseEnvFile, renderSeed };
