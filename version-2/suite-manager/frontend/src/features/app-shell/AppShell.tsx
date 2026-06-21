import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';

import { Drawer, Icon } from '../../components/ui';
import { SettingsScreen } from '../settings/SettingsScreen';
import { CustomizeScreen } from '../customize/CustomizeScreen';
import type { Owner } from '../setup/types';

type AppShellProps = {
  onLogout: () => Promise<void>;
  owner: Owner;
};

class RouteBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Suite Manager page failed to render.', error, info); }
  render() {
    if (this.state.failed) return <section className="mos-shell"><div className="mos-panel suite-card"><h1 className="mos-card-title">This page could not load</h1><p>The Suite Manager navigation is still available. Reload the page to try again.</p></div></section>;
    return this.props.children;
  }
}

export function AppShell({ onLogout, owner }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const routeForPath = () => window.location.pathname.endsWith('/settings') ? 'settings' : window.location.pathname.endsWith('/customize') ? 'customize' : 'dashboard';
  const [route, setRoute] = useState(routeForPath);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    const update = () => setRoute(routeForPath());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  function openSettings() {
    window.history.pushState({}, '', '/suite-manager/settings');
    setRoute('settings');
    closeMenu();
  }

  function openCustomize() {
    window.history.pushState({}, '', '/suite-manager/customize');
    setRoute('customize');
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

      <Drawer onClose={closeMenu} open={menuOpen} title="Suite Manager menu"><nav aria-label="Suite Manager menu" className="suite-nav"><a href="/"><Icon name="dashboard" />Dashboard</a><button aria-current={route === 'customize' ? 'page' : undefined} onClick={openCustomize} type="button"><Icon name="customize" />Customize</button><button aria-current={route === 'settings' ? 'page' : undefined} onClick={openSettings} type="button"><Icon name="settings" />Settings</button><button onClick={() => { closeMenu(); void onLogout(); }} type="button"><Icon name="sign-out" />Sign out</button></nav></Drawer>

      <main className="suite-shell-main">
        <RouteBoundary key={route}>{route === 'settings' ? <SettingsScreen /> : route === 'customize' ? <CustomizeScreen /> : (
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
        )}</RouteBoundary>
      </main>
    </div>
  );
}
