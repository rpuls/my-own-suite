#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const rootDir = process.cwd();
const vpsDir = path.join(rootDir, 'deploy', 'vps');
const URL_SAFE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
const TEMPLATE_EXTENSIONS = ['.env.template'];
const GLOBAL_TEMPLATE_FILES = new Set([
  '.env.template',
  'services/suite-manager/.env.template',
]);
const GLOBAL_TARGET_FILES = new Set(['.env', 'services/suite-manager/.env']);

function collectEnvTemplates(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectEnvTemplates(fullPath));
      continue;
    }

    if (entry.isFile() && TEMPLATE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      files.push(fullPath);
    }
  }

  return files;
}

function randomFromAlphabet(length, alphabet) {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error(`secret() length must be a positive integer, got: ${length}`);
  }
  if (!alphabet || alphabet.length === 0) {
    throw new Error('secret() alphabet must not be empty');
  }

  const bytes = crypto.randomBytes(length);
  let output = '';
  for (let i = 0; i < length; i += 1) {
    output += alphabet[bytes[i] % alphabet.length];
  }
  return output;
}

function splitArgs(raw) {
  const args = [];
  let current = '';
  let quote = null;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (quote) {
      if (ch === '\\' && i + 1 < raw.length) {
        current += raw[i + 1];
        i += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === ',') {
      args.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (quote) {
    throw new Error(`Unclosed quote in args: ${raw}`);
  }

  if (current.trim() !== '') {
    args.push(current.trim());
  }

  return args;
}

function resolveRefs(value, vars) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key];
    }
    return full;
  });
}

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const map = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const idx = line.indexOf('=');
    if (idx < 1) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    map[key] = value;
  }

  return map;
}

function getTemplateTargetPath(sourceRelPath) {
  return sourceRelPath.replace(/\.env\.template$/, '.env');
}

function isGlobalTemplate(sourceRelPath) {
  return GLOBAL_TEMPLATE_FILES.has(sourceRelPath);
}

function isGlobalTarget(targetRelPath) {
  return GLOBAL_TARGET_FILES.has(targetRelPath);
}

function evalSecret(rawArgs, sharedSecrets) {
  const args = splitArgs(rawArgs);

  let key = null;
  let length = 32;
  let alphabet = URL_SAFE_ALPHABET;

  if (args.length === 0) {
    return randomFromAlphabet(length, alphabet);
  }

  if (/^\d+$/.test(args[0])) {
    length = Number(args[0]);
    if (args[1]) {
      alphabet = args[1];
    }
  } else {
    key = args[0];
    if (!/^\d+$/.test(args[1] || '')) {
      throw new Error(`secret(name, length[, alphabet]) requires numeric length. Got: ${rawArgs}`);
    }
    length = Number(args[1]);
    if (args[2]) {
      alphabet = args[2];
    }
  }

  if (key) {
    if (!Object.prototype.hasOwnProperty.call(sharedSecrets, key)) {
      sharedSecrets[key] = randomFromAlphabet(length, alphabet);
    }
    return sharedSecrets[key];
  }

  return randomFromAlphabet(length, alphabet);
}

function evalBase64(rawArgs, localVars, sharedVars) {
  const args = splitArgs(rawArgs);
  if (args.length !== 1) {
    throw new Error(`base64(text) requires exactly 1 argument. Got: ${rawArgs}`);
  }

  const resolved = resolveRefs(args[0], { ...sharedVars, ...localVars });
  return Buffer.from(resolved, 'utf8').toString('base64');
}

function evalShared(rawArgs, sharedVars) {
  const args = splitArgs(rawArgs);
  if (args.length !== 1) {
    throw new Error(`shared(name) requires exactly 1 argument. Got: ${rawArgs}`);
  }

  const key = args[0];
  if (!Object.prototype.hasOwnProperty.call(sharedVars, key)) {
    throw new Error(`shared(${key}) is not defined yet`);
  }

  return sharedVars[key];
}

function evalUrl(rawArgs, sharedVars) {
  const args = splitArgs(rawArgs);
  if (args.length < 1 || args.length > 2) {
    throw new Error(`url(service[, protocol]) requires 1 or 2 arguments. Got: ${rawArgs}`);
  }

  const service = args[0];
  const protocol = args[1] || 'http';
  const domain = sharedVars.DOMAIN;

  if (!domain) {
    throw new Error('url(...) requires shared DOMAIN to be defined first');
  }

  return `${protocol}://${service}.${domain}`;
}

function evalHost(rawArgs, sharedVars) {
  const args = splitArgs(rawArgs);
  if (args.length !== 1) {
    throw new Error(`host(service) requires exactly 1 argument. Got: ${rawArgs}`);
  }

  const service = args[0];
  const domain = sharedVars.DOMAIN;

  if (!domain) {
    throw new Error('host(...) requires shared DOMAIN to be defined first');
  }

  return `${service}.${domain}`;
}

function evaluateExpression(expr, localVars, sharedVars, sharedSecrets) {
  const match = expr.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/);
  if (!match) {
    throw new Error(`Invalid template expression: ${expr}`);
  }

  const fn = match[1];
  const args = match[2];

  if (fn === 'secret') {
    return evalSecret(args, sharedSecrets);
  }

  if (fn === 'base64') {
    return evalBase64(args, localVars, sharedVars);
  }

  if (fn === 'shared') {
    return evalShared(args, sharedVars);
  }

  if (fn === 'url') {
    return evalUrl(args, sharedVars);
  }

  if (fn === 'host') {
    return evalHost(args, sharedVars);
  }

  throw new Error(`Unsupported template function: ${fn}`);
}

function renderTemplate(value, localVars, sharedVars, sharedSecrets) {
  return value.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_full, expr) => {
    return evaluateExpression(expr, localVars, sharedVars, sharedSecrets);
  });
}

function renderEnvFile(rawContent, sharedVars, sharedSecrets, seedVars = {}) {
  const lines = rawContent.split(/\r?\n/);
  const localVars = { ...seedVars };
  const out = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const idx = line.indexOf('=');

    if (!trimmed || trimmed.startsWith('#') || idx < 1) {
      out.push(line);
      continue;
    }

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    const rendered = Object.prototype.hasOwnProperty.call(seedVars, key)
      ? seedVars[key]
      : renderTemplate(value, localVars, sharedVars, sharedSecrets);

    localVars[key] = rendered;
    out.push(`${key}=${rendered}`);
  }

  return {
    rendered: out.join('\n'),
    localVars,
  };
}

function collectMissingAssignments(rawContent, sharedVars, sharedSecrets, existingVars) {
  const lines = rawContent.split(/\r?\n/);
  const localVars = { ...existingVars };
  const missingAssignments = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const idx = line.indexOf('=');

    if (!trimmed || trimmed.startsWith('#') || idx < 1) {
      continue;
    }

    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    const rendered = Object.prototype.hasOwnProperty.call(existingVars, key)
      ? existingVars[key]
      : renderTemplate(value, localVars, sharedVars, sharedSecrets);

    localVars[key] = rendered;

    if (!Object.prototype.hasOwnProperty.call(existingVars, key)) {
      missingAssignments.push(`${key}=${rendered}`);
    }
  }

  return {
    localVars,
    missingAssignments,
  };
}

const sourceFiles = collectEnvTemplates(vpsDir)
  .map((file) => path.relative(vpsDir, file).replace(/\\/g, '/'))
  .sort((a, b) => {
    if (a === '.env.template') return -1;
    if (b === '.env.template') return 1;
    if (a === 'services/suite-manager/.env.template') return -1;
    if (b === 'services/suite-manager/.env.template') return 1;
    return a.localeCompare(b);
  });

let createdCount = 0;
let updatedCount = 0;
let skippedCount = 0;
let errorCount = 0;
const sharedVars = {};
const sharedSecrets = {};

for (const sourceRelPath of sourceFiles) {
  const targetRelPath = getTemplateTargetPath(sourceRelPath);
  const sourcePath = path.join(vpsDir, sourceRelPath);
  const targetPath = path.join(vpsDir, targetRelPath);

  if (!fs.existsSync(sourcePath)) {
    errorCount += 1;
    console.error(`Missing source file: deploy/vps/${sourceRelPath}`);
    continue;
  }

  if (fs.existsSync(targetPath)) {
    try {
      const rawSource = fs.readFileSync(sourcePath, 'utf8');
      const existingVars = readEnvFile(targetPath) || {};
      const { rendered, localVars } = renderEnvFile(rawSource, sharedVars, sharedSecrets, existingVars);

      if (rendered.includes('${{')) {
        throw new Error(`Unresolved template expression in ${sourceRelPath}`);
      }

      if (isGlobalTemplate(sourceRelPath) || isGlobalTarget(targetRelPath)) {
        Object.assign(sharedVars, localVars);
      }

      const renderedLines = rendered.split(/\r?\n/);
      const missingLines = [];

      for (const line of renderedLines) {
        const trimmed = line.trim();
        const idx = line.indexOf('=');
        if (!trimmed || trimmed.startsWith('#') || idx < 1) {
          continue;
        }

        const key = line.slice(0, idx).trim();
        if (!Object.prototype.hasOwnProperty.call(existingVars, key)) {
          missingLines.push(line);
        }
      }

      if (missingLines.length > 0) {
        const existingRaw = fs.readFileSync(targetPath, 'utf8');
        const separator = existingRaw.endsWith('\n') || existingRaw.length === 0 ? '' : '\n';
        fs.writeFileSync(targetPath, `${existingRaw}${separator}${missingLines.join('\n')}\n`, 'utf8');
        updatedCount += 1;
        console.log(`Updated: deploy/vps/${targetRelPath} (added ${missingLines.length} missing keys)`);
      } else {
        skippedCount += 1;
        console.log(`Exists, skipped: deploy/vps/${targetRelPath}`);
      }
      } catch (error) {
        errorCount += 1;
        console.error(`Failed: deploy/vps/${targetRelPath} (${error.message})`);
      }
    continue;
  }

  try {
    const rawSource = fs.readFileSync(sourcePath, 'utf8');
    const { rendered, localVars } = renderEnvFile(rawSource, sharedVars, sharedSecrets);

    if (rendered.includes('${{')) {
      throw new Error(`Unresolved template expression in ${sourceRelPath}`);
    }

    if (isGlobalTemplate(sourceRelPath) || isGlobalTarget(targetRelPath)) {
      Object.assign(sharedVars, localVars);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, rendered, 'utf8');

    createdCount += 1;
    console.log(`Created: deploy/vps/${targetRelPath}`);
  } catch (error) {
    errorCount += 1;
    console.error(`Failed: deploy/vps/${targetRelPath} (${error.message})`);
  }
}

console.log(`\nDone. Created ${createdCount}, updated ${updatedCount}, skipped ${skippedCount}, errors ${errorCount}.`);

if (errorCount > 0) {
  process.exit(1);
}
