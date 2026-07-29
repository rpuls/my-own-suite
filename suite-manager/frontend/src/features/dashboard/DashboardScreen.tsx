import { useEffect, useState } from 'react';

import { BetaNotice } from '../../components/BetaNotice';
import { Icon, Notice } from '../../components/ui';
import { CONTRIBUTING_URL, DISCORD_INVITE_URL, GITHUB_REPO_URL, TERMS_URL } from '../../lib/links';
import type { Owner, TermsState } from '../setup/types';

type DashboardScreenProps = {
  onAcceptTerms: (version: string) => Promise<void>;
  onNavigate: (route: 'apps' | 'backups' | 'customize', path: string) => void;
  owner: Owner;
  terms: TermsState;
};

// Only the shape the welcome screen needs: whether anything is installed. The
// Apps screen owns the full package model.
type InstalledProbe = { instance: { status?: string } | null };

// Whether this suite has at least one app the owner actually installed.
// Uninstalled instances are tombstones, not apps, so they do not count.
async function readInstalledCount(): Promise<number> {
  const response = await fetch('/suite-manager/api/apps/packages');
  if (!response.ok) throw new Error('Unable to read installed apps.');
  const body = await response.json() as { packages?: InstalledProbe[] };
  return (body.packages || []).filter((item) => item.instance && item.instance.status !== 'uninstalled').length;
}

function TermsCard({ onAccept, terms }: { onAccept: (version: string) => Promise<void>; terms: TermsState }) {
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function accept() {
    setSaving(true);
    setError('');
    try {
      await onAccept(terms.version);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to record your acceptance.');
    } finally {
      setSaving(false);
    }
  }

  return <section className="mos-panel suite-card suite-terms-card">
    <h2 className="mos-card-title">Before you start</h2>
    <p className="suite-meta">
      My Own Suite is free and open source, and you are the operator of this server. That means your
      data, your backups, and your security are yours to look after — the project provides the
      software, without warranty and without liability.
    </p>
    <p>
      Please read the <a href={TERMS_URL} rel="noreferrer" target="_blank">terms of use<Icon name="external" /></a> once. They are short and written in plain language.
    </p>
    <label className="suite-terms-confirm">
      <input checked={confirmed} disabled={saving} onChange={(event) => setConfirmed(event.currentTarget.checked)} type="checkbox" />
      <span>I have read and accept the terms of use, and I understand this is early software provided as is.</span>
    </label>
    {error ? <Notice title="Your acceptance was not recorded" variant="error"><p>{error}</p></Notice> : null}
    <div className="suite-hero-actions">
      <button className="mos-btn mos-btn-primary" disabled={!confirmed || saving} onClick={() => void accept()} type="button">
        {saving ? 'Saving...' : 'Accept and continue'}
      </button>
    </div>
  </section>;
}

function CommunityCard() {
  return <section className="mos-panel suite-card suite-community-card">
    <h2 className="mos-card-title">Thank you for trying My Own Suite</h2>
    <p className="suite-meta">
      This project exists because people run it, break it, and say so. Being here this early genuinely
      helps — every rough edge you report makes the next person's install smoother.
    </p>
    <p>
      Got feedback, an idea, or something that went wrong? Bring it to Discord. Want to help build
      it? The contribution guide is the place to start — code, docs, app packages, and testing are all
      welcome.
    </p>
    <div className="suite-hero-actions">
      <a className="mos-btn mos-btn-primary" href={DISCORD_INVITE_URL} rel="noreferrer" target="_blank">
        Join the Discord<Icon name="external" />
      </a>
      <a className="mos-btn mos-btn-secondary" href={CONTRIBUTING_URL} rel="noreferrer" target="_blank">
        How to contribute<Icon name="external" />
      </a>
      <a className="mos-btn mos-btn-secondary" href={GITHUB_REPO_URL} rel="noreferrer" target="_blank">
        Source on GitHub<Icon name="external" />
      </a>
    </div>
  </section>;
}

export function DashboardScreen({ onAcceptTerms, onNavigate, owner, terms }: DashboardScreenProps) {
  // `null` while the answer is unknown: the welcome hero says something
  // different in each case, and guessing "no apps" would tell an owner with a
  // full suite to go install their first one.
  const [installedCount, setInstalledCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void readInstalledCount()
      .then((count) => { if (!cancelled) setInstalledCount(count); })
      .catch(() => { if (!cancelled) setInstalledCount(null); });
    return () => { cancelled = true; };
  }, []);

  const hasApps = installedCount !== null && installedCount > 0;
  const firstName = owner.name.trim().split(/\s+/)[0] || owner.name;
  // No version means this Suite Manager frontend is talking to a backend that
  // does not know about terms yet. Asking someone to accept nothing in
  // particular is worse than not asking, so the card stays away.
  const termsPending = !terms.accepted && Boolean(terms.version);

  return (
    <section className="mos-shell suite-dashboard">
      <div className="suite-hero">
        <h1>{hasApps ? `Welcome back, ${firstName}` : "You're all set — install your first app"}</h1>
        <p className="suite-lead mos-body-lg">
          {hasApps
            ? 'Suite Manager is your control room: add apps, keep them updated, and back everything up. Your dashboard is one tap away on the menu.'
            : 'Suite Manager is your control room: add apps, keep them updated, and back everything up. The best first move is installing an app — everything else grows from there.'}
        </p>
        {hasApps ? null : <div className="suite-hero-actions">
          <button className="mos-btn mos-btn-primary" onClick={() => onNavigate('apps', '/suite-manager/apps')} type="button">
            Install your first app
          </button>
        </div>}
      </div>

      <BetaNotice />

      {termsPending ? <TermsCard onAccept={onAcceptTerms} terms={terms} /> : null}

      {termsPending ? null : <div className="suite-dashboard-grid">
        <section className="mos-panel suite-card suite-status-card">
          <h2 className="mos-card-title">Signed in</h2>
          <p className="suite-meta mos-meta">Owner</p>
          <strong>{owner.name}</strong>
          <span>{owner.email}</span>
        </section>

        <section className="mos-panel suite-card suite-firstrun-card">
          <h2 className="mos-card-title">{hasApps ? 'Keep it healthy' : 'First steps'}</h2>
          <p className="suite-meta mos-meta">{hasApps ? 'The three things worth doing regularly.' : 'Three things to get your suite going.'}</p>
          <div className="suite-firstrun-steps">
            <button className="mos-btn mos-btn-secondary suite-firstrun-step" onClick={() => onNavigate('apps', '/suite-manager/apps')} type="button">
              <Icon name="apps" /><span>{hasApps ? 'Add another app' : '1. Install an app'}</span>
            </button>
            <button className="mos-btn mos-btn-secondary suite-firstrun-step" onClick={() => onNavigate('customize', '/suite-manager/customize')} type="button">
              <Icon name="customize" /><span>{hasApps ? 'Tidy up your dashboard' : '2. Add it to your Homepage'}</span>
            </button>
            <button className="mos-btn mos-btn-secondary suite-firstrun-step" onClick={() => onNavigate('backups', '/suite-manager/backups')} type="button">
              <Icon name="backup" /><span>{hasApps ? 'Check your backups' : '3. Make your first backup'}</span>
            </button>
          </div>
        </section>
      </div>}

      <CommunityCard />
    </section>
  );
}
