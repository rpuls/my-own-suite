#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readArg(name, fallback = '') {
  const prefixed = `--${name}=`;
  const valueWithEquals = process.argv.find((arg) => arg.startsWith(prefixed));
  if (valueWithEquals) {
    return valueWithEquals.slice(prefixed.length).trim();
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1].trim();
  }

  return fallback;
}

function readRepeatedArg(name) {
  const values = [];
  const prefixed = `--${name}=`;

  for (let index = 0; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (arg.startsWith(prefixed)) {
      values.push(arg.slice(prefixed.length).trim());
      continue;
    }

    if (arg === `--${name}` && process.argv[index + 1]) {
      values.push(process.argv[index + 1].trim());
      index += 1;
    }
  }

  return values.filter(Boolean);
}

function normalizeLf(content) {
  return String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function indentBlock(content, spaces) {
  const indent = ' '.repeat(spaces);
  return normalizeLf(content)
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function parseEnvFile(filePath) {
  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const idx = line.indexOf('=');
    if (idx < 1) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function yamlQuote(value) {
  return JSON.stringify(String(value));
}

function assertNoNewlines(label, value) {
  if (/[\r\n]/.test(String(value))) {
    console.error(`${label} cannot contain newlines.`);
    process.exit(1);
  }
}

function assertHostname(label, value) {
  assertNoNewlines(label, value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(String(value))) {
    console.error(`${label} must be a single hostname label using only letters, numbers, and hyphens.`);
    process.exit(1);
  }
}

function assertLinuxUser(label, value) {
  assertNoNewlines(label, value);
  if (!/^[a-z_][a-z0-9_-]*[$]?$/.test(String(value))) {
    console.error(`${label} must be a valid Linux username.`);
    process.exit(1);
  }
}

function assertDomain(label, value) {
  assertNoNewlines(label, value);
  if (
    !value ||
    String(value).includes('..') ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(String(value))
  ) {
    console.error(`${label} must be a domain-like value using letters, numbers, hyphens, and dots.`);
    process.exit(1);
  }
}

function assertAbsolutePath(label, value) {
  assertNoNewlines(label, value);
  if (!String(value).startsWith('/')) {
    console.error(`${label} must be an absolute path.`);
    process.exit(1);
  }
}

function assertUpdateTrack(value) {
  if (!['stable', 'branch'].includes(value)) {
    console.error('UPDATE_TRACK must be either stable or branch.');
    process.exit(1);
  }
}

function randomLoginPassword() {
  return `${crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14)}!`;
}

function buildMosEnvContent(values) {
  const lines = [
    ['REPO_DIR', values.repoDir],
    ['MOS_REPO_URL', values.repoUrl],
    ['MOS_REPO_REF', values.repoRef],
    ['MOS_UPDATE_TRACK', values.updateTrack],
    ['MOS_UPDATE_REF', values.updateRef],
    ['MOS_HOSTNAME', values.hostname],
    ['MOS_PRIMARY_USER', values.username],
    ['MOS_STACK_DOMAIN', values.stackDomain],
    ['MOS_PUBLIC_DOMAIN', values.publicDomain],
    ['MOS_OWNER_NAME', values.ownerName],
    ['MOS_OWNER_EMAIL', values.ownerEmail],
    ['MOS_OWNER_PASSWORD', values.ownerPassword],
    ['MOS_INSTALLER_KIND', 'cloud'],
    ['INSTALL_DOCKER', '1'],
    ['INSTALL_NODE', '1'],
    ['CLONE_REPO_IF_MISSING', '1'],
    ['AUTO_START_STACK', '1'],
  ];

  return lines.map(([key, value]) => `${key}=${shellQuote(value)}`).join('\n');
}

function buildSshKeysSection(keys) {
  if (keys.length === 0) {
    return '';
  }

  return [
    '    ssh_authorized_keys:',
    ...keys.map((key) => `      - ${yamlQuote(key)}`),
  ].join('\n');
}

const repoRoot = process.cwd();
const templateDir = path.join(repoRoot, 'deploy', 'self-host', 'autoinstall');
const outputDir = path.resolve(repoRoot, readArg('output-dir', 'deploy/self-host/cloud-init/generated'));
const quiet = readArg('quiet', '').toLowerCase() === 'true';
const defaultInstallerConfigPath = path.join(
  repoRoot,
  'deploy',
  'self-host',
  'autoinstall',
  'installer-config',
  'selfhost-installer.env',
);
const explicitInstallerConfigPath = readArg('installer-config');
const installerConfigPath = explicitInstallerConfigPath
  ? path.resolve(repoRoot, explicitInstallerConfigPath)
  : defaultInstallerConfigPath;
const installerConfigExists = fs.existsSync(installerConfigPath);
const installerConfig = installerConfigExists ? parseEnvFile(installerConfigPath) : null;

if (explicitInstallerConfigPath && !installerConfigExists) {
  console.error(`Installer config not found: ${installerConfigPath}`);
  process.exit(1);
}

const hostname = readArg('hostname', installerConfig?.HOSTNAME || 'mos');
const username = readArg('username', installerConfig?.USERNAME || 'mos');
const realname = readArg('realname', installerConfig?.REALNAME || 'My Own Suite');
const timezone = readArg('timezone', installerConfig?.TIMEZONE || 'Europe/Copenhagen');
const stackDomain = readArg('stack-domain', installerConfig?.STACK_DOMAIN || 'mos.example.com');
const publicDomain = readArg('public-domain', installerConfig?.PUBLIC_DOMAIN || '');
const repoDir = readArg('repo-dir', installerConfig?.REPO_DIR || '/opt/my-own-suite');
const repoUrl = readArg('repo-url', installerConfig?.REPO_URL || 'https://github.com/rpuls/my-own-suite.git');
const repoRef = readArg('repo-ref', installerConfig?.REPO_REF || 'staging');
const updateTrack = readArg('update-track', installerConfig?.UPDATE_TRACK || 'branch');
const updateRef = readArg('update-ref', installerConfig?.UPDATE_REF || repoRef);
const configuredLinuxPassword = installerConfig?.LINUX_PASSWORD || '';
const loginPassword = readArg('login-password') || configuredLinuxPassword || randomLoginPassword();
const ownerName = readArg('owner-name', installerConfig?.OWNER_NAME || 'Suite Owner');
const ownerEmail = readArg('owner-email', installerConfig?.OWNER_EMAIL || '');
const ownerPassword = readArg('owner-password', installerConfig?.OWNER_PASSWORD || '');
const sshAuthorizedKeys = [
  ...(installerConfig?.SSH_AUTHORIZED_KEY ? [installerConfig.SSH_AUTHORIZED_KEY] : []),
  ...readRepeatedArg('ssh-authorized-key'),
];

if (!ownerEmail) {
  console.error('Missing owner email. Set OWNER_EMAIL in the installer config or pass --owner-email.');
  process.exit(1);
}

if (!ownerPassword) {
  console.error('Missing owner password. Set OWNER_PASSWORD in the installer config or pass --owner-password.');
  process.exit(1);
}

if (!loginPassword) {
  console.error('Missing Linux login password. Set LINUX_PASSWORD in the installer config or pass --login-password.');
  process.exit(1);
}

assertHostname('HOSTNAME', hostname);
assertLinuxUser('USERNAME', username);
assertDomain('STACK_DOMAIN', stackDomain);
assertAbsolutePath('REPO_DIR', repoDir);
assertUpdateTrack(updateTrack);

const firstBootScript = normalizeLf(
  fs.readFileSync(path.join(templateDir, 'mos-selfhost-firstboot.sh'), 'utf8'),
).trimEnd();
const installCoreScript = normalizeLf(
  fs.readFileSync(path.join(repoRoot, 'scripts', 'selfhost', 'install-from-env.sh'), 'utf8'),
).trimEnd();
const systemdService = normalizeLf(
  fs.readFileSync(path.join(templateDir, 'mos-selfhost-bootstrap.service'), 'utf8'),
).trimEnd();

const mosEnv = buildMosEnvContent({
  hostname,
  ownerEmail,
  ownerName,
  ownerPassword,
  publicDomain,
  repoDir,
  repoRef,
  repoUrl,
  stackDomain,
  updateRef,
  updateTrack,
  username,
});

const cloudConfig = [
  '#cloud-config',
  `hostname: ${yamlQuote(hostname)}`,
  `timezone: ${yamlQuote(timezone)}`,
  'package_update: true',
  'package_upgrade: true',
  'ssh_pwauth: true',
  'users:',
  '  - default',
  `  - name: ${yamlQuote(username)}`,
  `    gecos: ${yamlQuote(realname)}`,
  '    groups: [adm, cdrom, dip, lxd, sudo]',
  '    shell: /bin/bash',
  '    sudo: ALL=(ALL) NOPASSWD:ALL',
  '    lock_passwd: false',
  buildSshKeysSection(sshAuthorizedKeys),
  'chpasswd:',
  '  expire: false',
  '  users:',
  `    - name: ${yamlQuote(username)}`,
  `      password: ${yamlQuote(loginPassword)}`,
  '      type: text',
  'packages:',
  '  - git',
  '  - qemu-guest-agent',
  'write_files:',
  '  - path: /etc/mos-selfhost.env',
  '    permissions: "0600"',
  '    content: |',
  indentBlock(mosEnv, 6),
  '  - path: /usr/local/bin/mos-selfhost-firstboot.sh',
  '    permissions: "0755"',
  '    content: |',
  indentBlock(firstBootScript, 6),
  '  - path: /usr/local/bin/mos-selfhost-install-from-env.sh',
  '    permissions: "0755"',
  '    content: |',
  indentBlock(installCoreScript, 6),
  '  - path: /etc/systemd/system/mos-selfhost-bootstrap.service',
  '    permissions: "0644"',
  '    content: |',
  indentBlock(systemdService, 6),
  'runcmd:',
  '  - systemctl daemon-reload',
  '  - systemctl enable mos-selfhost-bootstrap.service',
  '  - systemctl start mos-selfhost-bootstrap.service',
  '',
].filter((line) => line !== '').join('\n');

fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, 'user-data');
fs.writeFileSync(outputPath, normalizeLf(cloudConfig), 'utf8');

if (!quiet) {
  console.log(`Wrote ${outputPath}`);
  if (installerConfigExists) {
    console.log(`Using installer config: ${installerConfigPath}`);
  }
  console.log(`Cloud login username: ${username}`);
  if (!configuredLinuxPassword && !readArg('login-password')) {
    console.log(`Generated cloud login password: ${loginPassword}`);
  }
  console.log('Next step: paste the generated user-data into a supported provider when creating an Ubuntu 24.04 server.');
}
