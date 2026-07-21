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
// Everything here derives presentation from a package's privacy-review.json
// (schemas/app-privacy-assessment.schema.json). The score is the sum of the
// five dimension levels (0-2 each, so 0-10 total). Postures, phrases, and
// verdicts are generic schema-level rules — no app-specific logic belongs in
// this file.

export type PrivacyPostureId = 'private-by-default' | 'privacy-configured' | 'external-dependency' | 'review-required';

export type PrivacyDimensionKey = 'telemetry' | 'externalServices' | 'accountDependency' | 'dataProcessing' | 'policyExposure';

export type PrivacyProvenance = {
  humanReviewed: boolean;
  method: string | null;
  model: string | null;
  sourceRevision: string | null;
};

export type PrivacyReviewSummary = {
  dimensions: Record<string, string> | null;
  posture: string;
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
  'external-dependency': {
    border: 'var(--mos-color-warning-border)',
    color: 'var(--mos-color-warning)',
    label: 'External dependency',
    sentence: 'Normal use relies on an outside service or account, so some traffic or data leaves your server.',
    soft: 'var(--mos-color-warning-soft)',
  },
  'review-required': {
    border: 'var(--mos-color-danger-border)',
    color: 'var(--mos-color-danger)',
    label: 'Not yet reviewed',
    sentence: 'MOS has not reviewed this app. Treat it as unverified.',
    soft: 'var(--mos-color-danger-soft)',
  },
};

export const DIMENSIONS: Array<{ iconPath: string; key: PrivacyDimensionKey; label: string }> = [
  { iconPath: 'M4.9 19.1a10 10 0 010-14.2M19.1 4.9a10 10 0 010 14.2M7.8 16.2a6 6 0 010-8.4M16.2 7.8a6 6 0 010 8.4M12 11a1 1 0 100 2 1 1 0 000-2z', key: 'telemetry', label: 'Telemetry' },
  { iconPath: 'M9 3v5M15 3v5M6.5 8h11v3.5a5.5 5.5 0 01-5.5 5.5 5.5 5.5 0 01-5.5-5.5V8zM12 17v4', key: 'externalServices', label: 'External services' },
  { iconPath: 'M21 2l-9.6 9.6M15.5 7.5l3 3M11.4 11.6a4.8 4.8 0 10-6.8 6.8 4.8 4.8 0 006.8-6.8z', key: 'accountDependency', label: 'Accounts' },
  { iconPath: 'M22 12H2M5.5 5h13l3.5 7v5a2 2 0 01-2 2H4a2 2 0 01-2-2v-5l3.5-7zM6 16h.01M10 16h.01', key: 'dataProcessing', label: 'Data processing' },
  { iconPath: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M16 13H8M16 17H8', key: 'policyExposure', label: 'Policies' },
];

const PHRASES: Record<PrivacyDimensionKey, Record<string, { level: 0 | 1 | 2; phrase: string }>> = {
  telemetry: {
    'disabled-by-mos': { level: 2, phrase: 'Turned off by MOS' },
    'none-observed': { level: 2, phrase: 'None observed' },
    optional: { level: 1, phrase: 'Optional, off by default' },
    unavoidable: { level: 0, phrase: 'Cannot be turned off' },
    unknown: { level: 0, phrase: 'Not yet known' },
  },
  externalServices: {
    'none-required': { level: 2, phrase: 'None required' },
    optional: { level: 1, phrase: 'Optional features only' },
    required: { level: 0, phrase: 'Required to work' },
    unknown: { level: 0, phrase: 'Not yet known' },
  },
  accountDependency: {
    'local-only': { level: 2, phrase: 'Your local account only' },
    'optional-upstream-account': { level: 1, phrase: 'Optional outside account' },
    'required-upstream-account': { level: 0, phrase: 'Outside account required' },
    unknown: { level: 0, phrase: 'Not yet known' },
  },
  dataProcessing: {
    local: { level: 2, phrase: 'Stays on your machine' },
    'optional-external': { level: 1, phrase: 'Optional outside processing' },
    'required-external': { level: 0, phrase: 'Processed outside' },
    unknown: { level: 0, phrase: 'Not yet known' },
  },
  policyExposure: {
    'self-hosted-software-only': { level: 2, phrase: 'Only the software license' },
    'upstream-services-involved': { level: 1, phrase: 'Outside terms apply' },
    unclear: { level: 0, phrase: 'Unclear' },
  },
};

const VERDICTS: Record<0 | 1 | 2, PrivacyVerdict> = {
  0: { border: 'var(--mos-color-danger-border)', color: 'var(--mos-color-danger)', soft: 'var(--mos-color-danger-soft)', word: 'Outside' },
  1: { border: 'var(--mos-color-warning-border)', color: 'var(--mos-color-warning)', soft: 'var(--mos-color-warning-soft)', word: 'Your choice' },
  2: { border: 'var(--mos-color-accent-border)', color: 'var(--mos-color-accent)', soft: 'var(--mos-color-accent-soft)', word: 'Private' },
};

const UNKNOWN_VERDICT: PrivacyVerdict = { border: 'var(--mos-color-surface-border)', color: 'var(--mos-color-text-muted)', soft: 'var(--mos-color-surface-strong)', word: 'Unknown' };

export function postureFor(privacy: PrivacyReviewSummary | null | undefined) {
  const posture = privacy?.posture as PrivacyPostureId | undefined;
  return (posture && POSTURES[posture]) || POSTURES['review-required'];
}

export function isRated(privacy: PrivacyReviewSummary | null | undefined): boolean {
  return privacy?.status === 'reviewed' && privacy.posture !== 'review-required';
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

export function badgeTextFor(privacy: PrivacyReviewSummary | null | undefined): string {
  const score = privacyScore(privacy);
  return score === null ? '?' : String(score);
}

// The visible scale for the shield number: a bare "7" means nothing without
// "out of 10" somewhere on the surface that shows it.
export function scoreScaleLabel(privacy: PrivacyReviewSummary | null | undefined): string | null {
  const score = privacyScore(privacy);
  return score === null ? null : `Privacy score ${score} out of 10`;
}

export function dimensionRowsFor(privacy: PrivacyReviewSummary | null | undefined): PrivacyDimensionRow[] {
  return DIMENSIONS.map((dimension) => {
    const value = String(privacy?.dimensions?.[dimension.key] ?? 'unknown');
    const entry = PHRASES[dimension.key][value] || { level: 0 as const, phrase: 'Not yet known' };
    const unknown = /unknown|unclear/u.test(value);
    return {
      iconPath: dimension.iconPath,
      key: dimension.key,
      label: dimension.label,
      phrase: entry.phrase,
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
  return isRated(privacy) ? reviewerLabel(privacy) : 'Not yet rated';
}

export function provenanceLine(privacy: PrivacyReviewSummary | null | undefined, packageVersion?: string | null): string {
  if (!isRated(privacy)) return 'Not yet rated by MOS';
  return [reviewerLabel(privacy), reviewDateLabel(privacy?.reviewedAt), packageVersion ? `package ${packageVersion}` : null]
    .filter(Boolean)
    .join(' · ');
}

export function privacyChanged(installed: PrivacyReviewSummary, candidate: PrivacyReviewSummary): boolean {
  return installed.posture !== candidate.posture || privacyScore(installed) !== privacyScore(candidate);
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
  if (!privacyChanged(installed, candidate)) {
    // Two unrated packages share no score to "keep".
    return privacyScore(installed) === null
      ? 'Neither the version you run today nor this update has been rated by MOS yet.'
      : 'This update keeps the same privacy score as the version you run today.';
  }
  const before = privacyScore(installed);
  const after = privacyScore(candidate);
  if (after === null) return 'The new version has not been rated yet. Treat it as unverified until MOS finishes reviewing it.';
  if (before === null) return 'The version you run today was never rated. The new version has a completed MOS review.';
  if (after < before) return 'The new version relies more on outside services than the version you run today. Check the new assessment before updating.';
  if (after > before) return 'The new version is rated more private than the version you run today.';
  return 'The overall score stays the same, but the assessment behind it changed. Check the new assessment before updating.';
}
