import type { Owner } from '../setup/types';

type AppShellProps = {
  onLogout: () => Promise<void>;
  owner: Owner;
};

export function AppShell({ onLogout, owner }: AppShellProps) {
  return (
    <div className="suite-shell">
      <header className="suite-shell-header">
        <div className="suite-shell-brand">
          <img
            alt=""
            className="suite-shell-mark"
            height="40"
            src="/brand/my-own-suite-mark.png"
            width="40"
          />
          <div className="suite-shell-title">
            <span className="mos-eyebrow">My Own Suite</span>
            <strong className="mos-card-title">Suite Manager</strong>
          </div>
        </div>

        <button className="mos-btn mos-btn-secondary" onClick={() => void onLogout()} type="button">
          Sign out
        </button>
      </header>

      <main className="suite-shell-main">
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
      </main>
    </div>
  );
}
