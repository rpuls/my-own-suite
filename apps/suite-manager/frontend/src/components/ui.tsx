import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import type { ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import type { InputHTMLAttributes } from 'react';

type DialogProps = {
  children: ReactNode;
  description?: string;
  footer?: ReactNode;
  hideHeaderText?: boolean;
  onClose: () => void;
  title: string;
};

type NoticeProps = {
  children?: ReactNode;
  title: string;
  variant?: 'error' | 'info' | 'success' | 'warning';
};

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  helperText?: ReactNode;
  label: string;
};

type TextAreaFieldProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  helperText?: ReactNode;
  label: string;
};

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  children: ReactNode;
  helperText?: ReactNode;
  label: string;
};

type StepperProps = {
  canNavigateToStep?: (stepIndex: number) => boolean;
  currentStepIndex: number;
  onStepClick?: (stepIndex: number) => void;
  steps: string[];
};

export function Stepper({ canNavigateToStep, currentStepIndex, onStepClick, steps }: StepperProps) {
  return (
    <div className="suite-stepper" aria-label="Progress">
      {steps.map((step, index) => {
        const label = `${index + 1}. ${step}`;
        const isCurrent = index === currentStepIndex;
        const canNavigate = Boolean(onStepClick && canNavigateToStep?.(index));

        return canNavigate ? (
          <button
            aria-current={isCurrent ? 'step' : undefined}
            className={isCurrent ? 'is-active' : ''}
            key={step}
            onClick={() => onStepClick(index)}
            type="button"
          >
            {label}
          </button>
        ) : (
          <span aria-current={isCurrent ? 'step' : undefined} className={isCurrent ? 'is-active' : ''} key={step}>
            {label}
          </span>
        );
      })}
    </div>
  );
}

export function Dialog({ children, description, footer, hideHeaderText = false, onClose, title }: DialogProps) {
  return (
    <div className="suite-modal-backdrop" role="presentation">
      <section aria-modal="true" className="suite-dialog mos-panel" role="dialog">
        <div className={`suite-dialog-header ${hideHeaderText ? 'is-compact' : ''}`}>
          {hideHeaderText ? (
            <h2 className="suite-sr-only">{title}</h2>
          ) : (
            <div>
              <h2>{title}</h2>
              {description ? <p className="suite-meta mos-meta">{description}</p> : null}
            </div>
          )}
          <button aria-label={`Close ${title}`} className="suite-icon-button" onClick={onClose} type="button">
            <X aria-hidden="true" className="suite-inline-icon" />
          </button>
        </div>

        {children}

        {footer ? <div className="suite-dialog-footer">{footer}</div> : null}
      </section>
    </div>
  );
}

export function Notice({ children, title, variant = 'info' }: NoticeProps) {
  const Icon = variant === 'success' ? CheckCircle2 : variant === 'info' ? Info : AlertTriangle;
  return (
    <div className={`suite-notice is-${variant}`}>
      <Icon aria-hidden="true" className="suite-notice-icon" />
      <div className="suite-notice-copy">
        <strong>{title}</strong>
        {children}
      </div>
    </div>
  );
}

export function TextField({ helperText, label, ...inputProps }: TextFieldProps) {
  return (
    <label className="suite-control">
      <span className="suite-field-label">{label}</span>
      <input className="suite-input" {...inputProps} />
      {helperText ? <span className="suite-control-help">{helperText}</span> : null}
    </label>
  );
}

export function TextAreaField({ helperText, label, ...textareaProps }: TextAreaFieldProps) {
  return (
    <label className="suite-control">
      <span className="suite-field-label">{label}</span>
      <textarea className="suite-input suite-textarea" {...textareaProps} />
      {helperText ? <span className="suite-control-help">{helperText}</span> : null}
    </label>
  );
}

export function SelectField({ children, helperText, label, ...selectProps }: SelectFieldProps) {
  return (
    <label className="suite-control">
      <span className="suite-field-label">{label}</span>
      <select className="suite-input suite-select" {...selectProps}>
        {children}
      </select>
      {helperText ? <span className="suite-control-help">{helperText}</span> : null}
    </label>
  );
}
