const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { APP_AGENT_CONTRACT_VERSION } = require('../../../../shared/app-agent-contract.cjs');
const {
  compareSemver,
  describeRequestedPermissions,
  diffRequestedPermissions,
  stableJson,
  validatePlatformCompatibility,
  validatePrivacyBinding,
} = require('./package-contracts.cjs');
const { declaredHostRequirements, unmetHostRequirements } = require('./host-requirements.cjs');

function equal(left, right) { return stableJson(left) === stableJson(right); }
function fields(manifest) { return new Map((manifest.setup?.fields || []).map((field) => [field.id, field])); }
function volumes(manifest) { return new Set(Object.values(manifest.resources?.services || {}).flatMap((service) => service.volumes || [])); }

function privacyFor(packageDir, manifest, packageDigest, source) {
  const unreviewed = { dimensions: null, posture: null, reviewedAt: null, status: 'review-required' };
  // Only a MOS-reviewed source may have its shipped review presented as a
  // review. Any other package can put whatever posture it likes in its own
  // `privacy-review.json`, so the file is not read for it at all, and the preview
  // says MOS does not assess this app rather than has not got round to it.
  if (source?.trust !== 'mos-reviewed') return { dimensions: null, posture: null, reviewedAt: null, status: 'not-assessed' };
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
    return { dimensions: null, errors: ['privacy review is not valid JSON.'], posture: null, reviewedAt: null, status: 'invalid' };
  }
  const errors = validatePrivacyBinding(review, { manifest, packageDigest, source });
  return errors.length
    ? { dimensions: null, errors, posture: null, reviewedAt: null, status: 'invalid' }
    : { dimensions: review.dimensions || null, posture: review.posture, reviewedAt: review.reviewedAt, status: 'reviewed' };
}

// Why the app agent cannot apply this update, in the owner's terms, or null when
// it can. Three different refusals wear the same shape on the card: an agent
// that cannot be reached; a package asking for a contract newer than this MOS
// ships, which is the manifest's own gate and stands until MOS is updated; and
// an agent that is not the one this MOS shipped with, which means its last
// update applied half of itself.
function describeAgentBlocker(reported, requiredByPackage) {
  if (reported === null) return 'MOS could not reach the part of itself that runs apps.';
  if (requiredByPackage > APP_AGENT_CONTRACT_VERSION) {
    return `This update needs app agent contract ${requiredByPackage} and this MOS ships ${APP_AGENT_CONTRACT_VERSION}. Update MOS first.`;
  }
  if (reported !== APP_AGENT_CONTRACT_VERSION) {
    return `The app agent on this server reports contract ${reported} and this MOS needs ${APP_AGENT_CONTRACT_VERSION}, so its last update did not fully apply.`;
  }
  return null;
}

// `requiresOneOf` is satisfied by any one of its types, so one installed provider
// clears the whole list.
function unmetRequirements(manifest, peers) {
  const required = manifest.usefulness?.requiresOneOf || [];
  if (!peers || !required.length) return [];
  const provided = new Set(peers.providedTypes || []);
  if (required.some((type) => provided.has(type))) return [];
  return required.map((type) => ({ providers: peers.providersByType?.[type] || [], type }));
}

function compareAppPackages({ candidate, installed, platformVersion, agentContractVersion = null, host = {}, peers = null }) {
  const changes = [];
  const breakingAreas = new Set();
  const installedFields = fields(installed.manifest);
  const candidateFields = fields(candidate.manifest);
  for (const [id, field] of installedFields) {
    const next = candidateFields.get(id);
    if (!next && field.required) { breakingAreas.add('setup'); changes.push({ area: 'setup', classification: 'operator-action-required', summary: `${field.label || id} is no longer asked for. The value you entered stays stored and the new version will not use it.` }); }
    else if (next && (field.secret !== next.secret || field.type !== next.type)) { breakingAreas.add('setup'); changes.push({ area: 'setup', classification: 'operator-action-required', summary: `Setup field ${id} changed storage or input type.` }); }
  }
  const requiredInput = [];
  for (const [id, field] of candidateFields) {
    if (!installedFields.has(id) && field.required && !field.generated) {
      requiredInput.push({ id, label: field.label, secret: field.secret === true, type: field.type, ...(field.secret !== true && field.default !== undefined ? { default: field.default } : {}) });
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
  // An update may start needing something this server is not, such as another
  // processor or HTTPS. Refusing here keeps that discovery in the preview
  // instead of in a build that cannot pull its images or an app that cannot work.
  const platformErrors = [
    ...validatePlatformCompatibility(candidate.manifest, platformVersion),
    ...unmetHostRequirements(declaredHostRequirements(candidate.manifest), host).map((unmet) => unmet.reason),
  ];
  const agentBlocker = describeAgentBlocker(agentContractVersion, candidate.manifest.update?.minimumAppAgentVersion || 1);
  const agentReady = agentBlocker === null;
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
  // A candidate needing a capability nothing provides still builds and goes healthy,
  // with nothing to talk to. Flags rather than blocks, and only if the update caused it.
  const requirements = unmetRequirements(candidate.manifest, peers);
  const introducesUnmetRequirement = requirements.length > 0 && unmetRequirements(installed.manifest, peers).length === 0;
  const unsupported = platformErrors.length || !agentReady || undeclaredBreaking.length;
  const ownerAction = requiredInput.length || introducesUnmetRequirement
    || changes.some((change) => ['migration-required', 'operator-action-required'].includes(change.classification));
  const compatibility = unsupported ? 'unsupported' : ownerAction ? 'owner-action-required' : 'compatible';
  const identity = `${installed.packageDigest}:${candidate.packageDigest}`;
  return {
    candidate: { appVersion: candidate.manifest.appVersion || null, packageDigest: candidate.packageDigest, packageVersion: candidate.manifest.version, privacy: candidatePrivacy, source: candidate.source },
    changes,
    compatibility,
    confirmationToken: crypto.createHash('sha256').update(identity).digest('hex'),
    installed: { appVersion: installed.manifest.appVersion || null, packageDigest: installed.packageDigest, packageVersion: installed.manifest.version, privacy: installedPrivacy },
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
    requirements,
    schemaVersion: 1,
    updateStatus,
    validation: {
      errors: [
        ...platformErrors,
        ...(agentBlocker ? [agentBlocker] : []),
        ...undeclaredBreaking.map((area) => `Undeclared breaking change: ${area}.`),
      ],
    },
  };
}

module.exports = { compareAppPackages };
