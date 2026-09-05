import { cn } from '@/lib/utils';

// The MOS switch, following the structure contract in mos.css: a visually
// hidden real checkbox with role="switch" immediately followed by the
// decorative track, both inside the <label> that carries the copy — keyboard,
// focus, and form semantics stay the platform's, the look is the brand's.
function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <>
      <input
        type="checkbox"
        role="switch"
        className="mos-switch-input"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange?.(event.target.checked)}
      />
      <span className={cn('mos-switch-track', className)} aria-hidden="true">
        <span className="mos-switch-knob" />
      </span>
    </>
  );
}

export { Switch };
