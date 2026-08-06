import { useEffect, useRef, useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

export type IconName = 'apps' | 'backup' | 'check' | 'chevron-right' | 'customize' | 'dashboard' | 'external' | 'hard-drive' | 'menu' | 'more' | 'network-drive' | 'refresh' | 'settings' | 'sign-out' | 'update' | 'upload' | 'usb-drive' | 'x';

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    apps: <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><path d="M14 17.5h7M17.5 14v7" /></>,
    backup: <><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" /><path d="M8 15h8M9 9h6M9 12h6" /></>,
    check: <path d="M5 13l4 4 10-10" />,
    'chevron-right': <path d="M9 6l6 6-6 6" />,
    customize: <><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    dashboard: <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><rect height="7" rx="1" width="7" x="14" y="14" /></>,
    external: <path d="M7 17L17 7M9 7h8v8" />,
    'hard-drive': <><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><line x1="3" x2="21" y1="9" y2="9" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    more: <><circle cx="12" cy="5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="19" r="1.2" /></>,
    'network-drive': <><circle cx="12" cy="12" r="3" /><path d="M12 1v4" /><path d="M12 19v4" /><path d="m4.93 4.93 2.83 2.83" /><path d="m16.24 16.24 2.83 2.83" /><path d="M1 12h4" /><path d="M19 12h4" /><path d="m4.93 19.07 2.83-2.83" /><path d="m16.24 7.76 2.83-2.83" /></>,
    refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M3 21v-5h5" /></>,
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

export function Notice({ children, title, variant = 'info' }: { children: ReactNode; title: ReactNode; variant?: 'error' | 'info' | 'success' | 'warning' }) {
  return <div className={`suite-notice suite-notice-${variant}`} role={variant === 'error' ? 'alert' : 'status'}><strong>{title}</strong><div>{children}</div></div>;
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
