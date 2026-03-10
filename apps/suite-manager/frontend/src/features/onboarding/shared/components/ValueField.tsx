import { Copy } from 'lucide-react';
import type { ReactNode } from 'react';

type ValueFieldProps = {
  actions?: ReactNode;
  copied?: boolean;
  label: string;
  onCopy?: () => void;
  value: string;
  valueClassName?: string;
};

export function ValueField({ actions, copied = false, label, onCopy, value, valueClassName }: ValueFieldProps) {
  return (
    <div className="suite-field">
      <div className="suite-field-header">
        <span className="suite-field-label">{label}</span>
        <div className="suite-field-actions">
          {actions}
          {onCopy ? (
            <button className="suite-copy-button" onClick={onCopy} type="button">
              <Copy aria-hidden="true" className="suite-inline-icon" />
              {copied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </div>
      </div>
      <span className={valueClassName ? `suite-field-value ${valueClassName}` : 'suite-field-value'}>{value}</span>
    </div>
  );
}
