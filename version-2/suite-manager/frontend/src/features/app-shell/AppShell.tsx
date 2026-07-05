import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';

import { Drawer, Icon } from '../../components/ui';
import { AppsScreen } from '../apps/AppsScreen';
import { BackupsScreen } from '../backups/BackupsScreen';
import { SettingsScreen } from '../settings/SettingsScreen';
import { CustomizeScreen } from '../customize/CustomizeScreen';
import { UpdatesScreen } from '../updates/UpdatesScreen';
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
  const routeForPath = () => window.location.pathname.endsWith('/settings') ? 'settings' : window.location.pathname.endsWith('/updates') ? 'updates' : window.location.pathname.endsWith('/backups') ? 'backups' : window.location.pathname.endsWith('/customize') ? 'customize' : window.location.pathname.endsWith('/apps') ? 'apps' : 'dashboard';
  const [route, setRoute] = useState(routeForPath);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useEffect(() => {
    const update = () => setRoute(routeForPath());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  function navigate(nextRoute: 'apps' | 'backups' | 'customize' | 'settings' | 'updates', path: string) {
    window.history.pushState({}, '', path);
    setRoute(nextRoute);
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

      <Drawer onClose={closeMenu} open={menuOpen} title="Suite Manager menu"><nav aria-label="Suite Manager menu" className="suite-nav"><a href="/"><Icon name="dashboard" />Dashboard</a><button aria-current={route === 'apps' ? 'page' : undefined} onClick={() => navigate('apps', '/suite-manager/apps')} type="button"><Icon name="apps" />Apps</button><button aria-current={route === 'customize' ? 'page' : undefined} onClick={() => navigate('customize', '/suite-manager/customize')} type="button"><Icon name="customize" />Customize</button><button aria-current={route === 'backups' ? 'page' : undefined} onClick={() => navigate('backups', '/suite-manager/backups')} type="button"><Icon name="backup" />Backup</button><button aria-current={route === 'updates' ? 'page' : undefined} onClick={() => navigate('updates', '/suite-manager/updates')} type="button"><Icon name="settings" />Updates</button><button aria-current={route === 'settings' ? 'page' : undefined} onClick={() => navigate('settings', '/suite-manager/settings')} type="button"><Icon name="settings" />Settings</button><button onClick={() => { closeMenu(); void onLogout(); }} type="button"><Icon name="sign-out" />Sign out</button></nav></Drawer>

      <main className="suite-shell-main">
        <RouteBoundary key={route}>{route === 'settings' ? <SettingsScreen /> : route === 'updates' ? <UpdatesScreen /> : route === 'backups' ? <BackupsScreen /> : route === 'customize' ? <CustomizeScreen /> : route === 'apps' ? <AppsScreen owner={owner} /> : (
        <section className="mos-shell suite-dashboard">
          <div className="suite-hero">
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
