import { useCallback, useEffect, useState } from 'react';

import { Drawer, Icon } from '../../components/ui';
import { SettingsScreen } from '../settings/SettingsScreen';
import type { Owner } from '../setup/types';

type AppShellProps = {
  onLogout: () => Promise<void>;
  owner: Owner;
};

export function AppShell({ onLogout, owner }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [route, setRoute] = useState(() => window.location.pathname.endsWith('/settings') ? 'settings' : 'dashboard');
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    const update = () => setRoute(window.location.pathname.endsWith('/settings') ? 'settings' : 'dashboard');
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  function openSettings() {
    window.history.pushState({}, '', '/suite-manager/settings');
    setRoute('settings');
    closeMenu();
  }

  return (
    <div className="suite-shell">
      <header className="suite-shell-header">
        <div className="suite-shell-brand">
          <img
            alt=""
            className="suite-shell-mark"
            height="40"
            src="/suite-manager/assets/brand/my-own-suite-mark.png"
            width="40"
          />
          <div className="suite-shell-title">
            <span className="mos-eyebrow">My Own Suite</span>
            <strong className="mos-card-title">Suite Manager</strong>
          </div>
        </div>

        <button aria-expanded={menuOpen} aria-haspopup="dialog" aria-label="Open navigation menu" className="suite-icon-button" onClick={() => setMenuOpen(true)} title="Menu" type="button"><Icon name="menu" /></button>
      </header>

      <Drawer onClose={closeMenu} open={menuOpen} title="Suite Manager menu"><nav className="suite-nav"><a href="/"><Icon name="dashboard" />Dashboard</a><button aria-current={route === 'settings' ? 'page' : undefined} onClick={openSettings} type="button"><Icon name="settings" />Settings</button><button onClick={() => { closeMenu(); void onLogout(); }} type="button"><Icon name="sign-out" />Sign out</button></nav></Drawer>

      <main className="suite-shell-main">
        {route === 'settings' ? <SettingsScreen /> : (
        <section className="mos-shell suite-dashboard">
          <div className="suite-hero">
            <span className="mos-pill mos-pill-accent">Control plane</span>
            <h1>Suite Manager is ready</h1>
            <p className="suite-lead mos-body-lg">
              Owner setup is complete. App installs, platform settings, and host-agent controls will grow from here.
            </p>
          </div>

          <div className="suite-dashboard-grid">
            <section className="mos-panel suite-card suite-status-card">
              <h2 className="mos-card-title">Signed in</h2>
              <p className="suite-meta mos-meta">Owner</p>
              <strong>{owner.name}</strong>
              <span>{owner.email}</span>
            </section>

            <section className="mos-panel suite-card suite-status-card">
              <h2 className="mos-card-title">Platform state</h2>
              <p className="suite-meta mos-meta">Current milestone</p>
              <strong>Owner onboarding</strong>
              <span>No optional apps are installed by this slice.</span>
            </section>
          </div>
        </section>
        )}
      </main>
    </div>
  );
}
