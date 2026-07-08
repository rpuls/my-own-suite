import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localEnvPath = path.join(e2eRoot, '.env');

function parseEnvFile(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadLocalEnv() {
  if (!fs.existsSync(localEnvPath)) return;
  const values = parseEnvFile(fs.readFileSync(localEnvPath, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function envString(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function envFlag(name, fallback = false) {
  const value = envString(name, fallback ? '1' : '0').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function envList(name, fallback) {
  return envString(name, fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function envListIfSet(name) {
  if (process.env[name] === undefined) return null;
  return String(process.env[name])
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function vaultwardenPassword() {
  const password = envString('MOS_V2_E2E_VAULTWARDEN_PASSWORD', 'MOS-E2E-Master-Password-2026!');
  if (password.length >= 12 && /[a-z]/u.test(password) && /[A-Z]/u.test(password) && /\d/u.test(password) && /[^A-Za-z0-9]/u.test(password)) {
    return password;
  }
  throw new Error('MOS_V2_E2E_VAULTWARDEN_PASSWORD must be at least 12 chars and include lowercase, uppercase, number, and symbol, for example MOS-E2E-Master-Password-2026!');
}

function normalizeBaseURL(value) {
  const parsed = new URL(value || 'http://home.mos.home');
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/u, '');
}

export function loadHypervEnv() {
  loadLocalEnv();
  const defaultPreDnsAppIds = ['stirling-pdf', 'radicale'];
  const defaultPostDnsAppIds = ['vaultwarden', 'seafile', 'onlyoffice'];
  const appIds = envList('MOS_V2_E2E_APP_IDS', [...defaultPreDnsAppIds, ...defaultPostDnsAppIds].join(','));
  const preDnsAppIds = envListIfSet('MOS_V2_E2E_PRE_DNS_APP_IDS') || defaultPreDnsAppIds.filter((id) => appIds.includes(id));
  const postDnsAppIds = envListIfSet('MOS_V2_E2E_POST_DNS_APP_IDS') || defaultPostDnsAppIds.filter((id) => appIds.includes(id));
  const cloudflareApiToken = envString('CLOUDFLARE_API_TOKEN');
  const dns01BaseDomain = envString('MOS_V2_E2E_DNS01_BASE_DOMAIN');
  const dns01Configured = Boolean(cloudflareApiToken && dns01BaseDomain);

  return {
    appIds,
    baseURL: normalizeBaseURL(envString('MOS_V2_E2E_BASE_URL', 'http://home.mos.home')),
    cloudflareApiToken,
    dns01AcmeEmail: envString('MOS_V2_E2E_DNS01_ACME_EMAIL', envString('MOS_V2_E2E_OWNER_EMAIL', 'owner@example.com')),
    dns01BaseDomain,
    enableBackup: envFlag('MOS_V2_E2E_ENABLE_BACKUP', true),
    enableDns01: dns01Configured || envFlag('MOS_V2_E2E_ENABLE_DNS01', false),
    enableLifecycle: envFlag('MOS_V2_E2E_ENABLE_LIFECYCLE', false),
    enableLabReset: envFlag('MOS_V2_E2E_RESET_BEFORE_RUN', true),
    enableRestore: envFlag('MOS_V2_E2E_ENABLE_RESTORE', true),
    enableUpdate: envFlag('MOS_V2_E2E_ENABLE_UPDATE', false),
    owner: {
      email: envString('MOS_V2_E2E_OWNER_EMAIL', 'owner@example.com'),
      name: envString('MOS_V2_E2E_OWNER_NAME', 'MOS Owner'),
      password: envString('MOS_V2_E2E_OWNER_PASSWORD', 'correct horse battery'),
    },
    postDnsAppIds,
    preDnsAppIds,
    radicale: {
      password: envString('MOS_V2_E2E_RADICALE_PASSWORD', 'radicale-test-password'),
      username: envString('MOS_V2_E2E_RADICALE_USERNAME', 'admin'),
    },
    vaultwarden: {
      email: envString('MOS_V2_E2E_VAULTWARDEN_EMAIL', envString('MOS_V2_E2E_OWNER_EMAIL', 'owner@example.com')),
      name: envString('MOS_V2_E2E_VAULTWARDEN_NAME', envString('MOS_V2_E2E_OWNER_NAME', 'MOS Owner')),
      password: vaultwardenPassword(),
    },
    seafile: {
      adminEmail: envString('MOS_V2_E2E_SEAFILE_ADMIN_EMAIL', envString('MOS_V2_E2E_OWNER_EMAIL', 'owner@example.com')),
      adminPassword: envString('MOS_V2_E2E_SEAFILE_ADMIN_PASSWORD', 'seafile-test-password'),
    },
  };
}

export function redact(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 6) return '<redacted>';
  return `${text.slice(0, 2)}...${text.slice(-2)}`;
}
