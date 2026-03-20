import type { FormEvent } from 'react';
import { useState } from 'react';

type LoginScreenProps = {
  error: string | null;
  onLogin: (email: string, password: string) => Promise<void>;
};

export function LoginScreen({ error, onLogin }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);

    try {
      await onLogin(email, password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="suite-app">
      <section className="mos-shell suite-auth-layout">
        <div className="suite-auth-stage">
          <div className="suite-auth-brand">
            <img
              alt=""
              className="suite-auth-mark"
              height="56"
              src="./brand/my-own-suite-mark.png"
              width="56"
            />
            <span className="mos-eyebrow">My Own Suite</span>
          </div>
          <h1>Please sign in</h1>
          <p className="suite-lead">Your digital independence awaits you.</p>

          <div className="mos-panel suite-card suite-auth-card">
            <div className="suite-auth-card-header">
              <h2>Sign in</h2>
            </div>

            <form className="suite-auth-form" onSubmit={(event) => void handleSubmit(event)}>
              <label className="suite-auth-field">
                <span>Email</span>
                <input
                  autoComplete="username"
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  type="email"
                  value={email}
                />
              </label>

              <label className="suite-auth-field">
                <span>Password</span>
                <input
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
              </label>

              {error ? <p className="suite-error">{error}</p> : null}

              <button className="mos-btn mos-btn-primary" disabled={submitting} type="submit">
                {submitting ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
