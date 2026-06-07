#!/usr/bin/env node

const fs = require('node:fs');
const http = require('node:http');

function readArg(name, fallback = '') {
  const prefixed = `--${name}=`;
  const valueWithEquals = process.argv.find((arg) => arg.startsWith(prefixed));
  if (valueWithEquals) {
    return valueWithEquals.slice(prefixed.length).trim();
  }

  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1].trim();
  }

  return fallback;
}

const command = process.argv[2] || 'status';
const socketPath = process.env.MOS_SERVICE_AGENT_SOCKET_PATH || readArg('socket', '/run/mos-service-agent/agent.sock');
const tokenFile = process.env.MOS_SERVICE_AGENT_TOKEN_FILE || readArg('token-file', '/etc/mos-service-agent/auth.token');

function loadToken() {
  try {
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

function requestJson({ includeAuth, method, path }) {
  return new Promise((resolve, reject) => {
    const headers = {};
    const token = includeAuth ? loadToken() : '';
    if (includeAuth && token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const request = http.request(
      {
        headers,
        method,
        path,
        socketPath,
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          raw += chunk;
        });
        response.on('end', () => {
          try {
            const parsed = raw.trim() ? JSON.parse(raw) : {};
            if (response.statusCode >= 200 && response.statusCode < 300) {
              resolve(parsed);
              return;
            }

            reject(new Error(parsed.error || `Request failed with status ${response.statusCode}.`));
          } catch (error) {
            reject(error);
          }
        });
      },
    );

    request.on('error', reject);
    request.end();
  });
}

async function main() {
  if (command === 'health') {
    const body = await requestJson({ includeAuth: false, method: 'GET', path: '/healthz' });
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  if (command === 'status') {
    const body = await requestJson({ includeAuth: true, method: 'GET', path: '/v1/status' });
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  if (command === 'restart') {
    const service = readArg('service') || process.argv[3] || '';
    if (!service) {
      throw new Error('Provide --service <service-name> when using the restart command.');
    }

    const body = await requestJson({
      includeAuth: true,
      method: 'POST',
      path: `/v1/services/${encodeURIComponent(service)}/restart`,
    });
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return;
  }

  throw new Error('Unsupported command. Use health, status, or restart.');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
