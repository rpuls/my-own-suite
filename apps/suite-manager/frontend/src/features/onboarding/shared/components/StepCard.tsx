import { CheckCircle2, LoaderCircle, LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';

import type { OnboardingStep, OnboardingStepStatus } from '../types';

type StepCardProps = {
  children: ReactNode;
  detectionState?: 'completed' | 'detecting' | null;
  expanded: boolean;
  onToggle: () => void;
  step: OnboardingStep;
};

function statusLabel(status: OnboardingStepStatus, detectionState?: 'completed' | 'detecting' | null): string {
  if (detectionState === 'detecting') {
    return 'Detecting';
  }

  if (detectionState === 'completed') {
    return 'Detected';
  }

  if (status === 'completed') {
    return 'Completed';
  }

  if (status === 'locked') {
    return 'Locked';
  }

  return 'Ready';
}

function statusIcon(status: OnboardingStepStatus, detectionState?: 'completed' | 'detecting' | null) {
  if (detectionState === 'detecting') {
    return <LoaderCircle aria-hidden="true" className="suite-step-status-icon suite-spin" />;
  }

  if (status === 'completed') {
    return <CheckCircle2 aria-hidden="true" className="suite-step-status-icon" />;
  }

  if (status === 'locked') {
    return <LockKeyhole aria-hidden="true" className="suite-step-status-icon" />;
  }

  return null;
}

export function StepCard({ children, detectionState = null, expanded, onToggle, step }: StepCardProps) {
  const cardClassName = [
    'suite-step-card',
    `is-${step.status}`,
    detectionState ? `is-${detectionState}` : '',
    expanded ? 'is-expanded' : 'is-collapsed',
  ].join(' ');

  return (
    <article className={cardClassName}>
      <button
        className="suite-step-header"
        disabled={step.status === 'locked'}
        onClick={onToggle}
        type="button"
      >
        <div className="suite-step-heading">
          <h2 className="mos-card-title">{step.title}</h2>
        </div>
        <span className={`suite-step-status mos-pill is-${detectionState || step.status}`}>
          {statusIcon(step.status, detectionState)}
          {statusLabel(step.status, detectionState)}
        </span>
      </button>

      <div className="suite-step-body">
        <div className="suite-step-body-inner">{children}</div>
      </div>
    </article>
  );
}
