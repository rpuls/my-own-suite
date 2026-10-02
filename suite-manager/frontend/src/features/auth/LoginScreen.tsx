import type { FormEvent } from 'react';
import { useState } from 'react';

import { AuthStage } from '../../components/AuthStage';
import type { Owner } from '../setup/types';

type LoginScreenProps = {
  error: string | null;
  onLogin: (input: { email: string; password: string; owner: Owner }) => Promise<void>;
  owner: Owner;
};

export function LoginScreen({ error, onLogin, owner }: LoginScreenProps) {
  const [email, setEmail] = useState(owner.email);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);

    try {
      await onLogin({ email, owner, password });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthStage>
      <div className="suite-auth-copy">
        <h1 className="mos-page-title">Welcome back</h1>
        <p className="suite-lead mos-body-lg">Sign in as the MOS owner to open Suite Manager.</p>
      </div>

      <div className="mos-panel suite-card suite-auth-card">
        <div className="suite-auth-card-header">
          <h2 className="mos-card-title">Sign in</h2>
          <p className="suite-meta mos-meta">Owner account created for {owner.name}.</p>
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
    </AuthStage>
  );
}
