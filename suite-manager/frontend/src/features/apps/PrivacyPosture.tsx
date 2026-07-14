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
  ASSESSMENT_DOCS_URL,
  GLYPHS,
  SHIELD_PATH,
  badgeTextFor,
  dimensionRowsFor,
  isRated,
  postureFor,
  privacyChangeSentence,
  privacyChanged,
  provenanceLine,
  tileMetaLine,
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

export function PrivacyFactsTile({ onOpen, privacy }: { onOpen: () => void; privacy: PrivacyReviewSummary | null | undefined }) {
  const posture = postureFor(privacy);
  return <button className="suite-privacy-tile" onClick={onOpen} type="button">
    <span className="suite-privacy-tile-label">Privacy</span>
    <span className="suite-privacy-tile-posture">
      <PrivacyShieldBadge privacy={privacy} size="tile" />
      <strong>{posture.label}</strong>
    </span>
    <span className="suite-privacy-tile-meta">
      {tileMetaLine(privacy)}
      <Glyph path={GLYPHS.chevronRight} />
    </span>
  </button>;
}

export function PrivacyPostureDialog({ appName, assessmentUrl = ASSESSMENT_DOCS_URL, onClose, packageVersion, privacy }: {
  appName: string;
  assessmentUrl?: string;
  onClose: () => void;
  packageVersion?: string | null;
  privacy: PrivacyReviewSummary | null | undefined;
}) {
  const posture = postureFor(privacy);
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
    <div className="suite-privacy-footer">
      <div className="suite-privacy-footer-meta">
        <span>{provenanceLine(privacy, isRated(privacy) ? packageVersion : null)}</span>
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
