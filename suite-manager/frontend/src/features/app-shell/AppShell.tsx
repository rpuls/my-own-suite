import { Component, useCallback, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';

import { Drawer, Icon, Notice } from '../../components/ui';
import { useStaleFrontend } from '../../frontend-build';
import { AppsScreen } from '../apps/AppsScreen';
import { BackupsScreen } from '../backups/BackupsScreen';
import { DashboardScreen } from '../dashboard/DashboardScreen';
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
  const staleFrontend = useStaleFrontend();
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

      {/* Dashboard and Customize are one row: the link opens the dashboard, the
          pencil beside it edits that same dashboard. Two menu entries for one
          thing made the menu longer without making it clearer. */}
      <Drawer onClose={closeMenu} open={menuOpen} title="Suite Manager menu"><nav aria-label="Suite Manager menu" className="suite-nav">
        <div className="suite-nav-row">
          <a href="/"><Icon name="dashboard" />Dashboard</a>
          <button aria-current={route === 'customize' ? 'page' : undefined} aria-label="Customize dashboard" className="suite-nav-edit" onClick={() => navigate('customize', '/suite-manager/customize')} title="Customize dashboard" type="button"><Icon name="customize" /></button>
        </div>
        <button aria-current={route === 'apps' ? 'page' : undefined} onClick={() => navigate('apps', '/suite-manager/apps')} type="button"><Icon name="apps" />Apps</button>
        <button aria-current={route === 'backups' ? 'page' : undefined} onClick={() => navigate('backups', '/suite-manager/backups')} type="button"><Icon name="backup" />Backup</button>
        <button aria-current={route === 'updates' ? 'page' : undefined} onClick={() => navigate('updates', '/suite-manager/updates')} type="button"><Icon name="update" />Updates</button>
        <button aria-current={route === 'settings' ? 'page' : undefined} onClick={() => navigate('settings', '/suite-manager/settings')} type="button"><Icon name="settings" />Settings</button>
        <button onClick={() => { closeMenu(); void onLogout(); }} type="button"><Icon name="sign-out" />Sign out</button>
      </nav></Drawer>

      {/* Offered rather than done: this tab did not ask for the update and may
          be in the middle of an install or a half-typed dialog, and reloading
          it from under someone throws that away. The Updates screen reloads
          itself instead, because there the owner started it and is watching. */}
      {staleFrontend ? <div className="mos-shell suite-shell-stale">
        <Notice title="MOS was updated" variant="info">
          <p>This page is still running the version it was opened with. Reload to pick up the new one.</p>
          <button className="mos-btn mos-btn-primary" onClick={() => window.location.reload()} type="button">Reload</button>
        </Notice>
      </div> : null}

      <main className="suite-shell-main">
        <RouteBoundary key={route}>{route === 'settings' ? <SettingsScreen /> : route === 'updates' ? <UpdatesScreen /> : route === 'backups' ? <BackupsScreen /> : route === 'customize' ? <CustomizeScreen /> : route === 'apps' ? <AppsScreen owner={owner} /> : (
          <DashboardScreen onNavigate={navigate} owner={owner} />
        )}</RouteBoundary>
      </main>
    </div>
  );
}
