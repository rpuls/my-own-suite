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

function normalizeBaseURL(value) {
  const parsed = new URL(value || 'http://home.mos.home');
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/u, '');
}

export function loadHypervEnv() {
  loadLocalEnv();
  const appIds = envString('MOS_V2_E2E_APP_IDS', 'stirling-pdf,vaultwarden,radicale,seafile,onlyoffice')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return {
    appIds,
    baseURL: normalizeBaseURL(envString('MOS_V2_E2E_BASE_URL', 'http://home.mos.home')),
    cloudflareApiToken: envString('CLOUDFLARE_API_TOKEN'),
    dns01AcmeEmail: envString('MOS_V2_E2E_DNS01_ACME_EMAIL', envString('MOS_V2_E2E_OWNER_EMAIL', 'owner@example.com')),
    dns01BaseDomain: envString('MOS_V2_E2E_DNS01_BASE_DOMAIN'),
    enableBackup: envFlag('MOS_V2_E2E_ENABLE_BACKUP', true),
    enableDns01: envFlag('MOS_V2_E2E_ENABLE_DNS01', false),
    enableLifecycle: envFlag('MOS_V2_E2E_ENABLE_LIFECYCLE', false),
    enableLabReset: envFlag('MOS_V2_E2E_RESET_BEFORE_RUN', true),
    enableRestore: envFlag('MOS_V2_E2E_ENABLE_RESTORE', false),
    enableUpdate: envFlag('MOS_V2_E2E_ENABLE_UPDATE', false),
    owner: {
      email: envString('MOS_V2_E2E_OWNER_EMAIL', 'owner@example.com'),
      name: envString('MOS_V2_E2E_OWNER_NAME', 'MOS Owner'),
      password: envString('MOS_V2_E2E_OWNER_PASSWORD', 'correct horse battery'),
    },
    radicale: {
      password: envString('MOS_V2_E2E_RADICALE_PASSWORD', 'radicale-test-password'),
      username: envString('MOS_V2_E2E_RADICALE_USERNAME', 'admin'),
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
