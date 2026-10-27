#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ASSET_REFERENCE = /(?:src|href)="\/suite-manager\/assets\/([^"?#]+)/gu;

// Vite builds beside the pages being served (see vite.config.mjs), never into them.
function nextBuildDir(distDir) {
  return `${distDir}-next`;
}

function missingFromBuild(buildDir) {
  const indexPath = path.join(buildDir, 'index.html');
  if (!fs.existsSync(indexPath)) return ['index.html'];
  const html = fs.readFileSync(indexPath, 'utf8');
  return [...html.matchAll(ASSET_REFERENCE)].map((match) => match[1]).filter((file) => !fs.existsSync(path.join(buildDir, file)));
}

// Runs as Suite Manager starts, so a running server never hands out pages newer than itself:
// during an update the old server keeps its own pages until the new one replaces it.
function promoteFrontendBuild(distDir, { log = () => {} } = {}) {
  const nextDir = nextBuildDir(distDir);
  if (!fs.existsSync(nextDir)) return false;
  const missing = missingFromBuild(nextDir);
  if (missing.length) {
    log(`Kept the pages already served: the new build is missing ${missing.join(', ')}.`);
    return false;
  }
  const previousDir = `${distDir}-previous`;
  fs.rmSync(previousDir, { force: true, recursive: true });
  if (fs.existsSync(distDir)) fs.renameSync(distDir, previousDir);
  fs.renameSync(nextDir, distDir);
  fs.rmSync(previousDir, { force: true, recursive: true });
  return true;
}

module.exports = { missingFromBuild, nextBuildDir, promoteFrontendBuild };

// The unit's root ExecStartPre: Suite Manager itself cannot write the repository on a server.
if (require.main === module) {
  promoteFrontendBuild(path.resolve(process.argv[2]), { log: (message) => console.error(`[mos-suite-manager] ${message}`) });
}
