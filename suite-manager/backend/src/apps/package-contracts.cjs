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
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/u;
// The source kinds and trust levels a package identity can actually carry.
// `publisher-signed` is deliberately absent: MOS pins no publisher keys, so
// nothing can verify such a claim and the registry refuses it outright. A
// development-only `local` source kind exists in external-source-registry, but
// it never reaches here — a downloaded candidate's identity is always resolved
// as `external-git` (see external-source-client performDownload).
const SOURCE_KINDS = new Set(['external-git', 'official-git']);
const TRUST_LEVELS = new Set(['mos-reviewed', 'unverified']);
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
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
    let review;
    try {
      review = JSON.parse(text);
    } catch {
      // Classified rather than a raw SyntaxError: digesting is the first thing
      // every install/migration/backup path does to a package, so an unfenced
      // parse here turns one malformed review into an unclassified failure of
      // whatever operation touched the package first.
      throw new AppPackageContractError('Package privacy-review.json is not valid JSON.');
    }
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

// Verify a snapshot directory against the identity a caller claims for it:
// the manifest must declare the id `packageId` resolves to (the bare id for an
// official package, the suffix of `x-<namespace>-<id>` for an external one)
// and the on-disk bytes must hash to the expected digest. Every consumer of a
// snapshot must verify through here rather than comparing `manifest.id` to the
// package id by hand, because a hand-rolled comparison misses the namespacing
// rule and rejects every external package.
function verifySnapshotIdentity(packageDir, { errorMessage = 'PACKAGE_SNAPSHOT_MISMATCH', expectedDigest, packageId }) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'manifest.json'), 'utf8'));
  if (manifest.id !== parseNamespacedPackageId(packageId).packageId) throw new Error(errorMessage);
  if (digestAppPackage(packageDir, { manifest }) !== expectedDigest) throw new Error(errorMessage);
  return manifest;
}

function compareSemver(left, right) {
  const leftMatch = String(left).match(SEMVER_PATTERN);
  const rightMatch = String(right).match(SEMVER_PATTERN);
  if (!leftMatch || !rightMatch) return null;
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(leftMatch[index]) - Number(rightMatch[index]);
    if (difference) return Math.sign(difference);
  }
  const leftPrerelease = leftMatch[4];
  const rightPrerelease = rightMatch[4];
  if (leftPrerelease === undefined && rightPrerelease === undefined) return 0;
  if (leftPrerelease === undefined) return 1;
  if (rightPrerelease === undefined) return -1;
  const leftIdentifiers = leftPrerelease.split('.');
  const rightIdentifiers = rightPrerelease.split('.');
  for (let index = 0; index < Math.max(leftIdentifiers.length, rightIdentifiers.length); index += 1) {
    if (leftIdentifiers[index] === undefined) return -1;
    if (rightIdentifiers[index] === undefined) return 1;
    const leftNumeric = /^\d+$/u.test(leftIdentifiers[index]);
    const rightNumeric = /^\d+$/u.test(rightIdentifiers[index]);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftIdentifiers[index]) - Number(rightIdentifiers[index]);
      if (difference) return Math.sign(difference);
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftIdentifiers[index] !== rightIdentifiers[index]) {
      return leftIdentifiers[index] < rightIdentifiers[index] ? -1 : 1;
    }
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

// The mechanical posture derivation promised by apps/README.md: postures are
// derived from their dimensions, never selected by intuition, and an unknown
// fact is never turned into a favorable result.
//
// The permitted value of every dimension, which is also the vocabulary
// derivePrivacyPosture reasons over. Declared once so the derivation and the
// document validator below cannot disagree about what a dimension may say.
const PRIVACY_DIMENSION_VALUES = Object.freeze({
  accountDependency: ['local-only', 'optional-upstream-account', 'required-upstream-account', 'unknown'],
  confidence: ['verified', 'documented', 'inferred', 'unknown'],
  dataProcessing: ['local', 'optional-external', 'required-external', 'unknown'],
  externalServices: ['none-required', 'optional', 'required', 'unknown'],
  policyExposure: ['self-hosted-software-only', 'upstream-services-involved', 'unclear'],
  telemetry: ['none-observed', 'disabled-by-mos', 'optional', 'unavoidable', 'unknown'],
});
const PRIVACY_POSTURES = Object.freeze(['private-by-default', 'privacy-configured', 'external-dependency', 'review-required']);
const PRIVACY_DIMENSIONS = Object.freeze(Object.keys(PRIVACY_DIMENSION_VALUES));

function derivePrivacyPosture(dimensions) {
  const d = dimensions && typeof dimensions === 'object' && !Array.isArray(dimensions) ? dimensions : {};
  if (PRIVACY_DIMENSIONS.some((name) => d[name] === undefined || d[name] === 'unknown' || d[name] === 'unclear')) {
    return 'review-required';
  }
  if (d.telemetry === 'unavoidable' || d.externalServices === 'required'
    || d.accountDependency === 'required-upstream-account' || d.dataProcessing === 'required-external') {
    return 'external-dependency';
  }
  if (d.telemetry === 'none-observed' && d.externalServices === 'none-required'
    && d.accountDependency === 'local-only' && d.dataProcessing === 'local') {
    return 'private-by-default';
  }
  // Optional external touchpoints with no enabled telemetry. Telemetry that
  // exists but was not disabled ('optional') supports no favorable posture.
  if (d.telemetry === 'none-observed' || d.telemetry === 'disabled-by-mos') {
    return 'privacy-configured';
  }
  return 'review-required';
}

// Semantic validity of the assessment itself, independent of which package it
// binds to: the stated posture must be the one its dimensions derive, and a
// favorable posture must rest on at least one concrete piece of evidence.
function validatePrivacyAssessment(review) {
  if (!review || typeof review !== 'object' || Array.isArray(review)) return ['privacy review must be an object.'];
  const errors = [];
  const derived = derivePrivacyPosture(review.dimensions);
  if (review.posture !== derived) {
    errors.push(`privacy review posture must be derived from its dimensions: expected ${derived}, found ${String(review.posture)}.`);
  }
  if (review.posture !== 'review-required') {
    const evidence = Array.isArray(review.evidence) ? review.evidence : [];
    const concrete = evidence.filter((entry) => entry && typeof entry === 'object'
      && String(entry.claim || '').trim() && String(entry.source || '').trim());
    if (concrete.length === 0) errors.push('privacy review must cite at least one evidence entry with a claim and source for its posture.');
  }
  return errors;
}

// --- Privacy assessment document shape -----------------------------------
//
// The authored shape of a `privacy-review.json`, enforced when the repository's
// own reviews are checked (`npm run apps:privacy:check`). This is deliberately
// the only encoding of that shape. It previously lived in a committed JSON
// Schema file interpreted at check time by a hand-written partial evaluator,
// which silently passed every keyword the evaluator had not implemented — a
// validator that quietly declines to validate is worse than none, because it
// reports success. Plain code cannot skip a rule it does not recognise.
//
// Runtime install/update paths deliberately do NOT call this: they enforce
// binding (validatePrivacyBinding) and semantics (validatePrivacyAssessment)
// against packages that may predate any given authoring rule.

const ISO_DATE_TIME = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const NON_EMPTY_STRING = (value) => typeof value === 'string' && value.trim() !== '';

function checkRecord(value, pointer, { optional = {}, required = {}, sealed = true }) {
  const errors = [];
  if (!isPlainRecord(value)) return [`${pointer} must be an object.`];
  for (const [name, check] of Object.entries(required)) {
    if (value[name] === undefined) errors.push(`${pointer}.${name} is required.`);
    else errors.push(...check(value[name], `${pointer}.${name}`));
  }
  for (const [name, check] of Object.entries(optional)) {
    if (value[name] !== undefined) errors.push(...check(value[name], `${pointer}.${name}`));
  }
  if (sealed) {
    for (const name of Object.keys(value)) {
      if (!(name in required) && !(name in optional)) errors.push(`${pointer}.${name} is not a known property.`);
    }
  }
  return errors;
}

const isString = (value, pointer) => (typeof value === 'string' ? [] : [`${pointer} must be a string.`]);
const isBoolean = (value, pointer) => (typeof value === 'boolean' ? [] : [`${pointer} must be a boolean.`]);
const isDateTime = (value, pointer) => (ISO_DATE_TIME(value) ? [] : [`${pointer} must be an ISO date-time.`]);
const isOneOf = (values) => (value, pointer) => (values.includes(value) ? [] : [`${pointer} must be one of ${values.join(', ')}.`]);
const matches = (pattern, description) => (value, pointer) => (typeof value === 'string' && pattern.test(value) ? [] : [`${pointer} must be ${description}.`]);

function isListOf(check, { minItems = 0 } = {}) {
  return (value, pointer) => {
    if (!Array.isArray(value)) return [`${pointer} must be an array.`];
    const errors = value.flatMap((item, index) => check(item, `${pointer}[${index}]`));
    if (value.length < minItems) errors.push(`${pointer} must contain at least ${minItems} item(s).`);
    return errors;
  };
}

const isEvidence = (value, pointer) => checkRecord(value, pointer, {
  optional: { retrievedAt: isString, url: isString },
  required: {
    claim: isString,
    source: isString,
    type: isOneOf(['observed', 'configured', 'documented', 'inferred']),
  },
  sealed: false,
});

function validatePrivacyAssessmentDocument(review) {
  return checkRecord(review, 'review', {
    optional: {
      expiresAt: isDateTime,
      telemetryControls: isListOf(isEvidence),
    },
    required: {
      appId: matches(PACKAGE_ID_PATTERN, 'a valid package id'),
      dimensions: (value, pointer) => checkRecord(value, pointer, {
        required: Object.fromEntries(PRIVACY_DIMENSIONS.map((name) => [name, isOneOf(PRIVACY_DIMENSION_VALUES[name])])),
        sealed: false,
      }),
      evidence: isListOf(isEvidence),
      openQuestions: isListOf(isString),
      policies: isListOf((value, pointer) => checkRecord(value, pointer, {
        optional: { contentHash: isString, effectiveDate: isString, publisher: isString },
        required: { kind: isOneOf(['terms', 'privacy', 'license']), retrievedAt: isString, url: isString },
        sealed: false,
      })),
      posture: isOneOf(PRIVACY_POSTURES),
      provenance: (value, pointer) => checkRecord(value, pointer, {
        optional: { humanReviewer: isString },
        required: {
          humanReviewed: isBoolean,
          method: isOneOf(['ai-assisted', 'human']),
          model: isString,
          modelIdentifierSource: isOneOf(['runtime-reported', 'user-supplied', 'unknown']),
          provider: isString,
          repositoryCommit: isString,
          skill: isOneOf(['assess-app-privacy']),
          skillRevision: isString,
        },
        sealed: false,
      }),
      reviewedAt: isDateTime,
      schemaVersion: (value, pointer) => (value === 1 ? [] : [`${pointer} must be 1.`]),
      scope: (value, pointer) => checkRecord(value, pointer, {
        optional: { clientsExcluded: isListOf(isString) },
        required: {
          components: isListOf((component, componentPointer) => checkRecord(component, componentPointer, {
            optional: { digest: isString },
            required: { artifact: isString, name: isString, version: isString },
          }), { minItems: 1 }),
          packageDigest: matches(DIGEST_PATTERN, 'a SHA-256 digest'),
          packageVersion: isString,
          source: (source, sourcePointer) => checkRecord(source, sourcePointer, {
            required: {
              kind: isOneOf([...SOURCE_KINDS]),
              path: isString,
              repository: (repository, repositoryPointer) => {
                if (!NON_EMPTY_STRING(repository)) return [`${repositoryPointer} must be a string.`];
                try { new URL(repository); return []; } catch { return [`${repositoryPointer} must be a URI.`]; }
              },
              revision: isString,
              trust: isOneOf([...TRUST_LEVELS]),
            },
          }),
        },
      }),
    },
  });
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

// This denylist is defense in depth around the actual execution boundary:
// renderDryRunProjections only projects explicitly supported manifest fields
// into the agent request. Any new projection field must be reviewed here too,
// or an external package could gain a capability this list never considered.
function validateConstrainedCapabilities(manifest, { trust } = {}) {
  const errors = [];
  if (!isConstrainedTrust(trust)) return errors;
  if (!isPlainRecord(manifest)) return ['manifest must be an object.'];
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (manifest[key] !== undefined) errors.push(`manifest.${key} is not permitted for a non-official package.`);
  }
  // An external route host is served under the reserved `ext-` prefix, so it has
  // fewer characters to spend than the DNS label limit suggests. Rejected here,
  // where the package is still a candidate, rather than at apply time when the
  // name has already been promised to the owner.
  for (const route of Array.isArray(manifest.routes) ? manifest.routes : []) {
    const host = String(route?.host || '');
    if (host.length > EXTERNAL_ROUTE_HOST_MAX_LENGTH) {
      errors.push(`routes.host must be at most ${EXTERNAL_ROUTE_HOST_MAX_LENGTH} characters for a non-official package, because it is served as ${EXTERNAL_ROUTE_HOST_PREFIX}${host}.`);
    }
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

// --- The app host namespace ----------------------------------------------
//
// An app's public web address is its route host, not its package id: the id is
// an internal identity that is namespaced for external packages, while the
// route host is what Caddy actually serves and what assertRouteHostsAvailable
// reserves installation-wide. Deriving a host from a package id produces a name
// the app agent refuses, because the agent rebuilds every site from the route
// host and checks appHost agrees with it.
//
// External route hosts live under a reserved prefix. MOS cannot know the names
// of its own future apps, so it cannot maintain a denylist of them; instead it
// promises never to ship an official app under `ext-`, which is enforced
// mechanically by `npm run apps:catalog:check`. That inverts the problem: an
// external package cannot name a host MOS might later want, including `home`.
//
// The prefix does not make two external apps unique to each other. Two packages
// both claiming `notes` still contend for `ext-notes`, and the second install
// fails with APP_ROUTE_HOST_TAKEN, which is the documented meaning of a route
// host being global to the installation.
const EXTERNAL_ROUTE_HOST_PREFIX = 'ext-';
const DNS_LABEL_MAX_LENGTH = 63;
const EXTERNAL_ROUTE_HOST_MAX_LENGTH = DNS_LABEL_MAX_LENGTH - EXTERNAL_ROUTE_HOST_PREFIX.length;

// External-ness is read back off the namespaced package id rather than taken as
// a separate argument. namespacedPackageId returns a bare id only for a
// MOS-reviewed official source, so the namespace marker and "is external" are
// the same fact, and a caller cannot forget to pass it or pass it wrongly —
// which for a host prefix would mean silently renaming every official app.
function isExternalPackageId(packageId) {
  return parseNamespacedPackageId(packageId).namespaced;
}

// The host an app actually answers on, given the id MOS installed it under.
function effectiveRouteHost(host, packageId) {
  return isExternalPackageId(packageId) ? `${EXTERNAL_ROUTE_HOST_PREFIX}${host}` : String(host);
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
// `external` names the host namespace the package will be placed in, so the
// address an owner is asked to consent to is the one that will actually be
// served. It is a property of the source, so both sides of an update comparison
// must pass the same value: a route that only appears to change because one side
// was namespaced and the other was not would read as an app widening its access.
function describeRequestedPermissions(manifest, { external = false } = {}) {
  const permissions = new Set();
  for (const route of Array.isArray(manifest?.routes) ? manifest.routes : []) {
    if (route?.host) permissions.add(`route:${external ? `${EXTERNAL_ROUTE_HOST_PREFIX}${route.host}` : route.host}`);
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
  EXTERNAL_ROUTE_HOST_MAX_LENGTH,
  EXTERNAL_ROUTE_HOST_PREFIX,
  SUPPORTED_ARCHITECTURES,
  advisoriesForVersion,
  advisoryAffectsVersion,
  canonicalPackagePath,
  compareSemver,
  collectPackageFiles,
  derivePrivacyPosture,
  describeRequestedPermissions,
  diffRequestedPermissions,
  digestAppPackage,
  effectiveRouteHost,
  isExternalPackageId,
  namespacedPackageId,
  parseNamespacedPackageId,
  stableJson,
  validateAdvisory,
  validateAdvisoryIndex,
  validateArchitectureCompatibility,
  validateCatalog,
  validateConstrainedCapabilities,
  validateExternalIdentity,
  validatePlatformCompatibility,
  validatePrivacyAssessment,
  validatePrivacyAssessmentDocument,
  validatePrivacyBinding,
  validateSourceIdentity,
  verifySnapshotIdentity,
};
