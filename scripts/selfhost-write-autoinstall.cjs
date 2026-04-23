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

function indentBlock(content, spaces) {
  const indent = ' '.repeat(spaces);
  return content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function normalizeLf(content) {
  return String(content).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function replaceAll(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.split(key).join(value);
  }
  return output;
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

function buildInstallerEnvContent(installerValues) {
  return [
    `INSTALL_OWNER_NAME=${shellQuote(installerValues.ownerName)}`,
    `INSTALL_OWNER_EMAIL=${shellQuote(installerValues.ownerEmail)}`,
    `INSTALL_OWNER_PASSWORD=${shellQuote(installerValues.ownerPassword)}`,
    `INSTALL_LINUX_PASSWORD=${shellQuote(installerValues.linuxPassword)}`,
  ].join('\n');
}

const repoRoot = process.cwd();
const templateDir = path.join(repoRoot, 'deploy', 'self-host', 'autoinstall');
const outputDir = path.resolve(repoRoot, readArg('output-dir', 'deploy/self-host/autoinstall/generated'));
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

const hostname = readArg('hostname', installerConfig?.HOSTNAME || 'mos');
const username = readArg('username', installerConfig?.USERNAME || 'mos');
const realname = readArg('realname', installerConfig?.REALNAME || 'My Own Suite');
const timezone = readArg('timezone', installerConfig?.TIMEZONE || 'Europe/Copenhagen');
const stackDomain = readArg('stack-domain', installerConfig?.STACK_DOMAIN || 'mos.home');
const publicDomain = readArg('public-domain', installerConfig?.PUBLIC_DOMAIN || '');
const repoDir = readArg('repo-dir', installerConfig?.REPO_DIR || '/opt/my-own-suite');
const repoUrl = readArg('repo-url', installerConfig?.REPO_URL || 'https://github.com/rpuls/my-own-suite.git');
const repoRef = readArg('repo-ref', installerConfig?.REPO_REF || 'staging');
const updateTrack = readArg('update-track', installerConfig?.UPDATE_TRACK || 'branch');
const updateRef = readArg('update-ref', installerConfig?.UPDATE_REF || repoRef);
const instanceId = readArg('instance-id', `mos-${hostname}`);
const configuredLinuxPassword = installerConfig?.LINUX_PASSWORD || '';
const loginPassword =
  readArg('login-password') ||
  configuredLinuxPassword ||
  `${crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14)}!`;
const placeholderPasswordHash =
  readArg(
    'placeholder-password-hash',
    '$6$rounds=4096$mosdefault$0LAtw7Jx1xvO2K6f8P4K2Y4d6I3K1d6jK8w0tL6vIYx7f7C2QzB4uQ4QKzLkAKQsiM0qPThG0p2uQqV5sK3kP0',
  );

if (explicitInstallerConfigPath && !installerConfigExists) {
  console.error(`Installer config not found: ${installerConfigPath}`);
  process.exit(1);
}

if (!placeholderPasswordHash.startsWith('$')) {
  console.error('The placeholder password hash must look like a crypt-style hash such as $6$...');
  process.exit(1);
}

const installerValues = installerConfigExists
  ? {
      ownerName: installerConfig.OWNER_NAME || 'Suite Owner',
      ownerEmail: installerConfig.OWNER_EMAIL || '',
      ownerPassword: installerConfig.OWNER_PASSWORD || '',
      linuxPassword: loginPassword,
    }
  : null;

if (installerValues && !installerValues.ownerEmail) {
  console.error(`Installer config ${installerConfigPath} is missing OWNER_EMAIL.`);
  process.exit(1);
}

if (installerValues && !installerValues.ownerPassword) {
  console.error(`Installer config ${installerConfigPath} is missing OWNER_PASSWORD.`);
  process.exit(1);
}

const userDataTemplate = normalizeLf(fs.readFileSync(path.join(templateDir, 'user-data.template'), 'utf8'));
const metaDataTemplate = normalizeLf(fs.readFileSync(path.join(templateDir, 'meta-data.template'), 'utf8'));
const firstBootScript = normalizeLf(
  fs.readFileSync(path.join(templateDir, 'mos-selfhost-firstboot.sh'), 'utf8'),
).trimEnd();
const systemdService = normalizeLf(
  fs.readFileSync(path.join(templateDir, 'mos-selfhost-bootstrap.service'), 'utf8'),
).trimEnd();

const userData = replaceAll(userDataTemplate, {
  '__HOSTNAME__': hostname,
  '__REALNAME__': realname,
  '__USERNAME__': username,
  '__PLACEHOLDER_PASSWORD_HASH__': placeholderPasswordHash,
  '__LOGIN_PASSWORD__': loginPassword,
  '__TIMEZONE__': timezone,
  '__REPO_DIR__': repoDir,
  '__MOS_REPO_URL__': repoUrl,
  '__MOS_REPO_REF__': repoRef,
  '__MOS_UPDATE_TRACK__': updateTrack,
  '__MOS_UPDATE_REF__': updateRef,
  '__STACK_DOMAIN__': stackDomain,
  '__PUBLIC_DOMAIN__': publicDomain,
  '__INSTALLER_ENV__': indentBlock(installerValues ? buildInstallerEnvContent(installerValues) : '', 10),
  '__FIRSTBOOT_SCRIPT__': indentBlock(firstBootScript, 10),
  '__SYSTEMD_SERVICE__': indentBlock(systemdService, 10),
});

const metaData = replaceAll(metaDataTemplate, {
  '__INSTANCE_ID__': instanceId,
  '__HOSTNAME__': hostname,
});

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'user-data'), normalizeLf(userData), 'utf8');
fs.writeFileSync(path.join(outputDir, 'meta-data'), normalizeLf(metaData), 'utf8');

if (!quiet) {
  console.log(`Wrote ${path.join(outputDir, 'user-data')}`);
  console.log(`Wrote ${path.join(outputDir, 'meta-data')}`);
  if (installerConfigExists) {
    console.log(`Using installer config: ${installerConfigPath}`);
    console.log(`Linux login username: ${username}`);
    console.log('Linux and Suite Manager credentials come from the installer config file.');
  } else {
    console.log(`VM login username: ${username}`);
    console.log(`VM login password: ${loginPassword}`);
  }
  console.log('Next step: place both files on a small FAT32 seed disk labeled CIDATA and attach it to the VM.');
}
