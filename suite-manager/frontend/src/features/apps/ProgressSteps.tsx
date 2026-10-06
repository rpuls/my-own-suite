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
  seconds?: number;
  status: 'complete' | 'failed' | 'pending' | 'running' | 'skipped';
};

export function setStep<T extends ProgressStep>(steps: T[], id: T['id'], status: ProgressStep['status']): T[] {
  return steps.map((step) => (step.id === id ? { ...step, status } : step));
}

// Shown once a step has run long enough to make someone wonder whether it still runs.
function elapsed(step: ProgressStep) {
  if (step.status !== 'running' || step.seconds === undefined || step.seconds < 10) return '';
  const minutes = Math.floor(step.seconds / 60);
  return minutes ? `${minutes} min ${String(step.seconds % 60).padStart(2, '0')} s` : `${step.seconds} s`;
}

export function ProgressSteps({ error, errorTitle, steps }: { error: string; errorTitle: string; steps: ProgressStep[] }) {
  if (!steps.length) return null;
  return <div className="suite-app-install-progress" role="status" aria-live="polite">
    <ol>
      {steps.map((step) => <li className={`is-${step.status}`} key={step.id}>
        <span className="suite-app-step-dot" aria-hidden="true" />
        <span>
          {/* Hidden from the live region, which would otherwise announce every tick. */}
          <strong>{step.label}{elapsed(step) ? <span aria-hidden="true" className="suite-app-step-elapsed"> · {elapsed(step)}</span> : null}</strong>
          <small>{step.detail}</small>
        </span>
      </li>)}
    </ol>
    {error ? <Notice title={errorTitle} variant="error"><p>{error}</p></Notice> : null}
  </div>;
}
