#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.cwd();
const vpsDir = path.join(repoRoot, 'deploy', 'vps');

const migrations = [];

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const values = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const index = line.indexOf('=');
    if (index < 1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

function appendEnvValues(filePath, values) {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return;
  }

  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const separator = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  const lines = [
    '# Migrated by npm run system:migrate. Keep these values aligned with the current .env.template.',
    ...keys.map((key) => `${key}=${values[key]}`),
  ];

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${existing}${separator}${lines.join('\n')}\n`, 'utf8');
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readTextFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return fs.readFileSync(filePath, 'utf8');
}

function writeTextFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, 'utf8');
}

function main() {
  if (!fs.existsSync(vpsDir)) {
    console.log('Skipped system migrations because deploy/vps was not found.');
    return;
  }

  let changedCount = 0;

  for (const migration of migrations) {
    const result = migration.migrate({
      appendEnvValues,
      ensureDirectory,
      readEnvFile,
      readTextFile,
      repoRoot,
      vpsDir,
      writeTextFile,
    });

    if (result.changed) {
      changedCount += 1;
      console.log(`Applied system migration ${migration.id}: ${result.details.join(', ')}`);
    } else {
      console.log(`Skipped system migration ${migration.id}: ${result.details.join(', ')}`);
    }
  }

  console.log(`\nDone. Applied ${changedCount} system migration(s).`);
}

main();
