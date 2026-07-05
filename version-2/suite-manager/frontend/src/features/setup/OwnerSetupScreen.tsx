import type { FormEvent } from 'react';
import { useState } from 'react';

type OwnerSetupScreenProps = {
  error: string | null;
  onCreateOwner: (input: { email: string; name: string; password: string }) => Promise<void>;
};

export function OwnerSetupScreen({ error, onCreateOwner }: OwnerSetupScreenProps) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);

    try {
      await onCreateOwner({ email, name, password });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="suite-app">
      <section className="mos-shell suite-auth-layout suite-first-run">
        <div className="suite-auth-stage">
          <div className="suite-auth-brand">
            <img
              alt=""
              className="suite-auth-mark"
              height="56"
              src="/suite-manager/assets/brand/my-own-suite-mark.png"
              width="56"
            />
            <span className="mos-eyebrow">My Own Suite</span>
          </div>

          <div className="suite-auth-copy">
            <h1 className="mos-page-title">Create your MOS owner account</h1>
            <p className="suite-lead mos-body-lg">
              This first account controls Suite Manager and the future app platform on this machine.
            </p>
          </div>

          <div className="mos-panel suite-card suite-auth-card">
            <div className="suite-auth-card-header">
              <h2 className="mos-card-title">Owner details</h2>
            </div>

            <form className="suite-auth-form" onSubmit={(event) => void handleSubmit(event)}>
              <label className="suite-auth-field">
                <span>Name</span>
                <input
                  autoComplete="name"
                  onChange={(event) => setName(event.target.value)}
                  required
                  type="text"
                  value={name}
                />
              </label>

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
                  autoComplete="new-password"
                  minLength={12}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  type="password"
                  value={password}
                />
                <small>Use at least 12 characters.</small>
              </label>

              {error ? <p className="suite-error">{error}</p> : null}

              <button className="mos-btn mos-btn-primary" disabled={submitting} type="submit">
                {submitting ? 'Creating owner...' : 'Create owner'}
              </button>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}
