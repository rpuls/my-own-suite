const { execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const CADDY_BINARY = process.env.MOS_V2_CADDY_BINARY || '/usr/local/libexec/mos-v2/caddy';
const CADDYFILE_PATH = process.env.MOS_V2_CADDYFILE_PATH || '/etc/caddy/Caddyfile';
const SECRET_ENV_PATH = process.env.MOS_V2_CADDY_SECRET_ENV || '/etc/mos-v2/secrets/caddy-cloudflare.env';
const TRANSACTION_ROOT = process.env.MOS_V2_HTTPS_TRANSACTION_ROOT || '/var/lib/mos-v2/https-agent/transactions';

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 120000, ...options }, (error, stdout) => {
      if (error) { reject(new Error('COMMAND_FAILED')); return; }
      resolve(stdout || '');
    });
  });
}

async function atomicWrite(filePath, content, mode) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, content, { mode });
  await fsp.chmod(temporary, mode);
  await fsp.rename(temporary, filePath);
}

async function cloudflareRequest(token, requestPath) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${requestPath}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success !== true) throw new Error('CLOUDFLARE_ACCESS_DENIED');
  return body;
}

function transactionPath(rollbackId) {
  if (!/^[0-9a-f-]{36}$/u.test(String(rollbackId || ''))) throw new Error('INVALID_ROLLBACK_ID');
  return path.join(TRANSACTION_ROOT, rollbackId);
}

async function snapshotFile(source, target) {
  if (fs.existsSync(source)) await fsp.copyFile(source, target);
  else await fsp.writeFile(`${target}.missing`, '');
}

async function restoreFile(source, target) {
  if (fs.existsSync(`${source}.missing`)) await fsp.rm(target, { force: true });
  else await atomicWrite(target, await fsp.readFile(source), target === SECRET_ENV_PATH ? 0o600 : 0o644);
}

class SystemHttpsAdapter {
  async hasCloudflareModule() {
    const output = await execFilePromise(CADDY_BINARY, ['list-modules']);
    return output.split(/\r?\n/u).includes('dns.providers.cloudflare');
  }

  async verifyCloudflareAccess(token, baseDomain) {
    await cloudflareRequest(token, '/user/tokens/verify');
    const labels = baseDomain.split('.');
    for (let index = 0; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');
      const body = await cloudflareRequest(token, `/zones?name=${encodeURIComponent(candidate)}&status=active`);
      if (Array.isArray(body.result) && body.result.some((zone) => zone.name === candidate)) return;
    }
    throw new Error('CLOUDFLARE_ZONE_UNAVAILABLE');
  }

  async createCheckpoint(rollbackId) {
    const dir = transactionPath(rollbackId);
    await fsp.mkdir(dir, { recursive: false, mode: 0o700 });
    await snapshotFile(CADDYFILE_PATH, path.join(dir, 'Caddyfile'));
    await snapshotFile(SECRET_ENV_PATH, path.join(dir, 'caddy-cloudflare.env'));
  }

  async installCandidate({ caddyfile, cloudflareApiToken }) {
    await atomicWrite(SECRET_ENV_PATH, `CLOUDFLARE_API_TOKEN=${cloudflareApiToken}\n`, 0o600);
    await atomicWrite(CADDYFILE_PATH, caddyfile, 0o644);
  }

  validateCandidate(token) {
    return execFilePromise(CADDY_BINARY, ['validate', '--config', CADDYFILE_PATH], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
    });
  }

  reload(token) {
    return execFilePromise(CADDY_BINARY, ['reload', '--config', CADDYFILE_PATH], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
    });
  }

  async restoreCheckpoint(rollbackId) {
    const dir = transactionPath(rollbackId);
    await restoreFile(path.join(dir, 'Caddyfile'), CADDYFILE_PATH);
    await restoreFile(path.join(dir, 'caddy-cloudflare.env'), SECRET_ENV_PATH);
  }

  async reloadPrevious() {
    let token = '';
    if (fs.existsSync(SECRET_ENV_PATH)) {
      token = (await fsp.readFile(SECRET_ENV_PATH, 'utf8')).replace(/^CLOUDFLARE_API_TOKEN=/u, '').trim();
    }
    return this.reload(token);
  }

  removeCheckpoint(rollbackId) {
    return fsp.rm(transactionPath(rollbackId), { recursive: true, force: true });
  }
}

module.exports = { SystemHttpsAdapter, atomicWrite };
