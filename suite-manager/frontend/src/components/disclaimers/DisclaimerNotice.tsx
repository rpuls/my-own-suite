import { useState, type ReactNode } from 'react';

import { Dialog, Icon, Notice } from '../ui';

// Shared shape for every temporary disclaimer: a short line that fits on the
// page, and a Read more dialog for the honest version. Long apologies inline
// train people to skim past the notice; a sentence and a link does not.
export type DisclaimerCopy = {
  callout: string;
  calloutTitle: string;
  dialogTitle: string;
  dismissLabel: string;
  paragraphs: string[];
  readMoreLabel: string;
  // A disclaimer that asks the owner to do something themselves gets numbered
  // steps instead of another paragraph, because prose hides the order.
  steps?: string[];
  summary: string;
  title: string;
};

export function DisclaimerNotice({ copy, details, variant = 'warning' }: {
  copy: DisclaimerCopy;
  details?: ReactNode;
  variant?: 'info' | 'warning';
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return <>
    <Notice title={copy.title} variant={variant}>
      <p>{copy.summary}</p>
      <div className="suite-disclaimer-actions">
        <button className="mos-btn mos-btn-secondary" onClick={() => setDetailsOpen(true)} type="button">
          {copy.readMoreLabel}<Icon name="chevron-right" />
        </button>
      </div>
    </Notice>
    {detailsOpen ? <Dialog
      closeOnBackdrop
      footer={<button className="mos-btn mos-btn-primary" onClick={() => setDetailsOpen(false)} type="button">{copy.dismissLabel}</button>}
      onClose={() => setDetailsOpen(false)}
      title={copy.dialogTitle}
    >
      <div className="suite-disclaimer-details">
        {copy.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
        {copy.steps ? <ol className="suite-disclaimer-steps">{copy.steps.map((step) => <li key={step}>{step}</li>)}</ol> : null}
        {details}
        <Notice title={copy.calloutTitle} variant="info"><p>{copy.callout}</p></Notice>
      </div>
    </Dialog> : null}
  </>;
}
