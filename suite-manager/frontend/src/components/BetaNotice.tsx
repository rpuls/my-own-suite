import { useState, type ReactNode } from 'react';

import betaNotice from '../../../../shared/beta-notice.json';
import { Dialog, Icon, Notice } from './ui';

// The same early-software warning the public landing page shows, in the same
// words: the wording lives in shared/beta-notice.json and both surfaces render
// it. Someone who never read the website still has to meet this warning before
// they trust the platform with their data, so unlike the landing-page snackbar
// this one is part of the page and cannot be dismissed away.
export function BetaNotice({ children }: { children?: ReactNode }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return <>
    <Notice title={betaNotice.title} variant="warning">
      <p>{betaNotice.summary}</p>
      {children}
      <div className="suite-beta-actions">
        <button className="mos-btn mos-btn-secondary" onClick={() => setDetailsOpen(true)} type="button">
          {betaNotice.readMoreLabel}<Icon name="chevron-right" />
        </button>
      </div>
    </Notice>
    {detailsOpen ? <Dialog
      closeOnBackdrop
      footer={<button className="mos-btn mos-btn-primary" onClick={() => setDetailsOpen(false)} type="button">{betaNotice.dismissLabel}</button>}
      onClose={() => setDetailsOpen(false)}
      title={betaNotice.dialogTitle}
    >
      <div className="suite-beta-details">
        {betaNotice.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        <Notice title="Keep backups" variant="info"><p>{betaNotice.callout}</p></Notice>
      </div>
    </Dialog> : null}
  </>;
}
