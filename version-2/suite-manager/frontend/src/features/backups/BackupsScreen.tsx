import { useEffect, useState } from 'react';

import { Dialog, Icon, Notice } from '../../components/ui';

type BackupDestination = {
  availableBytes: number | null;
  canMount?: boolean;
  id: string;
  label: string;
  mountBlockedReason?: string | null;
  mountPath: string | null;
  mountState?: 'mounted' | 'unmounted' | 'unsupported-mount';
  sizeBytes: number | null;
  storageKind?: 'external' | 'local' | 'network' | null;
  writable: boolean;
};

type BackupJob = {
  error: string | null;
  id: string;
  kind: string | null;
  logs?: Array<{ at?: string; message?: string }>;
  outputPath: string | null;
  rescuePath: string | null;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
};

type BackupBundle = {
  appCount: number;
  archivePath?: string;
  createdAt: string | null;
  destinationId: string;
  destinationLabel: string;
  id: string;
  path: string;
  sourceVersion: string | null;
  volumeCount: number;
};

type BackupStatus = {
  backups: BackupBundle[];
  currentJob: BackupJob | null;
  destinations: BackupDestination[];
  error?: string | null;
  inventory?: {
    summary: { appCount: number; declaredVolumeCount: number; relationshipCount: number; warningCount: number };
    warnings: Array<{ message: string; packageId: string }>;
  };
  lastJob: BackupJob | null;
  serviceAvailable: boolean;
};

async function jsonResponse<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : fallback);
  return body;
}

function formatDate(value: string | null) {
  if (!value) return 'Unknown date';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'Unknown space';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function isRunning(job: BackupJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

function driveIconName(kind: string | null | undefined) {
  if (kind === 'external') return 'usb-drive';
  if (kind === 'network') return 'network-drive';
  return 'hard-drive';
}

function driveLabel(destination: BackupDestination) {
  return destination.label;
}

function jobMessage(job: BackupJob | null) {
  if (!job) return '';
  if (job.status === 'succeeded') return job.kind === 'restore' ? 'Restore completed.' : 'Backup completed.';
  if (job.status === 'failed') return job.kind === 'restore' ? 'Restore failed.' : 'Backup failed.';
  return job.stage || (job.kind === 'restore' ? 'Restore in progress' : 'Backup in progress');
}

function operationTitle(job: BackupJob | null, restoreStarted: boolean) {
  if (restoreStarted || job?.kind === 'restore') return 'Restoring your backup';
  return 'Backing up your suite';
}

function operationMessage(job: BackupJob | null, restoreStarted: boolean) {
  if (restoreStarted || job?.kind === 'restore') return 'MOS is replacing the current install with the selected backup. Suite Manager may briefly reconnect while services restart.';
  return 'MOS is pausing apps, saving their data, and then starting them again. Please wait until the backup finishes.';
}

function operationStage(job: BackupJob | null, restoreStarted: boolean) {
  if (job?.stage) return job.stage;
  return restoreStarted ? 'Starting restore' : 'Starting backup';
}

function backupDescription(backup: BackupBundle) {
  if (backup.appCount > 0) return `${backup.appCount} app${backup.appCount === 1 ? '' : 's'} and ${backup.volumeCount} data store${backup.volumeCount === 1 ? '' : 's'}`;
  return 'No apps in this backup';
}

export function BackupsScreen() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [selectedDestinationId, setSelectedDestinationId] = useState('');
  const [selectedRestore, setSelectedRestore] = useState<BackupBundle | null>(null);
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [restoreStarted, setRestoreStarted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const activeJob = status?.currentJob || null;
  const running = restoreStarted || isRunning(activeJob);
  const selectedDestination = status?.destinations.find((destination) => destination.id === selectedDestinationId);

  async function load() {
    setError('');
    const next = await jsonResponse<BackupStatus>(await fetch('/suite-manager/api/backups/status'), 'Unable to load backups.');
    setStatus(next);
    if (!isRunning(next.currentJob) && restoreStarted) setRestoreStarted(false);
    if (!selectedDestinationId) {
      const firstWritable = next.destinations.find((destination) => destination.mountState === 'mounted' && destination.writable);
      if (firstWritable) setSelectedDestinationId(firstWritable.id);
    }
  }

  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load backups.')); }, []);
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 4000);
    return () => window.clearInterval(timer);
  }, [running]);

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

  async function mount(destination: BackupDestination) {
    await runAction(`mount:${destination.id}`, async () => {
      const result = await jsonResponse<{ destination: BackupDestination }>(await fetch('/suite-manager/api/backups/mount', {
        body: JSON.stringify({ destinationId: destination.id }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to mount this drive.');
      setSelectedDestinationId(result.destination.id);
    });
  }

  async function startBackup() {
    if (!selectedDestination) return;
    await runAction('backup', async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/start', {
        body: JSON.stringify({ destinationId: selectedDestination.id }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to start backup.');
    });
  }

  async function startRestore() {
    if (!selectedRestore) return;
    setBusy('restore');
    setError('');
    try {
      await jsonResponse(await fetch('/suite-manager/api/backups/restore', {
        body: JSON.stringify({ backupPath: selectedRestore.path, confirmation: restoreConfirmation }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to start restore.');
      setSelectedRestore(null);
      setRestoreConfirmation('');
      setRestoreStarted(true);
      await load().catch(() => undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  }

  return <section className="mos-shell suite-backups">
    <div className="suite-hero">
      <h1>Backup & Restore</h1>
      <p className="suite-lead mos-body-lg">Save a copy of My Own Suite to an external drive, then restore it if you ever need to recover your system.</p>
    </div>

    {error ? <Notice title="Backup needs attention" variant="error"><p>{error}</p></Notice> : null}
    {restoreStarted ? <Notice title="Restore started" variant="info"><p>MOS is restoring the selected backup and may be unavailable for a short moment. This page will reconnect when Suite Manager starts again.</p></Notice> : null}
    {status && !status.serviceAvailable ? <Notice title="Backup is not available yet" variant="warning"><p>The host backup service is not running on this install. Update or restart the MOS V2 host services, then come back here.</p></Notice> : null}

    {status?.serviceAvailable ? <div className="suite-backup-layout" aria-busy={running}>
      {running ? <div className="suite-backup-busy" aria-live="polite" role="status">
        <div className="suite-backup-spinner" aria-hidden="true" />
        <div>
          <strong>{operationTitle(activeJob, restoreStarted)}</strong>
          <p>{operationMessage(activeJob, restoreStarted)}</p>
          <small>{operationStage(activeJob, restoreStarted)}</small>
        </div>
      </div> : null}

      <section className="mos-panel suite-card suite-backup-panel">
        <div className="suite-backup-header-row">
          <div>
            <h2 className="mos-card-title">Available backup drives</h2>
            <p className="suite-meta">Select where you want to save your backup. Always use an external USB drive when possible.</p>
          </div>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running} onClick={() => void load()} type="button">
            <Icon name="refresh" /> Refresh
          </button>
        </div>

        {status.destinations.length ? <div className="suite-drive-list">
          {status.destinations.map((destination) => {
            const mounted = destination.mountState === 'mounted';
            const selectable = mounted && destination.writable && !running && !busy;
            const selected = selectedDestinationId === destination.id;

            return <div className={`suite-drive-item ${selected ? 'is-selected' : ''}`} key={destination.id}>
              <button className="suite-drive-select" disabled={!selectable} onClick={() => setSelectedDestinationId(destination.id)} type="button">
                <span className="suite-drive-icon"><Icon name={driveIconName(destination.storageKind)} /></span>
                <div className="suite-drive-info">
                  <strong>{driveLabel(destination)}</strong>
                  {mounted && destination.sizeBytes
                    ? <small>{formatBytes(destination.availableBytes)} free of {formatBytes(destination.sizeBytes)}</small>
                    : <small>{mounted ? 'Calculating space...' : destination.mountBlockedReason || 'Drive connected but not available'}</small>
                  }
                </div>
              </button>

              {!mounted && destination.canMount
                ? <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={Boolean(busy) || running} onClick={() => void mount(destination)} type="button">
                    {busy === `mount:${destination.id}` ? 'Mounting...' : 'Mount'}
                  </button>
                : null
              }
            </div>;
          })}
        </div> :
          <div className="suite-empty-state">
            <p className="suite-meta">No backup drives found.</p>
            <p className="suite-meta">Plug in a USB drive and click Refresh above.</p>
          </div>
        }

        <div className="suite-backup-actions">
          <button className="mos-btn mos-btn-primary" disabled={!selectedDestination?.writable || Boolean(busy) || running} onClick={() => void startBackup()} type="button">
            {busy === 'backup' ? 'Starting backup...' : 'Back up now'}
          </button>
        </div>
      </section>

      {(status.currentJob || status.lastJob) ? <section className="mos-panel suite-card suite-backup-panel">
        <h2 className="mos-card-title">{running ? 'Working on it' : 'Latest activity'}</h2>
        <p>{jobMessage(status.currentJob || status.lastJob)}</p>
        {(status.currentJob || status.lastJob)?.error ? <p className="suite-error">{(status.currentJob || status.lastJob)?.error}</p> : null}
      </section> : null}

      <section className="mos-panel suite-card suite-backup-panel">
        <h2 className="mos-card-title">Restore from a backup</h2>
        {status.backups.length ? <div className="suite-backup-bundle-list">
          {status.backups.map((backup) => <article key={backup.path}>
            <div><strong>{backup.createdAt ? formatDate(backup.createdAt) : 'MOS backup'}</strong><span>{backupDescription(backup)} · {backup.destinationLabel || 'Backup drive'}</span></div>
            <div className="suite-backup-action-row">
              {running ? <button className="mos-btn mos-btn-secondary" disabled type="button">Download</button> : <a className="mos-btn mos-btn-secondary" href={`/suite-manager/api/backups/download?path=${encodeURIComponent(backup.path)}`}>Download</a>}
              <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running} onClick={() => { setSelectedRestore(backup); setRestoreConfirmation(''); }} type="button">Restore</button>
            </div>
          </article>)}
        </div> : <p className="suite-meta">Backups found on connected drives will appear here.</p>}
      </section>

      <details className="suite-advanced suite-backup-advanced">
        <summary>Advanced details</summary>
        <dl>
          <dt>Detected apps</dt><dd>{status.inventory?.summary.appCount ?? 0}</dd>
          <dt>Detected app data stores</dt><dd>{status.inventory?.summary.declaredVolumeCount ?? 0}</dd>
          <dt>App connections</dt><dd>{status.inventory?.summary.relationshipCount ?? 0}</dd>
          <dt>Warnings</dt><dd>{status.inventory?.warnings.map((warning) => `${warning.packageId}: ${warning.message}`).join(', ') || 'None'}</dd>
        </dl>
      </details>
    </div> : null}

    {selectedRestore ? <Dialog
      footer={<>
        <button className="mos-btn mos-btn-primary" disabled={restoreConfirmation !== 'RESTORE' || Boolean(busy)} onClick={() => void startRestore()} type="button">{busy === 'restore' ? 'Starting restore...' : 'Restore backup'}</button>
        <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => setSelectedRestore(null)} type="button">Cancel</button>
      </>}
      onClose={() => { if (!busy) setSelectedRestore(null); }}
      title="Restore this backup?"
    >
      <Notice title="This will replace the current install" variant="warning"><p>MOS will stop, restore the selected backup, and start again. Current app data will be replaced. A small rescue copy is saved first.</p></Notice>
      <p className="suite-meta">{formatDate(selectedRestore.createdAt)} · {backupDescription(selectedRestore)} · {selectedRestore.destinationLabel || 'backup storage'}</p>
      <label className="suite-auth-field">
        <span>Type RESTORE to continue</span>
        <input autoFocus onChange={(event) => setRestoreConfirmation(event.currentTarget.value)} value={restoreConfirmation} />
      </label>
    </Dialog> : null}
  </section>;
}