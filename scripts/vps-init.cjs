#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.cwd();
const vpsDir = path.join(rootDir, 'deploy', 'vps');

const envPairs = [
  ['.env.example', '.env'],
  ['apps/homepage/.env.example', 'apps/homepage/.env'],
  ['apps/seafile/.env.example', 'apps/seafile/.env'],
  ['apps/onlyoffice/.env.example', 'apps/onlyoffice/.env'],
  ['apps/immich/.env.example', 'apps/immich/.env'],
  ['apps/radicale/.env.example', 'apps/radicale/.env'],
  ['apps/stirling-pdf/.env.example', 'apps/stirling-pdf/.env'],
  ['apps/vaultwarden/.env.example', 'apps/vaultwarden/.env'],
];

let createdCount = 0;
let skippedCount = 0;
let errorCount = 0;

for (const [sourceRelPath, targetRelPath] of envPairs) {
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

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  createdCount += 1;
  console.log(`Created: deploy/vps/${targetRelPath}`);
}

console.log(`\nDone. Created ${createdCount}, skipped ${skippedCount}, errors ${errorCount}.`);

if (errorCount > 0) {
  process.exit(1);
}
