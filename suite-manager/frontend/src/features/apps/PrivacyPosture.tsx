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

import { Dialog } from '../../components/ui';
import {
  ADVISORY_SEVERITY_STYLE,
  ADVISORY_TYPE_LABEL,
  ASSESSMENT_DOCS_URL,
  GLYPHS,
  SHIELD_PATH,
  advisoryMarkerLabel,
  badgeTextFor,
  dimensionRowsFor,
  isRated,
  postureFor,
  privacyChangeSentence,
  privacyChanged,
  provenanceLine,
  provenanceMethodLabel,
  sortedAdvisories,
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
  return <span aria-hidden="true" className={`suite-privacy-shield is-${size}${text.length > 1 ? ' is-wide' : ''}`}>
    <svg viewBox="0 0 24 24"><path d={SHIELD_PATH} fill={posture.soft} stroke={posture.color} strokeLinejoin="round" strokeWidth="1.6" /></svg>
    <span style={{ color: posture.color }}>{text}</span>
  </span>;
}

export function PrivacyFactsTile({ advisories, onOpen, privacy }: { advisories?: PrivacyAdvisory[] | null; onOpen: () => void; privacy: PrivacyReviewSummary | null | undefined }) {
  const posture = postureFor(privacy);
  const marker = advisoryMarkerLabel(advisories);
  const topSeverity = sortedAdvisories(advisories)[0]?.severity;
  return <button className="suite-privacy-tile" onClick={onOpen} type="button">
    <span className="suite-privacy-tile-label">Privacy</span>
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

export function PrivacyPostureDialog({ advisories, appName, assessmentUrl = ASSESSMENT_DOCS_URL, onClose, packageVersion, privacy }: {
  advisories?: PrivacyAdvisory[] | null;
  appName: string;
  assessmentUrl?: string;
  onClose: () => void;
  packageVersion?: string | null;
  privacy: PrivacyReviewSummary | null | undefined;
}) {
  const posture = postureFor(privacy);
  const method = provenanceMethodLabel(privacy);
  return <Dialog
    className="suite-privacy-dialog"
    closeOnBackdrop
    header={<div className="suite-privacy-dialog-heading">
      <PrivacyShieldBadge privacy={privacy} size="dialog" />
      <div>
        <h2>{appName}</h2>
        <span className="suite-privacy-pill" style={{ background: posture.soft, borderColor: posture.border }}>{posture.label}</span>
      </div>
    </div>}
    onClose={onClose}
    title={`${appName} privacy`}
  >
    <p className="suite-privacy-sentence">{posture.sentence}</p>
    <div className="suite-privacy-rows">
      {dimensionRowsFor(privacy).map((row) => <div className="suite-privacy-row" key={row.key}>
        <span className="suite-privacy-row-icon"><Glyph path={row.iconPath} /></span>
        <span className="suite-privacy-row-text">
          <strong>{row.label}</strong>
          <span>{row.phrase}</span>
        </span>
        <span className="suite-privacy-verdict" style={{ background: row.verdict.soft, borderColor: row.verdict.border, color: row.verdict.color }}>{row.verdict.word}</span>
      </div>)}
    </div>
    <AdvisoryNotices advisories={advisories || []} />
    <div className="suite-privacy-footer">
      <div className="suite-privacy-footer-meta">
        <span>{[provenanceLine(privacy, isRated(privacy) ? packageVersion : null), method].filter(Boolean).join(' · ')}</span>
        <a className="suite-privacy-link" href={assessmentUrl} rel="noreferrer" target="_blank">
          How MOS assesses app privacy
          <Glyph path={GLYPHS.externalLink} />
        </a>
      </div>
      <button className="mos-btn mos-btn-secondary" onClick={onClose} type="button">Close</button>
    </div>
  </Dialog>;
}

export function PrivacyChangeRow({ candidate, candidateVersion, installed, installedVersion }: {
  candidate: PrivacyReviewSummary;
  candidateVersion: string;
  installed: PrivacyReviewSummary;
  installedVersion: string;
}) {
  const changed = privacyChanged(installed, candidate);
  return <div className={`suite-privacy-change${changed ? ' is-changed' : ''}`}>
    <span className="suite-privacy-change-label">Privacy change · {installedVersion} → {candidateVersion}</span>
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
