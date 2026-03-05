#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const rootDir = process.cwd();
const vpsDir = path.join(rootDir, 'deploy', 'vps');
const URL_SAFE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';

function collectEnvExamples(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(collectEnvExamples(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.env.example')) {
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

function resolveLocalRefs(value, localVars) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, key) => {
    if (Object.prototype.hasOwnProperty.call(localVars, key)) {
      return localVars[key];
    }
    return full;
  });
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

function evalBase64(rawArgs, localVars) {
  const args = splitArgs(rawArgs);
  if (args.length !== 1) {
    throw new Error(`base64(text) requires exactly 1 argument. Got: ${rawArgs}`);
  }

  const resolved = resolveLocalRefs(args[0], localVars);
  return Buffer.from(resolved, 'utf8').toString('base64');
}

function evaluateExpression(expr, localVars, sharedSecrets) {
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
    return evalBase64(args, localVars);
  }

  throw new Error(`Unsupported template function: ${fn}`);
}

function renderTemplate(value, localVars, sharedSecrets) {
  return value.replace(/\$\{\{\s*([\s\S]*?)\s*\}\}/g, (_full, expr) => {
    return evaluateExpression(expr, localVars, sharedSecrets);
  });
}

function renderEnvFile(rawContent, sharedSecrets) {
  const lines = rawContent.split(/\r?\n/);
  const localVars = {};
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
    const rendered = renderTemplate(value, localVars, sharedSecrets);

    localVars[key] = rendered;
    out.push(`${key}=${rendered}`);
  }

  return out.join('\n');
}

const sourceFiles = collectEnvExamples(vpsDir)
  .map((file) => path.relative(vpsDir, file).replace(/\\/g, '/'))
  .sort((a, b) => {
    if (a === '.env.example') return -1;
    if (b === '.env.example') return 1;
    return a.localeCompare(b);
  });

let createdCount = 0;
let skippedCount = 0;
let errorCount = 0;
const sharedSecrets = {};

for (const sourceRelPath of sourceFiles) {
  const targetRelPath = sourceRelPath.replace(/\.example$/, '');
  const sourcePath = path.join(vpsDir, sourceRelPath);
  const targetPath = path.join(vpsDir, targetRelPath);

  if (!fs.existsSync(sourcePath)) {
    errorCount += 1;
    console.error(`Missing source file: deploy/vps/${sourceRelPath}`);
    continue;
  }

  if (fs.existsSync(targetPath)) {
    skippedCount += 1;
    console.log(`Exists, skipped: deploy/vps/${targetRelPath}`);
    continue;
  }

  try {
    const rawSource = fs.readFileSync(sourcePath, 'utf8');
    const rendered = renderEnvFile(rawSource, sharedSecrets);

    if (rendered.includes('${{')) {
      throw new Error(`Unresolved template expression in ${sourceRelPath}`);
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

console.log(`\nDone. Created ${createdCount}, skipped ${skippedCount}, errors ${errorCount}.`);

if (errorCount > 0) {
  process.exit(1);
}
