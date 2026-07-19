import { useEffect, useRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

export type IconName = 'apps' | 'backup' | 'customize' | 'dashboard' | 'hard-drive' | 'menu' | 'more' | 'network-drive' | 'refresh' | 'settings' | 'sign-out' | 'usb-drive' | 'x';

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    apps: <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><path d="M14 17.5h7M17.5 14v7" /></>,
    backup: <><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" /><path d="M8 15h8M9 9h6M9 12h6" /></>,
    customize: <><path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
    dashboard: <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><rect height="7" rx="1" width="7" x="14" y="14" /></>,
    'hard-drive': <><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><line x1="3" x2="21" y1="9" y2="9" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    more: <><circle cx="12" cy="5" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="12" cy="19" r="1.2" /></>,
    'network-drive': <><circle cx="12" cy="12" r="3" /><path d="M12 1v4" /><path d="M12 19v4" /><path d="m4.93 4.93 2.83 2.83" /><path d="m16.24 16.24 2.83 2.83" /><path d="M1 12h4" /><path d="M19 12h4" /><path d="m4.93 19.07 2.83-2.83" /><path d="m16.24 7.76 2.83-2.83" /></>,
    refresh: <><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M3 21v-5h5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4MOS1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    'sign-out': <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" /></>,
    'usb-drive': <><rect width="16" height="10" x="4" y="12" rx="2" /><path d="M2 8h20" /><path d="M6 8V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v3" /></>,
    x: <path d="m6 6 12 12M18 6 6 18" />,
  };
  return <svg aria-hidden="true" className="suite-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">{paths[name]}</svg>;
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
  return <div className="suite-drawer-layer"><button aria-label="Close navigation menu" className="suite-drawer-backdrop" onClick={onClose} tabIndex={-1} type="button" /><aside ref={drawerRef} aria-label={title} aria-modal="true" className="suite-drawer" role="dialog"><div className="suite-drawer-header"><strong>{title}</strong><button ref={closeRef} aria-label="Close navigation menu" className="suite-icon-button" onClick={onClose} title="Close menu" type="button"><Icon name="x" /></button></div>{children}</aside></div>;
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
  return <div className="suite-modal-backdrop" onClick={closeOnBackdrop ? (event) => { if (event.target === event.currentTarget) onCloseRef.current(); } : undefined} role="presentation"><section ref={dialogRef} aria-label={title} aria-modal="true" className={`suite-dialog mos-panel${className ? ` ${className}` : ''}`} role="dialog"><div className="suite-dialog-header">{header ?? <h2>{title}</h2>}<button ref={closeRef} aria-label={`Close ${title}`} className="suite-icon-button" onClick={onClose} type="button"><Icon name="x" /></button></div>{children}{footer ? <div className="suite-dialog-footer">{footer}</div> : null}</section></div>;
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
