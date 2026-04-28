import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const supportDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(supportDir, '..', '..', '..');
const composeDir = path.join(repoRoot, 'deploy', 'vps');
const composeFiles = ['docker-compose.yml', 'docker-compose.e2e.yml'];
const projectName = 'mos-e2e';
const profiles = ['vaultwarden', 'seafile', 'stirling-pdf', 'radicale', 'immich'];
const stackStatePath = path.resolve(supportDir, '..', '.stack-state.json');

function dockerComposeArgs(extraArgs) {
  const fileArgs = composeFiles.flatMap((file) => ['-f', path.join(composeDir, file)]);
  const profileArgs = profiles.flatMap((profile) => ['--profile', profile]);

  return [
    'compose',
    ...fileArgs,
    '--project-directory',
    composeDir,
    '-p',
    projectName,
    ...profileArgs,
    ...extraArgs,
  ];
}

function runDockerCompose(extraArgs) {
  execFileSync('docker', dockerComposeArgs(extraArgs), {
    cwd: repoRoot,
    env: {
      ...process.env,
      MOS_E2E_HTTP_PORT: process.env.MOS_E2E_HTTP_PORT || '18080',
      MOS_E2E_HTTPS_PORT: process.env.MOS_E2E_HTTPS_PORT || '18443',
    },
    stdio: 'inherit',
  });
}

async function waitFor(url, timeoutMs, isReady = (status) => status >= 200 && status < 400) {
  const startedAt = Date.now();
  const request = readinessRequest(url);

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const status = await requestStatus(request);
      if (isReady(status)) {
        return;
      }
    } catch {
      // keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function requestStatus(request) {
  const parsed = new URL(request.url);
  const client = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = client.request(
      parsed,
      {
        headers: request.headers,
        timeout: 5000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`Timed out requesting ${request.url}`));
    });
    req.end();
  });
}

function readinessRequest(url) {
  const parsed = new URL(url);

  if (!parsed.hostname.endsWith('.localhost')) {
    return { url, headers: undefined };
  }

  const originalHost = parsed.host;
  parsed.hostname = '127.0.0.1';
  return {
    url: parsed.toString(),
    headers: {
      Host: originalHost,
    },
  };
}

function readSuiteManagerEnv() {
  return readEnvFile(path.join(composeDir, 'services', 'suite-manager', '.env'));
}

function readEnvFile(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const env = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const equalsIndex = trimmed.indexOf('=');
    if (equalsIndex < 0) {
      continue;
    }

    env[trimmed.slice(0, equalsIndex)] = trimmed.slice(equalsIndex + 1);
  }

  return env;
}

export async function startStack() {
  runDockerCompose(['down', '--volumes', '--remove-orphans']);
  runDockerCompose(['up', '-d', '--build']);

  await waitFor('http://suite-manager.localhost:18080/healthz', 180000);
  await waitFor('http://suite-manager.localhost:18080/setup/', 180000);
  await waitFor('http://seafile.localhost:18080/', 180000);
  await waitFor('http://stirling-pdf.localhost:18080/', 180000, (status) => status === 401 || (status >= 200 && status < 400));
  await waitFor('http://immich.localhost:18080/', 180000);

  const suiteManagerEnv = readSuiteManagerEnv();
  const seafileEnv = readEnvFile(path.join(composeDir, 'services', 'seafile', '.env'));
  const radicaleEnv = readEnvFile(path.join(composeDir, 'services', 'radicale', '.env'));
  fs.writeFileSync(
    stackStatePath,
    JSON.stringify(
      {
        ownerEmail: suiteManagerEnv.OWNER_EMAIL,
        ownerPassword: suiteManagerEnv.OWNER_PASSWORD,
        radicaleAdminPassword: radicaleEnv.RADICALE_ADMIN_PASSWORD,
        radicaleAdminUsername: radicaleEnv.RADICALE_ADMIN_USERNAME,
        seafileAdminEmail: seafileEnv.SEAFILE_ADMIN_EMAIL,
        seafileAdminPassword: seafileEnv.SEAFILE_ADMIN_PASSWORD,
      },
      null,
      2,
    ),
    'utf8',
  );
}

export function stopStack() {
  runDockerCompose(['down', '--volumes', '--remove-orphans']);

  if (fs.existsSync(stackStatePath)) {
    fs.rmSync(stackStatePath, { force: true });
  }
}

export function readStackState() {
  return JSON.parse(fs.readFileSync(stackStatePath, 'utf8'));
}
