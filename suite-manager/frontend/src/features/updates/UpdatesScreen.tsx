import { useEffect, useState } from 'react';

import { AdvancedPanel, Notice, Select, Spinner } from '../../components/ui';
import { buildChanged, servedBuildId } from '../../frontend-build';
import { jsonResponse } from '../../lib/api';

type UpdateJob = {
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
  currentJob: UpdateJob | null;
  error: string | null;
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

function shortCommit(value: string | null) {
  return value ? value.slice(0, 12) : 'Unknown';
}

function targetLabel(status: UpdateStatus) {
  if (status.updateAvailable === null) return 'Not checked';
  return status.track.type === 'branch' ? shortCommit(status.latestRevision) : status.latestRelease.version || 'Unknown';
}

function updateButtonLabel(status: UpdateStatus, updating: boolean) {
  if (updating) return 'Updating...';
  if (status.updateAvailable === null) return 'Could not check';
  return status.updateAvailable ? 'Update now' : 'Already up to date';
}

function currentLabel(status: UpdateStatus) {
  if (status.track.type === 'stable' && status.installedVersion) return status.installedVersion;
  return shortCommit(status.track.currentCommit);
}

function isRunning(job: UpdateJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

// The tail of the update log, and on a failed job the last lines the failing
// step wrote. It is a `reveal` computed per render for the reason the prop is a
// runtime value at all: the same panel is a diagnostic on a failed job and
// ambient detail on a job that worked. The rendered content and the copied
// text come from the same values, so a bug report cannot quote something the
// screen never showed.
function UpdateJobLog({ job }: { job: UpdateJob }) {
  const entries = (job.logs || []).slice(-12);
  const output = job.status === 'failed' && job.output ? job.output : '';
  if (!entries.length && !output) return null;
  const steps = entries.map((entry) => `${formatDate(entry.at || null)}  ${entry.message || 'No message'}`).join('\n');
  return <AdvancedPanel
    copyText={() => [steps, output].filter(Boolean).join('\n\n')}
    output={output || undefined}
    reveal={job.status === 'failed' ? 'on-failure' : 'technical-mode'}
  >
    {entries.length ? <ol className="suite-updates-log">
      {entries.map((entry, index) => <li key={`${entry.at || 'log'}-${index}`}><span>{formatDate(entry.at || null)}</span><code>{entry.message || 'No message'}</code></li>)}
    </ol> : null}
  </AdvancedPanel>;
}

type TrackChoice = 'stable' | 'main' | 'staging';

function selectedTrack(status: UpdateStatus): TrackChoice {
  if (status.track.type === 'stable') return 'stable';
  return status.track.ref === 'staging' ? 'staging' : 'main';
}

export function UpdatesScreen() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [track, setTrack] = useState<TrackChoice>('stable');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [checking, setChecking] = useState(false);
  const [reloading, setReloading] = useState(false);
  const running = isRunning(status?.currentJob || null);
  const updating = running || busy === 'update';
  const jobStatus = status?.currentJob?.status || null;

  async function load() {
    const next = await jsonResponse<UpdateStatus>(await fetch('/suite-manager/api/updates/status'), 'Unable to load update status.');
    setStatus(next);
    setTrack(selectedTrack(next));
  }

  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load update status.')); }, []);
  useEffect(() => {
    if (!updating) return undefined;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [updating]);

  // The update finished with the owner on this screen watching it, which is the
  // one place a reload is unambiguously wanted: they started it, nothing here is
  // half-typed, and the screen is otherwise left reporting success from the code
  // the update just replaced. Only when the bundle actually changed — an update
  // that shipped no new frontend has nothing to reload for. The delay is so the
  // outcome is readable before the page goes.
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

  async function switchTrack() {
    await runAction('track', async () => {
      await jsonResponse(await fetch('/suite-manager/api/updates/track', {
        body: JSON.stringify({ track }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to switch update track.');
    });
  }

  return <section aria-busy={updating} className="mos-shell mos-page">
    <div className="suite-hero">
      <h1>Updates</h1>
      <p className="suite-lead mos-body-lg">Update the MOS control plane through a host-owned agent, with live progress, restart-safe feedback, and diagnostics kept visible.</p>
    </div>

    {error ? <Notice title="Updates need attention" variant="error"><p>{error}</p></Notice> : null}
    {reloading ? <Notice title={<span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Spinner />Reloading Suite Manager</span>} variant="success">
      <p>The update brought a new version of this interface. Reloading so you are looking at it.</p>
    </Notice> : null}
    {status && !status.serviceAvailable ? <Notice title="Update agent unavailable" variant="warning"><p>This install does not expose the MOS update agent to Suite Manager yet. Install or repair the host services before using in-app updates.</p></Notice> : null}
    {updating ? <Notice title={<span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Spinner />{busy === 'update' && !running ? 'Starting update' : 'Update in progress'}</span>} variant="info"><p>Suite Manager may briefly reconnect while the host refreshes repo-owned services and agents.</p></Notice> : null}
    {updating ? <div className="suite-updates-progress" role="status" aria-live="polite">
      <div className="suite-updates-progress-bar" aria-hidden="true" />
      <div>
        <strong>{busy === 'update' && !running ? 'Asking the update agent to start...' : status?.currentJob?.stage || 'Refreshing repo-owned services...'}</strong>
        <span>Keep this page open; progress and failure details will appear below.</span>
      </div>
    </div> : null}

    {status ? <div className="suite-updates-layout">
      <section className="mos-panel suite-card suite-updates-panel">
        <div className="suite-updates-header">
          <div>
            <h2 className="mos-card-title">Control-plane update</h2>
            <p className="suite-meta">Checked {formatDate(status.checkedAt)}</p>
          </div>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running || checking} onClick={() => void checkAgain()} type="button">{checking ? 'Checking...' : 'Check again'}</button>
        </div>

        <dl className="suite-updates-facts">
          <div><dt>Track</dt><dd>{status.track.label || 'Unknown'}</dd></div>
          <div><dt>Current</dt><dd>{currentLabel(status)}</dd></div>
          <div><dt>Target</dt><dd>{targetLabel(status)}</dd></div>
          <div><dt>Updater</dt><dd>{status.managedApplyAvailable ? 'Ready' : 'Unavailable'}</dd></div>
        </dl>

        {status.serviceAvailable && status.checkFailure ? <Notice title="Could not check for updates" variant="warning">
          <p>{status.checkFailure.reason}</p>
          <AdvancedPanel facts={[{ label: 'Checked', value: formatDate(status.checkedAt) }]} output={status.checkFailure.diagnostics || undefined} reveal="on-failure" />
        </Notice> : null}

        {status.trackConfigurationAvailable ? <div className="suite-updates-track">
          <Select disabled={Boolean(busy) || running} helperText="Stable follows official tagged releases and is the default for fresh installs. Main carries reviewed changes ahead of the next release. Staging receives changes earlier for testing." label="Update track" onChange={(event) => setTrack(event.currentTarget.value === 'stable' ? 'stable' : event.currentTarget.value === 'staging' ? 'staging' : 'main')} value={track}>
            <option value="stable">Stable releases</option>
            <option value="main">Main branch</option>
            <option value="staging">Staging branch (early testing)</option>
          </Select>
          <button className="mos-btn mos-btn-secondary" disabled={busy === 'track' || updating || track === selectedTrack(status)} onClick={() => void switchTrack()} type="button">{busy === 'track' ? 'Switching...' : 'Switch track'}</button>
        </div> : null}

        <button className="mos-btn mos-btn-primary" disabled={!status.managedApplyAvailable || !status.updateAvailable || Boolean(busy) || running || checking} onClick={() => void startUpdate()} type="button">
          {updateButtonLabel(status, updating)}
        </button>
        <p className="suite-meta">A platform update refreshes MOS services and host agents. Installed apps keep running from their installed package snapshots; app updates are applied separately from the Apps screen.</p>
      </section>

      <section className="mos-panel suite-card suite-updates-panel">
        <h2 className="mos-card-title">{status.changeSummary.title}</h2>
        {status.changeSummary.source ? <p className="suite-meta">From {status.changeSummary.source}</p> : null}
        {status.changeSummary.items.length ? <ul className="suite-updates-change-list">{status.changeSummary.items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="suite-meta">No local changelog summary is available for this target.</p>}
      </section>


      {status.currentJob ? <section className="mos-panel suite-card suite-updates-panel">
        <h2 className="mos-card-title">Update activity</h2>
        <p>{status.currentJob.status === 'failed' ? 'The last update failed.' : status.currentJob.status === 'succeeded' ? 'The last update finished.' : status.currentJob.stage || 'Update activity received.'}</p>
        {status.currentJob.error ? <p className="suite-error">{status.currentJob.error}</p> : null}
        <UpdateJobLog job={status.currentJob} />
      </section> : null}
    </div> : <p className="suite-meta">Loading update status...</p>}
  </section>;
}
