import { useEffect, useRef, type InputHTMLAttributes, type ReactNode } from 'react';

export type IconName = 'dashboard' | 'menu' | 'settings' | 'sign-out' | 'x';

export function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    dashboard: <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><rect height="7" rx="1" width="7" x="14" y="14" /></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
    'sign-out': <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" /></>,
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

export function TextInput({ helperText, label, ...props }: InputHTMLAttributes<HTMLInputElement> & { helperText?: string; label: string }) {
  return <label className="suite-field"><span>{label}</span><input {...props} />{helperText ? <small>{helperText}</small> : null}</label>;
}

export function Notice({ children, title, variant = 'info' }: { children: ReactNode; title: string; variant?: 'error' | 'info' | 'success' | 'warning' }) {
  return <div className={`suite-notice suite-notice-${variant}`} role={variant === 'error' ? 'alert' : 'status'}><strong>{title}</strong><div>{children}</div></div>;
}
