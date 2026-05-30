import { ExternalLink, HardDrive, RefreshCcw } from 'lucide-react';
import { useState } from 'react';

import { useBackups } from './useBackups';
import type { BackupDestination, BackupJobSummary } from './types';

function formatDate(value: string | null): string {
  if (!value) {
    return 'Not available';
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'Unknown';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }

  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function jobIsRunning(job: BackupJobSummary | null): boolean {
  return Boolean(job && (job.status === 'running' || job.status === 'queued'));
}

function JobPanel({ job, title }: { job: BackupJobSummary | null; title: string }) {
  if (!job) {
    return null;
  }

  return (
    <div className="suite-updates-job">
      <strong>{title}</strong>
      <p className="suite-meta mos-meta">
        {job.status || 'unknown'} in stage {job.stage || 'unknown'}.
        {job.updatedAt ? ` Last update ${formatDate(job.updatedAt)}.` : ''}
      </p>
      {job.outputPath ? <p className="suite-meta mos-meta">Output: {job.outputPath}</p> : null}
      {job.error ? <p className="suite-warning">{job.error}</p> : null}
      {job.logs && job.logs.length > 0 ? (
        <ol className="suite-updates-job-log">
          {job.logs.slice(-8).map((entry, index) => (
            <li key={`${entry.at || 'log'}-${index}`}>
              <span>{entry.at ? formatDate(entry.at) : 'Backup job'}</span>
              <code>{entry.message || 'No message'}</code>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function DestinationButton({
  destination,
  disabled,
  isSelected,
  onSelect,
}: {
  destination: BackupDestination;
  disabled: boolean;
  isSelected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className={`suite-backup-destination${isSelected ? ' is-selected' : ''}`}
      disabled={disabled || !destination.writable}
      onClick={() => onSelect(destination.id)}
      type="button"
    >
      <HardDrive aria-hidden="true" className="suite-backup-drive-icon" />
      <span className="suite-backup-destination-copy">
        <strong>{destination.label || destination.mountPath}</strong>
        <span>{destination.mountPath}</span>
      </span>
      <span className="suite-backup-destination-meta">
        {formatBytes(destination.availableBytes)} free
        {destination.transport ? ` - ${destination.transport}` : ''}
        {!destination.writable ? ' - read only' : ''}
      </span>
    </button>
  );
}

function ManagedInfrastructureGuidance({ error, onRefresh }: { error: string | null; onRefresh: () => void }) {
  return (
    <div className="suite-backup-managed">
      <div className="suite-updates-header">
        <div>
          <h2 className="mos-card-title">No backup agent available</h2>
          <p className="suite-meta mos-meta">
            This usually means My Own Suite is running on managed infrastructure like Railway, Dokploy, or a regular
            Docker Compose host instead of the MOS self-host install path.
          </p>
        </div>

        <button className="suite-copy-button suite-updates-refresh" onClick={onRefresh} type="button">
          <RefreshCcw aria-hidden="true" className="suite-inline-icon" />
          Check again
        </button>
      </div>

      {error ? <p className="suite-warning">{error}</p> : null}

      <p className="suite-backup-managed-lead">
        Use your hosting platform's backup and restore tools for now. Those tools can see the platform-owned databases,
        volumes, snapshots, and restore controls that Suite Manager cannot safely control from inside the app container.
      </p>

      <div className="suite-backup-resource-grid">
        <a className="suite-backup-resource" href="https://docs.railway.com/reference/backups" rel="noreferrer" target="_blank">
          <span>
            <strong>Railway</strong>
            <small>Use Railway backups for database and volume-backed data, including restore from the Railway dashboard.</small>
          </span>
          <ExternalLink aria-hidden="true" className="suite-inline-icon" />
        </a>

        <a className="suite-backup-resource" href="https://docs.dokploy.com/docs/core/backups" rel="noreferrer" target="_blank">
          <span>
            <strong>Dokploy</strong>
            <small>Use Dokploy's backup system for platform data, and its volume backup tools for app volumes.</small>
          </span>
          <ExternalLink aria-hidden="true" className="suite-inline-icon" />
        </a>

        <a
          className="suite-backup-resource"
          href="https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes"
          rel="noreferrer"
          target="_blank"
        >
          <span>
            <strong>Docker Compose</strong>
            <small>Back up the compose files, environment files, and persistent Docker volumes used by the stack.</small>
          </span>
          <ExternalLink aria-hidden="true" className="suite-inline-icon" />
        </a>
      </div>
    </div>
  );
}

export default function BackupsApp() {
  const { isJobRunning, isStarting, refresh, startBackup, state } = useBackups();
  const [selectedDestinationId, setSelectedDestinationId] = useState<string>('');

  const loaded = state.kind === 'loaded' ? state.status : null;
  const selectedDestination = loaded?.destinations.find((destination) => destination.id === selectedDestinationId);
  const canStart =
    Boolean(loaded?.serviceAvailable && loaded.startBackupAvailable && selectedDestination?.writable) &&
    !isStarting &&
    !isJobRunning;

  return (
    <main className="suite-app">
      <section className="mos-shell suite-hero">
        <span className="mos-eyebrow">My Own Suite</span>
        <h1 className="mos-page-title">Backup</h1>
        <p className="suite-lead">
          Keep your suite recoverable with the backup tools available for the infrastructure running it.
        </p>
      </section>

      <section className="mos-shell">
        <div className="mos-panel suite-card suite-updates-card suite-backups-card">
          {state.kind === 'loading' ? <p className="suite-empty">Loading backup state...</p> : null}
          {state.kind === 'error' ? <p className="suite-error">{state.message}</p> : null}

          {loaded && !loaded.serviceAvailable ? (
            <ManagedInfrastructureGuidance error={loaded.error} onRefresh={() => void refresh()} />
          ) : null}

          {loaded && loaded.serviceAvailable ? (
            <div className="suite-updates-grid">
              <div className="suite-updates-panel-wide suite-backup-selfhost-header">
                <div className="suite-updates-header">
                  <div>
                    <h2 className="mos-card-title">External backup</h2>
                    <p className="suite-meta mos-meta">
                      Plug in a drive, choose the detected mount, then start a host-owned backup job.
                    </p>
                  </div>

                  <button
                    className="suite-copy-button suite-updates-refresh"
                    disabled={isStarting || isJobRunning}
                    onClick={() => void refresh()}
                    type="button"
                  >
                    <RefreshCcw aria-hidden="true" className="suite-inline-icon" />
                    Scan again
                  </button>
                </div>

                {jobIsRunning(loaded.currentJob) ? (
                  <div className="suite-updates-live-banner" aria-live="polite">
                    <span className="suite-updates-spinner" aria-hidden="true"></span>
                    <div>
                      <strong>Backup in progress</strong>
                      <p className="suite-meta mos-meta">
                        The host backup agent is writing persistent job state, so progress can recover after Suite Manager
                        restarts.
                      </p>
                    </div>
                  </div>
                ) : null}

                <p className="suite-warning">
                  This first backup-agent slice records suite metadata and repo-managed runtime configuration. Full Docker
                  volume archiving and automated restore are next in the epic.
                </p>
              </div>

              <article className="suite-updates-panel">
                <span className="mos-eyebrow">Backup agent</span>
                <strong className="suite-updates-version">{loaded.serviceAvailable ? 'Available' : 'Unavailable'}</strong>
                <p className="suite-meta mos-meta">
                  {loaded.startBackupAvailable
                    ? 'Suite Manager can start host-owned backup jobs.'
                    : 'Install or refresh the self-host backup agent to enable managed backups.'}
                </p>
              </article>

              <article className="suite-updates-panel">
                <span className="mos-eyebrow">Restore</span>
                <strong className="suite-updates-version">{loaded.restorePlanAvailable ? 'Planned' : 'Unavailable'}</strong>
                <p className="suite-meta mos-meta">
                  Restore remains version-paired and conservative until the cold backup format is validated.
                </p>
              </article>

              <article className="suite-updates-panel suite-updates-panel-wide">
                <div className="suite-updates-status-row">
                  <span className={`mos-pill ${loaded.destinations.length > 0 ? 'is-active' : ''}`}>
                    {loaded.destinations.length > 0 ? `${loaded.destinations.length} destination(s)` : 'No drive found'}
                  </span>
                  <span className="suite-meta mos-meta">Checked {formatDate(loaded.checkedAt)}</span>
                </div>

                {loaded.error ? <p className="suite-warning">{loaded.error}</p> : null}

                <div className="suite-backup-destinations">
                  {loaded.destinations.map((destination) => (
                    <DestinationButton
                      destination={destination}
                      disabled={isStarting || isJobRunning}
                      isSelected={destination.id === selectedDestinationId}
                      key={destination.id}
                      onSelect={setSelectedDestinationId}
                    />
                  ))}
                </div>

                {loaded.destinations.length === 0 ? (
                  <p className="suite-meta mos-meta">
                    Mount an external drive under /media, /mnt, or /run/media, then scan again.
                  </p>
                ) : null}

                <div className="suite-actions">
                  <button
                    className="suite-copy-button"
                    disabled={!canStart}
                    onClick={() => void startBackup(selectedDestinationId)}
                    type="button"
                  >
                    {isStarting ? 'Starting...' : 'Start backup'}
                  </button>
                </div>

                <JobPanel job={loaded.currentJob} title="Current job" />
                {!jobIsRunning(loaded.currentJob) ? <JobPanel job={loaded.lastJob} title="Last job" /> : null}
              </article>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
