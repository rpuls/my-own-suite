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

function requireArg(name, fallback = '') {
  const value = readArg(name, fallback);
  if (!value) {
    console.error(`Missing required --${name} argument.`);
    process.exit(1);
  }
  return value;
}

function indentBlock(content, spaces) {
  const indent = ' '.repeat(spaces);
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `${indent}${line}`)
    .join('\n');
}

function replaceAll(template, replacements) {
  let output = template;
  for (const [key, value] of Object.entries(replacements)) {
    output = output.split(key).join(value);
  }
  return output;
}

const repoRoot = process.cwd();
const templateDir = path.join(repoRoot, 'deploy', 'self-host', 'autoinstall');
const outputDir = path.resolve(repoRoot, readArg('output-dir', 'deploy/self-host/autoinstall/generated'));

const hostname = readArg('hostname', 'mos');
const username = readArg('username', 'mos');
const realname = readArg('realname', 'My Own Suite');
const timezone = readArg('timezone', 'Europe/Copenhagen');
const stackDomain = readArg('stack-domain', 'mos.home');
const publicDomain = readArg('public-domain', '');
const repoDir = readArg('repo-dir', '/opt/my-own-suite');
const repoUrl = readArg('repo-url', 'https://github.com/rpuls/my-own-suite.git');
const repoRef = readArg('repo-ref', 'staging');
const instanceId = readArg('instance-id', `mos-${hostname}`);
const loginPassword =
  readArg('login-password') ||
  `${crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 14)}!`;
const placeholderPasswordHash =
  readArg(
    'placeholder-password-hash',
    '$6$rounds=4096$mosdefault$0LAtw7Jx1xvO2K6f8P4K2Y4d6I3K1d6jK8w0tL6vIYx7f7C2QzB4uQ4QKzLkAKQsiM0qPThG0p2uQqV5sK3kP0',
  );

if (!placeholderPasswordHash.startsWith('$')) {
  console.error('The placeholder password hash must look like a crypt-style hash such as $6$...');
  process.exit(1);
}

const userDataTemplate = fs.readFileSync(path.join(templateDir, 'user-data.template'), 'utf8');
const metaDataTemplate = fs.readFileSync(path.join(templateDir, 'meta-data.template'), 'utf8');
const firstBootScript = fs.readFileSync(path.join(templateDir, 'mos-selfhost-firstboot.sh'), 'utf8').trimEnd();
const systemdService = fs.readFileSync(path.join(templateDir, 'mos-selfhost-bootstrap.service'), 'utf8').trimEnd();

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
  '__STACK_DOMAIN__': stackDomain,
  '__PUBLIC_DOMAIN__': publicDomain,
  '__FIRSTBOOT_SCRIPT__': indentBlock(firstBootScript, 10),
  '__SYSTEMD_SERVICE__': indentBlock(systemdService, 10),
});

const metaData = replaceAll(metaDataTemplate, {
  '__INSTANCE_ID__': instanceId,
  '__HOSTNAME__': hostname,
});

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'user-data'), userData, 'utf8');
fs.writeFileSync(path.join(outputDir, 'meta-data'), metaData, 'utf8');

console.log(`Wrote ${path.join(outputDir, 'user-data')}`);
console.log(`Wrote ${path.join(outputDir, 'meta-data')}`);
console.log(`VM login username: ${username}`);
console.log(`VM login password: ${loginPassword}`);
console.log('Next step: place both files on a small FAT32 seed disk labeled CIDATA and attach it to the VM.');
