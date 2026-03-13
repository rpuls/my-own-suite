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
  return /^(CHANGE_ME|REPLACE_ME)/.test(value) || value.includes('${{');
}

const GLOBAL_FILES = {
  root: '.env',
  suiteManager: 'services/suite-manager/.env',
};

const APP_FILES = {};

const SERVICE_FILES = {
  authelia: 'services/authelia/.env',
  homepage: 'services/homepage/.env',
  onlyoffice: 'services/onlyoffice/.env',
  radicale: 'services/radicale/.env',
  stirlingPdf: 'services/stirling-pdf/.env',
  seafile: 'services/seafile/.env',
  seafileMysql: 'services/seafile-mysql/.env',
  seafileMemcached: 'services/seafile-memcached/.env',
  immich: 'services/immich/.env',
  immichMachineLearning: 'services/immich-machine-learning/.env',
  immichPostgres: 'services/immich-postgres/.env',
  immichValkey: 'services/immich-valkey/.env',
  vaultwarden: 'services/vaultwarden/.env',
  vaultwardenPostgres: 'services/vaultwarden-postgres/.env',
};
const files = { ...GLOBAL_FILES, ...APP_FILES, ...SERVICE_FILES };
const TIMEZONE_CHECKS = [
  ['seafile', 'TIME_ZONE'],
  ['immich', 'TZ'],
  ['immichMachineLearning', 'TZ'],
  ['onlyoffice', 'TZ'],
  ['stirlingPdf', 'TZ'],
];

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

function warnIfTimezoneDiffersFromSuiteManager(fileName, key) {
  if (!env.suiteManager || !env[fileName]) {
    return;
  }

  const sharedTimezone = env.suiteManager.TIMEZONE || '';
  const serviceTimezone = env[fileName][key] || '';

  if (!isMissing(sharedTimezone) && serviceTimezone !== sharedTimezone) {
    warnings.push(`${files[fileName]} ${key} differs from suite-manager TIMEZONE.`);
  }
}

if (env.root) {
  requireVar('root', 'DOMAIN', { allowPlaceholder: false });

  if ((env.root.DOMAIN || '').trim() === 'localhost') {
    errors.push('DOMAIN=localhost is not supported with Authelia cookie sharing. Use a subdomain root such as mos.localhost.');
  }
}

if (env.suiteManager) {
  requireVar('suiteManager', 'OWNER_EMAIL', { allowPlaceholder: false });
  requireVar('suiteManager', 'OWNER_PASSWORD', { allowPlaceholder: false });
  requireVar('suiteManager', 'TIMEZONE', { allowPlaceholder: false });

  if (isMissing(env.suiteManager.OWNER_NAME || '')) {
    warnings.push('services/suite-manager/.env OWNER_NAME is empty; suite-manager will fall back to "Owner".');
  }

  if (isMissing(env.suiteManager.BOOTSTRAP_TOKEN || '')) {
    warnings.push('services/suite-manager/.env BOOTSTRAP_TOKEN is empty; onboarding secrets will not require an unlock token.');
  }
}

if (env.authelia) {
  requireVar('authelia', 'MOS_AUTHELIA_PUBLIC_URL', { allowPlaceholder: false });
  requireVar('authelia', 'MOS_AUTHELIA_THEME', { allowPlaceholder: false });
  requireVar('authelia', 'MOS_AUTHELIA_SESSION_DOMAIN', { allowPlaceholder: false });
  requireVar('authelia', 'MOS_AUTHELIA_OWNER_EMAIL', { allowPlaceholder: false });
  requireVar('authelia', 'MOS_AUTHELIA_OWNER_PASSWORD', { allowPlaceholder: false });
  requireVar('authelia', 'MOS_AUTHELIA_SESSION_SECRET', { allowPlaceholder: false });
  requireVar('authelia', 'MOS_AUTHELIA_STORAGE_ENCRYPTION_KEY', { allowPlaceholder: false });
  requireVar('authelia', 'MOS_AUTHELIA_JWT_SECRET', { allowPlaceholder: false });

  if (env.root && env.authelia.MOS_AUTHELIA_SESSION_DOMAIN !== env.root.DOMAIN) {
    errors.push('Authelia AUTHELIA_SESSION_DOMAIN must match root DOMAIN so auth cookies work across protected subdomains.');
  }

  if (!['light', 'dark', 'grey', 'oled', 'auto'].includes(env.authelia.MOS_AUTHELIA_THEME)) {
    errors.push('Authelia MOS_AUTHELIA_THEME must be one of: light, dark, grey, oled, auto.');
  }
}

if (env.seafile) {
  requireVar('seafile', 'DB_ROOT_PASSWD', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_ADMIN_EMAIL', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_ADMIN_PASSWORD', { allowPlaceholder: false });
}

if (env.seafileMysql) {
  requireVar('seafileMysql', 'MYSQL_ROOT_PASSWORD', { allowPlaceholder: false });
}

if (env.seafile && env.seafileMysql) {
  const mysqlRootPassword = env.seafileMysql.MYSQL_ROOT_PASSWORD || '';
  const dbRootPassword = env.seafile.DB_ROOT_PASSWD || '';

  if (!isMissing(mysqlRootPassword) && mysqlRootPassword !== dbRootPassword) {
    errors.push('Seafile MYSQL_ROOT_PASSWORD and DB_ROOT_PASSWD must match for first-run bootstrap.');
  }
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
  requireVar('vaultwarden', 'DATABASE_URL', { allowPlaceholder: false });
}

if (env.vaultwardenPostgres) {
  requireVar('vaultwardenPostgres', 'POSTGRES_USER', { allowPlaceholder: false });
  requireVar('vaultwardenPostgres', 'POSTGRES_PASSWORD', { allowPlaceholder: false });
  requireVar('vaultwardenPostgres', 'POSTGRES_DB', { allowPlaceholder: false });
}

if (env.vaultwarden && env.vaultwardenPostgres) {
  const databaseUrl = env.vaultwarden.DATABASE_URL || '';
  const pgUser = env.vaultwardenPostgres.POSTGRES_USER || '';
  const pgPassword = env.vaultwardenPostgres.POSTGRES_PASSWORD || '';
  const pgDb = env.vaultwardenPostgres.POSTGRES_DB || '';

  const expectedParts = [
    `${pgUser}:`,
    `:${pgPassword}@vaultwarden-postgres:5432/`,
    `/${pgDb}`,
  ];

  for (const part of expectedParts) {
    if (!isMissing(part) && !databaseUrl.includes(part)) {
      warnings.push('Vaultwarden DATABASE_URL differs from vaultwarden-postgres credentials.');
      break;
    }
  }
}

if (env.immich) {
  requireVar('immich', 'DB_PASSWORD', { allowPlaceholder: false });
  requireVar('immich', 'DB_USERNAME', { allowPlaceholder: false });
  requireVar('immich', 'DB_DATABASE_NAME', { allowPlaceholder: false });
}

if (env.immichPostgres) {
  requireVar('immichPostgres', 'POSTGRES_USER', { allowPlaceholder: false });
  requireVar('immichPostgres', 'POSTGRES_PASSWORD', { allowPlaceholder: false });
  requireVar('immichPostgres', 'POSTGRES_DB', { allowPlaceholder: false });
}

if (env.immich && env.immichPostgres) {
  const dbUsername = env.immich.DB_USERNAME || '';
  const pgUser = env.immichPostgres.POSTGRES_USER || '';
  const dbPassword = env.immich.DB_PASSWORD || '';
  const pgPassword = env.immichPostgres.POSTGRES_PASSWORD || '';
  const dbName = env.immich.DB_DATABASE_NAME || '';
  const pgDb = env.immichPostgres.POSTGRES_DB || '';

  if (dbUsername === pgUser && dbPassword !== pgPassword) {
    warnings.push('Immich DB_PASSWORD and POSTGRES_PASSWORD differ while DB_USERNAME matches POSTGRES_USER.');
  }

  if (dbName !== pgDb) {
    warnings.push('Immich DB_DATABASE_NAME differs from immich-postgres POSTGRES_DB.');
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

if (env.suiteManager && env.seafile) {
  const sharedEmail = env.suiteManager.OWNER_EMAIL || '';

  if (!isMissing(sharedEmail) && env.seafile.SEAFILE_ADMIN_EMAIL !== sharedEmail) {
    warnings.push('Seafile SEAFILE_ADMIN_EMAIL differs from suite-manager OWNER_EMAIL.');
  }
}

for (const [fileName, timezoneKey] of TIMEZONE_CHECKS) {
  warnIfTimezoneDiffersFromSuiteManager(fileName, timezoneKey);
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
