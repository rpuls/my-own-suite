import { RefreshCcw } from 'lucide-react';

import { useUpdates } from './useUpdates';

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

export default function UpdatesApp() {
  const { applyUpdate, isApplying, isJobRunning, refresh, state } = useUpdates();
  const canApplyUpdate =
    state.kind === 'loaded' &&
    state.status.mode === 'managed' &&
    state.status.serviceAvailable &&
    state.status.updateAvailable &&
    !isApplying &&
    !isJobRunning;

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
                Managed self-host installs can now surface their active track and start host-owned update jobs when a newer version or commit is actually available.
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

          {state.kind === 'loaded' ? (
            <div className="suite-updates-grid">
              <article className="suite-updates-panel">
                <span className="mos-eyebrow">Installed</span>
                <strong className="suite-updates-version">{state.status.installedVersion || 'Unknown'}</strong>
                <p className="suite-meta mos-meta">{installedVersionHelpText(state.status.installedVersionSource)}</p>
              </article>

              <article className="suite-updates-panel">
                <span className="mos-eyebrow">Latest available</span>
                <strong className="suite-updates-version">{state.status.latestRelease.version || 'Unknown'}</strong>
                <p className="suite-meta mos-meta">
                  Source: {labelForSource(state.status.latestRelease.source)}
                </p>
                {state.status.track.label ? (
                  <p className="suite-meta mos-meta">Track: {state.status.track.label}</p>
                ) : null}
                {canApplyUpdate ? (
                  <button
                    className="suite-copy-button suite-updates-inline-action"
                    disabled={isApplying || isJobRunning}
                    onClick={() => void applyUpdate()}
                    type="button"
                  >
                    {isApplying ? 'Starting...' : 'Update now'}
                  </button>
                ) : null}
              </article>

              <article className="suite-updates-panel suite-updates-panel-wide">
                <div className="suite-updates-status-row">
                  <span
                    className={`mos-pill ${state.status.updateAvailable ? 'is-active' : 'is-completed'}`}
                  >
                    {isJobRunning ? 'Updating now' : state.status.updateAvailable ? 'Update available' : 'Up to date'}
                  </span>

                  <span className="suite-meta mos-meta">Checked {formatDate(state.status.checkedAt)}</span>
                </div>

                <p className="suite-meta mos-meta">
                  {state.status.mode === 'notify-only'
                    ? 'This installation is configured for notify-only updates. Install new versions through your hosting platform or deployment workflow.'
                    : state.status.serviceAvailable
                      ? 'This installation is configured for managed updates and can ask the host-owned updater service to apply the next available update.'
                      : 'This installation is configured for managed updates, but the local host updater service is currently unavailable.'}
                </p>

                <dl className="suite-updates-facts">
                  <div>
                    <dt>Release channel</dt>
                    <dd>{state.status.latestRelease.channel || 'Unknown'}</dd>
                  </div>
                  <div>
                    <dt>Update mode</dt>
                    <dd>{state.status.mode}</dd>
                  </div>
                  <div>
                    <dt>Updater service</dt>
                    <dd>{state.status.serviceAvailable ? 'Available' : 'Unavailable'}</dd>
                  </div>
                  <div>
                    <dt>Published</dt>
                    <dd>{formatDate(state.status.latestRelease.publishedAt)}</dd>
                  </div>
                  <div>
                    <dt>Release notes</dt>
                    <dd>
                      {state.status.latestRelease.notesUrl ? (
                        <a href={state.status.latestRelease.notesUrl} rel="noreferrer" target="_blank">
                          Open release notes
                        </a>
                      ) : (
                        'Not available'
                      )}
                    </dd>
                  </div>
                </dl>

                {state.status.currentJob ? (
                  <div className="suite-updates-job">
                    <strong>Current job</strong>
                    <p className="suite-meta mos-meta">
                      {state.status.currentJob.status || 'unknown'} in stage {state.status.currentJob.stage || 'unknown'}.
                      Last update {state.status.currentJob.updatedAt ? ` ${formatDate(state.status.currentJob.updatedAt)}` : ''}
                    </p>
                    {state.status.currentJob.error ? (
                      <p className="suite-warning">{state.status.currentJob.error}</p>
                    ) : null}
                    {state.status.currentJob.logs && state.status.currentJob.logs.length > 0 ? (
                      <ol className="suite-updates-job-log">
                        {state.status.currentJob.logs.slice(-8).map((entry, index) => (
                          <li key={`${entry.at || 'log'}-${index}`}>
                            <span>{entry.at ? formatDate(entry.at) : 'Update job'}</span>
                            <code>{entry.message || 'No message'}</code>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                ) : null}

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
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
