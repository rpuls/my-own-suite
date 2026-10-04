#!/usr/bin/env node
// Re-stamps an app package after its contents changed, usually a moved image pin:
// package version, appVersion, the privacy review's scope and package digest, and
// the catalog. It re-binds the review to the new package; it does not re-assess it.
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { compareSemver, digestAppPackage } = require('../suite-manager/backend/src/apps/package-contracts.cjs');
const { parseImageReference, readImagePins } = require('./app-images.cjs');
const { main: writeCatalog } = require('./app-package-catalog.cjs');
const { baselineRefs, readBaselineCatalog } = require('./app-version-guard.cjs');

const repoRoot = path.resolve(__dirname, '..');
const LEVELS = ['patch', 'minor', 'major'];

const USAGE = `Usage: npm run apps:bump -- <app> [options]

Re-stamps apps/<app> after its contents changed, usually a moved Dockerfile pin.

  --app-version <version>        The primary image's version, when its FROM line has no tag.
  --component <image>=<version>  Another image's version, when its FROM line has no tag. Repeatable.
  --level patch|minor|major      How far past the published package version to move. Default: patch.
  --package-version <x.y.z>      Set the package version outright instead.
`;

function bumpVersion(version, level) {
  const [major, minor, patch] = version.split('.').map(Number);
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// A tag such as `v3.2.2` names version 3.2.2; any other tag is the version as tagged.
function versionFromTag(tag) {
  return tag ? tag.replace(/^v(?=\d)/u, '') : null;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Keeps the file's own line endings, so a Windows checkout shows only real changes.
function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const crlf = fs.readFileSync(filePath, 'utf8').includes('\r\n');
  fs.writeFileSync(filePath, crlf ? text.replace(/\n/gu, '\r\n') : text);
}

// A moved digest with no tag and no stated version is refused rather than
// recorded under the old version, which would make the review lie.
function restampComponents(packageDir, review, { appVersion, componentVersions }) {
  const problems = [];
  let primaryVersion = null;
  for (const pin of readImagePins(packageDir).filter((item) => item.digest)) {
    const component = (review.scope.components || []).find((item) => item.artifact === pin.artifact);
    if (!component) {
      problems.push(`${pin.dockerfile} pins ${pin.artifact}, which the privacy review lists no component for.`);
      continue;
    }
    const primary = pin.dockerfile === 'Dockerfile';
    const stated = primary ? appVersion : componentVersions[pin.artifact];
    const unmoved = component.digest === pin.digest ? component.version : null;
    const version = stated || versionFromTag(pin.tag) || unmoved;
    if (!version) {
      const option = primary ? '--app-version <version>' : `--component ${pin.artifact}=<version>`;
      problems.push(`${pin.artifact} moved to ${pin.digest} with no tag; pass ${option}.`);
      continue;
    }
    component.digest = pin.digest;
    component.version = version;
    if (primary) primaryVersion = version;
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return primaryVersion;
}

function nextPackageVersion(current, { baseline, level, packageVersion }) {
  if (packageVersion) return packageVersion;
  if (!baseline) return current;
  const target = bumpVersion(baseline.packageVersion, level);
  return compareSemver(current, target) >= 0 ? current : target;
}

// `baseline` is the published catalog's entry, null for a never-published package.
// Running twice is a no-op: a version already past the published one is kept.
function bumpPackage(packageDir, { appVersion, baseline = null, componentVersions = {}, level = 'patch', packageVersion } = {}) {
  const manifestPath = path.join(packageDir, 'manifest.json');
  const reviewPath = path.join(packageDir, 'privacy-review.json');
  const manifest = readJson(manifestPath);
  const review = readJson(reviewPath);
  if (!review.scope) throw new Error(`${path.basename(packageDir)}: privacy-review.json has no scope to re-stamp.`);
  if (baseline && digestAppPackage(packageDir, { manifest }) === baseline.packageDigest) {
    throw new Error(`${manifest.id} matches the published package; nothing to bump.`);
  }
  const previous = { appVersion: manifest.appVersion, packageVersion: manifest.version };

  manifest.appVersion = restampComponents(packageDir, review, { appVersion, componentVersions }) || manifest.appVersion;
  manifest.version = nextPackageVersion(manifest.version, { baseline, level, packageVersion });
  review.scope.packageVersion = manifest.version;
  writeJson(manifestPath, manifest);
  writeJson(reviewPath, review);
  review.scope.packageDigest = digestAppPackage(packageDir, { manifest });
  writeJson(reviewPath, review);

  return { appVersion: manifest.appVersion, packageDigest: review.scope.packageDigest, packageVersion: manifest.version, previous };
}

function parseComponentVersions(entries) {
  return Object.fromEntries(entries.map((entry) => {
    const [image, version] = entry.split('=');
    if (!image || !version) throw new Error(`--component takes <image>=<version>, got ${entry}.`);
    return [parseImageReference(image).artifact, version];
  }));
}

function readBaseline(appId) {
  const refs = baselineRefs();
  const { catalog } = readBaselineCatalog(refs);
  if (!catalog) throw new Error(`Cannot read the published catalog from ${refs.join(' or ')} to bump from. Fetch it, or pass --package-version.`);
  return catalog.packages?.[appId] || null;
}

function main(args = process.argv.slice(2)) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'app-version': { type: 'string' },
      component: { default: [], multiple: true, type: 'string' },
      help: { short: 'h', type: 'boolean' },
      level: { default: 'patch', type: 'string' },
      'package-version': { type: 'string' },
    },
  });
  if (values.help || positionals.length !== 1) {
    process.stdout.write(USAGE);
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (!LEVELS.includes(values.level)) throw new Error(`--level must be one of ${LEVELS.join(', ')}.`);
  const [appId] = positionals;
  const packageDir = path.join(repoRoot, 'apps', appId);
  if (!fs.existsSync(path.join(packageDir, 'manifest.json'))) throw new Error(`apps/${appId} is not an app package.`);

  const result = bumpPackage(packageDir, {
    appVersion: values['app-version'],
    baseline: values['package-version'] ? null : readBaseline(appId),
    componentVersions: parseComponentVersions(values.component),
    level: values.level,
    packageVersion: values['package-version'],
  });
  process.stdout.write(`apps/${appId}: package ${result.previous.packageVersion} -> ${result.packageVersion}, app ${result.previous.appVersion} -> ${result.appVersion}.\n`);
  writeCatalog([]);
  process.stdout.write('The privacy review was re-bound to the new package, not re-assessed: follow skills/assess-app-privacy for the releases crossed.\n');
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { bumpPackage, main };
