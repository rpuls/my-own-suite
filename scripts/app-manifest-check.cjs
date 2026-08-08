#!/usr/bin/env node
// Validates app package manifests against the locked manifest contract
// without running MOS: the structural pass interprets the published
// apps/manifest.schema.json, and the semantic pass covers cross-references,
// the template grammar, and package-file existence.
//
//   npm run apps:manifest:check                 validates every apps/<app>/manifest.json
//   npm run apps:manifest:check -- <dir...>     validates the given package folders
//
// A package folder is any folder containing a manifest.json. Exit code 1 when
// any manifest is invalid, 0 when all pass.
const fs = require('node:fs');
const path = require('node:path');

const { validateAppPackageManifest } = require('../suite-manager/backend/src/apps/package-manifest.cjs');

const repoRoot = path.resolve(__dirname, '..');

function packageDirsFrom(args) {
  if (args.length) {
    return args.map((arg) => path.resolve(process.cwd(), arg));
  }
  const appsDir = path.join(repoRoot, 'apps');
  return fs.readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appsDir, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')));
}

function main(args = process.argv.slice(2)) {
  const dirs = packageDirsFrom(args.filter((arg) => !arg.startsWith('-')));
  if (!dirs.length) {
    process.stderr.write('No package folders with a manifest.json found.\n');
    process.exitCode = 1;
    return;
  }
  let failures = 0;
  for (const packageDir of dirs) {
    const manifestPath = path.join(packageDir, 'manifest.json');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      failures += 1;
      process.stderr.write(`✖ ${manifestPath}\n  ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }
    const errors = validateAppPackageManifest(manifest, { packageDir });
    if (errors.length) {
      failures += 1;
      process.stderr.write(`✖ ${manifestPath}\n${errors.map((line) => `  ${line}`).join('\n')}\n`);
    } else {
      process.stdout.write(`✔ ${path.relative(repoRoot, manifestPath)}\n`);
    }
  }
  if (failures) {
    process.stderr.write(`\n${failures} manifest${failures === 1 ? '' : 's'} failed validation.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('All manifests are valid.\n');
}

if (require.main === module) main();

module.exports = { main };
