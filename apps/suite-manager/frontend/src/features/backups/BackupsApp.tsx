import { ExternalLink, HardDrive, RefreshCcw } from 'lucide-react';
import { useState } from 'react';

import { useBackups } from './useBackups';
import type { BackupBundle, BackupDestination, BackupJobSummary } from './types';

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

function jobActionLabel(job: BackupJobSummary): string {
  return job.kind === 'restore' ? 'Restore' : 'Backup';
}

function jobStatusLabel(job: BackupJobSummary): string {
  const action = jobActionLabel(job);

  if (job.status === 'succeeded') {
    return `${action} completed`;
  }

  if (job.status === 'failed') {
    return `${action} failed`;
  }

  if (job.status === 'running' || job.status === 'queued') {
    return `${action} in progress`;
  }

  return `${action} status unknown`;
}

function restoreStatusLabel(restoreApplyAvailable: boolean, restorePlanAvailable: boolean): string {
  if (restoreApplyAvailable) {
    return 'Available';
  }

  if (restorePlanAvailable) {
    return 'Preview';
  }

  return 'Unavailable';
}

function restoreStatusText(restoreApplyAvailable: boolean, restorePlanAvailable: boolean): string {
  if (restoreApplyAvailable) {
    return 'Suite Manager can start a host-owned restore from a detected backup bundle.';
  }

  if (restorePlanAvailable) {
    return 'Suite Manager can inspect restore candidates, but starting a restore is not enabled yet.';
  }

  return 'Install or refresh the self-host backup agent to enable managed restore actions.';
}

function JobPanel({ job, title }: { job: BackupJobSummary | null; title: string }) {
  if (!job) {
    return null;
  }

  const isRunning = jobIsRunning(job);

  return (
    <div className="suite-updates-job">
      <strong>{title}</strong>
      <p className="suite-meta mos-meta">
        {jobStatusLabel(job)}
        {job.updatedAt ? ` on ${formatDate(job.updatedAt)}.` : '.'}
      </p>
      {job.outputPath ? (
        <p className="suite-meta mos-meta">
          {job.kind === 'restore' ? 'Restored from' : 'Saved to'} {job.outputPath}
        </p>
      ) : null}
      {job.error ? <p className="suite-warning">{job.error}</p> : null}
      {job.logs && job.logs.length > 0 ? (
        <details className="suite-job-details">
          <summary>Advanced details</summary>
          {job.rescuePath ? <p className="suite-meta mos-meta">Pre-restore rescue: {job.rescuePath}</p> : null}
          <ol className="suite-updates-job-log">
            {job.logs.slice(-8).map((entry, index) => (
              <li key={`${entry.at || 'log'}-${index}`}>
                <span>{entry.at ? formatDate(entry.at) : 'Backup job'}</span>
                <code>{entry.message || 'No message'}</code>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

function DestinationButton({
  destination,
  disabled,
  isMounting,
  isSelected,
  mountAvailable,
  onMount,
  onSelect,
}: {
  destination: BackupDestination;
  disabled: boolean;
  isMounting: boolean;
  isSelected: boolean;
  mountAvailable: boolean;
  onMount: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const mountState = destination.mountState || 'mounted';
  const isMounted = mountState === 'mounted';
  const canSelect = isMounted && destination.writable && !disabled;
  const canMount = !isMounted && Boolean(destination.canMount) && mountAvailable && !disabled && !isMounting;
  const statusText =
    isMounted
      ? destination.writable
        ? 'ready'
        : 'read only'
      : mountState === 'unsupported-mount'
        ? 'mounted outside backup paths'
        : 'not mounted';
  const capacityText = isMounted
    ? `${formatBytes(destination.availableBytes)} free`
    : destination.sizeBytes
      ? formatBytes(destination.sizeBytes)
      : statusText;
  const storageKindLabel =
    destination.storageKind === 'network'
      ? 'Network storage'
      : destination.storageKind === 'local'
        ? 'Local storage'
        : 'External drive';
  const destinationName = destination.label || destination.mountPath || destination.devicePath || 'Backup storage';
  const subtitle = isMounted
    ? `Mounted at ${destination.mountPath || 'backup path'}`
    : destination.canMount
      ? 'Ready to mount for backups'
      : destination.devicePath || 'Storage device';

  function handleDestinationClick(): void {
    if (canSelect) {
      onSelect(destination.id);
    }
  }

  return (
    <div
      className={`suite-backup-destination${isSelected ? ' is-selected' : ''}${!canSelect ? ' is-disabled' : ''}`}
      onClick={handleDestinationClick}
      role={canSelect ? 'button' : undefined}
      tabIndex={canSelect ? 0 : undefined}
      onKeyDown={(event) => {
        if (canSelect && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect(destination.id);
        }
      }}
    >
      <HardDrive aria-hidden="true" className="suite-backup-drive-icon" />
      <span className="suite-backup-destination-copy">
        <strong>{storageKindLabel}: {destinationName}</strong>
        <span>{subtitle}</span>
        {!isMounted ? (
          <span className="suite-warning">
            {destination.mountBlockedReason ||
            (mountState === 'unsupported-mount'
              ? 'Mount this drive under /media, /mnt, or /run/media to use it for MOS backups.'
              : 'The drive is connected but not mounted. Mount it first, then scan again.')}
          </span>
        ) : null}
      </span>
      <span className="suite-backup-destination-meta">
        {capacityText}
        {!isMounted && destination.sizeBytes ? ` - ${statusText}` : ''}
        {destination.fileSystem ? ` - ${destination.fileSystem}` : ''}
        {isMounted && !destination.writable ? ' - read only' : ''}
      </span>
      {!isMounted && destination.canMount ? (
        <button
          className="suite-copy-button suite-backup-mount-button"
          disabled={!canMount}
          onClick={(event) => {
            event.stopPropagation();
            onMount(destination.id);
          }}
          type="button"
        >
          {isMounting ? 'Mounting...' : 'Mount'}
        </button>
      ) : null}
    </div>
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

function BackupBundleList({
  backups,
  canRestore,
  isRestoring,
  onRestore,
}: {
  backups: BackupBundle[];
  canRestore: boolean;
  isRestoring: boolean;
  onRestore: (backup: BackupBundle) => void;
}) {
  if (backups.length === 0) {
    return (
      <p className="suite-meta mos-meta">
        Completed backup bundles on mounted drives will appear here after the next scan.
      </p>
    );
  }

  return (
    <div className="suite-backup-bundles">
      {backups.slice(0, 6).map((backup) => (
        <article className="suite-backup-bundle" key={`${backup.destinationId}-${backup.path}`}>
          <div>
            <strong>{backup.sourceVersion ? `MOS ${backup.sourceVersion}` : 'MOS backup'}</strong>
            <p className="suite-meta mos-meta">
              {backup.createdAt ? formatDate(backup.createdAt) : 'Unknown date'} on {backup.destinationLabel || backup.destinationId}
            </p>
          </div>
          <dl className="suite-backup-bundle-facts">
            <div>
              <dt>Volumes</dt>
              <dd>{backup.volumeCount}</dd>
            </div>
            <div>
              <dt>Archive size</dt>
              <dd>{formatBytes(backup.totalVolumeArchiveBytes)}</dd>
            </div>
            <div>
              <dt>Profiles</dt>
              <dd>{backup.activeProfiles.length > 0 ? backup.activeProfiles.join(', ') : 'Core'}</dd>
            </div>
          </dl>
          <p className="suite-meta mos-meta suite-backup-bundle-path">{backup.path}</p>
          <button
            className="suite-copy-button suite-backup-restore-button"
            disabled={!canRestore || isRestoring}
            onClick={() => onRestore(backup)}
            type="button"
          >
            Restore
          </button>
        </article>
      ))}
    </div>
  );
}

export default function BackupsApp() {
  const { isJobRunning, isMounting, isRestoring, isStarting, mountDestination, refresh, startBackup, startRestore, state } = useBackups();
  const [selectedDestinationId, setSelectedDestinationId] = useState<string>('');
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [selectedRestore, setSelectedRestore] = useState<BackupBundle | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loaded = state.kind === 'loaded' ? state.status : null;
  const selectedDestination = loaded?.destinations.find((destination) => destination.id === selectedDestinationId);
  const runningJob = loaded && jobIsRunning(loaded.currentJob) ? loaded.currentJob : null;
  const latestCompletedJob = loaded && !runningJob ? loaded.lastJob || loaded.currentJob : null;
  const canStart =
    Boolean(loaded?.serviceAvailable && loaded.startBackupAvailable && selectedDestination?.writable) &&
    !isStarting &&
    !isJobRunning;
  const canRestore = Boolean(loaded?.restoreApplyAvailable) && !isRestoring && !isJobRunning;

  async function handleStartBackup(): Promise<void> {
    setActionError(null);
    try {
      await startBackup(selectedDestinationId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to start backup.');
    }
  }

  async function handleMountDestination(destinationId: string): Promise<void> {
    setActionError(null);
    try {
      const destination = await mountDestination(destinationId);
      if (destination?.id) {
        setSelectedDestinationId(destination.id);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to mount drive.');
    }
  }

  async function handleStartRestore(): Promise<void> {
    if (!selectedRestore) {
      return;
    }

    setActionError(null);
    try {
      await startRestore(selectedRestore.path, restoreConfirmation);
      setSelectedRestore(null);
      setRestoreConfirmation('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to start restore.');
    }
  }

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
        <div className="suite-backups-stack">
          {state.kind === 'loading' ? <p className="suite-empty">Loading backup state...</p> : null}
          {state.kind === 'error' ? <p className="suite-error">{state.message}</p> : null}
          {actionError ? <p className="suite-error">{actionError}</p> : null}

          {loaded && !loaded.serviceAvailable ? (
            <div className="mos-panel suite-card suite-updates-card suite-backups-card">
              <ManagedInfrastructureGuidance error={loaded.error} onRefresh={() => void refresh()} />
            </div>
          ) : null}

          {loaded && loaded.serviceAvailable ? (
            <>
              <section className="mos-panel suite-card suite-updates-card suite-backups-card">
                <div className="suite-backup-selfhost-stack">
                  <div className="suite-backup-selfhost-header">
                    <div className="suite-updates-header">
                      <div>
                        <h2 className="mos-card-title">Backup</h2>
                        <p className="suite-meta mos-meta">
                          Connect or mount storage, choose a writable destination, then start a host-owned backup job.
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
                      The stack will be stopped while Docker volumes are archived, then started again with the same detected
                      profiles. Suite Manager may be unavailable during the backup.
                    </p>
                  </div>

                  <div className="suite-backup-capability-note">
                    <span className="mos-eyebrow">Backup agent</span>
                    <strong>{loaded.serviceAvailable ? 'Available' : 'Unavailable'}</strong>
                    <p className="suite-meta mos-meta">
                      {loaded.startBackupAvailable
                        ? 'Suite Manager can start host-owned backup jobs.'
                        : 'Install or refresh the self-host backup agent to enable managed backups.'}
                    </p>
                  </div>

                  <section className="suite-backup-section">
                    <div className="suite-updates-status-row">
                      <div>
                        <span className="mos-eyebrow">Select drive</span>
                        <h2 className="mos-card-title">Backup destination</h2>
                      </div>
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
                          isMounting={isMounting}
                          isSelected={destination.id === selectedDestinationId}
                          mountAvailable={loaded.mountDestinationAvailable}
                          key={destination.id}
                          onMount={(destinationId) => void handleMountDestination(destinationId)}
                          onSelect={setSelectedDestinationId}
                        />
                      ))}
                    </div>

                    {loaded.destinations.length === 0 ? (
                      <p className="suite-meta mos-meta">
                        Plug in an external drive. If it is already plugged in, make sure Linux sees it as a removable or USB
                        block device, then mount it under /media, /mnt, or /run/media.
                      </p>
                    ) : null}

                    <div className="suite-actions">
                      <button
                        className="suite-copy-button"
                        disabled={!canStart}
                        onClick={() => void handleStartBackup()}
                        type="button"
                      >
                        {isStarting ? 'Starting...' : 'Start backup'}
                      </button>
                    </div>

                    <JobPanel job={runningJob} title="Backup activity" />
                    <JobPanel job={latestCompletedJob} title="Latest backup activity" />
                  </section>
                </div>
              </section>

              <section className="mos-panel suite-card suite-updates-card suite-backups-card">
                <div className="suite-backup-selfhost-stack">
                  <div className="suite-updates-status-row">
                    <div>
                      <span className="mos-eyebrow">Restore</span>
                      <h2 className="mos-card-title">Restore from backup</h2>
                    </div>
                    <span className="mos-pill">{loaded.backups.length} found</span>
                  </div>

                  <div className="suite-backup-capability-note">
                    <span className="mos-eyebrow">Restore status</span>
                    <strong>{restoreStatusLabel(loaded.restoreApplyAvailable, loaded.restorePlanAvailable)}</strong>
                    <p className="suite-meta mos-meta">{restoreStatusText(loaded.restoreApplyAvailable, loaded.restorePlanAvailable)}</p>
                  </div>

                  <p className="suite-meta mos-meta">
                    Restore stops the current stack, replaces MOS Docker volumes and runtime config from the selected bundle,
                    then starts the recorded profiles. Use this only on a fresh or intentionally disposable install.
                  </p>

                  <BackupBundleList
                    backups={loaded.backups}
                    canRestore={canRestore}
                    isRestoring={isRestoring}
                    onRestore={(backup) => {
                      setActionError(null);
                      setSelectedRestore(backup);
                      setRestoreConfirmation('');
                    }}
                  />
                </div>
              </section>
            </>
          ) : null}
        </div>
      </section>

      {selectedRestore ? (
        <div className="suite-modal-backdrop" role="presentation">
          <section aria-modal="true" className="suite-restore-modal mos-panel" role="dialog">
            <h2 className="mos-card-title">Restore this backup?</h2>
            <p className="suite-warning">
              This will stop My Own Suite, remove current MOS Docker volumes, restore data from the selected backup, and
              restart the recorded profiles.
            </p>
            <dl className="suite-backup-bundle-facts">
              <div>
                <dt>Backup</dt>
                <dd>{selectedRestore.sourceVersion ? `MOS ${selectedRestore.sourceVersion}` : selectedRestore.id}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{formatDate(selectedRestore.createdAt)}</dd>
              </div>
              <div>
                <dt>Volumes</dt>
                <dd>{selectedRestore.volumeCount}</dd>
              </div>
            </dl>
            <label className="suite-auth-field">
              <span>Type RESTORE to continue</span>
              <input
                autoFocus
                onChange={(event) => setRestoreConfirmation(event.target.value)}
                value={restoreConfirmation}
              />
            </label>
            <div className="suite-actions">
              <button className="suite-copy-button suite-danger-button" disabled={restoreConfirmation !== 'RESTORE' || isRestoring} onClick={() => void handleStartRestore()} type="button">
                {isRestoring ? 'Starting...' : 'Start restore'}
              </button>
              <button
                className="suite-copy-button"
                disabled={isRestoring}
                onClick={() => {
                  setSelectedRestore(null);
                  setRestoreConfirmation('');
                }}
                type="button"
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
