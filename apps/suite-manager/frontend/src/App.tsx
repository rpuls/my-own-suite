import { AppShell } from './features/app-shell/AppShell';
import { LoginScreen } from './features/auth/LoginScreen';
import { useSession } from './features/auth/useSession';

export default function App() {
  const { login, logout, state } = useSession();

  if (state.kind === 'loading') {
    return (
      <main className="suite-app">
        <section className="mos-shell suite-hero">
          <span className="mos-eyebrow">My Own Suite</span>
          <h1>Loading Suite Manager</h1>
        </section>
      </main>
    );
  }

  if (state.kind === 'error') {
    return (
      <main className="suite-app">
        <section className="mos-shell">
          <div className="mos-panel suite-card">
            <p className="suite-error">{state.message}</p>
          </div>
        </section>
      </main>
    );
  }

  if (state.kind === 'unauthenticated') {
    return <LoginScreen error={state.error} onLogin={login} />;
  }

  return <AppShell onLogout={logout} ownerName={state.owner.name} />;
}
