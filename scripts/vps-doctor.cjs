#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.cwd();
const vpsDir = path.join(rootDir, 'deploy', 'vps');

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const map = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    map[key] = value;
  }

  return map;
}

function isMissing(value) {
  return value === undefined || value === null || value.trim() === '';
}

function isPlaceholder(value) {
  return /^(CHANGE_ME|REPLACE_ME)/.test(value);
}

const files = {
  root: '.env',
  homepage: 'apps/homepage/.env',
  seafile: 'apps/seafile/.env',
  onlyoffice: 'apps/onlyoffice/.env',
  immich: 'apps/immich/.env',
  radicale: 'apps/radicale/.env',
  stirlingPdf: 'apps/stirling-pdf/.env',
  vaultwarden: 'apps/vaultwarden/.env',
};

const env = {};
const missingFiles = [];

for (const [name, relPath] of Object.entries(files)) {
  const absolutePath = path.join(vpsDir, relPath);
  const parsed = readEnvFile(absolutePath);
  if (!parsed) {
    missingFiles.push(relPath);
    continue;
  }
  env[name] = parsed;
}

const errors = [];
const warnings = [];

for (const relPath of missingFiles) {
  errors.push(`Missing file: deploy/vps/${relPath}`);
}

function requireVar(fileName, key, opts = {}) {
  const fileEnv = env[fileName] || {};
  const value = fileEnv[key];
  if (isMissing(value)) {
    errors.push(`Missing required value ${key} in deploy/vps/${files[fileName]}`);
    return;
  }

  if (!opts.allowPlaceholder && isPlaceholder(value)) {
    errors.push(`Placeholder value for ${key} in deploy/vps/${files[fileName]}`);
  }
}

if (env.root) {
  requireVar('root', 'DOMAIN', { allowPlaceholder: false });
}

if (env.seafile) {
  requireVar('seafile', 'MYSQL_ROOT_PASSWORD', { allowPlaceholder: false });
  requireVar('seafile', 'DB_ROOT_PASSWD', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_ADMIN_EMAIL', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_ADMIN_PASSWORD', { allowPlaceholder: false });
}

if (env.radicale) {
  requireVar('radicale', 'RADICALE_ADMIN_USERNAME', { allowPlaceholder: false });
  requireVar('radicale', 'RADICALE_ADMIN_PASSWORD', { allowPlaceholder: false });
  requireVar('radicale', 'RADICALE_BASIC_AUTH_B64', { allowPlaceholder: false });
  requireVar('radicale', 'RADICALE_ICAL_TOKEN', { allowPlaceholder: false });
}

if (env.homepage) {
  requireVar('homepage', 'RADICALE_ICAL_URL', { allowPlaceholder: false });
}

if (env.vaultwarden) {
  requireVar('vaultwarden', 'ADMIN_TOKEN', { allowPlaceholder: false });
}

if (env.immich) {
  requireVar('immich', 'DB_PASSWORD', { allowPlaceholder: false });
  requireVar('immich', 'POSTGRES_PASSWORD', { allowPlaceholder: false });

  const dbUsername = env.immich.DB_USERNAME || '';
  const pgUser = env.immich.POSTGRES_USER || '';
  const dbPassword = env.immich.DB_PASSWORD || '';
  const pgPassword = env.immich.POSTGRES_PASSWORD || '';

  if (dbUsername === pgUser && dbPassword !== pgPassword) {
    warnings.push('Immich DB_PASSWORD and POSTGRES_PASSWORD differ while DB_USERNAME matches POSTGRES_USER.');
  }
}

if (env.onlyoffice) {
  const jwtEnabled = (env.onlyoffice.JWT_ENABLED || '').toLowerCase() === 'true';
  if (jwtEnabled) {
    requireVar('onlyoffice', 'JWT_SECRET', { allowPlaceholder: false });
  }
}

if (env.homepage && env.radicale) {
  const homepageUrl = env.homepage.RADICALE_ICAL_URL || '';
  const radicaleToken = env.radicale.RADICALE_ICAL_TOKEN || '';

  if (!isMissing(homepageUrl) && !isMissing(radicaleToken)) {
    const includesToken = homepageUrl.includes(radicaleToken);
    const includesPlaceholder = homepageUrl.includes('${RADICALE_ICAL_TOKEN}');
    if (!includesToken && !includesPlaceholder) {
      errors.push('RADICALE_ICAL_URL must include RADICALE_ICAL_TOKEN (or ${RADICALE_ICAL_TOKEN}) for Homepage calendar bridge.');
    }
  }
}

if (warnings.length > 0) {
  console.log('Warnings:');
  for (const warning of warnings) {
    console.log(`- ${warning}`);
  }
  console.log('');
}

if (errors.length > 0) {
  console.error('Doctor checks failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Doctor checks passed. Environment looks ready.');
