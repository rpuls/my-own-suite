// Privacy posture visual components: shield badge, facts tile, posture
// dialog, and the update-preview privacy-change row (Phase 6).
//
// SIBLING COMPONENT — there is no shared component library between Suite
// Manager (React) and the public site (Astro) yet, so the badge, tile, and
// dialog are implemented twice and must stay visually identical:
//   suite-manager/frontend/src/features/apps/PrivacyPosture.tsx  (this file)
//   site/src/components/PrivacyPosture.astro
// PrivacyChangeRow exists only here (the site has no update preview).
// Shared logic and copy live in the byte-identical sibling modules
// privacy-posture.ts (next to this file) and site/src/lib/privacy-posture.ts.
// If you change look, copy, or logic here, mirror it in the siblings.

import { Dialog, Notice } from '../../components/ui';
import {
  ADVISORY_SEVERITY_STYLE,
  ADVISORY_TYPE_LABEL,
  ASSESSMENT_DOCS_URL,
  ENCLOSURE_FACTS,
  ENCLOSURE_GAP,
  EXTERNAL_DOCS_URL,
  GLYPHS,
  SHIELD_PATH,
  advisoryMarkerLabel,
  badgeTextFor,
  dimensionRowsFor,
  gradeScaleLabel,
  isNotAssessed,
  isRated,
  postureFor,
  privacyChangeSentence,
  privacyChanged,
  provenanceLine,
  provenanceMethodLabel,
  shieldDashArray,
  sortedAdvisories,
  tileLabelFor,
  tileMetaLine,
  type PrivacyAdvisory,
  type PrivacyReviewSummary,
} from './privacy-posture';

function Glyph({ className, path }: { className?: string; path: string }) {
  return <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d={path} /></svg>;
}

export function PrivacyShieldBadge({ privacy, size }: { privacy: PrivacyReviewSummary | null | undefined; size: 'dialog' | 'row' | 'tile' }) {
  const posture = postureFor(privacy);
  const text = badgeTextFor(privacy);
  const dash = shieldDashArray(privacy);
  return <span aria-hidden="true" className={`suite-privacy-shield is-${size}${text.length > 1 ? ' is-wide' : ''}`}>
    <svg viewBox="0 0 24 24"><path d={SHIELD_PATH} fill={posture.soft} stroke={posture.color} strokeDasharray={dash || undefined} strokeLinejoin="round" strokeWidth="1.6" /></svg>
    <span style={{ color: posture.color }}>{text}</span>
  </span>;
}

export function PrivacyFactsTile({ advisories, onOpen, privacy }: { advisories?: PrivacyAdvisory[] | null; onOpen: () => void; privacy: PrivacyReviewSummary | null | undefined }) {
  const posture = postureFor(privacy);
  const marker = advisoryMarkerLabel(advisories);
  const topSeverity = sortedAdvisories(advisories)[0]?.severity;
  return <button className="suite-privacy-tile" onClick={onOpen} type="button">
    <span className="suite-privacy-tile-label">{tileLabelFor(privacy)}</span>
    <span className="suite-privacy-tile-posture">
      <PrivacyShieldBadge privacy={privacy} size="tile" />
      <strong>{posture.label}</strong>
    </span>
    <span className="suite-privacy-tile-meta">
      {marker && topSeverity
        ? <span className="suite-privacy-advisory-flag" style={{ background: ADVISORY_SEVERITY_STYLE[topSeverity].soft, borderColor: ADVISORY_SEVERITY_STYLE[topSeverity].border, color: ADVISORY_SEVERITY_STYLE[topSeverity].color }}>{marker}</span>
        : tileMetaLine(privacy)}
      <Glyph path={GLYPHS.chevronRight} />
    </span>
  </button>;
}

function AdvisoryNotices({ advisories }: { advisories: PrivacyAdvisory[] }) {
  if (!advisories.length) return null;
  return <div className="suite-privacy-advisories">
    <span className="suite-privacy-advisories-label">Current advisories</span>
    {sortedAdvisories(advisories).map((advisory) => {
      const style = ADVISORY_SEVERITY_STYLE[advisory.severity];
      return <div className="suite-privacy-advisory" key={advisory.id} style={{ background: style.soft, borderColor: style.border }}>
        <span className="suite-privacy-advisory-head">
          <strong style={{ color: style.color }}>{ADVISORY_TYPE_LABEL[advisory.type]}</strong>
          <span className="suite-privacy-advisory-severity" style={{ color: style.color }}>{advisory.severity}</span>
        </span>
        <p className="suite-privacy-advisory-summary">{advisory.summary}</p>
        <p className="suite-privacy-advisory-remediation">{advisory.remediation}</p>
        {advisory.evidenceUrl ? <a className="suite-privacy-link" href={advisory.evidenceUrl} rel="noreferrer" target="_blank">
          Evidence
          <Glyph path={GLYPHS.externalLink} />
        </a> : null}
      </div>;
    })}
  </div>;
}

// The body of the dialog for an app MOS does not assess. It answers the three
// questions the five "unknown" dimension rows used to leave open: why there is
// no grade and why one is not coming, what MOS guarantees regardless, and what
// is left for the owner to weigh. Suite Manager only — the public site lists
// catalog apps, every one of which carries a review, so there is no sibling.
function NotAssessedBody() {
  return <>
    <p className="suite-privacy-why">
      Whatever this package says about its own privacy is its publisher&apos;s word. MOS does not repeat it here, because a claim printed in MOS&apos;s colours reads as a claim MOS checked, and nobody did.
    </p>
    <div className="suite-privacy-rows">
      <span className="suite-privacy-rows-label">What MOS enforces anyway</span>
      {ENCLOSURE_FACTS.map((fact) => <div className="suite-privacy-row" key={fact.label}>
        <span className="suite-privacy-row-icon"><Glyph path={fact.iconPath} /></span>
        <span className="suite-privacy-row-text">
          <strong>{fact.label}</strong>
          <span>{fact.detail}</span>
        </span>
        <span className="suite-privacy-verdict" style={{ background: 'var(--mos-color-accent-soft)', borderColor: 'var(--mos-color-accent-border)', color: 'var(--mos-color-accent)' }}>Enforced</span>
      </div>)}
    </div>
    <Notice title="What you are trusting" variant="warning">
      <p>{ENCLOSURE_GAP}</p>
    </Notice>
  </>;
}

export function PrivacyPostureDialog({ advisories, appName, appVersion, assessmentUrl = ASSESSMENT_DOCS_URL, onClose, overrideNotice = null, packageId, privacy, sourceLabel = null }: {
  advisories?: PrivacyAdvisory[] | null;
  appName: string;
  appVersion?: string | null;
  assessmentUrl?: string;
  onClose: () => void;
  // One scoped line, shown only when this instance carries owner-set
  // configuration that MOS's assessment could not have taken into account. It
  // has no sibling on the public site because a published page describes a
  // package rather than somebody's running instance, so there is nothing to
  // mirror and this stays a Suite Manager-only addition.
  overrideNotice?: string | null;
  // Used only to link out to the published assessment. The posture sentence
  // promises the evidence names what leaves and who receives it, so the
  // dialog has to be able to reach it.
  packageId?: string | null;
  privacy: PrivacyReviewSummary | null | undefined;
  // Who publishes the app, for a package MOS does not assess. It is the one
  // thing the owner can actually weigh in place of a grade, so the dialog
  // names it rather than leaving "a source you added" abstract.
  sourceLabel?: string | null;
}) {
  const posture = postureFor(privacy);
  const method = provenanceMethodLabel(privacy);
  const gradeScale = gradeScaleLabel(privacy);
  const notAssessed = isNotAssessed(privacy);
  return <Dialog
    className="suite-privacy-dialog"
    header={<div className="suite-privacy-dialog-heading">
      <PrivacyShieldBadge privacy={privacy} size="dialog" />
      <div>
        <h2>{appName}</h2>
        <span className="suite-privacy-pill" style={{ background: posture.soft, borderColor: posture.border }}>{posture.label}</span>
        {gradeScale ? <span className="suite-privacy-score-scale">{gradeScale}</span> : null}
      </div>
    </div>}
    onClose={onClose}
    title={`${appName} privacy`}
  >
    <p className="suite-privacy-sentence">{posture.sentence}</p>
    {/* The override line scopes an assessment to the app as MOS ships it, so it
        has nothing to say where there is no assessment to scope. */}
    {overrideNotice && !notAssessed ? <p className="suite-privacy-override">{overrideNotice}</p> : null}
    {notAssessed ? <NotAssessedBody /> : <div className="suite-privacy-rows">
      {dimensionRowsFor(privacy).map((row) => <div className="suite-privacy-row" key={row.key}>
        <span className="suite-privacy-row-icon"><Glyph path={row.iconPath} /></span>
        <span className="suite-privacy-row-text">
          <strong>{row.label}</strong>
          <span>{row.phrase}</span>
        </span>
        <span className="suite-privacy-verdict" style={{ background: row.verdict.soft, borderColor: row.verdict.border, color: row.verdict.color }}>{row.verdict.word}</span>
      </div>)}
    </div>}
    <AdvisoryNotices advisories={advisories || []} />
    {packageId && isRated(privacy) ? <a
      className="suite-privacy-report-link"
      href={`https://myownsuite.org/docs/apps/${packageId}/#privacy-assessment`}
      rel="noreferrer"
      target="_blank"
    >
      <span>
        <strong>Read the full assessment</strong>
        <span>Every piece of evidence, its source, and what the review does not settle</span>
      </span>
      <Glyph path={GLYPHS.externalLink} />
    </a> : null}
    <div className="suite-privacy-footer">
      <div className="suite-privacy-footer-meta">
        {/* Who published it sits where a reviewed app's provenance sits, because
            it answers the same question: whose word this app comes with. */}
        <span>{[
          provenanceLine(privacy, isRated(privacy) ? appVersion : null),
          notAssessed && sourceLabel ? `from ${sourceLabel}` : null,
          method,
        ].filter(Boolean).join(' · ')}</span>
        <a className="suite-privacy-link" href={notAssessed ? EXTERNAL_DOCS_URL : assessmentUrl} rel="noreferrer" target="_blank">
          {notAssessed ? 'Why MOS does not assess these' : 'How MOS assesses app privacy'}
          <Glyph path={GLYPHS.externalLink} />
        </a>
      </div>
      <button className="mos-btn mos-btn-secondary" onClick={onClose} type="button">Close</button>
    </div>
  </Dialog>;
}

export function PrivacyChangeRow({ candidate, candidateVersion, installed, installedVersion }: {
  candidate: PrivacyReviewSummary;
  candidateVersion: string | null;
  installed: PrivacyReviewSummary;
  installedVersion: string | null;
}) {
  const changed = privacyChanged(installed, candidate);
  const versions = installedVersion && candidateVersion ? (installedVersion === candidateVersion ? installedVersion : `${installedVersion} → ${candidateVersion}`) : null;
  return <div className={`suite-privacy-change${changed ? ' is-changed' : ''}`}>
    <span className="suite-privacy-change-label">Privacy change{versions ? ` · ${versions}` : ''}</span>
    <div className="suite-privacy-change-row">
      <span className="suite-privacy-change-side">
        <PrivacyShieldBadge privacy={installed} size="row" />
        <strong>{postureFor(installed).label}</strong>
      </span>
      {changed ? <>
        <Glyph className="suite-privacy-change-arrow" path={GLYPHS.arrowRight} />
        <span className="suite-privacy-change-side is-candidate">
          <PrivacyShieldBadge privacy={candidate} size="row" />
          <strong>{postureFor(candidate).label}</strong>
        </span>
      </> : <span className="suite-privacy-change-same">
        <Glyph path={GLYPHS.check} />
        No change
      </span>}
    </div>
    <p>{privacyChangeSentence(installed, candidate)}</p>
  </div>;
}
