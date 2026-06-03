#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = process.cwd();
const snippetPath = path.join(repoRoot, 'deploy', 'vps', 'generated', 'caddy', 'external-proxies.caddy');
const rootEnvPath = path.join(repoRoot, 'deploy', 'vps', '.env');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(output || `${command} ${args.join(' ')} failed.`);
  }

  return result.stdout || '';
}

function runNode(args, options = {}) {
  return run(process.execPath, args, options);
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    const idx = line.indexOf('=');
    if (!trimmed || trimmed.startsWith('#') || idx < 1) {
      continue;
    }

    values[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  return values;
}

function createPreview() {
  const content = run('docker', [
    'exec',
    'mos-suite-manager',
    'cat',
    '/data/homepage-config/services.template.yaml',
  ]);
  const code = `
    import fs from 'node:fs';
    import { createCaddyProxyPreviewFromServicesTemplate } from './apps/suite-manager/src/features/homepage-config/caddy-preview.ts';

    const content = fs.readFileSync(0, 'utf8');
    const options = {
      domain: process.env.DOMAIN,
      urlScheme: process.env.PUBLIC_URL_SCHEME,
    };
    process.stdout.write(JSON.stringify(createCaddyProxyPreviewFromServicesTemplate(content, options)));
  `;
  const rootEnv = readEnvFile(rootEnvPath);

  const raw = runNode([
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    code,
  ], {
    env: {
      ...process.env,
      DOMAIN: rootEnv.DOMAIN || process.env.DOMAIN || '',
      PUBLIC_URL_SCHEME: rootEnv.PUBLIC_URL_SCHEME || process.env.PUBLIC_URL_SCHEME || '',
    },
    input: content,
  });

  return JSON.parse(raw);
}

function validateCaddy() {
  run('docker', ['exec', 'mos-caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile'], {
    stdio: 'inherit',
  });
}

function reloadCaddy() {
  run('docker', ['exec', 'mos-caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile'], {
    stdio: 'inherit',
  });
}

function summarizeErrors(errors) {
  return errors.map((error) => `- ${error.path}: ${error.message}`).join('\n');
}

function main() {
  const previousContent = fs.existsSync(snippetPath) ? fs.readFileSync(snippetPath, 'utf8') : null;
  const preview = createPreview();

  if (!preview.valid) {
    throw new Error(`Generated external proxy config is invalid:\n${summarizeErrors(preview.errors || [])}`);
  }

  const nextContent = preview.caddyfile && preview.caddyfile.trim()
    ? preview.caddyfile
    : '# No generated external proxy routes.\n';

  try {
    writeFileAtomic(snippetPath, nextContent);
    validateCaddy();
    reloadCaddy();
  } catch (error) {
    if (previousContent === null) {
      fs.rmSync(snippetPath, { force: true });
    } else {
      writeFileAtomic(snippetPath, previousContent);
    }

    throw error;
  }

  console.log(`Applied ${preview.routes.length} external proxy route(s) to ${path.relative(repoRoot, snippetPath)}.`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to apply external proxy routes.');
  process.exit(1);
}
