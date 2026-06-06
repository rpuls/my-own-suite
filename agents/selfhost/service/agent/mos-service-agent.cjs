#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const socketPath = process.env.MOS_SERVICE_AGENT_SOCKET_PATH || '/run/mos-service-agent/agent.sock';
const tokenFile = process.env.MOS_SERVICE_AGENT_TOKEN_FILE || '/etc/mos-service-agent/auth.token';
const repoDir = process.env.MOS_SERVICE_AGENT_REPO_DIR || '';
const caddyExternalProxiesPath = repoDir
  ? path.join(repoDir, 'deploy', 'vps', 'generated', 'caddy', 'external-proxies.caddy')
  : '';

const SERVICES = {
  caddy: { container: 'mos-caddy', capabilities: ['restart', 'external-proxies.apply'] },
  homepage: { container: 'mos-homepage', capabilities: ['restart'] },
  immich: { container: 'mos-immich', capabilities: ['restart'] },
  'immich-machine-learning': { container: 'mos-immich-machine-learning', capabilities: ['restart'] },
  'immich-postgres': { container: 'mos-immich-postgres', capabilities: ['restart'] },
  'immich-valkey': { container: 'mos-immich-valkey', capabilities: ['restart'] },
  onlyoffice: { container: 'mos-onlyoffice', capabilities: ['restart'] },
  radicale: { container: 'mos-radicale', capabilities: ['restart'] },
  seafile: { container: 'mos-seafile', capabilities: ['restart'] },
  'seafile-mysql': { container: 'mos-seafile-mysql', capabilities: ['restart'] },
  'seafile-valkey': { container: 'mos-seafile-valkey', capabilities: ['restart'] },
  'stirling-pdf': { container: 'mos-stirling-pdf', capabilities: ['restart'] },
  'suite-manager': { container: 'mos-suite-manager', capabilities: ['restart'] },
  vaultwarden: { container: 'mos-vaultwarden', capabilities: ['restart'] },
  'vaultwarden-postgres': { container: 'mos-vaultwarden-postgres', capabilities: ['restart'] },
};

const LOCAL_HTTPS_ENV_PATH = repoDir ? path.join(repoDir, 'deploy', 'vps', '.env') : '';
const CADDY_ENV_PATH = repoDir ? path.join(repoDir, 'deploy', 'vps', 'services', 'caddy', '.env') : '';

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function loadToken() {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function readJsonBody(request, maxBytes = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;

    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }

      raw += chunk;
      if (raw.length > maxBytes) {
        tooLarge = true;
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(new Error('Request body is too large.'));
        return;
      }

      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function authenticate(request) {
  const token = loadToken();
  if (!token) {
    return false;
  }

  return request.headers.authorization === `Bearer ${token}`;
}

function cleanupSocket() {
  if (process.platform === 'win32') {
    return;
  }

  try {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
  } catch {}
}

function listCapabilities() {
  const capabilities = Object.fromEntries(
    Object.entries(SERVICES).map(([service, spec]) => {
      const capabilities =
        service === 'caddy' && !caddyExternalProxiesPath
          ? spec.capabilities.filter((capability) => capability !== 'external-proxies.apply')
          : spec.capabilities;

      return [
        service,
        {
          capabilities,
          container: spec.container,
        },
      ];
    }),
  );

  capabilities.settings = {
    capabilities: repoDir ? ['local-https.apply'] : [],
    container: '',
  };

  return capabilities;
}

function restartContainer(container) {
  return new Promise((resolve, reject) => {
    execFile('docker', ['restart', container], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || 'Docker restart failed.').trim()));
        return;
      }

      resolve((stdout || '').trim());
    });
  });
}

function execDocker(args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message || 'Docker command failed.').trim()));
        return;
      }

      resolve((stdout || stderr || '').trim());
    });
  });
}

function execRepo(command, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd: repoDir, timeout }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message || `${command} failed.`).trim()));
        return;
      }

      resolve((stdout || stderr || '').trim());
    });
  });
}

function writeFileAtomic(filePath, content) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o644 });
  fs.renameSync(tempPath, filePath);
}

function writeEnvValue(filePath, key, value) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing env file: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  let found = false;
  const nextLines = lines.map((line) => {
    const trimmed = line.trim();
    const idx = line.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || idx < 1) {
      return line;
    }

    const currentKey = line.slice(0, idx).trim();
    if (currentKey !== key) {
      return line;
    }

    found = true;
    return `${key}=${value}`;
  });

  if (!found) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
      nextLines.push(`${key}=${value}`);
    } else {
      nextLines[nextLines.length - 1] = `${key}=${value}`;
    }
  }

  writeFileAtomic(filePath, `${nextLines.join('\n').replace(/\n+$/u, '')}\n`);
}

function isRealAcmeDomain(domain) {
  const normalized = domain.trim().toLowerCase();
  return Boolean(
    normalized &&
      normalized !== 'localhost' &&
      normalized !== 'mos.home' &&
      !normalized.endsWith('.localhost') &&
      !normalized.endsWith('.home') &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(normalized),
  );
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.trim());
}

function scheduleLocalHttpsReconfigure() {
  setTimeout(() => {
    execRepo(
      'node',
      ['scripts/mos-compose.cjs', 'up', '-d', '--build', 'caddy', 'homepage', 'suite-manager'],
      600_000,
    )
      .then(() => execRepo('npm', ['run', 'caddy:external-proxies:apply'], 120_000))
      .catch(() => {});
  }, 1500);
}

async function validateCaddy() {
  return execDocker(['exec', 'mos-caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile']);
}

async function reloadCaddy() {
  return execDocker(['exec', 'mos-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile']);
}

async function handleRestart(response, serviceName) {
  const service = SERVICES[serviceName];
  if (!service) {
    json(response, 404, { error: 'Unknown MOS service.' });
    return;
  }

  try {
    const output = await restartContainer(service.container);
    json(response, 202, {
      action: 'restart',
      container: service.container,
      ok: true,
      output,
      service: serviceName,
    });
  } catch (error) {
    json(response, 500, {
      error: error instanceof Error ? error.message : 'Unable to restart service.',
      service: serviceName,
    });
  }
}

async function handleApplyCaddyExternalProxies(request, response) {
  if (!caddyExternalProxiesPath) {
    json(response, 409, { error: 'Caddy external proxy path is not configured.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : 'Invalid request body.' });
    return;
  }

  if (!body || typeof body.caddyfile !== 'string') {
    json(response, 400, { error: 'Generated Caddyfile content is required.' });
    return;
  }

  const nextContent = body.caddyfile.trim()
    ? body.caddyfile
    : '# No generated external proxy routes.\n';
  const previousContent = fs.existsSync(caddyExternalProxiesPath)
    ? fs.readFileSync(caddyExternalProxiesPath, 'utf8')
    : null;

  try {
    writeFileAtomic(caddyExternalProxiesPath, nextContent);
    await validateCaddy();
    await reloadCaddy();
    json(response, 202, {
      action: 'external-proxies.apply',
      ok: true,
      path: caddyExternalProxiesPath,
      service: 'caddy',
    });
  } catch (error) {
    try {
      if (previousContent === null) {
        fs.rmSync(caddyExternalProxiesPath, { force: true });
      } else {
        writeFileAtomic(caddyExternalProxiesPath, previousContent);
      }
    } catch {}

    json(response, 500, {
      error: error instanceof Error ? error.message : 'Unable to apply generated Caddy proxy config.',
      service: 'caddy',
    });
  }
}

async function handleApplyLocalHttps(request, response) {
  if (!repoDir || !LOCAL_HTTPS_ENV_PATH || !CADDY_ENV_PATH) {
    json(response, 409, { error: 'Local HTTPS apply path is not configured.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request, 16 * 1024);
  } catch (error) {
    json(response, 400, { error: error instanceof Error ? error.message : 'Invalid request body.' });
    return;
  }

  const domain = typeof body.domain === 'string' ? body.domain.trim().toLowerCase() : '';
  const acmeEmail = typeof body.acmeEmail === 'string' ? body.acmeEmail.trim() : '';
  const cloudflareApiToken = typeof body.cloudflareApiToken === 'string' ? body.cloudflareApiToken.trim() : '';

  if (!isRealAcmeDomain(domain)) {
    json(response, 400, { error: 'Enter a real Cloudflare-managed domain, such as mos.example.com.' });
    return;
  }

  if (!isEmailLike(acmeEmail)) {
    json(response, 400, { error: 'Enter a valid ACME contact email address.' });
    return;
  }

  if (!cloudflareApiToken) {
    json(response, 400, { error: 'Cloudflare API token is required.' });
    return;
  }

  if (!fs.existsSync(CADDY_ENV_PATH)) {
    try {
      await execRepo('node', ['scripts/vps-init.cjs'], 180_000);
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : 'Unable to create missing Caddy env file.',
        service: 'settings',
      });
      return;
    }
  }

  const previousRootEnv = fs.existsSync(LOCAL_HTTPS_ENV_PATH) ? fs.readFileSync(LOCAL_HTTPS_ENV_PATH, 'utf8') : null;
  const previousCaddyEnv = fs.existsSync(CADDY_ENV_PATH) ? fs.readFileSync(CADDY_ENV_PATH, 'utf8') : null;

  try {
    writeEnvValue(LOCAL_HTTPS_ENV_PATH, 'DOMAIN', domain);
    writeEnvValue(LOCAL_HTTPS_ENV_PATH, 'PUBLIC_URL_SCHEME', 'https');
    writeEnvValue(LOCAL_HTTPS_ENV_PATH, 'MOS_TLS_MODE', 'cloudflare-dns01');
    writeEnvValue(CADDY_ENV_PATH, 'CADDY_ACME_EMAIL', acmeEmail);
    writeEnvValue(CADDY_ENV_PATH, 'CLOUDFLARE_API_TOKEN', cloudflareApiToken);

    await execRepo('node', ['scripts/vps-init.cjs'], 180_000);
    await execRepo('npm', ['run', 'vps:doctor'], 120_000);

    scheduleLocalHttpsReconfigure();

    json(response, 202, {
      action: 'local-https.apply',
      domain,
      ok: true,
      restartScheduled: true,
    });
  } catch (error) {
    try {
      if (previousRootEnv !== null) {
        writeFileAtomic(LOCAL_HTTPS_ENV_PATH, previousRootEnv);
      }
      if (previousCaddyEnv !== null) {
        writeFileAtomic(CADDY_ENV_PATH, previousCaddyEnv);
      }
    } catch {}

    json(response, 500, {
      error: error instanceof Error ? error.message : 'Unable to apply local HTTPS settings.',
      service: 'settings',
    });
  }
}

ensureDir(path.dirname(socketPath));
cleanupSocket();

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');

  if (request.method === 'GET' && url.pathname === '/healthz') {
    json(response, 200, { ok: true, service: 'mos-service-agent' });
    return;
  }

  if (!authenticate(request)) {
    json(response, 401, { error: 'Unauthorized.' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/v1/status') {
    json(response, 200, {
      capabilities: listCapabilities(),
      service: 'mos-service-agent',
      socketPath,
    });
    return;
  }

  const restartMatch = url.pathname.match(/^\/v1\/services\/([^/]+)\/restart$/);
  if (request.method === 'POST' && restartMatch) {
    await handleRestart(response, decodeURIComponent(restartMatch[1]));
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/caddy/external-proxies/apply') {
    await handleApplyCaddyExternalProxies(request, response);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/v1/settings/local-https/apply') {
    await handleApplyLocalHttps(request, response);
    return;
  }

  json(response, 404, { error: 'Not found.' });
});

server.listen(socketPath, () => {
  process.stdout.write(`[mos-service-agent] listening on ${socketPath}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanupSocket();
    server.close(() => process.exit(0));
  });
}
