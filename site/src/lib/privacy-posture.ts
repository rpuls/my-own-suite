// Privacy posture presentation model (app privacy score, Phase 6).
//
// SIBLING FILE — this module intentionally exists twice, byte for byte,
// because Suite Manager (React) and the public site (Astro) do not share a
// component library yet:
//   suite-manager/frontend/src/features/apps/privacy-posture.ts
//   site/src/lib/privacy-posture.ts
// If you change one copy, apply the exact same change to the other. If a
// shared UI library is ever extracted, this module moves there first.
// The visual components built on top of it are siblings too:
//   suite-manager/frontend/src/features/apps/PrivacyPosture.tsx
//   site/src/components/PrivacyPosture.astro
//
// Everything here derives presentation from a package's privacy-review.json,
// whose contract lives in suite-manager/backend/src/apps/package-contracts.cjs
// (PRIVACY_DIMENSION_VALUES, PRIVACY_POSTURES, derivePrivacyPosture). The
// posture strings below must stay in step with that module. The five levels
// (0-2 each) sum to a 0-10 score, which maps to the A-to-D privacy grade shown
// on the shield (A 9-10, B 7-8, C 4-6, D 0-3). Postures, phrases, and verdicts
// are generic schema-level rules — no app-specific logic belongs in this file.

export type PrivacyPostureId = 'private-by-default' | 'privacy-configured' | 'owner-disableable' | 'external-dependency';

export type PrivacyDimensionKey = 'defaultEgress' | 'control' | 'accountDependency' | 'dataProcessing' | 'policyExposure';

export type PrivacyProvenance = {
  humanReviewed: boolean;
  method: string | null;
  model: string | null;
  sourceRevision: string | null;
};

export type PrivacyReviewSummary = {
  dimensions: Record<string, string> | null;
  posture: string | null;
  provenance?: PrivacyProvenance | null;
  reviewedAt: string | null;
  status: string;
};

export type PrivacyAdvisorySeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type PrivacyAdvisoryType = 'security' | 'privacy-review-invalidated' | 'policy-change' | 'package-withdrawn';

export type PrivacyAdvisory = {
  affectedVersions: string;
  evidenceUrl?: string;
  id: string;
  packageId: string;
  publishedAt: string;
  remediation: string;
  severity: PrivacyAdvisorySeverity;
  summary: string;
  type: PrivacyAdvisoryType;
};

export type PrivacyVerdict = { border: string; color: string; soft: string; word: string };

export type PrivacyDimensionRow = {
  iconPath: string;
  key: PrivacyDimensionKey;
  label: string;
  phrase: string;
  verdict: PrivacyVerdict;
};

export const ASSESSMENT_DOCS_URL = 'https://myownsuite.org/docs/privacy/how-we-assess/';

// Where the same page explains why an app from an added source never gets a
// grade. A surface showing NOT_ASSESSED links here instead, because sending
// somebody to "how MOS assesses app privacy" to read about an app MOS does not
// assess is the wrong door.
export const EXTERNAL_DOCS_URL = 'https://myownsuite.org/docs/privacy/how-we-assess/#apps-from-sources-you-add';

export const SHIELD_PATH = 'M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5l8-3z';

// Small stroke-style glyphs (24x24 grid) used by the privacy components.
export const GLYPHS = {
  arrowRight: 'M4 12h16M14 6l6 6-6 6',
  check: 'M5 13l4 4 10-10',
  chevronRight: 'M9 6l6 6-6 6',
  externalLink: 'M7 17L17 7M9 7h8v8',
};

export const POSTURES: Record<PrivacyPostureId, { border: string; color: string; label: string; sentence: string; soft: string }> = {
  'private-by-default': {
    border: 'var(--mos-color-accent-border)',
    color: 'var(--mos-color-accent)',
    label: 'Private by default',
    sentence: 'Runs entirely on your machine. Nothing leaves your server unless you share it.',
    soft: 'var(--mos-color-accent-soft)',
  },
  'privacy-configured': {
    border: 'var(--mos-color-info-border)',
    color: 'var(--mos-color-info)',
    label: 'Privacy configured',
    sentence: 'Talks to outside services out of the box — MOS turned those parts off for you.',
    soft: 'var(--mos-color-info-soft)',
  },
  'owner-disableable': {
    border: 'var(--mos-color-warning-border)',
    color: 'var(--mos-color-warning)',
    label: 'Your choice',
    sentence: 'Something leaves your server in normal use, and the app has a setting that stops it. MOS left the choice to you because it is a real trade-off. The full assessment says what leaves, who receives it, and where the switch is.',
    soft: 'var(--mos-color-warning-soft)',
  },
  'external-dependency': {
    border: 'var(--mos-color-warning-border)',
    color: 'var(--mos-color-warning)',
    label: 'External dependency',
    sentence: 'Something leaves your server in normal use and there is no in-app setting that stops it. MOS reviewed that and accepted it as the price of the feature. The full assessment says exactly what leaves, who receives it, and why.',
    soft: 'var(--mos-color-warning-soft)',
  },
};

// Not a posture. The absence of a review is a process state, tracked as
// `privacy.status`, and it is deliberately unavailable to the derivation: no
// combination of facts about an app can conclude "unreviewed".
export const UNREVIEWED = {
  border: 'var(--mos-color-danger-border)',
  color: 'var(--mos-color-danger)',
  label: 'Not yet reviewed',
  sentence: 'MOS has not reviewed this app. Treat it as unverified.',
  soft: 'var(--mos-color-danger-soft)',
};

// Not a posture either, and not the same absence as UNREVIEWED. An app from a
// source the owner added sits outside what MOS assesses, permanently rather
// than pending: MOS assesses the packages it publishes, and a
// `privacy-review.json` shipped by somebody else's repository is that
// publisher's word about themselves. Printing it here in MOS's colours would
// make their claim read as MOS's, so it is never carried forward and no grade
// is ever derived from it.
//
// Everything about this state has to say permanent rather than pending. No
// "yet", no "not rated", no queue implied anywhere it appears; grey rather
// than danger red, because this is absence of scope and not a failing verdict;
// and a shield drawn with a broken outline, because the slot is not waiting to
// be filled. See shieldDashArray and tileLabelFor.
export const NOT_ASSESSED = {
  border: 'var(--mos-color-surface-border)',
  color: 'var(--mos-color-text-muted)',
  label: 'Not assessed by MOS',
  sentence: 'MOS assesses the apps it publishes. This one comes from a source you added, so whether to trust it is your call.',
  soft: 'var(--mos-color-surface-strong)',
};

// The first two rows are the ones the posture derives from, and they lead for
// that reason: what happens, then who settled it.
export const DIMENSIONS: Array<{ iconPath: string; key: PrivacyDimensionKey; label: string }> = [
  { iconPath: 'M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3', key: 'defaultEgress', label: 'Out of the box' },
  { iconPath: 'M7 8h10a4 4 0 010 8H7a4 4 0 010-8zM7.5 12a1.5 1.5 0 103 0 1.5 1.5 0 00-3 0z', key: 'control', label: 'Who decides' },
  { iconPath: 'M21 2l-9.6 9.6M15.5 7.5l3 3M11.4 11.6a4.8 4.8 0 10-6.8 6.8 4.8 4.8 0 006.8-6.8z', key: 'accountDependency', label: 'Accounts' },
  { iconPath: 'M22 12H2M5.5 5h13l3.5 7v5a2 2 0 01-2 2H4a2 2 0 01-2-2v-5l3.5-7zM6 16h.01M10 16h.01', key: 'dataProcessing', label: 'Data processing' },
  { iconPath: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M16 13H8M16 17H8', key: 'policyExposure', label: 'Policies' },
];

// What MOS builds around every app package whoever wrote it. These replace the
// five dimension rows on a surface showing NOT_ASSESSED: the dimensions are
// MOS's questions about an app, and rendering them all "unknown" both promises
// an answer that is not coming and leaves the owner with nothing. These are the
// facts that survive the absence of an assessment — not findings about the app,
// but the shape of the box it runs in, which MOS enforces either way.
//
// Each one has to stay true of every package MOS can install, so nothing
// app-specific or source-specific belongs here. They restate the limits the
// Apps screen already promises an external package in prose.
export const ENCLOSURE_FACTS: Array<{ detail: string; iconPath: string; label: string }> = [
  {
    detail: 'Named volumes MOS creates for it. Not your host folders, not another app’s data, not your backups.',
    iconPath: 'M4 6.5h16v4H4zM4 13.5h16v4H4zM7.5 8.5h.01M7.5 15.5h.01',
    label: 'Its own storage only',
  },
  {
    detail: 'Only the web addresses its package asked for, which you saw before installing it. It cannot answer on any other address on your suite.',
    iconPath: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3.5 12h17M12 3c2.6 2.9 2.6 15.1 0 18M12 3c-2.6 2.9-2.6 15.1 0 18',
    label: 'Its own addresses only',
  },
  {
    detail: 'No Docker socket, no host network, no elevated container. It cannot reach the machine MOS runs on.',
    iconPath: 'M5.5 10.5h13v9.5h-13zM9 10.5V7a3 3 0 016 0v3.5M12 14.5v2.5',
    label: 'No privileged access',
  },
];

// The limit of the box above, said in the same breath rather than left for the
// owner to discover. Every other risk an unassessed app carries is bounded by
// ENCLOSURE_FACTS; this one is not bounded by anything, which is why it is the
// thing to decide on.
export const ENCLOSURE_GAP = 'Installing or updating it builds its Dockerfiles on your server, which runs commands its publisher wrote — with network access — before any of those limits apply. That step is what you are trusting the repository for.';

const PHRASES: Record<PrivacyDimensionKey, Record<string, { level: 0 | 1 | 2; phrase: string }>> = {
  defaultEgress: {
    'external-contact': { level: 1, phrase: 'Some contact in normal use' },
    none: { level: 2, phrase: 'Nothing leaves your server' },
  },
  control: {
    'accepted-by-mos': { level: 0, phrase: 'Kept on, reviewed by MOS' },
    'disabled-by-mos': { level: 1, phrase: 'Turned off by MOS' },
    'left-to-owner': { level: 1, phrase: 'Yours to switch off' },
    'nothing-to-decide': { level: 2, phrase: 'Nothing to decide' },
  },
  accountDependency: {
    'local-only': { level: 2, phrase: 'Your local account only' },
    'optional-upstream-account': { level: 1, phrase: 'Optional outside account' },
    'required-upstream-account': { level: 0, phrase: 'Outside account required' },
  },
  dataProcessing: {
    local: { level: 2, phrase: 'Stays on your machine' },
    'optional-external': { level: 1, phrase: 'Optional outside processing' },
    'required-external': { level: 0, phrase: 'Processed outside' },
  },
  policyExposure: {
    'self-hosted-software-only': { level: 2, phrase: 'Only the software license' },
    'upstream-services-involved': { level: 1, phrase: 'Outside terms apply' },
  },
};

const VERDICTS: Record<0 | 1 | 2, PrivacyVerdict> = {
  0: { border: 'var(--mos-color-danger-border)', color: 'var(--mos-color-danger)', soft: 'var(--mos-color-danger-soft)', word: 'Outside' },
  1: { border: 'var(--mos-color-warning-border)', color: 'var(--mos-color-warning)', soft: 'var(--mos-color-warning-soft)', word: 'Limited' },
  2: { border: 'var(--mos-color-accent-border)', color: 'var(--mos-color-accent)', soft: 'var(--mos-color-accent-soft)', word: 'Private' },
};

const UNKNOWN_VERDICT: PrivacyVerdict = { border: 'var(--mos-color-surface-border)', color: 'var(--mos-color-text-muted)', soft: 'var(--mos-color-surface-strong)', word: 'Unknown' };

// Whether this app is one MOS never rates, rather than one it has not rated
// yet. The backend decides it from the source the package came from, never
// from anything the package says about itself.
export function isNotAssessed(privacy: PrivacyReviewSummary | null | undefined): boolean {
  return privacy?.status === 'not-assessed';
}

export function postureFor(privacy: PrivacyReviewSummary | null | undefined) {
  if (isNotAssessed(privacy)) return NOT_ASSESSED;
  const posture = privacy?.posture as PrivacyPostureId | undefined;
  return (posture && POSTURES[posture]) || UNREVIEWED;
}

// A solid shield outline means MOS reached a verdict; a broken one means this
// slot is never going to hold one. Same silhouette in the same place, so the
// eye still knows where to look, with one bit of ink carrying the difference
// between "no answer yet" and "not MOS's question".
export function shieldDashArray(privacy: PrivacyReviewSummary | null | undefined): string | null {
  return isNotAssessed(privacy) ? '2.6 2.2' : null;
}

// The word "grade" over a `?` is a pending grade however grey the shield is,
// so the tile names what the slot actually holds instead.
export function tileLabelFor(privacy: PrivacyReviewSummary | null | undefined): string {
  return isNotAssessed(privacy) ? 'Privacy' : 'Posture grade';
}

// A completed review always carries a posture, so the status alone answers this.
export function isRated(privacy: PrivacyReviewSummary | null | undefined): boolean {
  return privacy?.status === 'reviewed';
}

export function privacyScore(privacy: PrivacyReviewSummary | null | undefined): number | null {
  if (!privacy || !isRated(privacy) || !privacy.dimensions) return null;
  let total = 0;
  for (const dimension of DIMENSIONS) {
    const entry = PHRASES[dimension.key][String(privacy.dimensions[dimension.key])];
    if (!entry) return null;
    total += entry.level;
  }
  return total;
}

// The 0-10 score collapses to a plain letter grade for display: A is best,
// D is worst. Bands: A 9-10, B 7-8, C 4-6, D 0-3.
export function privacyGrade(privacy: PrivacyReviewSummary | null | undefined): string | null {
  const score = privacyScore(privacy);
  if (score === null) return null;
  return score >= 9 ? 'A' : score >= 7 ? 'B' : score >= 4 ? 'C' : 'D';
}

export function badgeTextFor(privacy: PrivacyReviewSummary | null | undefined): string {
  return privacyGrade(privacy) ?? '?';
}

// The visible scale for the shield letter: a bare "B" means nothing without
// the A-to-D scale spelled out somewhere on the surface that shows it.
export function gradeScaleLabel(privacy: PrivacyReviewSummary | null | undefined): string | null {
  const grade = privacyGrade(privacy);
  return grade === null ? null : `Privacy grade ${grade} (A is best, D is worst)`;
}

export function dimensionRowsFor(privacy: PrivacyReviewSummary | null | undefined): PrivacyDimensionRow[] {
  return DIMENSIONS.map((dimension) => {
    const value = String(privacy?.dimensions?.[dimension.key] ?? '');
    const entry = PHRASES[dimension.key][value];
    const unknown = !entry;
    return {
      iconPath: dimension.iconPath,
      key: dimension.key,
      label: dimension.label,
      phrase: entry ? entry.phrase : 'Not yet known',
      verdict: unknown ? UNKNOWN_VERDICT : VERDICTS[entry.level],
    };
  });
}

export function reviewDateLabel(reviewedAt: string | null | undefined): string | null {
  if (!reviewedAt) return null;
  const date = new Date(reviewedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// A review authored by an AI without a human sign-off must say so everywhere
// "reviewed" appears — tile included — not only in dialog fine print.
function reviewerLabel(privacy: PrivacyReviewSummary | null | undefined): string {
  const provenance = privacy?.provenance;
  return provenance?.method === 'ai-assisted' && !provenance.humanReviewed ? 'AI-reviewed for MOS' : 'Reviewed by MOS';
}

export function tileMetaLine(privacy: PrivacyReviewSummary | null | undefined): string {
  if (isNotAssessed(privacy)) return 'From a source you added';
  return isRated(privacy) ? reviewerLabel(privacy) : 'Not yet rated';
}

export function provenanceLine(privacy: PrivacyReviewSummary | null | undefined, appVersion?: string | null): string {
  if (isNotAssessed(privacy)) return 'Not assessed by MOS';
  if (!isRated(privacy)) return 'Not yet rated by MOS';
  return [reviewerLabel(privacy), reviewDateLabel(privacy?.reviewedAt), appVersion ? `version ${appVersion}` : null]
    .filter(Boolean)
    .join(' · ');
}

export function privacyChanged(installed: PrivacyReviewSummary, candidate: PrivacyReviewSummary): boolean {
  return installed.posture !== candidate.posture || privacyGrade(installed) !== privacyGrade(candidate);
}

// Advisories are current, source-trusted notices about the installed version.
// They are presented separately from the installed assessment so a corrected
// advisory changes what the owner sees without implying the runtime changed.
const ADVISORY_SEVERITY_ORDER: Record<PrivacyAdvisorySeverity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

export const ADVISORY_SEVERITY_STYLE: Record<PrivacyAdvisorySeverity, { border: string; color: string; soft: string }> = {
  info: { border: 'var(--mos-color-info-border)', color: 'var(--mos-color-info)', soft: 'var(--mos-color-info-soft)' },
  low: { border: 'var(--mos-color-info-border)', color: 'var(--mos-color-info)', soft: 'var(--mos-color-info-soft)' },
  medium: { border: 'var(--mos-color-warning-border)', color: 'var(--mos-color-warning)', soft: 'var(--mos-color-warning-soft)' },
  high: { border: 'var(--mos-color-danger-border)', color: 'var(--mos-color-danger)', soft: 'var(--mos-color-danger-soft)' },
  critical: { border: 'var(--mos-color-danger-border)', color: 'var(--mos-color-danger)', soft: 'var(--mos-color-danger-soft)' },
};

export const ADVISORY_TYPE_LABEL: Record<PrivacyAdvisoryType, string> = {
  'package-withdrawn': 'Package withdrawn',
  'policy-change': 'Policy change',
  'privacy-review-invalidated': 'Review invalidated',
  security: 'Security',
};

export function sortedAdvisories(advisories: PrivacyAdvisory[] | null | undefined): PrivacyAdvisory[] {
  return [...(advisories || [])].sort((left, right) => ADVISORY_SEVERITY_ORDER[right.severity] - ADVISORY_SEVERITY_ORDER[left.severity]
    || String(right.publishedAt).localeCompare(String(left.publishedAt)));
}

export function advisoryMarkerLabel(advisories: PrivacyAdvisory[] | null | undefined): string | null {
  const count = advisories?.length || 0;
  if (!count) return null;
  return count === 1 ? '1 advisory' : `${count} advisories`;
}

export function provenanceMethodLabel(privacy: PrivacyReviewSummary | null | undefined): string | null {
  if (!isRated(privacy) || !privacy?.provenance) return null;
  const { humanReviewed, method } = privacy.provenance;
  const base = method === 'human' ? 'Human review' : method === 'ai-assisted' ? 'AI-assisted review' : null;
  if (!base) return humanReviewed ? 'Human-checked' : null;
  return method === 'ai-assisted' && humanReviewed ? `${base}, human-checked` : base;
}

export function privacyChangeSentence(installed: PrivacyReviewSummary, candidate: PrivacyReviewSummary): string {
  // An app from an added source has no MOS assessment on either side of an
  // update, so there is no change to describe — and saying "neither has been
  // rated yet" here would promise the review that is never coming.
  if (isNotAssessed(installed) || isNotAssessed(candidate)) {
    return 'MOS does not assess apps from sources you added, so neither version carries a MOS assessment.';
  }
  if (!privacyChanged(installed, candidate)) {
    // Two unrated packages share no score to "keep".
    return privacyScore(installed) === null
      ? 'Neither the version you run today nor this update has been rated by MOS yet.'
      : 'This update keeps the same privacy grade as the version you run today.';
  }
  const before = privacyScore(installed);
  const after = privacyScore(candidate);
  if (after === null) return 'The new version has not been rated yet. Treat it as unverified until MOS finishes reviewing it.';
  if (before === null) return 'The version you run today was never rated. The new version has a completed MOS review.';
  if (after < before) return 'The new version relies more on outside services than the version you run today. Check the new assessment before updating.';
  if (after > before) return 'The new version is rated more private than the version you run today.';
  return 'The overall grade stays the same, but the assessment behind it changed. Check the new assessment before updating.';
}
