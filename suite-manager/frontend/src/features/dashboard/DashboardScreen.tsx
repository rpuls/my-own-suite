import { useEffect, useState, type ReactNode } from 'react';

import { BetaNotice } from '../../components/disclaimers';
import { Avatar, Icon, PendingLine, type IconName } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { lowerFirst, whenWords } from '../../lib/dates';
import { CONTRIBUTING_URL, DISCORD_INVITE_URL, GITHUB_REPO_URL } from '../../lib/links';
import { BACKUPS_PATH, navigateOnClick, STORAGE_SETTINGS_PATH } from '../../lib/navigation';
import { issuesOf, useOverview, type AttentionIssue, type Overview, type OverviewTile as TileKey } from '../../lib/overview';
import { avatarOf, sourceIconUrl } from '../ai-activity/timeline';
import { formatInZone } from '../backups/model';
import type { Owner } from '../setup/types';

type DashboardScreenProps = {
  onNavigate: (route: 'apps' | 'backups' | 'customize' | 'settings', path: string) => void;
  owner: Owner;
};

const APPS_PATH = '/suite-manager/apps';
const UPDATES_PATH = '/suite-manager/updates';
const AI_SETTINGS_PATH = '/suite-manager/settings#set-ai';
const AI_ACTIVITY_PATH = '/suite-manager/ai-activity';

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

function FirstSteps({ onNavigate }: Pick<DashboardScreenProps, 'onNavigate'>) {
  return <section className="mos-panel suite-card suite-firstrun-card">
    <h2 className="mos-card-title">First steps</h2>
    <p className="suite-meta mos-meta">Three things to get your suite going.</p>
    <div className="suite-firstrun-steps">
      <button className="mos-btn mos-btn-secondary suite-firstrun-step" onClick={() => onNavigate('apps', APPS_PATH)} type="button">
        <Icon name="apps" /><span>1. Install an app</span>
      </button>
      <button className="mos-btn mos-btn-secondary suite-firstrun-step" onClick={() => onNavigate('customize', '/suite-manager/customize')} type="button">
        <Icon name="customize" /><span>2. Add it to your Homepage</span>
      </button>
      <button className="mos-btn mos-btn-secondary suite-firstrun-step" onClick={() => onNavigate('backups', BACKUPS_PATH)} type="button">
        <Icon name="backup" /><span>3. Make your first backup</span>
      </button>
    </div>
  </section>;
}

// The picture beside a problem: the app's own icon with a status dot, the
// assistant's avatar, or a warning sign for anything that is neither.
function IssueLead({ issue }: { issue: AttentionIssue }) {
  if (issue.assistant) return <Avatar {...avatarOf(issue.assistant)} small />;
  if (issue.app) {
    return <span className="suite-overview-issue-app">
      <img alt="" height="24" src={sourceIconUrl(issue.app)} width="24" />
      <span aria-hidden="true" className="suite-overview-dot" />
    </span>;
  }
  return <span className="suite-overview-issue-alert"><Icon name="alert" /></span>;
}

type TileLink = { label: string; path: string };

const TILES: Record<TileKey, { icon: IconName; link: TileLink; title: string }> = {
  apps: { icon: 'apps', link: { label: 'Open Apps', path: APPS_PATH }, title: 'Apps' },
  ai: { icon: 'chat-spark', link: { label: 'AI activity', path: AI_ACTIVITY_PATH }, title: 'AI assistants' },
  updates: { icon: 'update', link: { label: 'Open Updates', path: UPDATES_PATH }, title: 'Updates' },
  backups: { icon: 'backup', link: { label: 'Open Backups', path: BACKUPS_PATH }, title: 'Backups' },
  storage: { icon: 'usb-drive', link: { label: 'Storage in Settings', path: STORAGE_SETTINGS_PATH }, title: 'Storage' },
};

// Which tiles a suite shows is remembered, so the outlines drawn while the next answer
// is on its way are the tiles that answer will fill. No apps means no tiles: first steps instead.
const SHOWN_TILES_KEY = 'mos-overview-tiles';
const FIRST_VISIT_TILES: TileKey[] = ['apps', 'updates', 'backups', 'storage'];

// Added is not connected, so the count never says "connected".
function assistantCount(turnedOn: number) {
  if (!turnedOn) return 'No assistant turned on';
  return turnedOn === 1 ? '1 assistant' : `${turnedOn} assistants`;
}

function shownTiles(overview: Overview): TileKey[] {
  if (overview.apps.total === 0) return [];
  const shown: TileKey[] = ['apps'];
  if (overview.ai.connected || overview.ai.issues.length) shown.push('ai');
  if (overview.updates) shown.push('updates');
  if (overview.backups) shown.push('backups');
  if (overview.storage) shown.push('storage');
  return shown;
}

function rememberedTiles(): TileKey[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SHOWN_TILES_KEY) ?? 'null');
    return Array.isArray(saved) ? saved.filter((key): key is TileKey => key in TILES) : FIRST_VISIT_TILES;
  } catch {
    return FIRST_VISIT_TILES;
  }
}

function rememberTiles(tiles: TileKey[]) {
  try { localStorage.setItem(SHOWN_TILES_KEY, JSON.stringify(tiles)); } catch { /* the outlines fall back to the usual set */ }
}

function PendingTile({ tile }: { tile: TileKey }) {
  const { icon, link, title } = TILES[tile];
  return <section aria-hidden="true" className="mos-panel mos-pending suite-overview-tile">
    <div className="suite-overview-title">
      <span className="mos-panel-head-icon"><Icon name={icon} /></span>
      <h2 className="mos-card-title">{title}</h2>
      <span className="suite-overview-check mos-pending-mark" />
    </div>
    <div className="suite-overview-facts"><PendingLine width="45%" /><PendingLine width="80%" /></div>
    <span className="mos-link">{link.label}</span>
  </section>;
}

// One part of the suite at a glance. Information only: it names what is wrong and
// links to where it is fixed, and never acts itself.
function OverviewTile({ children, issues, link, tile }: {
  children: ReactNode;
  issues: AttentionIssue[];
  link?: TileLink;
  tile: TileKey;
}) {
  const ok = issues.length === 0;
  const { icon, title } = TILES[tile];
  const { label, path } = link ?? TILES[tile].link;
  return <section className={`mos-panel mos-arrive suite-overview-tile${ok ? '' : ' is-attention'}`}>
    <div className="suite-overview-title">
      <span aria-hidden="true" className="mos-panel-head-icon"><Icon name={icon} /></span>
      <h2 className="mos-card-title">{title}</h2>
      {ok ? <span aria-label="All is well" className="suite-overview-check" role="img"><Icon name="check" /></span> : null}
    </div>
    <div className="suite-overview-facts">{children}</div>
    {issues.length ? <ul className="suite-overview-issues">
      {issues.map((issue) => <li key={issue.id}><IssueLead issue={issue} /><p>{issue.text} <span>{issue.detail}</span></p></li>)}
    </ul> : null}
    <a className="mos-link" href={path} onClick={navigateOnClick(path)}>{label}</a>
  </section>;
}

function statusLine(count: number) {
  if (count === 0) return 'Everything is running.';
  return `${count === 1 ? '1 thing needs' : `${count} things need`} you. Everything else is running.`;
}

export function DashboardScreen({ onNavigate, owner }: DashboardScreenProps) {
  const overview = useOverview();
  const firstName = owner.name.trim().split(/\s+/)[0] || owner.name;
  // A first visit and a full suite read differently, so nothing is guessed while the answer is on its way.
  const hasApps = overview ? overview.apps.total > 0 : null;
  const [pendingTiles] = useState(rememberedTiles);
  const shown = overview ? shownTiles(overview) : [];
  useEffect(() => { if (overview) rememberTiles(shownTiles(overview)); }, [overview]);

  return (
    <section className="mos-shell suite-dashboard">
      <div className="suite-hero">
        <h1>{hasApps === false ? "You're all set — install your first app" : `Welcome back, ${firstName}`}</h1>
        <p className="suite-lead mos-body-lg">
          {hasApps === false
            ? 'Suite Manager is your control room: add apps, keep them updated, and back everything up. The best first move is installing an app — everything else grows from there.'
            : overview ? statusLine(issuesOf(overview).length) : 'Checking how your suite is doing.'}
        </p>
      </div>

      {hasApps === false ? <FirstSteps onNavigate={onNavigate} /> : null}

      {!overview && pendingTiles.length ? <div aria-busy="true" className="suite-overview-grid">
        {pendingTiles.map((tile) => <PendingTile key={tile} tile={tile} />)}
      </div> : null}

      {overview && hasApps ? <div className="suite-overview-grid">
        <OverviewTile issues={overview.apps.issues} tile="apps">
          <p><strong>{overview.apps.running} running</strong>{overview.apps.issues.length ? ` · ${overview.apps.issues.length} need${overview.apps.issues.length === 1 ? 's' : ''} you` : ''}</p>
        </OverviewTile>

        {shown.includes('ai') ? <OverviewTile issues={overview.ai.issues} link={overview.ai.issues.length ? { label: 'AI assistants in Settings', path: AI_SETTINGS_PATH } : undefined} tile="ai">
          <p><strong>{assistantCount(overview.ai.connected)}</strong></p>
          {overview.ai.lastUsed ? <p>{overview.ai.lastUsed.by} last connected {lowerFirst(whenWords(overview.ai.lastUsed.at))}.</p> : null}
        </OverviewTile> : null}

        {overview.updates ? <OverviewTile issues={overview.updates.issues} tile="updates">
          <p><strong>{overview.updates.available ? `${overview.updates.available} is available` : 'Up to date'}</strong></p>
          {overview.updates.checkedAt ? <p>Checked {lowerFirst(whenWords(overview.updates.checkedAt))}.</p> : null}
        </OverviewTile> : null}

        {overview.backups ? <OverviewTile issues={overview.backups.issues} tile="backups">
          <p><strong>{overview.backups.lastAt ? `Last backup ${lowerFirst(whenWords(overview.backups.lastAt))}` : 'No backups yet'}</strong></p>
          {overview.backups.nextAt && overview.backups.timeZone ? <p>Next {formatInZone(overview.backups.nextAt, overview.backups.timeZone)}.</p> : null}
        </OverviewTile> : null}

        {overview.storage ? <OverviewTile issues={overview.storage.issues} tile="storage">
          {overview.storage.systemFreeBytes !== null ? <p><strong>{formatBytes(overview.storage.systemFreeBytes)} free</strong> on the system drive</p> : null}
          {overview.storage.places ? <p>{overview.storage.places} more {overview.storage.places === 1 ? 'place' : 'places'} connected.</p> : null}
        </OverviewTile> : null}
      </div> : null}

      {/* Below what the owner came here to see. It is a caveat about the software,
          not a status, so it should not sit between them and their suite. */}
      <BetaNotice />

      <CommunityCard />
    </section>
  );
}
