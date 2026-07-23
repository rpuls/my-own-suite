const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  compareSemver,
  describeRequestedPermissions,
  diffRequestedPermissions,
  stableJson,
  validateArchitectureCompatibility,
  validatePlatformCompatibility,
  validatePrivacyBinding,
} = require('./package-contracts.cjs');

function equal(left, right) { return stableJson(left) === stableJson(right); }
function fields(manifest) { return new Map((manifest.setup?.fields || []).map((field) => [field.id, field])); }
function volumes(manifest) { return new Set(Object.values(manifest.resources?.services || {}).flatMap((service) => service.volumes || [])); }

function privacyFor(packageDir, manifest, packageDigest, source) {
  const unreviewed = { dimensions: null, posture: 'review-required', reviewedAt: null, status: 'review-required' };
  // Only a MOS-reviewed source may have its shipped review presented as a
  // review. Any other package can put whatever posture it likes in its own
  // `privacy-review.json`, so the file is not read for it at all.
  if (source?.trust !== 'mos-reviewed') return unreviewed;
  const reviewPath = path.join(packageDir, 'privacy-review.json');
  if (!fs.existsSync(reviewPath)) return unreviewed;
  // A comparison is a read-only preview of an update, so an unreadable review
  // degrades to the same `invalid` result a review that fails its binding
  // produces. Parsing raw here would instead abort the whole preview with an
  // unclassified error, and this is the first thing that reads either package's
  // review — so nothing downstream would ever get to classify it.
  let review;
  try {
    review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  } catch {
    return { dimensions: null, errors: ['privacy review is not valid JSON.'], posture: 'review-required', reviewedAt: null, status: 'invalid' };
  }
  const errors = validatePrivacyBinding(review, { manifest, packageDigest, source });
  return errors.length
    ? { dimensions: null, errors, posture: 'review-required', reviewedAt: null, status: 'invalid' }
    : { dimensions: review.dimensions || null, posture: review.posture, reviewedAt: review.reviewedAt, status: 'reviewed' };
}

function compareAppPackages({ candidate, installed, platformVersion, agentCapabilities = [], agentContractVersion = 0, hostArchitecture = null }) {
  const changes = [];
  const breakingAreas = new Set();
  const installedFields = fields(installed.manifest);
  const candidateFields = fields(candidate.manifest);
  for (const [id, field] of installedFields) {
    const next = candidateFields.get(id);
    if (!next && field.required) { breakingAreas.add('setup'); changes.push({ area: 'setup', classification: 'operator-action-required', summary: `Required setup field ${id} was removed.` }); }
    else if (next && (field.secret !== next.secret || field.type !== next.type)) { breakingAreas.add('setup'); changes.push({ area: 'setup', classification: 'operator-action-required', summary: `Setup field ${id} changed storage or input type.` }); }
  }
  const requiredInput = [];
  for (const [id, field] of candidateFields) {
    if (!installedFields.has(id) && field.required && !field.generated) {
      requiredInput.push({ id, label: field.label, secret: field.secret === true, type: field.type });
      changes.push({ area: 'setup', classification: 'operator-action-required', summary: `New required setup value: ${field.label || id}.` });
    }
  }
  for (const volume of volumes(installed.manifest)) {
    if (!volumes(candidate.manifest).has(volume)) { breakingAreas.add('volumes'); changes.push({ area: 'volumes', classification: 'migration-required', summary: `Persistent volume ${volume} is no longer declared.` }); }
  }
  for (const area of ['resources', 'routes', 'health', 'exports', 'integrations', 'usefulness']) {
    if (!equal(installed.manifest[area], candidate.manifest[area]) && !changes.some((change) => change.area === area)) {
      changes.push({ area, classification: 'automatically-handled', summary: `${area[0].toUpperCase()}${area.slice(1)} declarations changed.` });
    }
  }
  const declaredBreaking = new Set(candidate.manifest.update?.breakingChanges || []);
  const undeclaredBreaking = [...breakingAreas].filter((area) => !declaredBreaking.has(area));
  if (undeclaredBreaking.length) changes.push({ area: 'manifest', classification: 'unsupported', summary: `Breaking changes are not declared for: ${undeclaredBreaking.join(', ')}.` });
  // An update may narrow the architectures it runs on, and the host it is
  // running on is not one the owner can change. Refusing here keeps that
  // discovery in the preview instead of in a build that cannot pull its images.
  const platformErrors = [
    ...validatePlatformCompatibility(candidate.manifest, platformVersion),
    ...validateArchitectureCompatibility(candidate.manifest, hostArchitecture),
  ];
  const requiredAgentVersion = candidate.manifest.update?.minimumAppAgentVersion || 1;
  const agentReady = agentCapabilities.includes('apps.package.snapshot') && agentContractVersion >= requiredAgentVersion;
  // What the package asks MOS for: web addresses, named storage, integration
  // slots, capability provision. An update that widens that surface is never
  // routine. A MOS-reviewed candidate had the increase reviewed, so it is only
  // reported; anything else needs the owner to consent to the wider access.
  // An update never moves a package between sources, so one namespace applies to
  // both sides. Computed once so the diff can only report a real change.
  const externalHosts = candidate.source?.trust !== 'mos-reviewed';
  const installedPermissions = describeRequestedPermissions(installed.manifest, { external: externalHosts });
  const candidatePermissions = describeRequestedPermissions(candidate.manifest, { external: externalHosts });
  const addedPermissions = diffRequestedPermissions(installedPermissions, candidatePermissions);
  const removedPermissions = diffRequestedPermissions(candidatePermissions, installedPermissions);
  if (addedPermissions.length) {
    changes.push({
      area: 'permissions',
      classification: candidate.source?.trust === 'mos-reviewed' ? 'automatically-handled' : 'operator-action-required',
      summary: `The update asks for access the installed version does not have: ${addedPermissions.join(', ')}.`,
    });
  }
  // Version decides whether there is an update, and nothing else does. A
  // candidate that declares the installed version number is not an update
  // regardless of its contents, so it is reported as current and never applied —
  // the outcome the old integrity-error status already produced, without calling
  // the ordinary case a fault. Candidate bytes are verified against the signed
  // catalog digest when they are downloaded, which is where an actual content
  // substitution is caught.
  const versionOrder = compareSemver(candidate.manifest.version, installed.manifest.version);
  const updateStatus = versionOrder > 0 ? 'update-available'
    : versionOrder < 0 ? 'installed-newer'
      : 'current';
  const installedPrivacy = privacyFor(installed.packageDir, installed.manifest, installed.packageDigest, installed.source);
  const candidatePrivacy = privacyFor(candidate.packageDir, candidate.manifest, candidate.packageDigest, candidate.source);
  if (!equal(installedPrivacy, candidatePrivacy)) changes.push({ area: 'privacy', classification: candidatePrivacy.status === 'reviewed' ? 'automatically-handled' : 'operator-action-required', summary: installedPrivacy.posture === candidatePrivacy.posture ? 'The privacy assessment changes without changing the overall posture.' : `Privacy posture changes from ${installedPrivacy.posture} to ${candidatePrivacy.posture}.` });
  const unsupported = platformErrors.length || !agentReady || undeclaredBreaking.length;
  const ownerAction = requiredInput.length || changes.some((change) => ['migration-required', 'operator-action-required'].includes(change.classification));
  const compatibility = unsupported ? 'unsupported' : ownerAction ? 'owner-action-required' : 'compatible';
  const identity = `${installed.packageDigest}:${candidate.packageDigest}`;
  return {
    candidate: { packageDigest: candidate.packageDigest, packageVersion: candidate.manifest.version, privacy: candidatePrivacy, source: candidate.source },
    changes,
    compatibility,
    confirmationToken: crypto.createHash('sha256').update(identity).digest('hex'),
    installed: { packageDigest: installed.packageDigest, packageVersion: installed.manifest.version, privacy: installedPrivacy },
    metadata: {
      backupRequired: candidate.manifest.update?.backupRequired === true,
      downtime: candidate.manifest.update?.downtime || 'brief',
      migrations: candidate.manifest.update?.migrations || [],
      ownerActions: candidate.manifest.update?.ownerActions || [],
      rollback: candidate.manifest.update?.rollback || 'not-guaranteed',
    },
    packageId: candidate.manifest.id,
    permissions: { added: addedPermissions, candidate: candidatePermissions, installed: installedPermissions, removed: removedPermissions },
    requiredInput,
    schemaVersion: 1,
    updateStatus,
    validation: {
      agentCapability: agentReady ? 'compatible' : 'unsupported',
      errors: [
        ...platformErrors,
        ...(agentReady ? [] : [`App agent contract ${requiredAgentVersion} is required.`]),
        ...undeclaredBreaking.map((area) => `Undeclared breaking change: ${area}.`),
      ],
    },
  };
}

module.exports = { compareAppPackages };
