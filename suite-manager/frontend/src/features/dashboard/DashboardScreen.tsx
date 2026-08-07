import { useEffect, useState } from 'react';

import { BetaNotice } from '../../components/disclaimers';
import { Icon } from '../../components/ui';
import { CONTRIBUTING_URL, DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../../lib/links';
import type { Owner } from '../setup/types';
import { ConsoleLoginCard } from './ConsoleLoginCard';

type DashboardScreenProps = {
  onNavigate: (route: 'apps' | 'backups' | 'customize', path: string) => void;
  owner: Owner;
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

function CommunityCard() {
  return <section className="mos-panel suite-card suite-community-card">
    <h2 className="mos-card-title">Thank you for trying My Own Suite</h2>
    {/* The reason to ask for feedback here is not politeness: MOS has no
        telemetry, so an owner who says nothing is genuinely invisible to us.
        Saying that out loud turns the ask into the natural consequence of a
        promise we already made, rather than one more product nagging for a
        review. */}
    <p className="suite-meta">
      We collect no data about you or your suite, so your feedback is the only way we find out how
      this is going.
    </p>
    <p>
      Tell us what broke or confused you — every rough edge reported makes the next person's install
      smoother. Discord is the quickest way to reach us; if you'd rather build than report, start
      with the contribution guide.
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

export function DashboardScreen({ onNavigate, owner }: DashboardScreenProps) {
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

  return (
    <section className="mos-shell suite-dashboard">
      <div className="suite-hero">
        <h1>{hasApps ? `Welcome back, ${firstName}` : "You're all set — install your first app"}</h1>
        <p className="suite-lead mos-body-lg">
          {hasApps
            ? 'Suite Manager is your control room: add apps, keep them updated, and back everything up. Your dashboard is one tap away on the menu.'
            : 'Suite Manager is your control room: add apps, keep them updated, and back everything up. The best first move is installing an app — everything else grows from there.'}
        </p>
        {/* No call to action here. A primary button at the top of the page reads
            as "do this first", and on first run the first thing to do is save the
            server login below it. Installing an app is already step 1 of the
            First steps card, which is where the ordering is stated. */}
      </div>

      {/* Above everything else on purpose: it is the one thing on this screen
          that stops being possible if the owner ignores it. */}
      <ConsoleLoginCard />

      <div className="suite-dashboard-grid">
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
      </div>

      {/* Below what the owner came here to do. It is a caveat about the software,
          not a task, so it should not sit between them and their next step. */}
      <BetaNotice />

      <CommunityCard />
    </section>
  );
}
