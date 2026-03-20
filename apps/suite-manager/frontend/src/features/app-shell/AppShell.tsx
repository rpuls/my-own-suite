import { useState } from 'react';

import OnboardingApp from '../onboarding/main/OnboardingApp';
import { withSetupPath } from '../../lib/base-path';
import { useAppRoute } from './useAppRoute';

type AppShellProps = {
  onLogout: () => Promise<void>;
  ownerName: string;
};

export function AppShell({ onLogout, ownerName }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { navigate, route } = useAppRoute();

  function openRoute(path: '/' | '/onboarding'): void {
    setMenuOpen(false);
    if (path === '/') {
      window.location.assign('/');
      return;
    }
    navigate(path);
  }

  function renderRoute() {
    if (route === 'onboarding') {
      return <OnboardingApp />;
    }

    return (
      <section className="mos-shell">
        <div className="mos-panel suite-card">
          <h2>Page not found</h2>
          <p className="suite-meta">This route is not wired yet. Go back to the onboarding flow from the menu.</p>
        </div>
      </section>
    );
  }

  return (
    <div className="suite-shell">
      <header className="suite-shell-header">
        <div className="suite-shell-brand">
          <img
            alt=""
            className="suite-shell-mark"
            height="40"
            src={withSetupPath('/brand/my-own-suite-mark.png')}
            width="40"
          />
          <div className="suite-shell-title">
            <span className="mos-eyebrow">My Own Suite</span>
            <strong>Suite Manager</strong>
          </div>
        </div>

        <div className="suite-shell-menu">
          <button
            aria-expanded={menuOpen}
            aria-label="Toggle navigation menu"
            className="suite-menu-button"
            onClick={() => setMenuOpen((current) => !current)}
            type="button"
          >
            Menu
          </button>

          {menuOpen ? (
            <div className="suite-menu-popover">
              <p className="suite-meta">Signed in as {ownerName}</p>

              <nav className="suite-shell-nav-links">
                <button
                  className={`suite-shell-link ${route === 'homepage' ? 'is-active' : ''}`}
                  onClick={() => openRoute('/')}
                  type="button"
                >
                  Homepage
                </button>

                <button
                  className={`suite-shell-link ${route === 'onboarding' ? 'is-active' : ''}`}
                  onClick={() => openRoute('/onboarding')}
                  type="button"
                >
                  Onboarding
                </button>
              </nav>

              <button className="suite-subtle-button" onClick={() => void onLogout()} type="button">
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="suite-shell-main">{renderRoute()}</div>
    </div>
  );
}
