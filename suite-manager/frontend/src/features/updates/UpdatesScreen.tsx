import { useEffect, useState } from 'react';

import { Notice, Select, Spinner } from '../../components/ui';

type UpdateJob = {
  error: string | null;
  id: string;
  logs?: Array<{ at?: string; message?: string }>;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
};

type UpdateStatus = {
  changeSummary: { items: string[]; source: string | null; title: string };
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
  updateAvailable: boolean;
};

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : fallback);
  return body;
}

function formatDate(value: string | null) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function shortCommit(value: string | null) {
  return value ? value.slice(0, 12) : 'Unknown';
}

function targetLabel(status: UpdateStatus) {
  return status.track.type === 'branch' ? shortCommit(status.latestRevision) : status.latestRelease.version || 'Unknown';
}

function currentLabel(status: UpdateStatus) {
  if (status.track.type === 'stable' && status.installedVersion) return status.installedVersion;
  return shortCommit(status.track.currentCommit);
}

function isRunning(job: UpdateJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
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
  const running = isRunning(status?.currentJob || null);
  const updating = running || busy === 'update';

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
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running} onClick={() => void load()} type="button">Check again</button>
        </div>

        <dl className="suite-updates-facts">
          <div><dt>Track</dt><dd>{status.track.label || 'Unknown'}</dd></div>
          <div><dt>Current</dt><dd>{currentLabel(status)}</dd></div>
          <div><dt>Target</dt><dd>{targetLabel(status)}</dd></div>
          <div><dt>Updater</dt><dd>{status.managedApplyAvailable ? 'Ready' : 'Unavailable'}</dd></div>
        </dl>

        {status.trackConfigurationAvailable ? <div className="suite-updates-track">
          <Select disabled={Boolean(busy) || running} helperText="Stable follows official tagged releases and is the default for fresh installs. Main carries reviewed changes ahead of the next release. Staging receives changes earlier for testing." label="Update track" onChange={(event) => setTrack(event.currentTarget.value === 'stable' ? 'stable' : event.currentTarget.value === 'staging' ? 'staging' : 'main')} value={track}>
            <option value="stable">Stable releases</option>
            <option value="main">Main branch</option>
            <option value="staging">Staging branch (early testing)</option>
          </Select>
          <button className="mos-btn mos-btn-secondary" disabled={busy === 'track' || updating || track === selectedTrack(status)} onClick={() => void switchTrack()} type="button">{busy === 'track' ? 'Switching...' : 'Switch track'}</button>
        </div> : null}

        <button className="mos-btn mos-btn-primary" disabled={!status.managedApplyAvailable || !status.updateAvailable || Boolean(busy) || running} onClick={() => void startUpdate()} type="button">
          {updating ? 'Updating...' : status.updateAvailable ? 'Update now' : 'Already up to date'}
        </button>
        <p className="suite-meta">A platform update refreshes MOS services and host agents. Installed apps keep running from their installed package snapshots; app updates are applied separately from the Apps screen.</p>
      </section>

      <section className="mos-panel suite-card suite-updates-panel">
        <h2 className="mos-card-title">{status.changeSummary.title}</h2>
        {status.changeSummary.source ? <p className="suite-meta">From {status.changeSummary.source}</p> : null}
        {status.changeSummary.items.length ? <ul className="suite-updates-change-list">{status.changeSummary.items.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="suite-meta">No local changelog summary is available for this target.</p>}
        {status.error ? <Notice title="Lookup warning" variant="warning"><p>{status.error}</p></Notice> : null}
      </section>


      {status.currentJob ? <section className="mos-panel suite-card suite-updates-panel">
        <h2 className="mos-card-title">Update activity</h2>
        <p>{status.currentJob.status === 'failed' ? 'The last update failed.' : status.currentJob.status === 'succeeded' ? 'The last update finished.' : status.currentJob.stage || 'Update activity received.'}</p>
        {status.currentJob.error ? <p className="suite-error">{status.currentJob.error}</p> : null}
        {status.currentJob.logs?.length ? <details className="suite-advanced">
          <summary>Advanced details</summary>
          <ol className="suite-updates-log">
            {status.currentJob.logs.slice(-12).map((entry, index) => <li key={`${entry.at || 'log'}-${index}`}><span>{formatDate(entry.at || null)}</span><code>{entry.message || 'No message'}</code></li>)}
          </ol>
        </details> : null}
      </section> : null}
    </div> : <p className="suite-meta">Loading update status...</p>}
  </section>;
}
