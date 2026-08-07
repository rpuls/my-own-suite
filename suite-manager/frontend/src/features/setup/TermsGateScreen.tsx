import { useState } from 'react';

import { Checkbox, Icon, Notice } from '../../components/ui';
import { TERMS_URL } from '../../lib/links';
import type { Owner, TermsState } from './types';

type TermsGateScreenProps = {
  onAccept: (version: string) => Promise<void>;
  onLogout: () => Promise<void>;
  owner: Owner;
  terms: TermsState;
};

// A gate rather than a card on the dashboard. An install that is fully usable
// while the terms sit unread makes the acceptance decorative: what gives it any
// weight is that the owner met the warning and chose to continue before
// operating the server. It is asked once per terms version, and signing out is
// the way to decline.
export function TermsGateScreen({ onAccept, onLogout, owner, terms }: TermsGateScreenProps) {
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const firstName = owner.name.trim().split(/\s+/)[0] || owner.name;

  async function accept() {
    setSaving(true);
    setError('');
    try {
      await onAccept(terms.version);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to record your acceptance.');
      setSaving(false);
    }
  }

  return (
    <main className="suite-app">
      <section className="mos-shell suite-auth-layout">
        <div className="suite-auth-stage suite-terms-stage">
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
            <h1 className="mos-page-title">Before you start, {firstName}</h1>
            <p className="suite-lead mos-body-lg">
              You are about to run your own server. Please read this once — it takes a minute, and it
              is the only time MOS will ask.
            </p>
          </div>

          <section className="mos-panel suite-card suite-terms-card">
            <h2 className="mos-card-title">Terms of use</h2>
            <p className="suite-meta">
              My Own Suite is free and open source, and you are the operator of this server. That means your
              data, your backups, and your security are yours to look after — the project provides the
              software, without warranty and without liability.
            </p>
            <p>
              Please read the <a href={TERMS_URL} rel="noreferrer" target="_blank">terms of use<Icon name="external" /></a> once. They are short and written in plain language.
            </p>
            <Checkbox checked={confirmed} disabled={saving} onChange={(event) => setConfirmed(event.currentTarget.checked)}>
              I have read and accept the terms of use, and I understand this is early software provided as is.
            </Checkbox>
            {error ? <Notice title="Your acceptance was not recorded" variant="error"><p>{error}</p></Notice> : null}
            <div className="suite-hero-actions">
              <button className="mos-btn mos-btn-primary" disabled={!confirmed || saving} onClick={() => void accept()} type="button">
                {saving ? 'Saving...' : 'Accept and continue'}
              </button>
              <button className="mos-btn mos-btn-secondary" disabled={saving} onClick={() => void onLogout()} type="button">
                Sign out
              </button>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
