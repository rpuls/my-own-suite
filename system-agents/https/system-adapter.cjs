const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { HttpsAgentError } = require('./agent-core.cjs');
const { describeFailure, indent, runCommand } = require('../lib/command-output.cjs');

const CADDY_BINARY = process.env.MOS_CADDY_BINARY || '/usr/local/libexec/mos/caddy';
const CADDYFILE_PATH = process.env.MOS_CADDYFILE_PATH || '/etc/caddy/Caddyfile';
const SECRET_ENV_PATH = process.env.MOS_CADDY_SECRET_ENV || '/etc/mos/secrets/caddy-cloudflare.env';
const TRANSACTION_ROOT = process.env.MOS_HTTPS_TRANSACTION_ROOT || '/var/lib/mos/https-agent/transactions';
const SYSTEMCTL_BINARY = '/usr/bin/systemctl';
const JOURNALCTL_BINARY = '/usr/bin/journalctl';
const CADDY_LOG_LINES = 40;

async function atomicWrite(filePath, content, mode) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fsp.writeFile(temporary, content, { mode });
  await fsp.chmod(temporary, mode);
  await fsp.rename(temporary, filePath);
}

// One Cloudflare zone lookup. A rejection carries what Cloudflare answered —
// its error codes are how the owner learns the token is expired or lacks Zone
// Read — and never the token that asked.
async function cloudflareRequest(token, zoneName) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${encodeURIComponent(zoneName)}&status=active`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new HttpsAgentError('CLOUDFLARE_UNREACHABLE', 'Cloudflare could not be reached from this server.', {
      details: [`The zone lookup for "${zoneName}" failed: ${error?.cause?.message || error?.message || 'network error'}.`],
    });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.success !== true) {
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    const codes = errors.map((error) => error.code).filter(Boolean);
    const messages = errors.map((error) => error.message).filter(Boolean);
    throw new HttpsAgentError('CLOUDFLARE_ACCESS_DENIED', 'Cloudflare rejected the API token.', {
      details: [
        `Cloudflare answered the zone lookup for "${zoneName}" with HTTP ${response.status}${codes.length ? ` and error code${codes.length === 1 ? '' : 's'} ${codes.join(', ')}` : ''}.`,
        ...messages.map((message) => `Cloudflare said: ${message}`),
      ],
      statusCode: 400,
    });
  }
  return body;
}

function transactionPath(root, rollbackId) {
  if (!/^[0-9a-f-]{36}$/u.test(String(rollbackId || ''))) {
    throw new HttpsAgentError('INVALID_ROLLBACK_ID', 'The rollback id is not valid.', { statusCode: 400 });
  }
  return path.join(root, rollbackId);
}

async function snapshotFile(source, target) {
  if (fs.existsSync(source)) await fsp.copyFile(source, target);
  else await fsp.writeFile(`${target}.missing`, '');
}

class SystemHttpsAdapter {
  constructor({
    caddyBinary = CADDY_BINARY,
    caddyfilePath = CADDYFILE_PATH,
    execute = runCommand,
    secretEnvPath = SECRET_ENV_PATH,
    transactionRoot = TRANSACTION_ROOT,
  } = {}) {
    this.caddyBinary = caddyBinary;
    this.caddyfilePath = caddyfilePath;
    this.execute = execute;
    this.secretEnvPath = secretEnvPath;
    this.transactionRoot = transactionRoot;
  }

  // Runs one of the agent's few commands. A failure is reported under the
  // label the caller chose, with the command's last output and never its
  // command line.
  async run(file, args, { code, message, what, ...options }) {
    try {
      return await this.execute(file, args, options);
    } catch (error) {
      throw new HttpsAgentError(code, message, { details: describeFailure(error, what) });
    }
  }

  async hasCloudflareModule() {
    const { stdout } = await this.run(this.caddyBinary, ['list-modules'], {
      code: 'CADDY_MODULE_UNAVAILABLE',
      message: 'The installed Caddy build has no Cloudflare DNS module.',
      what: 'caddy list-modules',
    });
    return stdout.split(/\r?\n/u).includes('dns.providers.cloudflare');
  }

  async verifyCloudflareAccess(token, baseDomain) {
    const labels = baseDomain.split('.');
    const candidates = [];
    for (let index = 0; index < labels.length - 1; index += 1) {
      const candidate = labels.slice(index).join('.');
      candidates.push(candidate);
      const body = await cloudflareRequest(token, candidate);
      if (Array.isArray(body.result) && body.result.some((zone) => zone.name === candidate)) return;
    }
    throw new HttpsAgentError('CLOUDFLARE_ZONE_UNAVAILABLE', 'The token can see no active Cloudflare zone for this domain.', {
      details: [`Cloudflare listed no active zone named ${candidates.join(', ')} for this token. The domain may not be on Cloudflare, or the token may lack Zone Read for it.`],
      statusCode: 400,
    });
  }

  async createCheckpoint(rollbackId) {
    const dir = transactionPath(this.transactionRoot, rollbackId);
    await fsp.mkdir(dir, { recursive: false, mode: 0o700 });
    await snapshotFile(this.caddyfilePath, path.join(dir, 'Caddyfile'));
    await snapshotFile(this.secretEnvPath, path.join(dir, 'caddy-cloudflare.env'));
  }

  async installCandidate({ caddyfile, cloudflareApiToken }) {
    try {
      await atomicWrite(this.secretEnvPath, `CLOUDFLARE_API_TOKEN=${cloudflareApiToken}\n`, 0o600);
      await atomicWrite(this.caddyfilePath, caddyfile, 0o644);
    } catch (error) {
      throw new HttpsAgentError('HTTPS_CANDIDATE_INSTALL_FAILED', 'The new Caddy configuration could not be written.', { details: [error.message] });
    }
  }

  validateCandidate(token) {
    return this.run(this.caddyBinary, ['validate', '--config', this.caddyfilePath], {
      code: 'HTTPS_CADDY_VALIDATION_FAILED',
      env: { ...process.env, CLOUDFLARE_API_TOKEN: token },
      mask: [token],
      message: 'Caddy rejected the new configuration.',
      what: 'caddy validate for the new configuration',
    });
  }

  // A restart rather than a reload so Caddy re-reads the secret env file.
  // systemctl itself only says that the unit failed; the reason is in Caddy's
  // own log, so a failure quotes the newest lines of it.
  async reload(token) {
    try {
      await this.run(SYSTEMCTL_BINARY, ['restart', 'caddy.service'], {
        code: 'HTTPS_CADDY_RELOAD_FAILED',
        message: 'Caddy did not start with the new configuration.',
        what: 'systemctl restart caddy.service',
      });
    } catch (error) {
      const log = await this.caddyLog(token);
      if (log) error.details.push(`Caddy's last log lines:\n${indent(log)}`);
      throw error;
    }
  }

  async caddyLog(token) {
    try {
      const { stdout } = await this.execute(JOURNALCTL_BINARY, ['-u', 'caddy.service', '-n', String(CADDY_LOG_LINES), '--no-pager', '-o', 'cat'], { mask: token ? [token] : [] });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  async restoreCheckpoint(rollbackId) {
    const dir = transactionPath(this.transactionRoot, rollbackId);
    await this.restoreFile(path.join(dir, 'Caddyfile'), this.caddyfilePath);
    await this.restoreFile(path.join(dir, 'caddy-cloudflare.env'), this.secretEnvPath);
  }

  async restoreFile(source, target) {
    if (fs.existsSync(`${source}.missing`)) await fsp.rm(target, { force: true });
    else await atomicWrite(target, await fsp.readFile(source), target === this.secretEnvPath ? 0o600 : 0o644);
  }

  async reloadPrevious() {
    return this.reload();
  }

  removeCheckpoint(rollbackId) {
    return fsp.rm(transactionPath(this.transactionRoot, rollbackId), { recursive: true, force: true });
  }
}

module.exports = { SystemHttpsAdapter, atomicWrite };
