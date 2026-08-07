import type { FormEvent } from 'react';
import { useState } from 'react';

import { Notice } from '../../components/ui';

type OwnerSetupScreenProps = {
  error: string | null;
  onClearError: () => void;
  onCreateOwner: (input: { claimToken: string; email: string; name: string; password: string }) => Promise<void>;
  ownerClaimRequired: boolean;
};

function claimKeyFromUrl(): string {
  return new URLSearchParams(window.location.search).get('claim') || '';
}

// Forgiving paste: accept the bare key, the whole MOS_OWNER_CLAIM_TOKEN=... line, or a quoted value.
function normalizeClaimKey(raw: string): string {
  return raw.trim().replace(/^MOS_OWNER_CLAIM_TOKEN=/u, '').replace(/^["']+|["']+$/gu, '').trim();
}

export function OwnerSetupScreen({ error, onClearError, onCreateOwner, ownerClaimRequired }: OwnerSetupScreenProps) {
  const [claimKey, setClaimKey] = useState(claimKeyFromUrl);
  const [keyEditorOpen, setKeyEditorOpen] = useState(() => ownerClaimRequired && !claimKeyFromUrl());
  const [keyDraft, setKeyDraft] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const shownError = formError ?? error;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    if (password !== confirmPassword) {
      setFormError("Those passwords don't match. Please retype them.");
      return;
    }

    setFormError(null);
    setSubmitting(true);

    try {
      await onCreateOwner({ claimToken: claimKey, email, name, password });
    } finally {
      setSubmitting(false);
    }
  }

  function confirmKey(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextKey = normalizeClaimKey(keyDraft);

    if (!nextKey) {
      return;
    }

    setClaimKey(nextKey);
    setKeyEditorOpen(false);
    onClearError();
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
            <h1 className="mos-page-title">Create your owner account</h1>
            <p className="suite-lead mos-body-lg">
              This is the main account for My Own Suite on this machine. It controls Suite Manager
              and every app you install.
            </p>
          </div>

          <div className="mos-panel suite-card suite-auth-card">
            {keyEditorOpen ? (
              <>
                <div className="suite-auth-card-header">
                  <h2 className="mos-card-title">Open your one-time setup link</h2>
                </div>

                <Notice title="This page is missing its setup key" variant="warning">
                  On a cloud server, the owner account can only be created with the one-time setup
                  key the installer printed. It proves you are the person who installed this suite
                  — without it, this page refuses the account form.
                </Notice>

                <div className="suite-auth-keyhelp">
                  <p>
                    The easy fix: go back to the installer's green{' '}
                    <strong>Installation complete</strong> message and open the link under{' '}
                    <strong>Finish setup</strong> — it brings you back here with the key attached.
                  </p>
                  <p>
                    Terminal already closed? Reconnect to your server (web console or SSH) and
                    print the key:
                  </p>
                  <pre className="suite-command-block">sudo cat /etc/mos/secrets/owner-claim.env</pre>
                  <p>
                    Then paste the long value after <code>MOS_OWNER_CLAIM_TOKEN=</code> below.
                  </p>
                </div>

                <form className="suite-auth-form" onSubmit={confirmKey}>
                  <label className="suite-auth-field">
                    <span>Setup key</span>
                    <input
                      autoComplete="off"
                      className="suite-auth-key-input"
                      onChange={(event) => setKeyDraft(event.target.value)}
                      spellCheck={false}
                      type="text"
                      value={keyDraft}
                    />
                    <small>Pasting the whole line is fine — everything but the key is trimmed away.</small>
                  </label>

                  <div className="suite-auth-actions">
                    <button className="mos-btn mos-btn-primary" disabled={!normalizeClaimKey(keyDraft)} type="submit">
                      Use this key
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <>
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
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setFormError(null);
                      }}
                      required
                      type="password"
                      value={password}
                    />
                    <small>{password.length >= 12 ? '✓ 12+ characters' : 'Use at least 12 characters.'}</small>
                  </label>

                  <label className="suite-auth-field">
                    <span>Confirm password</span>
                    <input
                      autoComplete="new-password"
                      minLength={12}
                      onChange={(event) => {
                        setConfirmPassword(event.target.value);
                        setFormError(null);
                      }}
                      required
                      type="password"
                      value={confirmPassword}
                    />
                    <small>Retype your password to catch typos.</small>
                  </label>

                  {shownError ? <p className="suite-error">{shownError}</p> : null}

                  <button className="mos-btn mos-btn-primary" disabled={submitting} type="submit">
                    {submitting ? 'Creating owner...' : 'Create owner'}
                  </button>
                </form>

                {ownerClaimRequired ? (
                  <div className="suite-auth-keynote">
                    <span className="suite-meta">
                      Owner setup on a cloud server uses the one-time key from your setup link.
                    </span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}
