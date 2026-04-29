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

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

const GLOBAL_FILES = {
  root: '.env',
  suiteManager: 'services/suite-manager/.env',
};

const APP_FILES = {};

const SERVICE_FILES = {
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
const isSelfhostInstall =
  fs.existsSync(path.join(vpsDir, 'docker-compose.selfhost.yml')) ||
  fs.existsSync(path.join(vpsDir, 'services', 'suite-manager', '.env.selfhost'));

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

function getHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

if (env.root) {
  requireVar('root', 'DOMAIN', { allowPlaceholder: false });
}

if (env.suiteManager) {
  requireVar('suiteManager', 'OWNER_EMAIL', { allowPlaceholder: false });
  requireVar('suiteManager', 'OWNER_PASSWORD', { allowPlaceholder: false });
  requireVar('suiteManager', 'SESSION_SECRET', { allowPlaceholder: false });
  requireVar('suiteManager', 'TIMEZONE', { allowPlaceholder: false });

  if (isMissing(env.suiteManager.OWNER_NAME || '')) {
    warnings.push('services/suite-manager/.env OWNER_NAME is empty; suite-manager will fall back to "Owner".');
  }

  const smtpEnabled = isTruthy(env.suiteManager.SMTP_ENABLED || '');
  const smtpSecurity = (env.suiteManager.SMTP_SECURITY || '').trim().toLowerCase();
  const smtpUsername = env.suiteManager.SMTP_USERNAME || '';
  const smtpPassword = env.suiteManager.SMTP_PASSWORD || '';

  if (smtpEnabled) {
    requireVar('suiteManager', 'SMTP_HOST', { allowPlaceholder: false });
    requireVar('suiteManager', 'SMTP_PORT', { allowPlaceholder: false });
    requireVar('suiteManager', 'SMTP_FROM', { allowPlaceholder: false });

    if (!['starttls', 'force_tls', 'off'].includes(smtpSecurity)) {
      errors.push('SMTP_SECURITY in deploy/vps/services/suite-manager/.env must be one of: starttls, force_tls, off.');
    }

    if ((isMissing(smtpUsername) && !isMissing(smtpPassword)) || (!isMissing(smtpUsername) && isMissing(smtpPassword))) {
      errors.push('SMTP_USERNAME and SMTP_PASSWORD in deploy/vps/services/suite-manager/.env must either both be set or both be blank.');
    }
  }
}

if (env.seafile) {
  requireVar('seafile', 'SEAFILE_MYSQL_DB_HOST', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_MYSQL_DB_PORT', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_MYSQL_DB_USER', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_MYSQL_DB_PASSWORD', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_MYSQL_DB_CCNET_DB_NAME', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_MYSQL_DB_SEAFILE_DB_NAME', { allowPlaceholder: false });
  requireVar('seafile', 'SEAFILE_MYSQL_DB_SEAHUB_DB_NAME', { allowPlaceholder: false });
  requireVar('seafile', 'INIT_SEAFILE_MYSQL_ROOT_PASSWORD', { allowPlaceholder: false });
  requireVar('seafile', 'INIT_SEAFILE_ADMIN_EMAIL', { allowPlaceholder: false });
  requireVar('seafile', 'INIT_SEAFILE_ADMIN_PASSWORD', { allowPlaceholder: false });
  requireVar('seafile', 'JWT_PRIVATE_KEY', { allowPlaceholder: false });
  requireVar('seafile', 'CACHE_PROVIDER', { allowPlaceholder: false });
  requireVar('seafile', 'MEMCACHED_HOST', { allowPlaceholder: false });
  requireVar('seafile', 'MEMCACHED_PORT', { allowPlaceholder: false });
}

if (env.seafileMysql) {
  requireVar('seafileMysql', 'MYSQL_ROOT_PASSWORD', { allowPlaceholder: false });
}

if (env.seafile && env.seafileMysql) {
  const mysqlRootPassword = env.seafileMysql.MYSQL_ROOT_PASSWORD || '';
  const seafileInitRootPassword = env.seafile.INIT_SEAFILE_MYSQL_ROOT_PASSWORD || '';

  if (!isMissing(mysqlRootPassword) && mysqlRootPassword !== seafileInitRootPassword) {
    errors.push(
      'Seafile MYSQL_ROOT_PASSWORD and INIT_SEAFILE_MYSQL_ROOT_PASSWORD must match for first-run bootstrap.',
    );
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
  requireVar('homepage', 'SUITE_MANAGER_URL', { allowPlaceholder: false });
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

if (env.homepage) {
  const suiteManagerUrl = env.homepage.SUITE_MANAGER_URL || '';
  if (!isMissing(suiteManagerUrl) && /\/setup\/?$/i.test(suiteManagerUrl)) {
    errors.push('SUITE_MANAGER_URL in deploy/vps/services/homepage/.env should be the bare Suite Manager host; Homepage adds /setup/ in the tile itself.');
  }
}

if (isSelfhostInstall && env.root) {
  const domain = env.root.DOMAIN || '';

  if (domain === 'localhost') {
    errors.push('Self-host installs must set deploy/vps/.env DOMAIN to the configured stack domain, not localhost.');
  }

  if (env.suiteManager) {
    const suiteManagerPublicUrl = env.suiteManager.SUITE_MANAGER_PUBLIC_URL || '';
    const expectedSuiteManagerHost = `suite-manager.${domain}`;
    if (!isMissing(suiteManagerPublicUrl) && getHostname(suiteManagerPublicUrl) !== expectedSuiteManagerHost) {
      errors.push(`SUITE_MANAGER_PUBLIC_URL should use ${expectedSuiteManagerHost} for this self-host domain.`);
    }
  }

  if (env.homepage) {
    const allowedHosts = env.homepage.HOMEPAGE_ALLOWED_HOSTS || '';
    for (const host of [`homepage.${domain}`, `suite-manager.${domain}`]) {
      if (!allowedHosts.split(',').map((value) => value.trim()).includes(host)) {
        errors.push(`HOMEPAGE_ALLOWED_HOSTS should include ${host} for this self-host domain.`);
      }
    }

    const homepageUrls = {
      SUITE_MANAGER_URL: 'suite-manager',
      VAULTWARDEN_URL: 'vaultwarden',
      SEAFILE_URL: 'seafile',
      STIRLING_PDF_URL: 'stirling-pdf',
      RADICALE_URL: 'radicale',
      IMMICH_URL: 'immich',
    };

    for (const [key, service] of Object.entries(homepageUrls)) {
      const value = env.homepage[key] || '';
      const expectedHost = `${service}.${domain}`;
      if (!isMissing(value) && getHostname(value) !== expectedHost) {
        errors.push(`${key} should use ${expectedHost} for this self-host domain.`);
      }
    }
  }
}

if (env.suiteManager && env.seafile) {
  const sharedEmail = env.suiteManager.OWNER_EMAIL || '';

  if (!isMissing(sharedEmail) && env.seafile.INIT_SEAFILE_ADMIN_EMAIL !== sharedEmail) {
    warnings.push('Seafile INIT_SEAFILE_ADMIN_EMAIL differs from suite-manager OWNER_EMAIL.');
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
