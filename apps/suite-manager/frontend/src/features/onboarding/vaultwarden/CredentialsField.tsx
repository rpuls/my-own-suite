import { Eye, EyeOff } from 'lucide-react';

import { ValueField } from '../shared/components/ValueField';

type CredentialsFieldProps = {
  copied: boolean;
  onCopy: () => void;
  onToggleVisibility: () => void;
  revealed: boolean;
  value: string;
};

export function CredentialsField({
  copied,
  onCopy,
  onToggleVisibility,
  revealed,
  value,
}: CredentialsFieldProps) {
  return (
    <ValueField
      actions={
        <button className="suite-copy-button" onClick={onToggleVisibility} type="button">
          {revealed ? (
            <EyeOff aria-hidden="true" className="suite-inline-icon" />
          ) : (
            <Eye aria-hidden="true" className="suite-inline-icon" />
          )}
          {revealed ? 'Hide' : 'View'}
        </button>
      }
      copied={copied}
      label="Credentials"
      onCopy={onCopy}
      value={revealed ? value : '................'}
      valueClassName={revealed ? 'suite-field-secret-value is-revealed' : 'suite-field-secret-value'}
    />
  );
}
