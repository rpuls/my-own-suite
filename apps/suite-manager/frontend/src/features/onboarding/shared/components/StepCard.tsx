import { CheckCircle2, LockKeyhole } from 'lucide-react';
import type { ReactNode } from 'react';

import type { OnboardingStep, OnboardingStepStatus } from '../types';

type StepCardProps = {
  children: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  step: OnboardingStep;
};

function statusLabel(status: OnboardingStepStatus): string {
  if (status === 'completed') {
    return 'Completed';
  }

  if (status === 'locked') {
    return 'Waiting';
  }

  return 'Current';
}

function statusIcon(status: OnboardingStepStatus) {
  if (status === 'completed') {
    return <CheckCircle2 aria-hidden="true" className="suite-step-status-icon" />;
  }

  if (status === 'locked') {
    return <LockKeyhole aria-hidden="true" className="suite-step-status-icon" />;
  }

  return null;
}

export function StepCard({ children, expanded, onToggle, step }: StepCardProps) {
  const cardClassName = [
    'suite-step-card',
    `is-${step.status}`,
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
          <h2>{step.title}</h2>
        </div>
        <span className={`suite-step-status is-${step.status}`}>
          {statusIcon(step.status)}
          {statusLabel(step.status)}
        </span>
      </button>

      <div className="suite-step-body">
        <div className="suite-step-body-inner">{children}</div>
      </div>
    </article>
  );
}
