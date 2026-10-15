import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { labSshKeyPath } from '../../../scripts/smoke/lab-ssh-key.cjs';

export const e2eRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(e2eRoot, '..', '..');
const localEnvPath = path.join(e2eRoot, '.env');

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

function adopt(values) {
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function loadLocalEnv() {
  if (fs.existsSync(localEnvPath)) adopt(parseEnvFile(fs.readFileSync(localEnvPath, 'utf8')));
}

// A command that prints KEY=value lines, such as a secrets broker's handout, so lab keys never sit in a file.
// The environment and .env win over what it prints. A failure only warns: the steps that need its keys say so.
function loadSecretsCommand() {
  const command = envString('MOS_E2E_SECRETS_COMMAND');
  if (!command) return;
  try {
    adopt(parseEnvFile(execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })));
  } catch (error) {
    console.warn(`MOS_E2E_SECRETS_COMMAND failed, so its keys are missing: ${String(error.stderr || error.message).trim()}`);
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

// The disposable lab bucket, never a personal one (AGENTS.md).
function readBucket() {
  const bucket = {
    accessKeyId: envString('MOS_LAB_S3_ACCESS_KEY_ID'),
    bucket: envString('MOS_LAB_S3_BUCKET'),
    endpoint: envString('MOS_LAB_S3_ENDPOINT'),
    region: envString('MOS_LAB_S3_REGION'),
    secretAccessKey: envString('MOS_LAB_S3_SECRET_ACCESS_KEY'),
  };
  return Object.values(bucket).every(Boolean) ? bucket : null;
}

// Core settings only. App credentials belong to the app modules, which read
// their own variables through `read`.
export function labBaseURL() {
  loadLocalEnv();
  return normalizeBaseURL(envString('MOS_E2E_BASE_URL', 'http://home.mos.hyperv'));
}

// What the lab itself settles for every path it runs.
export function labPlanOptions() {
  const startsSecure = labBaseURL().startsWith('https:');
  return { backupTo: envString('MOS_E2E_BACKUP_TO') || null, startsSecure };
}

export function loadEnv() {
  const baseURL = labBaseURL();
  loadSecretsCommand();
  const cloudflareApiToken = envString('CLOUDFLARE_API_TOKEN');
  const dns01BaseDomain = envString('MOS_E2E_DNS01_BASE_DOMAIN');
  return {
    baseURL,
    bucket: readBucket,
    cloudflareApiToken,
    dns01AcmeEmail: envString('MOS_E2E_DNS01_ACME_EMAIL', envString('MOS_E2E_OWNER_EMAIL', 'owner@example.com')),
    dns01BaseDomain,
    dns01Configured: Boolean(cloudflareApiToken && dns01BaseDomain),
    owner: {
      claimToken: envString('MOS_E2E_OWNER_CLAIM_TOKEN'),
      email: envString('MOS_E2E_OWNER_EMAIL', 'owner@example.com'),
      name: envString('MOS_E2E_OWNER_NAME', 'MOS Owner'),
      password: envString('MOS_E2E_OWNER_PASSWORD', 'correct horse battery'),
    },
    labShell: labShell(baseURL),
    read: envString,
  };
}

// Root on the lab, for checks that read the machine itself. The Hyper-V lab is built to
// trust the key at labSshKeyPath; any other lab names its own login and key, or `local`
// when the tests run on the lab itself.
function labShell(baseURL) {
  const key = envString('MOS_E2E_LAB_SSH_KEY', labSshKeyPath);
  const target = envString('MOS_E2E_LAB_SSH', fs.existsSync(key) ? `mos@${new URL(baseURL).hostname}` : '');
  return target ? { key, target } : null;
}

export function redact(value) {
  const text = String(value || '');
  if (!text) return '';
  if (text.length <= 6) return '<redacted>';
  return `${text.slice(0, 2)}...${text.slice(-2)}`;
}
