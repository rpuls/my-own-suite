import { RefreshCcw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { SelectField } from '../../components/ui';
import { useUpdates } from './useUpdates';
import type { UpdatesStatus } from './types';

function formatDate(value: string | null): string {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function labelForSource(value: 'github-release' | 'local-manifest' | 'override' | 'unavailable'): string {
  if (value === 'github-release') {
    return 'Live GitHub release';
  }

  if (value === 'local-manifest') {
    return 'Bundled release manifest';
  }

  if (value === 'override') {
    return 'Test override';
  }

  return 'Unavailable';
}

function installedVersionHelpText(source: string | null): string {
  if (!source) {
    return 'The local installed-version metadata was not found in this installation.';
  }

  if (source.endsWith('release.json')) {
    return 'Read from bundled Suite Manager release metadata packaged with this installation.';
  }

  if (source.endsWith('VERSION')) {
    return 'Read from the local suite VERSION file on this installation.';
  }

  return `Read from ${source}.`;
}

function shortCommit(value: string | null): string {
  return value ? value.slice(0, 7) : 'Unknown';
}

function currentTrackOption(status: UpdatesStatus): 'stable' | 'staging' {
  return status.track.type === 'branch' && status.track.ref === 'staging' ? 'staging' : 'stable';
}

function updateTargetTitle(status: UpdatesStatus): string {
  return status.track.type === 'branch' ? `Latest ${status.track.ref || 'branch'} commit` : 'Latest stable release';
}

function updateTargetValue(status: UpdatesStatus): string {
  return status.track.type === 'branch'
    ? shortCommit(status.latestRevision)
    : status.latestRelease.version || 'Unknown';
}

function capabilityText(status: UpdatesStatus): string {
  if (status.managedApplyAvailable) {
    return 'Suite Manager can start a host-owned update job for this install.';
  }

  if (status.serviceAvailable) {
    return 'The local updater is reachable, but it cannot start managed updates yet.';
  }

  return 'No local updater is reachable. Use your hosting platform or deployment workflow to update.';
}

function jobStatusText(job: NonNullable<UpdatesStatus['currentJob']>): string {
  if (job.status === 'succeeded') {
    return 'The last update finished successfully.';
  }

  if (job.status === 'failed') {
    return 'The last update failed before it could finish.';
  }

  if (job.status === 'running' || job.status === 'queued') {
    return 'An update is running now. The suite may restart while it applies changes.';
  }

  return 'Suite Manager received update activity from the host updater.';
}

function UpdateActivity({ job }: { job: UpdatesStatus['currentJob'] }) {
  if (!job) {
    return null;
  }

  const logs = job.logs || [];

  return (
    <div className="suite-updates-job">
      <strong>Update activity</strong>
      <p className="suite-meta mos-meta">
        {jobStatusText(job)}
        {job.updatedAt ? ` Last updated ${formatDate(job.updatedAt)}.` : ''}
      </p>
      {job.error ? <p className="suite-warning">{job.error}</p> : null}
      {logs.length > 0 ? (
        <details className="suite-job-details">
          <summary>Advanced details</summary>
          <ol className="suite-updates-job-log">
            {logs.slice(-8).map((entry, index) => (
              <li key={`${entry.at || 'log'}-${index}`}>
                <span>{entry.at ? formatDate(entry.at) : 'Update job'}</span>
                <code>{entry.message || 'No message'}</code>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

export default function UpdatesApp() {
  const { applyUpdate, configureTrack, isApplying, isConfiguringTrack, isJobRunning, refresh, state } = useUpdates();
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedTrack, setSelectedTrack] = useState<'stable' | 'staging'>('stable');
  const canApplyUpdate =
    state.kind === 'loaded' &&
    state.status.managedApplyAvailable &&
    state.status.updateAvailable &&
    !isApplying &&
    !isJobRunning;
  const canSwitchTrack =
    state.kind === 'loaded' &&
    state.status.trackConfigurationAvailable &&
    selectedTrack !== currentTrackOption(state.status) &&
    !isApplying &&
    !isConfiguringTrack &&
    !isJobRunning;

  useEffect(() => {
    if (state.kind === 'loaded') {
      setSelectedTrack(currentTrackOption(state.status));
    }
  }, [state]);

  async function handleApplyUpdate(): Promise<void> {
    setActionError(null);
    try {
      await applyUpdate();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to start update.');
    }
  }

  async function handleConfigureTrack(): Promise<void> {
    setActionError(null);
    try {
      await configureTrack(selectedTrack);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to switch update track.');
    }
  }

  return (
    <main className="suite-app">
      <section className="mos-shell suite-hero">
        <span className="mos-eyebrow">My Own Suite</span>
        <h1 className="mos-page-title">Updates</h1>
      </section>

      <section className="mos-shell">
        <div className="mos-panel suite-card suite-updates-card">
          <div className="suite-updates-header">
            <div>
              <h2 className="mos-card-title">Suite core</h2>
              <p className="suite-meta mos-meta">
                Suite Manager checks the local updater capability before showing host-owned update actions.
              </p>
            </div>

            <div className="suite-updates-actions">
              <button
                className="suite-copy-button suite-updates-refresh"
                disabled={isApplying || isJobRunning}
                onClick={() => void refresh()}
                type="button"
              >
                <RefreshCcw aria-hidden="true" className="suite-inline-icon" />
                Check again
              </button>
            </div>
          </div>

          {isJobRunning ? (
            <div className="suite-updates-live-banner" aria-live="polite">
              <span className="suite-updates-spinner" aria-hidden="true"></span>
              <div>
                <strong>Update in progress</strong>
                <p className="suite-meta mos-meta">
                  My Own Suite is asking the host updater to apply changes. The page may go offline briefly while services restart.
                </p>
              </div>
            </div>
          ) : null}

          {state.kind === 'loading' ? <p className="suite-empty">Loading update state...</p> : null}

          {state.kind === 'error' ? <p className="suite-error">{state.message}</p> : null}
          {actionError ? <p className="suite-error">{actionError}</p> : null}

          {state.kind === 'loaded' ? (
            <>
              {state.status.trackConfigurationAvailable ? (
                <section className="suite-updates-track-panel">
                  <div className="suite-updates-track-copy">
                    <span className="mos-eyebrow">Update track</span>
                    <strong>{state.status.track.label || 'Stable releases'}</strong>
                    <p className="suite-meta mos-meta">
                      Stable follows published releases from main. Staging follows the latest commit on the staging branch for early testing.
                    </p>
                  </div>

                  <div className="suite-updates-track-controls">
                    <SelectField
                      disabled={isApplying || isConfiguringTrack || isJobRunning}
                      helperText="Changes what Update now will apply."
                      label="Track"
                      onChange={(event) => setSelectedTrack(event.target.value === 'staging' ? 'staging' : 'stable')}
                      value={selectedTrack}
                    >
                      <option value="stable">Stable (main)</option>
                      <option value="staging">Staging branch</option>
                    </SelectField>
                    <button
                      className="suite-copy-button suite-updates-track-action"
                      disabled={!canSwitchTrack}
                      onClick={() => void handleConfigureTrack()}
                      type="button"
                    >
                      {isConfiguringTrack ? 'Switching...' : 'Switch track'}
                    </button>
                  </div>
                </section>
              ) : !state.status.serviceAvailable ? (
                <section className="suite-updates-guidance">
                  <span className="mos-eyebrow">Updates</span>
                  <strong>Update through your hosting provider</strong>
                  <p className="suite-meta mos-meta">
                    In-app updates are only available on self-host installs with the local update agent. Managed platforms usually update from their own dashboard or deploy workflow.
                  </p>
                </section>
              ) : null}

              <div className="suite-updates-overview-grid">
                <article className="suite-updates-panel">
                  <span className="mos-eyebrow">Installed</span>
                  <strong className="suite-updates-version">{state.status.installedVersion || 'Unknown'}</strong>
                  <p className="suite-meta mos-meta">{installedVersionHelpText(state.status.installedVersionSource)}</p>
                </article>

                <article className="suite-updates-panel">
                  <span className="mos-eyebrow">Latest stable release</span>
                  <strong className="suite-updates-version">{state.status.latestRelease.version || 'Unknown'}</strong>
                  <p className="suite-meta mos-meta">Source: {labelForSource(state.status.latestRelease.source)}</p>
                  {state.status.latestRelease.notesUrl ? (
                    <a className="suite-meta mos-meta" href={state.status.latestRelease.notesUrl} rel="noreferrer" target="_blank">
                      Open release notes
                    </a>
                  ) : null}
                  {canApplyUpdate ? (
                    <button
                      className="suite-copy-button suite-updates-inline-action"
                      disabled={isApplying || isJobRunning}
                      onClick={() => void handleApplyUpdate()}
                      type="button"
                    >
                      {isApplying ? 'Starting...' : 'Update now'}
                    </button>
                  ) : null}
                </article>
              </div>

              <article className="suite-updates-panel suite-updates-panel-wide suite-updates-change-panel">
                <div className="suite-updates-status-row">
                  <span className="mos-eyebrow">Update details</span>

                  <span className="suite-meta mos-meta">Checked {formatDate(state.status.checkedAt)}</span>
                </div>

                <div className="suite-updates-change-summary">
                  <div>
                    <span className="mos-eyebrow">Changes</span>
                    <h3>{state.status.changeSummary.title}</h3>
                    {state.status.changeSummary.source ? (
                      <p className="suite-meta mos-meta">From {state.status.changeSummary.source}</p>
                    ) : null}
                  </div>

                  {state.status.changeSummary.items.length > 0 ? (
                    <ul>
                      {state.status.changeSummary.items.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="suite-meta mos-meta">
                      No local changelog summary is available for this target. Open the release notes for the full detail.
                    </p>
                  )}
                </div>

                <dl className="suite-updates-facts">
                  <div>
                    <dt>Active track</dt>
                    <dd>{state.status.track.label || 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Updater service</dt>
                    <dd>{state.status.serviceAvailable ? 'Available' : 'Unavailable'}</dd>
                  </div>
                  <div>
                    <dt>Managed apply</dt>
                    <dd>{state.status.managedApplyAvailable ? 'Available' : 'Unavailable'}</dd>
                  </div>
                  <div>
                    <dt>Update target</dt>
                    <dd>{updateTargetValue(state.status)}</dd>
                  </div>
                  <div>
                    <dt>Target type</dt>
                    <dd>{updateTargetTitle(state.status)}</dd>
                  </div>
                </dl>

                <UpdateActivity job={state.status.currentJob} />

                {state.status.error ? (
                  <p className="suite-warning">
                    Live release lookup failed, so Suite Manager fell back to bundled metadata. {state.status.error}
                  </p>
                ) : null}

                {state.status.latestRelease.source === 'override' ? (
                  <p className="suite-warning">
                    Test override is active. This screen is intentionally simulating a different latest available version.
                  </p>
                ) : null}
              </article>
            </>
          ) : null}
        </div>
      </section>
    </main>
  );
}
