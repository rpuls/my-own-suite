import { useEffect, useRef, useState } from 'react';

import { ActionMenu, AdvancedPanel, Dialog, Icon, Notice, TextInput } from '../../components/ui';
import { jsonResponse } from '../../lib/api';

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

type BackupValidation = {
  apps: Array<{ instanceId: string; packageId: string; packageVersion: string | null }>;
  bundlePath: string;
  checkedAt: string;
  software: { bundleVersion: string | null; currentVersion: string | null; matched: boolean };
  volumes: Array<{ name: string; rawBytes: number | null }>;
  warnings: string[];
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
  validation?: BackupValidation | null;
};

type BackupBundle = {
  appCount: number;
  archivePath?: string;
  createdAt: string | null;
  destinationId: string;
  destinationLabel: string;
  id: string;
  note?: string | null;
  path: string;
  sizeBytes?: number | null;
  sourceVersion: string | null;
  volumeCount: number;
};

type InterruptedRestore = {
  backupPath: string | null;
  jobId: string | null;
  phase: string;
  rescuePath: string | null;
  startedAt: string | null;
};

type BackupStatus = {
  backups: BackupBundle[];
  currentJob: BackupJob | null;
  destinations: BackupDestination[];
  error?: string | null;
  interruptedRestore?: InterruptedRestore | null;
  inventory?: {
    summary: { appCount: number; declaredVolumeCount: number; relationshipCount: number; warningCount: number };
    warnings: Array<{ message: string; packageId: string }>;
  };
  lastJob: BackupJob | null;
  restoreGuarantee?: string;
  serviceAvailable: boolean;
};


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

function jobMessage(job: BackupJob | null) {
  if (!job) return '';
  if (job.status === 'succeeded') {
    if (job.kind === 'restore') return 'Restore completed.';
    if (job.kind === 'validate') return 'Backup check passed. Every checksum, archive, and app package in the bundle is valid, so it can be restored.';
    if (job.kind === 'upload') return 'Backup upload completed. The bundle passed the same checks as a restore preflight and is listed below.';
    return 'Backup completed.';
  }
  if (job.status === 'failed') {
    if (job.kind === 'restore') return 'Restore failed.';
    if (job.kind === 'validate') return 'Backup check failed. Do not rely on this bundle for recovery.';
    if (job.kind === 'upload') return 'Backup upload failed. Nothing was added to the destination.';
    return 'Backup failed.';
  }
  return job.stage || (job.kind === 'restore' ? 'Restore in progress' : job.kind === 'validate' ? 'Backup check in progress' : job.kind === 'upload' ? 'Backup upload in progress' : 'Backup in progress');
}

function operationTitle(job: BackupJob | null, restoreStarted: boolean) {
  if (restoreStarted || job?.kind === 'restore') return 'Restoring your backup';
  if (job?.kind === 'validate') return 'Checking your backup';
  if (job?.kind === 'upload') return 'Adding your uploaded backup';
  return 'Backing up your suite';
}

function operationMessage(job: BackupJob | null, restoreStarted: boolean) {
  if (restoreStarted || job?.kind === 'restore') return 'MOS is replacing the current install with the selected backup. A large backup can take a long time — leave this page open and it will reconnect by itself. While services restart the suite may briefly look offline, and refreshing can show a temporary server error page even though the restore is running fine.';
  if (job?.kind === 'validate') return 'MOS is reading the backup and verifying every checksum and app package without changing anything. Apps keep running.';
  if (job?.kind === 'upload') return 'MOS is unpacking the uploaded backup file and verifying every checksum and app package. Apps keep running.';
  return 'MOS is pausing apps, saving their data, and then starting them again. Please wait until the backup finishes.';
}

function operationStage(job: BackupJob | null, restoreStarted: boolean) {
  if (job?.stage) return job.stage;
  return restoreStarted ? 'Starting restore' : 'Starting backup';
}

function backupDescription(backup: BackupBundle) {
  const contents = backup.appCount > 0 ? `${backup.appCount} app${backup.appCount === 1 ? '' : 's'} and ${backup.volumeCount} data store${backup.volumeCount === 1 ? '' : 's'}` : 'No apps in this backup';
  return Number.isFinite(backup.sizeBytes ?? NaN) ? `${contents} · ${formatBytes(backup.sizeBytes as number)}` : contents;
}

function usagePercent(used: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.max(0, Math.round(((total - used) / total) * 100)));
}

function getBackupButtonState(destinations: BackupDestination[], selectedId: string) {
  const selected = destinations.find(d => d.id === selectedId);

  if (destinations.length === 0) {
    return { enabled: false, message: 'No backup drives detected.' };
  }

  if (!selectedId) {
    return { enabled: false, message: 'Select a backup drive to continue.' };
  }

  if (!selected) {
    return { enabled: false, message: 'Select a backup drive to continue.' };
  }

  if (selected.mountState !== 'mounted') {
    return { enabled: false, message: 'The selected drive is not mounted.' };
  }

  if (!selected.writable) {
    return { enabled: false, message: 'The selected drive is not writable.' };
  }

  return {
    enabled: true,
    message: `Ready to back up to ${selected.label} · ${formatBytes(selected.availableBytes)} available`
  };
}

export function BackupsScreen() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [selectedDestinationId, setSelectedDestinationId] = useState('');
  const [selectedRestore, setSelectedRestore] = useState<BackupBundle | null>(null);
  const [selectedDelete, setSelectedDelete] = useState<BackupBundle | null>(null);
  const [noteEditor, setNoteEditor] = useState<{ backup: BackupBundle; value: string } | null>(null);
  const [backupNote, setBackupNote] = useState('');
  const [visibleBundles, setVisibleBundles] = useState(3);
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [restoreStarted, setRestoreStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState<'restore' | 'expired' | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const activeJob = status?.currentJob || null;
  const running = restoreStarted || isRunning(activeJob);
  const restoreInFlight = restoreStarted || (activeJob?.kind === 'restore' && isRunning(activeJob));
  const selectedDestination = status?.destinations.find((destination) => destination.id === selectedDestinationId);
  const buttonState = status ? getBackupButtonState(status.destinations, selectedDestinationId) : { enabled: false, message: '' };

  async function load() {
    setError('');
    setBusy('refresh');
    const response = await fetch('/suite-manager/api/backups/status');
    if (response.status === 401) {
      // A restore replaces Suite Manager state, so the session that started it
      // no longer exists once the restored control plane comes back.
      setSessionEnded(restoreStarted || (activeJob?.kind === 'restore' && isRunning(activeJob)) ? 'restore' : 'expired');
      setStatus(null);
      setRestoreStarted(false);
      setBusy('');
      return;
    }
    const next = await jsonResponse<BackupStatus>(response, 'Unable to load backups.');
    setStatus(next);
    setBusy('');
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
  // Leaving or refreshing mid-restore drops the operator onto a raw server
  // error page while the control plane is intentionally down; browsers only
  // show a generic confirmation, so the patient-waiting guidance lives in the
  // visible restore panel instead.
  useEffect(() => {
    if (!restoreInFlight) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [restoreInFlight]);

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await action();
      await load();
    } catch (caught) {
      // Refresh first so the page reflects reality (a vanished drive, a
      // finished job) before the error shows — load() clears the banner, so
      // the order matters.
      await load().catch(() => undefined);
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
        body: JSON.stringify({ destinationId: selectedDestination.id, note: backupNote }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to start backup.');
      setBackupNote('');
    });
  }

  async function acknowledgeInterrupted() {
    await runAction('acknowledge', async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/restore/acknowledge', {
        body: JSON.stringify({ confirmation: 'ACKNOWLEDGE' }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to dismiss the interrupted restore record.');
    });
  }

  async function checkBackup(backup: BackupBundle) {
    await runAction(`validate:${backup.path}`, async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/validate', {
        body: JSON.stringify({ backupPath: backup.path }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to check this backup.');
    });
  }

  async function saveNote(backup: BackupBundle, note: string) {
    setNoteEditor(null);
    await runAction(`note:${backup.path}`, async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/note', {
        body: JSON.stringify({ backupPath: backup.path, note }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to save the backup note.');
    });
  }

  async function deleteBackup(backup: BackupBundle) {
    setSelectedDelete(null);
    await runAction(`delete:${backup.path}`, async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/delete', {
        body: JSON.stringify({ backupPath: backup.path }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to delete this backup.');
    });
  }

  async function uploadBackup(file: File) {
    if (!selectedDestination) return;
    await runAction('upload', async () => {
      await jsonResponse(await fetch(`/suite-manager/api/backups/upload?destinationId=${encodeURIComponent(selectedDestination.id)}`, {
        body: file,
        headers: { 'Content-Type': 'application/octet-stream' },
        method: 'POST',
      }), 'Unable to upload this backup file.');
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
      await load().catch(() => undefined);
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  }

  return <section className="mos-shell suite-backups">
    <div className="mos-page">
      <div className="suite-hero">
        <h1>Backup & Restore</h1>
        <p className="suite-lead mos-body-lg">Save a whole-suite copy to storage mounted on this server, then restore it if you need to recover the system.</p>
        <Notice title="Backups are unencrypted full-secret exports" variant="warning"><p>Each bundle contains app data, owner and app credentials, Suite Manager state, and HTTPS/provider secrets. Use an encrypted, access-controlled destination. Do not leave downloaded bundles in Downloads or upload them to ordinary cloud storage.</p></Notice>
      </div>

      {error ? <Notice title="Backup needs attention" variant="error"><p>{error}</p></Notice> : null}
      {sessionEnded ? <Notice title={sessionEnded === 'restore' ? 'The restore signed you out' : 'Your session ended'} variant="info">
        <p>{sessionEnded === 'restore'
          ? 'Suite Manager restarted with the restored state, which ended this session. Sign in with the owner account saved in that backup — accounts and passwords now match the backup, not what was set just before the restore. After signing in, check the restore result here under Latest activity.'
          : 'Sign in again to manage backups.'}</p>
        <button className="mos-btn mos-btn-primary" onClick={() => window.location.reload()} type="button">Go to sign-in</button>
      </Notice> : null}
      {status?.interruptedRestore && !running ? <Notice title="A restore did not finish" variant="error">
        <p>A restore stopped during "{status.interruptedRestore.phase}", so this system may not match the backup it was restoring. A complete rescue copy of the pre-restore state was kept on the server{status.interruptedRestore.rescuePath ? ` at ${status.interruptedRestore.rescuePath}` : ''}. New backups and restores stay blocked until you dismiss this record; the rescue copy stays on disk either way.</p>
        <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => void acknowledgeInterrupted()} type="button">{busy === 'acknowledge' ? 'Dismissing...' : 'I understand, unblock backups'}</button>
      </Notice> : null}
      {restoreStarted ? <Notice title="Restore started" variant="info"><p>MOS is restoring the selected backup and may be unavailable for a short moment. When Suite Manager starts again you will be asked to sign in with the owner account saved in the backup.</p></Notice> : null}
      {status && !status.serviceAvailable ? <Notice title="Backup is not available yet" variant="warning"><p>The host backup service is not running on this install. Update or restart the MOS host services, then come back here.</p></Notice> : null}

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
              <h2 className="mos-card-title">Backup destination</h2>
              <p className="suite-meta">On own hardware, select an encrypted external drive. On a cloud server, select an encrypted block-storage volume mounted on this server.</p>
            </div>
            <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running} onClick={() => void load()} type="button">
              {busy === 'refresh' ? <span className="suite-spinner" /> : <Icon name="refresh" />}
              Refresh drives
            </button>
          </div>

          {status.destinations.length ? <div className="suite-drive-list">
            {status.destinations.map((destination) => {
              const mounted = destination.mountState === 'mounted';
              const selectable = mounted && destination.writable && !running && !busy;
              const selected = selectedDestinationId === destination.id;
              const kindLabel = destination.storageKind === 'external' ? 'USB' : destination.storageKind === 'network' ? 'Network' : 'Internal';

              return <div className={`suite-drive-item ${selected ? 'is-selected' : ''}`} key={destination.id}>
                <button className="suite-drive-select" disabled={!selectable} onClick={() => setSelectedDestinationId(destination.id)} type="button">
                  <span className="suite-drive-icon"><Icon name={driveIconName(destination.storageKind)} /></span>

                  <div className="suite-drive-info">
                    <div className="suite-drive-header">
                      <strong>{destination.label}</strong>
                        <span className="suite-drive-badges">
                        <span className="suite-category-pill">{kindLabel}</span>
                        {destination.writable && mounted ? <span className="suite-category-pill">Writable</span> : null}
                      </span>
                    </div>

                    {destination.mountPath ? <div className="suite-drive-path">{destination.mountPath}</div> : null}

                    {mounted && destination.sizeBytes && destination.availableBytes
                      ? <>
                          <div className="suite-drive-space">
                            <span>{formatBytes(destination.availableBytes)} free of {formatBytes(destination.sizeBytes)}</span>
                          </div>
                          <div className="suite-drive-bar">
                            <div className="suite-drive-bar-fill" style={{ width: `${100 - usagePercent(destination.availableBytes, destination.sizeBytes)}%` }} />
                          </div>
                        </>
                      : <div className="suite-drive-status">{mounted ? 'Calculating space...' : destination.mountBlockedReason || 'Drive connected but not available'}</div>
                    }
                  </div>

                  <div className="suite-drive-selector">
                    {selected ? <span className="suite-drive-check">✓</span> : null}
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
              <p className="suite-meta">No backup drives detected.</p>
              <p className="suite-meta">Own hardware: connect an external drive to this machine. Cloud server: attach and mount a provider block-storage volume. Then click Refresh drives.</p>
            </div>
          }

          <TextInput
            disabled={Boolean(busy) || running}
            helperText="Shown next to the backup so you can tell restore points apart later."
            label="Note for this backup (optional)"
            maxLength={200}
            onChange={(event) => setBackupNote(event.currentTarget.value)}
            placeholder="e.g. Before installing a new app"
            value={backupNote}
          />
          <div className="suite-backup-action-footer">
            <p className="suite-backup-status-message">{buttonState.message}</p>
            <button className="mos-btn mos-btn-primary" disabled={!buttonState.enabled || Boolean(busy) || running} onClick={() => void startBackup()} type="button">
              {busy === 'backup' ? 'Starting backup...' : 'Back up now'}
            </button>
          </div>
        </section>

        {(status.currentJob || status.lastJob) ? <section className="mos-panel suite-card suite-backup-panel">
          <h2 className="mos-card-title">{running ? 'Working on it' : 'Latest activity'}</h2>
          <p>{jobMessage(status.currentJob || status.lastJob)}</p>
          {(status.currentJob || status.lastJob)?.error ? <p className="suite-error">{(status.currentJob || status.lastJob)?.error}</p> : null}
          {((status.currentJob || status.lastJob)?.validation?.warnings || []).map((warning) => <p className="suite-meta" key={warning}>{warning}</p>)}
        </section> : null}

        <section className="mos-panel suite-card suite-backup-panel">
          <h2 className="mos-card-title">Restore from a backup</h2>
          {status.restoreGuarantee === 'experimental' ? <p className="suite-meta"><strong>Full restore is experimental.</strong> It replaces the current install with the backup, verifies the result, and keeps a complete rescue copy of the previous state, but it has not yet passed recovery drills on replacement hardware. Keep an independent copy of important data.</p> : <p className="suite-meta">Restore replaces the current install with the backup, verifies the result against it, and keeps a complete rescue copy of the previous state on the server. It has passed recovery drills on this and replacement hardware, including power-loss interruption. Backups are not yet encrypted or scheduled, so keep bundles on protected storage.</p>}
          <p className="suite-meta"><strong>Before downloading:</strong> this unencrypted bundle contains the suite's data and reusable secrets. Save it only to encrypted, access-controlled storage and remove unneeded browser copies.</p>
          {status.backups.length ? <div className="suite-backup-bundle-list">
            {status.backups.slice(0, visibleBundles).map((backup) => <article key={backup.path}>
              <div>
                <strong>{backup.createdAt ? formatDate(backup.createdAt) : 'MOS backup'}</strong>
                {backup.note ? <span className="suite-backup-note">{backup.note}</span> : null}
                <span>{backupDescription(backup)} · {backup.destinationLabel || 'Backup drive'}</span>
              </div>
              <ActionMenu ariaLabel="Backup actions" disabled={Boolean(busy) || running} items={[
                { label: 'Restore', onSelect: () => { setSelectedRestore(backup); setRestoreConfirmation(''); } },
                { label: 'Check', onSelect: () => void checkBackup(backup) },
                { label: 'Download', onSelect: () => window.location.assign(`/suite-manager/api/backups/download?path=${encodeURIComponent(backup.path)}`) },
                { label: backup.note ? 'Edit note' : 'Add note', onSelect: () => setNoteEditor({ backup, value: backup.note || '' }) },
                { label: 'Delete', onSelect: () => setSelectedDelete(backup) },
              ]} />
            </article>)}
            {status.backups.length > visibleBundles ? <div className="suite-backup-show-more">
              <button className="suite-subtle-button" onClick={() => setVisibleBundles((current) => current + 10)} type="button">
                Show {Math.min(10, status.backups.length - visibleBundles)} more
              </button>
            </div> : null}
          </div> : <p className="suite-meta">Backups found on connected drives will appear here.</p>}
          <div className="suite-backup-action-footer">
            <p className="suite-backup-status-message">Have a downloaded backup file? Upload it to the selected backup drive and it becomes restorable here after passing the same checks.</p>
            <input
              accept=".tar.gz,.tgz,application/gzip"
              hidden
              onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void uploadBackup(file); }}
              ref={uploadInputRef}
              type="file"
            />
            <button className="mos-btn mos-btn-secondary" disabled={!buttonState.enabled || Boolean(busy) || running} onClick={() => uploadInputRef.current?.click()} type="button">
              {busy === 'upload' ? <span className="suite-spinner" /> : <Icon name="upload" />}
              {busy === 'upload' ? 'Uploading...' : 'Upload backup file'}
            </button>
          </div>
        </section>

        <AdvancedPanel className="suite-backup-advanced" facts={[
          { label: 'Detected apps', value: String(status.inventory?.summary.appCount ?? 0) },
          { label: 'Detected app data stores', value: String(status.inventory?.summary.declaredVolumeCount ?? 0) },
          { label: 'App connections', value: String(status.inventory?.summary.relationshipCount ?? 0) },
          { label: 'Warnings', value: status.inventory?.warnings.map((warning) => `${warning.packageId}: ${warning.message}`).join(', ') || 'None' },
        ]} reveal="technical-mode" />
      </div> : null}

      {noteEditor ? <Dialog
        footer={<>
          <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={() => void saveNote(noteEditor.backup, noteEditor.value)} type="button">Save note</button>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => setNoteEditor(null)} type="button">Cancel</button>
        </>}
        onClose={() => { if (!busy) setNoteEditor(null); }}
        title="Backup note"
      >
        <p className="suite-meta">{formatDate(noteEditor.backup.createdAt)} · {backupDescription(noteEditor.backup)}</p>
        <TextInput
          helperText="Stored beside the backup on its drive. Leave empty to remove the note."
          label="What is this restore point about?"
          maxLength={200}
          onChange={(event) => setNoteEditor({ backup: noteEditor.backup, value: event.currentTarget.value })}
          placeholder="e.g. Before a big app install"
          value={noteEditor.value}
        />
      </Dialog> : null}

      {selectedDelete ? <Dialog
        footer={<>
          <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={() => void deleteBackup(selectedDelete)} type="button">{busy === `delete:${selectedDelete.path}` ? 'Deleting...' : 'Delete backup'}</button>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => setSelectedDelete(null)} type="button">Cancel</button>
        </>}
        onClose={() => { if (!busy) setSelectedDelete(null); }}
        title="Delete this backup?"
      >
        <Notice title="This cannot be undone" variant="warning"><p>The backup bundle is permanently removed from the drive. If you need it later, only a copy you downloaded or stored elsewhere can bring it back.</p></Notice>
        <p className="suite-meta">{formatDate(selectedDelete.createdAt)} · {backupDescription(selectedDelete)} · {selectedDelete.destinationLabel || 'backup storage'}</p>
      </Dialog> : null}

      {selectedRestore ? <Dialog
        footer={<>
          <button className="mos-btn mos-btn-primary" disabled={restoreConfirmation !== 'RESTORE' || Boolean(busy)} onClick={() => void startRestore()} type="button">{busy === 'restore' ? 'Starting restore...' : 'Restore backup'}</button>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => setSelectedRestore(null)} type="button">Cancel</button>
        </>}
        onClose={() => { if (!busy) setSelectedRestore(null); }}
        title="Restore this backup?"
      >
        <Notice title="This will replace the current install" variant="warning"><p>MOS will stop, restore the selected backup, verify it, and start again. Apps and app data added after this backup are removed so the system matches the backup exactly. A complete rescue copy of the current state is saved on the server first. When the restore finishes you will be signed out; sign back in with the owner account saved in this backup, which may differ from the current one. A large backup can take a long time to restore — keep this page open and let it finish.</p></Notice>
        <p className="suite-meta">{formatDate(selectedRestore.createdAt)} · {backupDescription(selectedRestore)} · {selectedRestore.destinationLabel || 'backup storage'}</p>
        <label className="suite-auth-field">
          <span>Type RESTORE to continue</span>
          <input autoFocus onChange={(event) => setRestoreConfirmation(event.currentTarget.value)} value={restoreConfirmation} />
        </label>
      </Dialog> : null}
    </div>
  </section>;
}