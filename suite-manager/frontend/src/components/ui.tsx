import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

export type IconName = 'apps' | 'backup' | 'check' | 'chevron-right' | 'copy' | 'customize' | 'dashboard' | 'external' | 'eye' | 'eye-off' | 'hard-drive' | 'menu' | 'more' | 'network-drive' | 'refresh' | 'screens' | 'settings' | 'sign-out' | 'update' | 'upload' | 'usb-drive' | 'x';

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    apps: <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><path d="M14 17.5h7M17.5 14v7" /></>,
    backup: <><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" /><path d="M8 15h8M9 9h6M9 12h6" /></>,
    check: <path d="M5 13l4 4 10-10" />,
    'chevron-right': <path d="M9 6l6 6-6 6" />,
    copy: <><rect height="14" rx="2" ry="2" width="14" x="8" y="8" /><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2" /></>,
    customize: <><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    dashboard: <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><rect height="7" rx="1" width="7" x="14" y="14" /></>,
    external: <path d="M7 17L17 7M9 7h8v8" />,
    eye: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
    'eye-off': <><path d="M10.6 6.2A9.8 9.8 0 0 1 12 6c6.4 0 10 6 10 6a17.6 17.6 0 0 1-3 3.6" /><path d="M6.3 7.7A17.6 17.6 0 0 0 2 12s3.6 6 10 6a9.8 9.8 0 0 0 3.6-.7" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /><path d="m3 3 18 18" /></>,
    'hard-drive': <><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><line x1="3" x2="21" y1="9" y2="9" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    more: <><circle cx="12" cy="5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="19" r="1.2" /></>,
    'network-drive': <><circle cx="12" cy="12" r="3" /><path d="M12 1v4" /><path d="M12 19v4" /><path d="m4.93 4.93 2.83 2.83" /><path d="m16.24 16.24 2.83 2.83" /><path d="M1 12h4" /><path d="M19 12h4" /><path d="m4.93 19.07 2.83-2.83" /><path d="m16.24 7.76 2.83-2.83" /></>,
    refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M3 21v-5h5" /></>,
    screens: <path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" /></>,
    'sign-out': <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" /></>,
    update: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
    upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></>,
    'usb-drive': <><rect width="16" height="10" x="4" y="12" rx="2" /><path d="M2 8h20" /><path d="M6 8V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3" /></>,
    x: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg aria-hidden="true" className="suite-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">{paths[name]}</svg>;
}

export type ConnectApp = { iconUrl?: string; name: string };

// Connect-apps visual: one continuous line drawing of two rounded boxes, with
// a plug cable leaving the source app and a socket waiting on the app it plugs
// into. The app icons render inside the boxes as part of the SVG, falling back
// to initials when a package has no icon.
//
// This is the same mark the public site draws for "apps that work together"
// (site/src/components/AppConnect.astro); the geometry below must stay
// identical to that file, and the styling comes from the shared
// .mos-connect-visual branding class.
export function AppConnect({ size = 'md', source, target }: { size?: 'md' | 'sm'; source: ConnectApp; target: ConnectApp }) {
  const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('');
  const inset = (app: ConnectApp, x: number) => (app.iconUrl
    ? <image height="56" href={app.iconUrl} width="56" x={x} y="52" />
    : <text fill="currentColor" fontSize="34" fontWeight="800" textAnchor="middle" x={x + 28} y="92">{initials(app.name)}</text>);
  return <svg aria-label={`${source.name} plugs into ${target.name}`} className={`mos-connect-visual${size === 'sm' ? ' mos-connect-visual-sm' : ''}`} fill="none" role="img" viewBox="0 0 460 160">
    <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="7">
      <rect height="112" rx="26" width="112" x="12" y="24" />
      <rect height="112" rx="26" width="112" x="336" y="24" />
      <line x1="124" x2="172" y1="80" y2="80" />
      <path d="M 210 52 L 200 52 A 28 28 0 0 0 200 108 L 210 108 Z" />
      <line x1="210" x2="236" y1="66" y2="66" />
      <line x1="210" x2="236" y1="94" y2="94" />
      <path d="M 252 50 L 260 50 A 30 30 0 0 1 260 110 L 252 110 Z" />
      <line x1="290" x2="336" y1="80" y2="80" />
    </g>
    {inset(source, 40)}
    {inset(target, 364)}
  </svg>;
}

export function Drawer({ children, onClose, open, title }: { children: ReactNode; onClose: () => void; open: boolean; title: string }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = [...drawerRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);
  if (!open) return null;
  return createPortal(
    <div className="suite-drawer-layer"><button aria-label="Close navigation menu" className="suite-drawer-backdrop" onClick={onClose} tabIndex={-1} type="button" /><aside ref={drawerRef} aria-label={title} aria-modal="true" className="suite-drawer" role="dialog"><div className="suite-drawer-header"><strong>{title}</strong><button ref={closeRef} aria-label="Close navigation menu" className="suite-icon-button" onClick={onClose} title="Close menu" type="button"><Icon name="x" /></button></div>{children}</aside></div>,
    document.body,
  );
}

export function TextInput({ helperText, label, ...props }: InputHTMLAttributes<HTMLInputElement> & { helperText?: ReactNode; label: string }) {
  return <label className="suite-control"><span className="suite-field-label">{label}</span><input className="suite-input" {...props} />{helperText ? <span className="suite-control-help">{helperText}</span> : null}</label>;
}

export function TextArea({ helperText, label, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { helperText?: ReactNode; label: string }) {
  return <label className="suite-control"><span className="suite-field-label">{label}</span><textarea className="suite-input suite-textarea" {...props} />{helperText ? <span className="suite-control-help">{helperText}</span> : null}</label>;
}

export function Select({ children, helperText, label, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode; helperText?: ReactNode; label: string }) {
  return <label className="suite-control"><span className="suite-field-label">{label}</span><select className="suite-input suite-select" {...props}>{children}</select>{helperText ? <span className="suite-control-help">{helperText}</span> : null}</label>;
}

// The shared confirmation checkbox: a boxed, full-width row whose whole surface
// is the hit target. Used wherever a deliberate acknowledgement gates an action,
// so "I have read this" looks and behaves the same everywhere it is asked.
export function Checkbox({ children, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { children: ReactNode }) {
  return <label className="suite-confirm"><input className="suite-confirm-box" type="checkbox" {...props} /><span>{children}</span></label>;
}

// The shared setting switch: label and optional description on the left, the
// switch on the right, the whole row a hit target. Use it for a preference that
// takes effect the moment it is flipped.
//
// Deliberately a different control from Checkbox rather than a restyling of it.
// A checkbox is a deliberate acknowledgement that gates something else and is
// submitted with it ("I have read this"); a switch *is* the change, with no
// submit step to follow. Keeping the two distinct is what stops a third
// almost-fitting control appearing the next time neither is quite right.
export function Switch({ description, label, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { description?: ReactNode; label: ReactNode }) {
  return <label className="suite-switch">
    <span className="suite-switch-copy">
      <span className="suite-switch-label">{label}</span>
      {description ? <span className="suite-switch-help">{description}</span> : null}
    </span>
    {/* A real checkbox, only repainted: keyboard, focus and form semantics stay
        the platform's. The decorative track must remain its immediate sibling —
        the shared .mos-switch-* rules are written against that order. */}
    <input className="mos-switch-input" role="switch" type="checkbox" {...props} />
    <span aria-hidden="true" className="mos-switch-track"><span className="mos-switch-knob" /></span>
  </label>;
}

// The settings row: label left, value right, hairline between neighbours. One
// element covers every line of app configuration, and the only distinction it
// draws is colour â€” a value in text-strong can be typed into, a value in
// text-muted is a fact. Deliberately not a disabled input for the read-only
// case: a disabled field says "not yet", and these values need to say "this is
// how it is". Its look lives in the shared branding stylesheet as .mos-row*, so
// the same row appears identically wherever it is used.
export function Rows({ children, lead = false }: { children: ReactNode; lead?: boolean }) {
  return <div className={`mos-rows${lead ? ' mos-rows-lead' : ''}`}>{children}</div>;
}

export function Row({ children, help, helpTone = 'muted', label, layout = 'inline' }: {
  children?: ReactNode;
  help?: ReactNode;
  helpTone?: 'invalid' | 'muted' | 'permanent';
  label: ReactNode;
  // "stacked" puts the label on its own line above a full-width control. Use it
  // for a row the owner types into; a row that only shows a value, or carries a
  // switch or a button, stays inline.
  layout?: 'inline' | 'stacked';
}) {
  return <div className={`mos-row${layout === 'stacked' ? ' mos-row-stacked' : ''}`}>
    <div className="mos-row-main"><span className="mos-row-label">{label}</span>{children}</div>
    {help ? <p className={`mos-row-help${helpTone === 'permanent' ? ' mos-row-help-permanent' : ''}${helpTone === 'invalid' ? ' mos-row-invalid' : ''}`} role={helpTone === 'invalid' ? 'alert' : undefined}>{help}</p> : null}
  </div>;
}

// Groups a value with the controls that act on it, so the pair stays one
// right-hand item however narrow the row gets.
export function RowTrailing({ children }: { children: ReactNode }) {
  return <span className="mos-row-trailing">{children}</span>;
}

export function RowValue({ children, code, mask }: { children?: ReactNode; code?: boolean; mask?: boolean }) {
  return <span className={`mos-row-value${code ? ' mos-row-code' : ''}${mask ? ' mos-row-mask' : ''}`}>
    {mask ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : children}
  </span>;
}

// `state` is for a field the form is actually waiting on: "missing" marks one
// that is required and still empty, "filled" one that is required and given, so
// a glance at the dialog says what is left to do. A field nothing is blocked on
// passes no state and stays neutral — colouring those too would make the two
// that matter disappear into the noise.
export function RowInput({ code, state, ...props }: InputHTMLAttributes<HTMLInputElement> & { code?: boolean; state?: 'filled' | 'missing' }) {
  return <input className={`mos-row-input${code ? ' mos-row-code' : ''}${state ? ` mos-row-input-${state}` : ''}`} {...props} />;
}

export function RowAction({ danger, icon, label, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & { danger?: boolean; icon: IconName; label: string }) {
  return <button aria-label={label} className={`mos-row-action${danger ? ' mos-row-action-danger' : ''}`} title={label} type="button" {...props}><Icon name={icon} /></button>;
}

// A switch row: the whole row is the hit target, which is why this renders a
// <label> rather than composing Row. Same track and knob as the boxed Switch â€”
// only the surround differs, so "on" reads the same everywhere.
export function RowSwitch({ description, label, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { description?: ReactNode; label: ReactNode }) {
  return <label className="mos-row">
    <span className="mos-row-main">
      <span className="mos-row-label">{label}</span>
      <input className="mos-switch-input" role="switch" type="checkbox" {...props} />
      <span aria-hidden="true" className="mos-switch-track"><span className="mos-switch-knob" /></span>
    </span>
    {description ? <span className="mos-row-help">{description}</span> : null}
  </label>;
}

export function Notice({ children, title, variant = 'info' }: { children: ReactNode; title: ReactNode; variant?: 'error' | 'info' | 'success' | 'warning' }) {
  return <div className={`suite-notice suite-notice-${variant}`} role={variant === 'error' ? 'alert' : 'status'}><strong>{title}</strong><div>{children}</div></div>;
}

export type AdvancedFact = { code?: boolean; label: string; value: string };

type TechnicalControls = { enabled: boolean; setEnabled: (next: boolean) => Promise<void> };

// Defaulting to off rather than throwing is deliberate: a subtree rendered
// outside the provider hides its technical surface instead of crashing, so the
// failure mode of a wiring mistake is the safe direction.
const TechnicalControlsContext = createContext<TechnicalControls>({ enabled: false, setEnabled: async () => {} });

export function TechnicalControlsProvider({ children, enabled, setEnabled }: { children: ReactNode; enabled: boolean; setEnabled: (next: boolean) => Promise<void> }) {
  const value = useMemo<TechnicalControls>(() => ({ enabled, setEnabled }), [enabled, setEnabled]);
  return <TechnicalControlsContext.Provider value={value}>{children}</TechnicalControlsContext.Provider>;
}

// Reading the preference directly is the exception, not the rule. AdvancedPanel
// gates itself, so a screen never writes `{enabled ? ... : null}` around a
// disclosure and a new advanced surface cannot leak because someone forgot to.
// Reach for this hook only when an entire section rather than a disclosure is
// technical-only, and say in a comment why the panel was not enough — otherwise
// the gating scatters back across the screens this component collected it from.
export function useTechnicalControls(): TechnicalControls {
  return useContext(TechnicalControlsContext);
}

// The one place Suite Manager shows technical surface: package ids, digests,
// ports, generated configuration, raw logs, and the manual overrides an owner
// owns. It decides its own visibility, which is why no call site may hand-roll
// a .suite-advanced disclosure — a unit test enforces that.
//
// `reveal` has no default because it is a judgement the author has to make.
// "on-failure" renders whatever the preference says, and is legal only where
// the surrounding UI is already reporting that something went wrong: a broken
// screen is the one place diagnostics help rather than intimidate, and
// CONTRIBUTING.md asks bug reporters to paste what is under this disclosure.
// "technical-mode" is everything else, and renders nothing at all — no hidden
// markup, nothing in the accessibility tree — until the owner opts in.
//
// `facts` and `output` take strings so the copy text can be derived from the
// same values that are displayed; a hand-passed `copyText` is a second copy of
// the same data waiting to go stale, so it stays an override for content that
// is neither. `children` renders below both and takes anything — a form, a
// textarea, a whole feature. The body is a grid, so a child gets the panel's own
// spacing and fills its width: right for a field or a fieldset, and the reason a
// row of buttons belongs in a .suite-editor-actions wrapper rather than loose in
// the panel.
export function AdvancedPanel({
  children,
  className,
  copyText,
  facts,
  layout = 'block',
  output,
  reveal,
  summary = 'Advanced details',
}: {
  children?: ReactNode;
  className?: string;
  copyText?: string | (() => string);
  facts?: AdvancedFact[];
  // "row" makes the disclosure one more line in a list of Rows — same height,
  // same hairline, chevron where a value would be. A variant of the shared
  // panel rather than a hand-rolled disclosure beside it, so a screen built
  // from rows does not have to choose between the row shape and this gating.
  layout?: 'block' | 'row';
  output?: string;
  reveal: 'on-failure' | 'technical-mode';
  summary?: string;
}) {
  const { enabled } = useTechnicalControls();
  const [copyState, setCopyState] = useState<'' | 'copied' | 'unavailable'>('');
  useEffect(() => {
    if (!copyState) return undefined;
    const timer = window.setTimeout(() => setCopyState(''), 2_000);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  if (reveal === 'technical-mode' && !enabled) return null;

  // Readable label/value lines rather than JSON: this text exists to be pasted
  // into a bug report and read by a person.
  const derived = [
    (facts || []).map((fact) => `${fact.label}: ${fact.value}`).join('\n'),
    output || '',
  ].filter(Boolean).join('\n\n');
  const resolveCopyText = () => (typeof copyText === 'function' ? copyText() : copyText ?? derived);
  const copyable = typeof copyText === 'function' || Boolean(copyText) || Boolean(derived);

  // MOS on plain HTTP is a non-secure origin with no navigator.clipboard, which
  // is the normal state of a fresh install rather than an edge case. Failing
  // visibly and leaving the text selectable is the whole recovery.
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(resolveCopyText());
      setCopyState('copied');
    } catch {
      setCopyState('unavailable');
    }
  }

  return <details className={`suite-advanced${layout === 'row' ? ' mos-row-disclosure' : ''}${className ? ` ${className}` : ''}`}>
    <summary>
      {layout === 'row' ? <><span className="mos-row-label">{summary}</span><span className="mos-row-chevron"><Icon name="chevron-right" /></span></> : summary}
    </summary>
    <div className="suite-advanced-body">
      {copyable ? <div className="suite-advanced-actions">
        <span className="suite-advanced-copy-state" role="status">{copyState === 'copied' ? 'Copied' : copyState === 'unavailable' ? 'Could not copy. Select the text instead.' : ''}</span>
        <button aria-label={`Copy ${summary.toLowerCase()}`} className="suite-icon-button" onClick={() => void copy()} title="Copy" type="button"><Icon name="copy" /></button>
      </div> : null}
      {facts?.length ? <dl>{facts.map((fact) => <Fragment key={fact.label}><dt>{fact.label}</dt><dd>{fact.code ? <code>{fact.value}</code> : fact.value}</dd></Fragment>)}</dl> : null}
      {output ? <pre>{output}</pre> : null}
      {children}
    </div>
  </details>;
}

export function Dialog({ children, className, closeOnBackdrop = false, footer, header, onClose, title }: { children: ReactNode; className?: string; closeOnBackdrop?: boolean; footer?: ReactNode; header?: ReactNode; onClose: () => void; title: string }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    if (!dialogRef.current?.contains(document.activeElement)) closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
  // Portalled to <body> for the same reason as Drawer and ActionMenu: a dialog
  // opened from inside a frosted surface (the app detail slide-over, any
  // .mos-panel) would otherwise take that ancestor as its containing block, so
  // `position: fixed` centres it on the panel instead of the screen and its
  // frost blurs nothing. Screen-centred and frosted is the only correct result.
  return createPortal(
    <div className="suite-modal-backdrop" onClick={closeOnBackdrop ? (event) => { if (event.target === event.currentTarget) onCloseRef.current(); } : undefined} role="presentation"><section ref={dialogRef} aria-label={title} aria-modal="true" className={`suite-dialog mos-panel${className ? ` ${className}` : ''}`} role="dialog"><div className="suite-dialog-header">{header ?? <h2>{title}</h2>}<button ref={closeRef} aria-label={`Close ${title}`} className="suite-icon-button" onClick={onClose} type="button"><Icon name="x" /></button></div>{children}{footer ? <div className="suite-dialog-footer">{footer}</div> : null}</section></div>,
    document.body,
  );
}

// Shared kebab ("...") action menu, used by every screen that needs one. The
// menu renders through a portal at body level like Dialog/Drawer: nested
// inside a frosted panel, an ancestor backdrop-filter becomes the popover's
// backdrop root and the frost blur never reaches the page, leaving unreadable
// text-on-text.
export function ActionMenu({ ariaLabel = 'More actions', disabled, items }: { ariaLabel?: string; disabled?: boolean; items: Array<{ label: string; onSelect: () => void }> }) {
  const [anchor, setAnchor] = useState<{ right: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  function toggle() {
    if (anchor) { setAnchor(null); return; }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ right: Math.max(8, window.innerWidth - rect.right), top: rect.bottom + 8 });
  }
  useEffect(() => {
    if (!anchor) return undefined;
    const close = () => setAnchor(null);
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [anchor]);
  return <>
    <button aria-expanded={Boolean(anchor)} aria-haspopup="menu" aria-label={ariaLabel} className="suite-icon-button" disabled={disabled} onClick={toggle} ref={buttonRef} title={ariaLabel} type="button"><Icon name="more" /></button>
    {anchor ? createPortal(
      <div className="mos-overlay suite-actions-popover" ref={menuRef} role="menu" style={{ right: anchor.right, top: anchor.top }}>
        {items.map((item) => <button key={item.label} onClick={() => { setAnchor(null); item.onSelect(); }} role="menuitem" type="button">{item.label}</button>)}
      </div>,
      document.body,
    ) : null}
  </>;
}

export function Stepper({ currentStepIndex, steps }: { currentStepIndex: number; steps: string[] }) {
  return <div className="suite-stepper" aria-label="Progress">{steps.map((step, index) => <span aria-current={index === currentStepIndex ? 'step' : undefined} className={index === currentStepIndex ? 'is-active' : ''} key={step}>{index + 1}. {step}</span>)}</div>;
}

export function Spinner() {
  return <svg className="suite-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
  </svg>;
}
