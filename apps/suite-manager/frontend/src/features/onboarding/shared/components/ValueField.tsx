import { Copy, QrCode } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type ReactNode } from 'react';

type ValueFieldProps = {
  actions?: ReactNode;
  copied?: boolean;
  disabled?: boolean;
  label: string;
  onCopy?: () => Promise<void> | void;
  qrAlt?: string;
  qrValue?: string;
  value: string;
  valueClassName?: string;
};

export function ValueField({
  actions,
  copied = false,
  disabled = false,
  label,
  onCopy,
  qrAlt,
  qrValue,
  value,
  valueClassName,
}: ValueFieldProps) {
  const [showQr, setShowQr] = useState(false);
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [localCopied, setLocalCopied] = useState(false);
  const isCopied = copied || localCopied;

  useEffect(() => {
    if (!showQr || !qrValue) {
      return;
    }

    let cancelled = false;

    void QRCode.toDataURL(qrValue, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
    }).then((src) => {
      if (!cancelled) {
        setQrSrc(src);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [qrValue, showQr]);

  async function handleCopy(): Promise<void> {
    if (!onCopy) {
      return;
    }

    await onCopy();
    setLocalCopied(true);
    window.setTimeout(() => {
      setLocalCopied(false);
    }, 1400);
  }

  return (
    <div className="suite-field">
      <div className="suite-field-header">
        <span className="suite-field-label mos-label">{label}</span>
        <div className="suite-field-actions">
          {actions}
          {qrValue ? (
            <button
              className="suite-copy-button"
              disabled={disabled}
              onClick={() => setShowQr((current) => !current)}
              title="Show this value as a QR code so you can copy it with your camera app"
              type="button"
            >
              <QrCode aria-hidden="true" className="suite-inline-icon" />
              {showQr ? 'Hide QR' : 'Show QR'}
            </button>
          ) : null}
          {onCopy ? (
            <button className="suite-copy-button" disabled={disabled} onClick={() => void handleCopy()} type="button">
              <Copy aria-hidden="true" className="suite-inline-icon" />
              {isCopied ? 'Copied' : 'Copy'}
            </button>
          ) : null}
        </div>
      </div>
      <span className={valueClassName ? `suite-field-value ${valueClassName}` : 'suite-field-value'}>{value}</span>
      {showQr && qrSrc ? (
        <div className="suite-qr-card suite-field-qr">
          <img alt={qrAlt || `${label} QR code`} className="suite-qr-image" src={qrSrc} />
          <span className="suite-qr-caption mos-meta">Scan to get this value onto another device.</span>
        </div>
      ) : null}
    </div>
  );
}
