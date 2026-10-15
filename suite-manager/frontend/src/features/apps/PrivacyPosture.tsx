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
  OUTBOUND_FROM_LABEL,
  outboundChanged,
  outboundChanges,
  outboundHostLabel,
  outboundSummary,
  postureFor,
  privacyChangeSentence,
  privacyChanged,
  provenanceLine,
  provenanceMethodLabel,
  shieldDashArray,
  sortedAdvisories,
  tileLabelFor,
  tileMetaLine,
  type OutboundDestination,
  type PrivacyAdvisory,
  type PrivacyReviewSummary,
} from './privacy-posture';

function Glyph({ className, path }: { className?: string; path: string }) {
  return <svg aria-hidden="true" className={className} fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24"><path d={path} /></svg>;
}

function OutboundList({ outbound }: { outbound: OutboundDestination[] }) {
  return <ul className="suite-privacy-outbound-list">
    {outbound.map((item) => <li key={`${item.from} ${item.host}`}>
      <span className="suite-privacy-outbound-head">
        <code>{outboundHostLabel(item.host)}</code>
        <span className="suite-privacy-outbound-from">{OUTBOUND_FROM_LABEL[item.from]}</span>
      </span>
      <span>{item.purpose}</span>
      <span className="suite-privacy-outbound-receiver">Received by {item.receiver}</span>
    </li>)}
  </ul>;
}

function OutboundSection({ privacy }: { privacy: PrivacyReviewSummary | null | undefined }) {
  const summary = outboundSummary(privacy);
  if (!summary) return null;
  return <div className="suite-privacy-outbound">
    <span className="suite-privacy-rows-label">What it connects to</span>
    <p className="suite-privacy-why">{summary}</p>
    {privacy?.outbound?.length ? <OutboundList outbound={privacy.outbound} /> : null}
  </div>;
}

// The hosts an update adds and drops; when the installed review predates the list, the new list whole.
function OutboundChange({ candidate, installed }: { candidate: PrivacyReviewSummary; installed: PrivacyReviewSummary }) {
  const changes = outboundChanges(installed, candidate);
  if (!changes) {
    if (!Array.isArray(candidate.outbound)) return null;
    return <div className="suite-privacy-outbound">
      <span className="suite-privacy-change-label">What the new version connects to</span>
      {candidate.outbound.length ? <OutboundList outbound={candidate.outbound} /> : <p>Nothing outside your server in normal use.</p>}
    </div>;
  }
  return <>
    {changes.added.length ? <div className="suite-privacy-outbound">
      <span className="suite-privacy-change-label">Starts connecting to</span>
      <OutboundList outbound={changes.added} />
    </div> : null}
    {changes.removed.length ? <div className="suite-privacy-outbound">
      <span className="suite-privacy-change-label">Stops connecting to</span>
      <OutboundList outbound={changes.removed} />
    </div> : null}
  </>;
}

function PrivacyShieldBadge({ privacy, size }: { privacy: PrivacyReviewSummary | null | undefined; size: 'dialog' | 'row' | 'tile' }) {
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

// Dialog body for an app MOS does not assess: why there is no grade, what MOS
// guarantees regardless, what is left to weigh. Suite Manager only — every app
// the public site lists carries a review, so there is no sibling.
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
  // Who publishes it: what the owner weighs in place of a grade.
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
    {/* Nothing to scope where there is no assessment. */}
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
    <OutboundSection privacy={privacy} />
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
        {/* The publisher sits where provenance does: whose word this comes with. */}
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
  return <div className={`suite-privacy-change${changed || outboundChanged(installed, candidate) ? ' is-changed' : ''}`}>
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
    <OutboundChange candidate={candidate} installed={installed} />
  </div>;
}
