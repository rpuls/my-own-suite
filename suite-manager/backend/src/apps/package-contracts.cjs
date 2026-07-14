const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PACKAGE_LIMITS = Object.freeze({
  maxFileBytes: 32 * 1024 * 1024,
  maxFiles: 256,
  maxPackageBytes: 128 * 1024 * 1024,
});
const ALLOWED_ROOT_FILES = /^(?:Dockerfile(?:\.[a-z0-9][a-z0-9-]*)?|README\.md|entrypoint\.sh|icon\.(?:avif|gif|jpe?g|png|svg|webp)|manifest\.json|privacy-review\.json)$/iu;
const TEXT_FILE = /(?:^Dockerfile(?:\.|$)|\.(?:cjs|css|html|js|json|md|mjs|sh|svg|txt|yaml|yml)$)/iu;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PACKAGE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u;
const SOURCE_KINDS = new Set(['external-git', 'local', 'official-git']);
const TRUST_LEVELS = new Set(['mos-reviewed', 'publisher-signed', 'unverified']);
const CATALOG_REFRESH_POLICY = Object.freeze({
  advisoryIntervalMs: 60 * 60 * 1000,
  backoffInitialMs: 5 * 60 * 1000,
  backoffMaximumMs: 6 * 60 * 60 * 1000,
  cacheStaleAfterMs: 24 * 60 * 60 * 1000,
  catalogIntervalMs: 6 * 60 * 60 * 1000,
  jitterRatio: 0.1,
  manualMinimumIntervalMs: 30 * 1000,
});

class AppPackageContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.code = 'INVALID_APP_PACKAGE_CONTENTS';
    this.details = details;
  }
}

function canonicalPackagePath(relativePath) {
  if (String(relativePath).includes('\\')) return null;
  const portable = String(relativePath);
  if (!portable || portable.includes('\0') || path.posix.isAbsolute(portable)) return null;
  const normalized = path.posix.normalize(portable);
  if (normalized === '..' || normalized.startsWith('../') || normalized !== portable) return null;
  return normalized;
}

function isAllowedPackageFile(relativePath, manifest) {
  if (ALLOWED_ROOT_FILES.test(relativePath)) return true;
  const declared = Array.isArray(manifest?.packageFiles) ? manifest.packageFiles : [];
  return declared.includes(relativePath);
}

function canonicalFileBytes(relativePath, bytes) {
  if (!TEXT_FILE.test(relativePath)) return bytes;
  const text = bytes.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(bytes) !== 0) {
    throw new AppPackageContractError(`Text package file is not valid UTF-8: ${relativePath}.`);
  }
  if (relativePath === 'privacy-review.json') {
    const review = JSON.parse(text);
    if (review?.scope) review.scope.packageDigest = 'sha256:<package-digest>';
    return Buffer.from(`${JSON.stringify(review, null, 2)}\n`, 'utf8');
  }
  return Buffer.from(text.replace(/\r\n?/gu, '\n'), 'utf8');
}

function collectPackageFiles(packageDir, { limits = DEFAULT_PACKAGE_LIMITS, manifest = null } = {}) {
  const errors = [];
  const files = [];
  let totalBytes = 0;
  const visit = (directory, relativeRoot = '') => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relativePath = canonicalPackagePath(relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name);
      if (!relativePath) {
        errors.push(`Package path is not canonical: ${relativeRoot}/${entry.name}.`);
        continue;
      }
      const absolutePath = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        errors.push(`Package must not contain symlinks: ${relativePath}.`);
      } else if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (!stat.isFile()) {
        errors.push(`Package must contain regular files only: ${relativePath}.`);
      } else if (!isAllowedPackageFile(relativePath, manifest)) {
        errors.push(`Package file is not allowed or declared in manifest.packageFiles: ${relativePath}.`);
      } else {
        if (stat.size > limits.maxFileBytes) errors.push(`Package file exceeds ${limits.maxFileBytes} bytes: ${relativePath}.`);
        totalBytes += stat.size;
        files.push({ absolutePath, relativePath, size: stat.size });
      }
    }
  };
  visit(packageDir);
  if (files.length > limits.maxFiles) errors.push(`Package contains more than ${limits.maxFiles} files.`);
  if (totalBytes > limits.maxPackageBytes) errors.push(`Package exceeds ${limits.maxPackageBytes} bytes.`);
  if (errors.length) throw new AppPackageContractError(`Invalid app package contents at ${packageDir}.`, errors);
  return files.sort((left, right) => Buffer.from(left.relativePath).compare(Buffer.from(right.relativePath)));
}

function digestAppPackage(packageDir, options = {}) {
  const manifest = options.manifest || JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'));
  const hash = crypto.createHash('sha256');
  for (const file of collectPackageFiles(packageDir, { ...options, manifest })) {
    const bytes = canonicalFileBytes(file.relativePath, fs.readFileSync(file.absolutePath));
    const pathBytes = Buffer.from(file.relativePath, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt32BE(pathBytes.length, 0);
    header.writeUInt32BE(bytes.length, 4);
    hash.update(header);
    hash.update(pathBytes);
    hash.update(bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function compareSemver(left, right) {
  const leftMatch = String(left).match(SEMVER_PATTERN);
  const rightMatch = String(right).match(SEMVER_PATTERN);
  if (!leftMatch || !rightMatch) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function validateSourceIdentity(source, { officialRepository = null } = {}) {
  const errors = [];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return ['source must be an object.'];
  if (!SOURCE_KINDS.has(source.kind)) errors.push('source.kind is unsupported.');
  if (typeof source.repository !== 'string' || !source.repository.trim()) errors.push('source.repository is required.');
  if (!canonicalPackagePath(source.path)) errors.push('source.path must be a canonical package-local path.');
  if (typeof source.revision !== 'string' || !source.revision.trim()) errors.push('source.revision is required.');
  if (!TRUST_LEVELS.has(source.trust)) errors.push('source.trust is unsupported.');
  if (source.trust === 'mos-reviewed' && (source.kind !== 'official-git' || !officialRepository || source.repository !== officialRepository)) {
    errors.push('mos-reviewed trust is derived only from the configured official repository.');
  }
  if (source.kind === 'external-git' && source.trust === 'mos-reviewed') {
    errors.push('external sources cannot claim mos-reviewed trust.');
  }
  return [...new Set(errors)];
}

function validateCatalog(catalog) {
  const errors = [];
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) return ['catalog must be an object.'];
  if (catalog.schemaVersion !== 1) errors.push('catalog.schemaVersion must be 1.');
  if (!catalog.packages || typeof catalog.packages !== 'object' || Array.isArray(catalog.packages)) return [...errors, 'catalog.packages must be an object.'];
  for (const [packageId, entry] of Object.entries(catalog.packages)) {
    const prefix = `catalog.packages.${packageId}`;
    if (!PACKAGE_ID_PATTERN.test(packageId)) errors.push(`${prefix} uses an invalid package id.`);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (entry.path !== `apps/${packageId}`) errors.push(`${prefix}.path must match its official package id.`);
    if (!SEMVER_PATTERN.test(String(entry.packageVersion || ''))) errors.push(`${prefix}.packageVersion must be semver-like.`);
    if (!SEMVER_PATTERN.test(String(entry.minimumMosVersion || ''))) errors.push(`${prefix}.minimumMosVersion must be semver-like.`);
    if (!DIGEST_PATTERN.test(String(entry.packageDigest || ''))) errors.push(`${prefix}.packageDigest must be a SHA-256 digest.`);
    if (!['review-required', 'reviewed', 'unverified'].includes(entry.privacy?.status)) errors.push(`${prefix}.privacy.status is invalid.`);
  }
  return errors;
}

function validatePlatformCompatibility(manifest, platformVersion) {
  const comparison = compareSemver(platformVersion, manifest?.minimumMosVersion);
  if (comparison === null) return ['Platform and minimum MOS versions must be semver-like.'];
  return comparison < 0 ? [`Package requires MOS ${manifest.minimumMosVersion} or newer; current version is ${platformVersion}.`] : [];
}

function validatePrivacyBinding(review, { manifest, packageDigest, source }) {
  const errors = [];
  if (!review || typeof review !== 'object' || Array.isArray(review)) return ['privacy review must be an object.'];
  if (review.schemaVersion !== 1) errors.push('privacy review schemaVersion must be 1.');
  if (review.appId !== manifest?.id) errors.push('privacy review appId does not match the manifest.');
  if (review.scope?.packageVersion !== manifest?.version) errors.push('privacy review packageVersion does not match the manifest.');
  if (review.scope?.packageDigest !== packageDigest) errors.push('privacy review packageDigest does not match the package contents.');
  for (const sourceError of validateSourceIdentity(review.scope?.source, {
    officialRepository: source?.trust === 'mos-reviewed' ? source.repository : null,
  })) errors.push(`privacy review ${sourceError}`);
  for (const field of ['kind', 'repository', 'path', 'revision', 'trust']) {
    if (review.scope?.source?.[field] !== source?.[field]) errors.push(`privacy review source.${field} does not match the resolved source.`);
  }
  if (!Array.isArray(review.scope?.components) || review.scope.components.length === 0) errors.push('privacy review must identify upstream components.');
  if (review.provenance?.model === undefined || !String(review.provenance.model).trim()) errors.push('privacy review must record the auditing model.');
  return errors;
}

function advisoryAffectsVersion(advisory, packageVersion) {
  const range = String(advisory?.affectedVersions || '').trim();
  if (range === '*') return SEMVER_PATTERN.test(String(packageVersion));
  if (SEMVER_PATTERN.test(range)) return compareSemver(packageVersion, range) === 0;
  const comparators = range.split(/\s+/u).filter(Boolean);
  if (!comparators.length) return false;
  return comparators.every((comparator) => {
    const match = comparator.match(/^(<=|>=|<|>)(.+)$/u);
    if (!match) return false;
    const comparison = compareSemver(packageVersion, match[2]);
    if (comparison === null) return false;
    return match[1] === '<' ? comparison < 0
      : match[1] === '<=' ? comparison <= 0
        : match[1] === '>' ? comparison > 0
          : comparison >= 0;
  });
}

const ADVISORY_SEVERITY_RANK = Object.freeze({ info: 0, low: 1, medium: 2, high: 3, critical: 4 });

function validateAdvisory(advisory) {
  const errors = [];
  if (!advisory || typeof advisory !== 'object' || Array.isArray(advisory)) return ['advisory must be an object.'];
  if (advisory.schemaVersion !== 1) errors.push('advisory.schemaVersion must be 1.');
  if (typeof advisory.id !== 'string' || !advisory.id.trim()) errors.push('advisory.id is required.');
  if (!PACKAGE_ID_PATTERN.test(String(advisory.packageId || ''))) errors.push('advisory.packageId is invalid.');
  if (!['info', 'low', 'medium', 'high', 'critical'].includes(advisory.severity)) errors.push('advisory.severity is invalid.');
  if (!['package-withdrawn', 'policy-change', 'privacy-review-invalidated', 'security'].includes(advisory.type)) errors.push('advisory.type is invalid.');
  const range = String(advisory.affectedVersions || '').trim();
  const supportedRange = range === '*' || SEMVER_PATTERN.test(range) || range.split(/\s+/u).every((part) => /^(?:<=|>=|<|>)\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(part));
  if (!supportedRange) errors.push('advisory.affectedVersions is unsupported.');
  if (typeof advisory.summary !== 'string' || !advisory.summary.trim()) errors.push('advisory.summary is required.');
  if (typeof advisory.remediation !== 'string' || !advisory.remediation.trim()) errors.push('advisory.remediation is required.');
  if (advisory.publishedAt === undefined || Number.isNaN(Date.parse(String(advisory.publishedAt)))) errors.push('advisory.publishedAt must be an ISO date-time.');
  if (advisory.evidenceUrl !== undefined) {
    let url = null;
    try { url = new URL(String(advisory.evidenceUrl)); } catch {}
    if (!url || url.protocol !== 'https:') errors.push('advisory.evidenceUrl must be an HTTPS URL.');
  }
  return errors;
}

// The official advisory feed is a small authored index fetched from the same
// trusted catalog source revision. Trust is derived from the source (see
// validateSourceIdentity); this only enforces structural validity and unique ids.
function validateAdvisoryIndex(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return ['advisory index must be an object.'];
  const errors = [];
  if (index.schemaVersion !== 1) errors.push('advisory index schemaVersion must be 1.');
  if (!Array.isArray(index.advisories)) return [...errors, 'advisory index advisories must be an array.'];
  const seen = new Set();
  index.advisories.forEach((advisory, position) => {
    for (const error of validateAdvisory(advisory)) errors.push(`advisories[${position}] ${error}`);
    const id = String(advisory?.id || '');
    if (id && seen.has(id)) errors.push(`advisories[${position}] duplicates advisory id ${id}.`);
    seen.add(id);
  });
  return errors;
}

// Applicable advisories for an installed/candidate version, most severe first.
// Advisories are current metadata about a version; they never mutate the
// installed package snapshot or its stored assessment.
function advisoriesForVersion(index, packageId, packageVersion) {
  const advisories = Array.isArray(index?.advisories) ? index.advisories : [];
  return advisories
    .filter((advisory) => advisory?.packageId === packageId && advisoryAffectsVersion(advisory, packageVersion))
    .sort((left, right) => (ADVISORY_SEVERITY_RANK[right.severity] || 0) - (ADVISORY_SEVERITY_RANK[left.severity] || 0)
      || String(right.publishedAt || '').localeCompare(String(left.publishedAt || '')));
}

module.exports = {
  ADVISORY_SEVERITY_RANK,
  AppPackageContractError,
  CATALOG_REFRESH_POLICY,
  DEFAULT_PACKAGE_LIMITS,
  advisoriesForVersion,
  advisoryAffectsVersion,
  canonicalPackagePath,
  compareSemver,
  collectPackageFiles,
  digestAppPackage,
  validateCatalog,
  validateAdvisory,
  validateAdvisoryIndex,
  validatePlatformCompatibility,
  validatePrivacyBinding,
  validateSourceIdentity,
};
