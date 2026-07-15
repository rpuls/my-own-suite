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
// The architectures MOS runs on. A package names the ones its pinned base images
// actually publish, which is knowable only to whoever pinned them.
const SUPPORTED_ARCHITECTURES = Object.freeze(['amd64', 'arm64']);
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

// A package's base images are pinned by digest, and a digest resolves to one
// architecture's image or to none at all. Nothing here can inspect a registry to
// find out which, so `architectures` is the publisher's declaration of what they
// pinned, checked against the host before MOS builds rather than after docker
// fails on it. It is a compatibility check, not a trust control: a package that
// cannot run here cannot harm the host either, and a wrong declaration only
// produces the same build failure it would have produced anyway.
//
// Both unknowns mean "no constraint", because neither is evidence of a mismatch:
// a package that declares nothing is every package written before this field
// existed, and a host MOS cannot identify would otherwise have every package
// blocked on it.
function validateArchitectureCompatibility(manifest, hostArchitecture) {
  const declared = manifest?.architectures;
  if (declared === undefined) return [];
  if (!Array.isArray(declared) || declared.length === 0 || declared.some((architecture) => !SUPPORTED_ARCHITECTURES.includes(architecture))) {
    return [`Package architectures must be a non-empty list of ${SUPPORTED_ARCHITECTURES.join(', ')}.`];
  }
  if (!SUPPORTED_ARCHITECTURES.includes(hostArchitecture)) return [];
  return declared.includes(hostArchitecture)
    ? []
    : [`Package runs on ${declared.join(', ')}; this host is ${hostArchitecture}.`];
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

// --- External package sources: constrained capability profile -------------
//
// Non-official packages (external-git / not mos-reviewed) run under a strict
// capability profile. They may only expose declared routes and named volumes;
// they must not reach for host networking, privileged containers, the Docker
// socket, host paths/devices, raw proxy config, or host-agent/systemd install.
// Enforcement here is structural and fails closed on any unknown escalation
// field so a manifest cannot smuggle capabilities past MOS projection.

const VOLUME_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,61}$/u;
const FORBIDDEN_MANIFEST_KEYS = Object.freeze([
  'caddy', 'caddyfile', 'capAdd', 'capabilities', 'compose', 'devices', 'dockerSocket',
  'hostAgent', 'hooks', 'network', 'networkMode', 'privileged', 'rootScript', 'scripts',
  'securityOpt', 'systemd',
]);
const FORBIDDEN_SERVICE_KEYS = Object.freeze([
  'capAdd', 'capabilities', 'cgroupParent', 'devices', 'deviceCgroupRules', 'deviceRequests',
  'dns', 'dockerSocket', 'extraHosts', 'groupAdd', 'ipc', 'mounts', 'network', 'networkMode',
  'pid', 'ports', 'privileged', 'securityOpt', 'sysctls', 'userns', 'uts',
]);
const CONSTRAINED_CAPABILITY_PROFILE = Object.freeze({
  forbiddenManifestKeys: FORBIDDEN_MANIFEST_KEYS,
  forbiddenServiceKeys: FORBIDDEN_SERVICE_KEYS,
  volumeNamePattern: VOLUME_NAME_PATTERN.source,
});
const RESERVED_ID_PREFIXES = Object.freeze(['mos', 'official', 'suite']);

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A package is unconstrained only when it is MOS-reviewed, which
// validateSourceIdentity permits solely from the configured official source.
function isConstrainedTrust(trust) {
  return trust !== 'mos-reviewed';
}

function volumeSource(spec) {
  return String(spec).split(':')[0];
}

function volumeTarget(spec) {
  return String(spec).split(':')[1] || '';
}

function validateConstrainedCapabilities(manifest, { trust } = {}) {
  const errors = [];
  if (!isConstrainedTrust(trust)) return errors;
  if (!isPlainRecord(manifest)) return ['manifest must be an object.'];
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (manifest[key] !== undefined) errors.push(`manifest.${key} is not permitted for a non-official package.`);
  }
  const services = isPlainRecord(manifest.resources?.services) ? manifest.resources.services : {};
  for (const [serviceId, service] of Object.entries(services)) {
    const prefix = `resources.services.${serviceId}`;
    if (!isPlainRecord(service)) continue;
    for (const key of FORBIDDEN_SERVICE_KEYS) {
      if (service[key] !== undefined) errors.push(`${prefix}.${key} is not permitted for a non-official package.`);
    }
    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    for (const spec of volumes) {
      const source = volumeSource(spec);
      const target = volumeTarget(spec);
      if (!VOLUME_NAME_PATTERN.test(source)) {
        errors.push(`${prefix}.volumes must use named volumes only; host path or bind mounts are not permitted (${spec}).`);
      }
      if (target === '/var/run/docker.sock' || target === '/run/docker.sock' || target.startsWith('/dev/')) {
        errors.push(`${prefix}.volumes must not mount host devices or the Docker socket (${spec}).`);
      }
    }
  }
  return [...new Set(errors)];
}

// Stable, collision-safe instance identity. Official packages keep their bare
// id; every other source is namespaced by a short digest of its repository and
// path so two sources can ship the same package id without colliding.
function sourceNamespace(source) {
  const repository = String(source?.repository || '').trim().toLowerCase().replace(/\.git$/u, '').replace(/\/+$/u, '');
  const packagePath = String(source?.path || '').trim().toLowerCase();
  return crypto.createHash('sha256').update(`${repository}\n${packagePath}`).digest('hex').slice(0, 8);
}

function namespacedPackageId(source, packageId) {
  if (!PACKAGE_ID_PATTERN.test(String(packageId || ''))) return null;
  if (source?.kind === 'official-git' && source?.trust === 'mos-reviewed') return packageId;
  const namespaced = `x-${sourceNamespace(source)}-${packageId}`;
  return namespaced.length <= 63 ? namespaced : null;
}

function parseNamespacedPackageId(id) {
  const match = String(id || '').match(/^x-([a-f0-9]{8})-([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u);
  if (!match) return { namespace: null, namespaced: false, packageId: String(id || '') };
  return { namespace: match[1], namespaced: true, packageId: match[2] };
}

// Prevent an external package from impersonating an official one: it may not
// reuse an official package id, sit under a reserved id prefix, or self-assert
// review/verification the platform has not granted.
function validateExternalIdentity(manifest, source, { officialPackageIds = [] } = {}) {
  const errors = [];
  if (!isPlainRecord(manifest)) return ['manifest must be an object.'];
  if (source?.kind === 'official-git' && source?.trust === 'mos-reviewed') return errors;
  const id = String(manifest.id || '');
  if (officialPackageIds.includes(id)) errors.push('external package id collides with an official package id.');
  if (RESERVED_ID_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}-`))) {
    errors.push('external package id uses a reserved official prefix.');
  }
  for (const claim of ['certified', 'mosReviewed', 'official', 'trust', 'verified']) {
    if (manifest[claim] !== undefined) errors.push(`external package must not self-assert ${claim}.`);
  }
  if (source?.trust === 'mos-reviewed') errors.push('external package cannot claim mos-reviewed trust.');
  return [...new Set(errors)];
}

// The security-relevant permission surface a package requests, as stable keys.
// Used to show owners what they are granting before install and to detect
// permission increases before an update.
function describeRequestedPermissions(manifest) {
  const permissions = new Set();
  for (const route of Array.isArray(manifest?.routes) ? manifest.routes : []) {
    if (route?.host) permissions.add(`route:${route.host}`);
  }
  const services = isPlainRecord(manifest?.resources?.services) ? manifest.resources.services : {};
  for (const service of Object.values(services)) {
    for (const spec of Array.isArray(service?.volumes) ? service.volumes : []) {
      permissions.add(`volume:${volumeSource(spec)}`);
    }
  }
  if (isPlainRecord(manifest?.integrations)) {
    for (const key of Object.keys(manifest.integrations)) permissions.add(`integration:${key}`);
  }
  if (manifest?.role === 'capability-provider') permissions.add('provides-capability');
  return [...permissions].sort((left, right) => left.localeCompare(right, 'en'));
}

// Permissions present in the candidate but not the installed package. An update
// that increases the requested surface must be surfaced for explicit consent.
function diffRequestedPermissions(installedPermissions, candidatePermissions) {
  const installed = new Set(Array.isArray(installedPermissions) ? installedPermissions : []);
  return (Array.isArray(candidatePermissions) ? candidatePermissions : [])
    .filter((permission) => !installed.has(permission))
    .sort((left, right) => left.localeCompare(right, 'en'));
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
  CONSTRAINED_CAPABILITY_PROFILE,
  DEFAULT_PACKAGE_LIMITS,
  SUPPORTED_ARCHITECTURES,
  advisoriesForVersion,
  advisoryAffectsVersion,
  canonicalPackagePath,
  compareSemver,
  collectPackageFiles,
  describeRequestedPermissions,
  diffRequestedPermissions,
  digestAppPackage,
  namespacedPackageId,
  parseNamespacedPackageId,
  validateAdvisory,
  validateAdvisoryIndex,
  validateArchitectureCompatibility,
  validateCatalog,
  validateConstrainedCapabilities,
  validateExternalIdentity,
  validatePlatformCompatibility,
  validatePrivacyBinding,
  validateSourceIdentity,
};
