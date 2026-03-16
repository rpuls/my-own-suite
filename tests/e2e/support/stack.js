import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const supportDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(supportDir, '..', '..', '..');
const composeDir = path.join(repoRoot, 'deploy', 'vps');
const composeFiles = ['docker-compose.yml', 'docker-compose.e2e.yml'];
const projectName = 'mos-e2e';
const profiles = ['vaultwarden', 'seafile', 'radicale'];
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

async function waitFor(url, timeoutMs) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status >= 200 && response.status < 400) {
        return;
      }
    } catch {
      // keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function readSuiteManagerEnv() {
  const filePath = path.join(composeDir, 'services', 'suite-manager', '.env');
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

  const suiteManagerEnv = readSuiteManagerEnv();
  fs.writeFileSync(
    stackStatePath,
    JSON.stringify(
      {
        ownerEmail: suiteManagerEnv.OWNER_EMAIL,
        ownerPassword: suiteManagerEnv.OWNER_PASSWORD,
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
