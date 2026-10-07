import { useEffect, useState } from 'react';

import { Markdown } from '../../components/Markdown';
import { AdvancedPanel, Icon, Notice, Panel, PanelBand, PanelBody, PanelHead, PanelItem, PanelList, Select, Spinner, Stepper } from '../../components/ui';
import type { IconName } from '../../components/ui';
import { buildChanged, servedBuildId } from '../../frontend-build';
import { jsonResponse } from '../../lib/api';
import { readVaultView, startupOf } from '../../lib/vault';
import { HostPatchesPanel } from './HostPatchesPanel';
import type { HostPatches } from './HostPatchesPanel';

type UpdateCheckpoint = {
  backupId: string | null;
  jobId: string | null;
  requested: boolean;
  status: string | null;
  target: string | null;
  waiting: { reason: string; since: string | null } | null;
};

type UpdateJob = {
  checkpoint: UpdateCheckpoint | null;
  error: string | null;
  id: string;
  logs?: Array<{ at?: string; message?: string }>;
  output?: string | null;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
};

type UpdateStatus = {
  changeSummary: { items: string[]; source: string | null; title: string };
  checkFailure: { diagnostics: string | null; errorCode: string; reason: string } | null;
  checkedAt: string;
  checkpoint: { destinationLabel: string | null; ready: boolean; supported: boolean };
  currentJob: UpdateJob | null;
  host: HostPatches;
  installedVersion: string | null;
  latestRelease: { notesUrl: string | null; source: string | null; version: string | null };
  latestRevision: string | null;
  managedApplyAvailable: boolean;
  serviceAvailable: boolean;
  track: { currentBranch: string | null; currentCommit: string | null; label: string | null; ref: string | null; type: 'branch' | 'stable' | null };
  trackConfigurationAvailable: boolean;
  updateAvailable: boolean | null;
};

function formatDate(value: string | null) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortCommit(value: string | null, length = 12) {
  return value ? value.slice(0, length) : 'Unknown';
}

function isRunning(job: UpdateJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

const BACKUP_STAGES = new Set(['taking-checkpoint', 'waiting-for-backup-destination']);

const STAGE_LABELS: Record<string, string> = {
  'taking-checkpoint': 'Taking a backup before updating...',
  'waiting-for-backup-destination': 'Waiting to take a backup before updating...',
};

function stageLabel(stage: string | null) {
  return (stage && STAGE_LABELS[stage]) || stage;
}

// The agent's stages, folded into the four an owner can follow.
const PROGRESS_STEPS = ['Backup', 'Download', 'Build', 'Restart'];
const STAGE_STEP: Record<string, number> = {
  'updating-checkout': 1,
  'installing-dependencies': 2,
  'building-frontend': 2,
  'reconciling-system': 3,
};

function checkpointNote(job: UpdateJob | null) {
  const checkpoint = job?.checkpoint;
  if (checkpoint?.status === 'skipped') return 'No backup was taken before this update.';
  if (checkpoint?.status !== 'succeeded') return null;
  return checkpoint.target
    ? `A backup was taken before this update, listed on the Backups screen as "Before update to ${checkpoint.target}".`
    : 'A backup was taken before this update and is listed on the Backups screen.';
}

function jobOutcome(job: UpdateJob) {
  if (job.status === 'failed') return 'The last update failed.';
  if (job.status === 'cancelled') return 'The last update was cancelled.';
  if (job.status === 'succeeded') return 'The last update finished.';
  return stageLabel(job.stage) || 'Update activity received.';
}

// The same panel is a diagnostic on a failed job and ambient detail on one that
// worked, which is why `reveal` is computed.
function UpdateJobLog({ job }: { job: UpdateJob }) {
  const entries = (job.logs || []).slice(-12);
  const output = job.status === 'failed' && job.output ? job.output : '';
  if (!entries.length && !output) return null;
  const steps = entries.map((entry) => `${formatDate(entry.at || null)}  ${entry.message || 'No message'}`).join('\n');
  return <AdvancedPanel
    copyText={() => [steps, output].filter(Boolean).join('\n\n')}
    output={output || undefined}
    reveal={job.status === 'failed' ? 'on-failure' : 'technical-mode'}
    summary="Update log"
  >
    {entries.length ? <ol className="suite-updates-log">
      {entries.map((entry, index) => <li key={`${entry.at || 'log'}-${index}`}><span>{formatDate(entry.at || null)}</span><code>{entry.message || 'No message'}</code></li>)}
    </ol> : null}
  </AdvancedPanel>;
}

type TrackChoice = 'stable' | 'main' | 'staging';

const TRACKS: Array<{ help: string; id: TrackChoice; name: string }> = [
  { help: 'Official tagged releases. Recommended.', id: 'stable', name: 'Stable releases' },
  { help: 'Reviewed changes, ahead of the next release.', id: 'main', name: 'Main branch' },
  { help: 'Changes as they land, for early testing.', id: 'staging', name: 'Staging branch' },
];

function selectedTrack(status: UpdateStatus): TrackChoice {
  if (status.track.type === 'stable') return 'stable';
  return status.track.ref === 'staging' ? 'staging' : 'main';
}

function asTrackChoice(value: string): TrackChoice {
  return value === 'stable' || value === 'staging' ? value : 'main';
}

type Summary = { icon: IconName; meta: string; title: string };

function summarize(status: UpdateStatus, updating: boolean): Summary {
  const checked = `Checked ${formatDate(status.checkedAt)}`;
  const branch = status.track.type === 'branch';
  const version = status.latestRelease.version;
  const target = branch ? `the newest ${status.track.ref || 'branch'} commit` : `MOS ${version || 'the latest release'}`;
  if (updating) return { icon: 'refresh', meta: 'Suite Manager may disconnect while MOS restarts. You can leave this page.', title: `Updating to ${target}` };
  if (!status.serviceAvailable) return { icon: 'update', meta: 'The update agent is not reachable from Suite Manager.', title: 'Updates are unavailable' };
  if (status.updateAvailable === null) return { icon: 'update', meta: checked, title: 'Could not check for updates' };
  if (status.updateAvailable) {
    return branch
      ? { icon: 'download', meta: `Newest commit on ${status.track.ref || 'the branch'} · ${checked}`, title: 'A newer commit is available' }
      : { icon: 'download', meta: `Stable release · ${checked}`, title: `MOS ${version || 'update'} is available` };
  }
  return branch
    ? { icon: 'check', meta: `You have the newest commit on ${status.track.ref || 'the branch'} · ${checked}`, title: "You're up to date" }
    : { icon: 'check', meta: `${status.installedVersion ? `MOS ${status.installedVersion}` : 'This'} is the latest stable release · ${checked}`, title: "You're up to date" };
}

type Fact = { code?: boolean; label: string; sub?: string; value: string };

function factsOf(status: UpdateStatus, updating: boolean): Fact[] {
  const branch = status.track.type === 'branch';
  const available = status.updateAvailable === null ? 'Not checked' : !status.updateAvailable ? '—' : null;
  return [
    { label: 'Track', value: status.track.label || 'Unknown' },
    branch
      ? { code: true, label: 'Installed', sub: status.installedVersion || undefined, value: shortCommit(status.track.currentCommit, 7) }
      : { label: 'Installed', value: status.installedVersion || shortCommit(status.track.currentCommit, 7) },
    branch
      ? { code: !available, label: 'Available', sub: available ? undefined : 'Unreleased', value: available || shortCommit(status.latestRevision, 7) }
      : { label: 'Available', value: available || status.latestRelease.version || 'Unknown' },
    { label: 'Updater', value: updating ? 'Working' : status.managedApplyAvailable ? 'Ready' : 'Unavailable' },
  ];
}

function changesHeading(status: UpdateStatus) {
  if (status.updateAvailable) return "What's in this update";
  if (status.track.type === 'stable' && status.installedVersion) return `What's new in ${status.installedVersion}`;
  return status.changeSummary.title;
}

// The changelog writes each entry as a bold lead sentence and its detail.
function splitChange(item: string) {
  const match = /^\*\*(.+?)\*\*\s*(.*)$/su.exec(item);
  return { body: match?.[2] ?? '', title: match?.[1] ?? item };
}

const CHANGES_PREVIEW = 3;

function ChangeList({ items }: { items: string[] }) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? items : items.slice(0, CHANGES_PREVIEW);
  const toggle = (index: number) => setExpanded((current) => ({ ...current, [index]: !current[index] }));

  return <PanelList>
    {visible.map((item, index) => {
      const { body, title } = splitChange(item);
      const open = Boolean(expanded[index]);
      return <PanelItem flush key={item}>
        <div className={`suite-updates-change${open ? ' is-open' : ''}`}>
          {body ? <button aria-expanded={open} className="suite-updates-change-head" onClick={() => toggle(index)} type="button">
            <strong><Markdown inline>{title}</Markdown></strong>
            <span className="suite-updates-chevron"><Icon name="chevron-right" /></span>
          </button> : <strong className="suite-updates-change-head"><Markdown inline>{title}</Markdown></strong>}
          {body ? <div className="suite-updates-change-body" onClick={open ? undefined : () => toggle(index)}><Markdown inline={!body.includes('\n')}>{body}</Markdown></div> : null}
        </div>
      </PanelItem>;
    })}
    {items.length > CHANGES_PREVIEW ? <PanelItem flush>
      <button aria-expanded={showAll} className="suite-updates-change-more" onClick={() => setShowAll((current) => !current)} type="button">
        {showAll ? 'Show fewer' : `Show all ${items.length} changes`}
        <span className={`suite-updates-chevron${showAll ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
      </button>
    </PanelItem> : null}
  </PanelList>;
}

function BackupBand({ job, status, updating }: { job: UpdateJob | null; status: UpdateStatus; updating: boolean }) {
  if (!status.checkpoint.supported) return null;
  const destination = status.checkpoint.destinationLabel || 'where automatic backups go';
  if (!status.checkpoint.ready) {
    return <PanelBand icon="backup" note="MOS has nowhere to put one. The update runs either way." title="No backup will be taken first" tone="warning">
      <a className="mos-btn mos-btn-ghost mos-btn-sm" href="/suite-manager/backups">Choose where backups go</a>
    </PanelBand>;
  }
  if (updating && BACKUP_STAGES.has(job?.stage || '')) {
    return <PanelBand busy note={`To ${destination}, before anything changes`} title="Backing up your suite" tone="accent" />;
  }
  return <PanelBand icon="backup" note={`To ${destination} — MOS waits if it isn't connected`} title="Backed up first" tone="info" />;
}

export function UpdatesScreen() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [track, setTrack] = useState<TrackChoice>('stable');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [checking, setChecking] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // Read from the one route that answers it; a quiet vault agent says no, which
  // understates the interruption rather than promising it away.
  const [asksForPassword, setAsksForPassword] = useState(false);
  const job = status?.currentJob || null;
  const running = isRunning(job);
  const updating = running || busy === 'update';
  const jobStatus = job?.status || null;
  const waitingReason = running ? job?.checkpoint?.waiting?.reason || '' : '';

  async function load() {
    const next = await jsonResponse<UpdateStatus>(await fetch('/suite-manager/api/updates/status'), 'Unable to load update status.');
    setStatus(next);
    setTrack(selectedTrack(next));
  }

  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load update status.')); }, []);
  useEffect(() => {
    void readVaultView()
      .then((view) => setAsksForPassword(startupOf(view) === 'password'))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!updating) return undefined;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [updating]);

  // The owner started this update and watched it finish, so a reload is wanted —
  // but only when the bundle actually changed. The delay lets the outcome be read.
  useEffect(() => {
    if (jobStatus !== 'succeeded') return undefined;
    let cancelled = false;
    let timer = 0;
    void servedBuildId().then((served) => {
      if (cancelled || !buildChanged(served)) return;
      setReloading(true);
      timer = window.setTimeout(() => window.location.reload(), 4000);
    }).catch(() => undefined);
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [jobStatus]);

  // A check takes seconds when the origin does not answer, and the agent retries
  // before giving up, so the button says it is working rather than seeming dead.
  async function checkAgain() {
    setChecking(true);
    setError('');
    try {
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load update status.');
    } finally {
      setChecking(false);
    }
  }

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await action();
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  }

  async function startUpdate() {
    await runAction('update', async () => {
      await jsonResponse(await fetch('/suite-manager/api/updates/start', { method: 'POST' }), 'Unable to start update.');
    });
  }

  async function answerWait(answer: 'cancel' | 'skip-backup') {
    const id = job?.id || '';
    await runAction(answer, async () => {
      await jsonResponse(await fetch(`/suite-manager/api/updates/${answer}`, {
        body: JSON.stringify({ id }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), answer === 'cancel' ? 'Unable to cancel the update.' : 'Unable to go on without a backup.');
    });
  }

  // MOS told the owner a restart was needed, so MOS performs it. Nothing is
  // reloaded afterwards: the server is going away.
  async function restartHost() {
    setRestarting(true);
    setError('');
    try {
      await jsonResponse(await fetch('/suite-manager/api/updates/host/restart', { method: 'POST' }), 'Unable to restart this server.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to restart this server.');
      setRestarting(false);
    }
  }

  async function switchTrack() {
    await runAction('track', async () => {
      await jsonResponse(await fetch('/suite-manager/api/updates/track', {
        body: JSON.stringify({ track }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to switch update track.');
    });
  }

  const summary = status ? summarize(status, updating) : null;
  const trackChanged = status ? track !== selectedTrack(status) && !updating : false;
  const pickedTrack = TRACKS.find((candidate) => candidate.id === track);
  const sourceMatch = /^(.*?)\s*(\[[^\]]+\])$/u.exec(status?.changeSummary.source || '');
  const finishedJob = job && !running ? job : null;

  return <section aria-busy={updating} className="mos-shell mos-page">
    <div className="suite-hero"><h1>Updates</h1></div>

    {error ? <Notice title="Updates need attention" variant="error"><p>{error}</p></Notice> : null}
    {reloading ? <Notice title={<span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Spinner />Reloading Suite Manager</span>} variant="success">
      <p>The update brought a new version of this interface. Reloading so you are looking at it.</p>
    </Notice> : null}
    {status && !status.serviceAvailable ? <Notice title="Update agent unavailable" variant="warning"><p>This install does not expose the MOS update agent to Suite Manager yet. Install or repair the host services before using in-app updates.</p></Notice> : null}
    {waitingReason ? <Notice title="Waiting to back up before updating" variant="warning">
      <p>{waitingReason}</p>
      <div className="suite-notice-actions">
        <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => void answerWait('cancel')} type="button">{busy === 'cancel' ? 'Cancelling...' : 'Cancel update'}</button>
        <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => void answerWait('skip-backup')} type="button">{busy === 'skip-backup' ? 'Starting...' : 'Update without a backup'}</button>
      </div>
    </Notice> : null}

    {status && summary ? <div className="suite-updates-layout">
      <Panel>
        <PanelBody>
          <div className="suite-updates-summary">
            <div className="suite-updates-hero">
              <span className="suite-updates-hero-icon"><Icon name={summary.icon} /></span>
              <div>
                <h2>{summary.title}</h2>
                <p className="suite-meta">{summary.meta}</p>
              </div>
            </div>

            <dl className="suite-updates-facts">
              {factsOf(status, updating).map((fact) => <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.code ? <code>{fact.value}</code> : fact.value}</dd>
                {fact.sub ? <dd className="suite-updates-fact-sub">{fact.sub}</dd> : null}
              </div>)}
            </dl>

            {status.serviceAvailable && status.checkFailure ? <Notice title="Could not check for updates" variant="warning">
              <p>{status.checkFailure.reason}</p>
              <AdvancedPanel facts={[{ label: 'Checked', value: formatDate(status.checkedAt) }]} output={status.checkFailure.diagnostics || undefined} reveal="on-failure" />
            </Notice> : null}

            <div className="suite-updates-actions">
              <div className="suite-updates-buttons">
                {status.updateAvailable && !updating ? <button className="mos-btn mos-btn-primary" disabled={!status.managedApplyAvailable || Boolean(busy) || checking} onClick={() => void startUpdate()} type="button">
                  {status.track.type === 'stable' && status.latestRelease.version ? `Update to ${status.latestRelease.version}` : 'Update now'}
                </button> : null}
                <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running || checking} onClick={() => void checkAgain()} type="button">
                  <Icon name="refresh" />{checking ? 'Checking...' : 'Check again'}
                </button>
              </div>
              {status.trackConfigurationAvailable ? <div className="suite-updates-track">
                <label className="suite-meta" htmlFor="suite-updates-track">Update track</label>
                <Select disabled={Boolean(busy) || updating} id="suite-updates-track" onChange={(event) => setTrack(asTrackChoice(event.currentTarget.value))} value={track}>
                  {TRACKS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                </Select>
                {trackChanged ? <button className="mos-btn mos-btn-secondary" disabled={busy === 'track'} onClick={() => void switchTrack()} type="button">{busy === 'track' ? 'Switching...' : 'Switch track'}</button> : null}
              </div> : null}
            </div>
            {trackChanged && pickedTrack ? <p className="suite-meta suite-updates-track-help">{pickedTrack.name}: {pickedTrack.help} Switching checks again for updates on that track.</p> : null}

            {updating ? <div aria-live="polite" className="suite-updates-steps" role="status">
              <Stepper currentStepIndex={STAGE_STEP[job?.stage || ''] ?? 0} steps={PROGRESS_STEPS} />
            </div> : null}
          </div>
        </PanelBody>

        <BackupBand job={job} status={status} updating={updating} />

        {finishedJob ? <PanelBody>
          <div className="suite-updates-outcome">
            <p><strong>{jobOutcome(finishedJob)}</strong></p>
            {finishedJob.error ? <p className="suite-error">{finishedJob.error}</p> : null}
            {finishedJob.status === 'failed' && finishedJob.stage === 'taking-checkpoint' ? <p className="suite-meta">Nothing on this machine was changed: the update stops before it fetches or builds anything if it cannot back up first. Fix the problem on the Backups screen and start the update again.</p> : null}
            {checkpointNote(finishedJob) ? <p className="suite-meta">{checkpointNote(finishedJob)}</p> : null}
            <UpdateJobLog job={finishedJob} />
          </div>
        </PanelBody> : null}

        <PanelHead title={changesHeading(status)}>
          {sourceMatch ? <p className="suite-meta">From {sourceMatch[1]} <code>{sourceMatch[2]}</code></p> : status.changeSummary.source ? <p className="suite-meta">From {status.changeSummary.source}</p> : null}
        </PanelHead>
        {status.changeSummary.items.length
          ? <ChangeList items={status.changeSummary.items} key={status.changeSummary.source || ''} />
          : <PanelBody><p className="suite-meta">No changelog summary is available for this target.</p></PanelBody>}

        <PanelBody><AdvancedPanel
          facts={[
            { code: true, label: 'Installed', value: [status.installedVersion, shortCommit(status.track.currentCommit, status.track.type === 'branch' ? 40 : 12)].filter(Boolean).join(' · ') },
            { code: true, label: 'Available', value: status.track.type === 'branch' ? shortCommit(status.latestRevision, 40) : status.latestRelease.version || 'Unknown' },
            { label: 'Updater', value: status.managedApplyAvailable ? 'Ready · host-owned agent' : 'Unavailable' },
            { label: 'Last checked', value: formatDate(status.checkedAt) },
          ]}
          reveal="technical-mode"
        >
          <p className="suite-meta">A platform update refreshes MOS services and host agents. Installed apps keep running from their package snapshots; app updates are applied separately from the Apps screen and are not backed up first.</p>
        </AdvancedPanel></PanelBody>
      </Panel>

      <HostPatchesPanel asksForPassword={asksForPassword} busy={busy} formatDate={formatDate} host={status.host} onRestart={() => void restartHost()} restarting={restarting} />
    </div> : <p className="suite-meta">Loading update status...</p>}
  </section>;
}
