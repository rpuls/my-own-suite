import { AppShell } from './features/app-shell/AppShell';
import { LoginScreen } from './features/auth/LoginScreen';
import { OwnerSetupScreen } from './features/setup/OwnerSetupScreen';
import { useSetupSession } from './features/setup/useSetupSession';

export default function App() {
  const { createOwner, login, logout, state } = useSetupSession();

  if (state.kind === 'loading') {
    return (
      <main className="suite-app">
        <section className="mos-shell suite-auth-layout">
          <div className="suite-auth-stage">
            <span className="mos-eyebrow">My Own Suite</span>
            <h1 className="mos-page-title">Loading Suite Manager</h1>
          </div>
        </section>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="suite-app">
        <section className="mos-shell suite-auth-layout">
          <div className="mos-panel suite-card suite-auth-card">
            <h1 className="mos-card-title">Suite Manager could not start</h1>
            <p className="suite-error">{state.message}</p>
          </div>
        </section>
      </main>
    );
  }

  if (state.kind === 'needs-owner') {
    return <OwnerSetupScreen error={state.error} onCreateOwner={createOwner} />;
  }

  if (state.kind === 'signed-out') {
    return <LoginScreen error={state.error} owner={state.owner} onLogin={login} />;
  }

  return <AppShell onLogout={logout} owner={state.owner} />;
}
