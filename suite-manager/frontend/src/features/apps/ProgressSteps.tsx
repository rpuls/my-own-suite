// The step list Suite Manager shows while an app operation is running.
//
// Extracted from the install flow so the app settings dialog can show the same
// thing rather than grow a second visual language for the same idea: an
// operation that takes tens of seconds, has named stages, and can fail at one of
// them. A spinning button says none of that.

import { Notice } from '../../components/ui';

export type ProgressStep = {
  detail: string;
  id: string;
  label: string;
  status: 'complete' | 'failed' | 'pending' | 'running' | 'skipped';
};

export function setStep<T extends ProgressStep>(steps: T[], id: T['id'], status: ProgressStep['status']): T[] {
  return steps.map((step) => (step.id === id ? { ...step, status } : step));
}

export function ProgressSteps({ error, errorTitle, steps }: { error: string; errorTitle: string; steps: ProgressStep[] }) {
  if (!steps.length) return null;
  return <div className="suite-app-install-progress" role="status" aria-live="polite">
    <ol>
      {steps.map((step) => <li className={`is-${step.status}`} key={step.id}>
        <span className="suite-app-step-dot" aria-hidden="true" />
        <span><strong>{step.label}</strong><small>{step.detail}</small></span>
      </li>)}
    </ol>
    {error ? <Notice title={errorTitle} variant="error"><p>{error}</p></Notice> : null}
  </div>;
}
