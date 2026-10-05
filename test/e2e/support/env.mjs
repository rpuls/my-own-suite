import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(e2eRoot, '..', '..');
const localEnvPath = path.join(e2eRoot, '.env');
const defaultBucketEnvPath = path.join(repoRoot, '.local-tools', 'lab-bucket', 'bucket.env');

export function parseEnvFile(raw) {
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
  for (const [key, value] of Object.entries(parseEnvFile(fs.readFileSync(localEnvPath, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function envString(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function normalizeBaseURL(value) {
  const parsed = new URL(value || 'http://home.mos.hyperv');
  parsed.pathname = parsed.pathname.replace(/\/+$/u, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/u, '');
}

// The disposable lab bucket, never a personal one (AGENTS.md). Read on demand so
// a path that never touches the bucket never needs the file.
function readBucket() {
  const file = envString('MOS_E2E_BUCKET_ENV', defaultBucketEnvPath);
  if (!fs.existsSync(file)) return null;
  const values = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const bucket = {
    accessKeyId: values.MOS_LAB_S3_ACCESS_KEY_ID,
    bucket: values.MOS_LAB_S3_BUCKET,
    endpoint: values.MOS_LAB_S3_ENDPOINT,
    region: values.MOS_LAB_S3_REGION,
    secretAccessKey: values.MOS_LAB_S3_SECRET_ACCESS_KEY,
  };
  return Object.values(bucket).every(Boolean) ? bucket : null;
}

// Core settings only. App credentials belong to the app modules, which read
// their own variables through `read`.
export function loadEnv() {
  loadLocalEnv();
  const cloudflareApiToken = envString('CLOUDFLARE_API_TOKEN');
  const dns01BaseDomain = envString('MOS_E2E_DNS01_BASE_DOMAIN');
  return {
    baseURL: normalizeBaseURL(envString('MOS_E2E_BASE_URL', 'http://home.mos.hyperv')),
    bucket: readBucket,
    cloudflareApiToken,
    dns01AcmeEmail: envString('MOS_E2E_DNS01_ACME_EMAIL', envString('MOS_E2E_OWNER_EMAIL', 'owner@example.com')),
    dns01BaseDomain,
    dns01Configured: Boolean(cloudflareApiToken && dns01BaseDomain),
    owner: {
      email: envString('MOS_E2E_OWNER_EMAIL', 'owner@example.com'),
      name: envString('MOS_E2E_OWNER_NAME', 'MOS Owner'),
      password: envString('MOS_E2E_OWNER_PASSWORD', 'correct horse battery'),
    },
    read: envString,
  };
}

export function redact(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 6) return '<redacted>';
  return `${text.slice(0, 2)}...${text.slice(-2)}`;
}
