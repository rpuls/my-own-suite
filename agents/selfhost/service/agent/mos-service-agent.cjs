#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const socketPath = process.env.MOS_SERVICE_AGENT_SOCKET_PATH || '/run/mos-service-agent/agent.sock';
const tokenFile = process.env.MOS_SERVICE_AGENT_TOKEN_FILE || '/etc/mos-service-agent/auth.token';

const SERVICES = {
  caddy: { container: 'mos-caddy', capabilities: ['restart'] },
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
  return Object.fromEntries(
    Object.entries(SERVICES).map(([service, spec]) => [
      service,
      {
        capabilities: spec.capabilities,
        container: spec.container,
      },
    ]),
  );
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
