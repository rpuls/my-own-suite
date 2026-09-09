import { useEffect, useState } from 'react';

import { ServerLoginNotice } from '../../components/ServerLoginNotice';
import { ActionMenu, AdvancedPanel, Checkbox, Choice, Dialog, Icon, Notice, SecretText, Select, Spinner, Switch, TextInput } from '../../components/ui';
import { jsonResponse } from '../../lib/api';

type BackupDestination = {
  accessKeyId?: string;
  availableBytes: number | null;
  bucket?: string;
  canMount?: boolean;
  checkedAt?: string | null;
  endpoint?: string;
  folder?: string;
  id: string;
  kind?: 'disk' | 'object';
  label: string;
  // Reached, and holding backups written with another server's key. Neither
  // usable nor broken: one recovery key away from both.
  locked?: boolean;
  mountBlockedReason?: string | null;
  mountPath: string | null;
  mountState?: 'mounted' | 'unmounted' | 'unsupported-mount';
  notReadyReason?: string | null;
  ready?: boolean;
  region?: string;
  repository?: { engineName: string | null; restorePoints: number; storedBytes: number | null } | null;
  sizeBytes: number | null;
  storageKind?: 'external' | 'local' | 'network' | 'object' | null;
  writable: boolean;
};

// What the connect dialog holds while it is open. The secret is write-only: it
// is sent when the owner types one and never comes back from the server, so an
// edit that leaves it blank keeps the key already stored.
type ObjectDraft = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  folder: string;
  id?: string;
  label: string;
  region: string;
  secretAccessKey: string;
};

const EMPTY_OBJECT_DRAFT: ObjectDraft = { accessKeyId: '', bucket: '', endpoint: '', folder: '', label: '', region: '', secretAccessKey: '' };

type BackupValidation = {
  apps: Array<{ instanceId: string; packageId: string; packageVersion: string | null }>;
  backupPath: string;
  checkedAt: string;
  software: { backupVersion: string | null; currentVersion: string | null; matched: boolean };
  source?: { backupHostname: string | null; currentHostname: string | null; matched: boolean };
  volumes: Array<{ name: string; rawBytes: number | null }>;
  warnings: string[];
};

type BackupJob = {
  // What a restore did about the domain the backup carried: `same` on the
  // machine that wrote it, otherwise the owner's `move` or `copy`.
  address?: { domain: string | null; plan: 'copy' | 'move' | 'same' } | null;
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

type BackupEntry = {
  appCount: number;
  createdAt: string | null;
  destinationId: string;
  destinationLabel: string;
  encrypted?: boolean;
  engineName?: string | null;
  id: string;
  kind?: string;
  note?: string | null;
  path: string;
  repositoryId?: string | null;
  restorable?: boolean;
  sizeBytes?: number | null;
  // The domain the writing machine served: a string, null for none, and absent
  // on a restore point too old to say.
  sourceDomain?: string | null;
  sourceHostname?: string | null;
  sourceInstallId?: string | null;
  sourceVersion: string | null;
  volumeCount: number;
};

type BackupSchedule = {
  destinationId: string | null;
  destinationLabel: string | null;
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  hour: number;
  keepLast: number;
  lastResult: { at: string; message: string; status: string } | null;
  lastRunAt: string | null;
  minute: number;
  nextRunAt: string | null;
  running: boolean;
  timeZone: string;
  waiting: { occurrence: string; reason: string; since: string } | null;
  weekday: number;
};

type InterruptedRestore = {
  backupPath: string | null;
  jobId: string | null;
  phase: string;
  rescuePath: string | null;
  startedAt: string | null;
};

// What this machine knows about its own recovery key. The fingerprint is a
// short digest, never the key: it is how two machines can be shown to hold the
// same one without either screen displaying it.
type RecoveryKeyState = {
  acknowledged: boolean;
  acknowledgedAt?: string | null;
  fingerprint: string | null;
  keyFile?: string | null;
  legacyKeyPresent?: boolean;
};

type RevealedRecoveryKey = { key: string; kit: string; kitFilename: string };

type BackupStatus = {
  backups: BackupEntry[];
  currentJob: BackupJob | null;
  destinations: BackupDestination[];
  error?: string | null;
  hostname?: string | null;
  installId?: string | null;
  interruptedRestore?: InterruptedRestore | null;
  inventory?: {
    summary: { appCount: number; declaredVolumeCount: number; relationshipCount: number; warningCount: number };
    warnings: Array<{ message: string; packageId: string }>;
  };
  lastJob: BackupJob | null;
  recoveryKey?: RecoveryKeyState | null;
  restoreGuarantee?: string;
  restoreGuaranteeByKind?: Record<string, string>;
  // This machine's console login is still waiting to be saved. It lives in the
  // state a backup carries and a restore replaces, so the screen waits with it.
  serverLoginUnsaved?: boolean;
  schedule?: BackupSchedule | null;
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

const RESTORE_PHASE_WORDS: Record<string, string> = {
  'reconciling-apps': 'while it was rebuilding your apps',
  rescue: 'while it was saving a rescue copy of the current state',
  'restoring-state': 'while it was putting your settings and accounts back',
  'restoring-volumes': 'while it was putting your app data back',
  'stopping-runtime': 'before it had changed anything, while it was stopping your apps',
  verifying: 'while it was checking the result against the backup',
};

function restorePhaseWords(phase: string | null | undefined) {
  return RESTORE_PHASE_WORDS[String(phase || '')] || 'at a step it could not name';
}

function driveIconName(destination: BackupDestination) {
  if (destination.kind === 'object') return 'cloud-storage';
  if (destination.storageKind === 'external') return 'usb-drive';
  if (destination.storageKind === 'network') return 'network-drive';
  return 'hard-drive';
}

function destinationKindLabel(destination: BackupDestination) {
  if (destination.kind === 'object') return 'Object storage';
  return destination.storageKind === 'external' ? 'USB' : destination.storageKind === 'network' ? 'Network' : 'Internal';
}

// Where the backups actually go, in the terms the owner entered them: the
// bucket and folder, and the host they live on.
function destinationAddress(destination: BackupDestination) {
  if (destination.kind !== 'object') return destination.mountPath;
  const host = (destination.endpoint || '').replace(/^https?:\/\//u, '');
  return `${destination.bucket || ''}${destination.folder ? `/${destination.folder}` : ''} · ${host}`;
}

function jobMessage(job: BackupJob | null) {
  if (!job) return '';
  if (job.status === 'succeeded') {
    if (job.kind === 'restore') return 'Restore completed.';
    if (job.kind === 'validate') return 'Backup check passed. The stored data and every app package in this backup are intact, so it can be restored.';
    if (job.kind === 'delete') return 'Backup deleted. The space only it was using has been reclaimed.';
    return 'Backup completed.';
  }
  if (job.status === 'failed') {
    if (job.kind === 'restore') return 'Restore failed.';
    if (job.kind === 'validate') return 'Backup check failed. Do not rely on this backup for recovery.';
    if (job.kind === 'delete') return 'Delete failed. The other backups on the drive are unaffected.';
    return 'Backup failed.';
  }
  return job.stage || (job.kind === 'restore' ? 'Restore in progress' : job.kind === 'validate' ? 'Backup check in progress' : job.kind === 'delete' ? 'Backup delete in progress' : 'Backup in progress');
}

function operationTitle(job: BackupJob | null, restoreStarted: boolean) {
  if (restoreStarted || job?.kind === 'restore') return 'Restoring your backup';
  if (job?.kind === 'validate') return 'Checking your backup';
  if (job?.kind === 'delete') return 'Deleting the backup';
  return 'Backing up your suite';
}

function operationMessage(job: BackupJob | null, restoreStarted: boolean) {
  if (restoreStarted || job?.kind === 'restore') return 'MOS is replacing the current install with the selected backup. A large backup can take a long time — leave this page open and it will reconnect by itself. While services restart the suite may briefly look offline, and refreshing can show a temporary server error page even though the restore is running fine.';
  if (job?.kind === 'validate') return 'MOS is reading everything this backup stored and checking it against what was recorded, without changing anything. Apps keep running.';
  if (job?.kind === 'delete') return 'MOS is removing the backup and reclaiming the space only it was using. Data other backups still need is kept. Apps keep running.';
  return 'MOS is pausing apps, saving their data, and then starting them again. Please wait until the backup finishes.';
}

function operationStage(job: BackupJob | null, restoreStarted: boolean) {
  if (job?.stage) return job.stage;
  return restoreStarted ? 'Starting restore' : 'Starting backup';
}

// A restore point's size is the suite data it restores, not space it takes on
// the drive — points share the store's deduplicated data, so sizes are not
// additive and are worded to not read that way. A retired-format backup's size
// is the space its folder occupies, which is the only useful thing left to say
// about it.
function backupDescription(backup: BackupEntry) {
  const contents = backup.appCount > 0 ? `${backup.appCount} app${backup.appCount === 1 ? '' : 's'} and ${backup.volumeCount} data store${backup.volumeCount === 1 ? '' : 's'}` : 'No apps in this backup';
  if (!Number.isFinite(backup.sizeBytes ?? NaN)) return contents;
  const size = formatBytes(backup.sizeBytes as number);
  return backup.kind === 'restore-point' ? `${contents} · restores ${size}` : `${contents} · ${size}`;
}

// Which machine wrote a restore point, said only when it was not this one. The
// install id decides when both sides have one — a standby may carry the same
// name on purpose — and the hostname before that; a backup naming neither
// counts as this machine's, which is the answer that never invents a warning.
function writtenElsewhere(backup: BackupEntry, status: BackupStatus | null | undefined) {
  if (!status?.installId || backup.sourceInstallId === status.installId) return null;
  return backup.sourceHostname || 'another server';
}

// The one question a restore onto another machine has to ask: a domain can
// point at one machine at a time. Asked when the backup carries one, and when
// it is too old to say; never when it is known to carry none.
function needsAddressChoice(backup: BackupEntry, status: BackupStatus | null | undefined) {
  return Boolean(writtenElsewhere(backup, status)) && Boolean(backup.sourceDomain);
}

function restoreAddressNote(job: BackupJob | null) {
  if (job?.kind !== 'restore' || job.status !== 'succeeded' || !job.address?.domain) return null;
  if (job.address.plan === 'copy') return `This machine was restored as a copy. Apps answer on this machine's own address, and ${job.address.domain} still points at the machine that wrote the backup; Settings offers to move it here.`;
  if (job.address.plan === 'move') return `This machine now serves ${job.address.domain}. To finish the move, point home.${job.address.domain} at this machine's address; Settings shows how.`;
  return null;
}

// The kit is text the browser saves, not a file the server serves: it holds the
// recovery key, and a URL that returns one is a URL that can be requested again.
function downloadKit(revealed: RevealedRecoveryKey) {
  const url = URL.createObjectURL(new Blob([revealed.kit], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.download = revealed.kitFilename || 'mos-recovery-kit.txt';
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function usagePercent(used: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.max(0, Math.round(((total - used) / total) * 100)));
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RETENTION_OPTIONS = [
  { label: 'Keep every automatic backup', value: 0 },
  { label: 'Keep the last 3', value: 3 },
  { label: 'Keep the last 7', value: 7 },
  { label: 'Keep the last 14', value: 14 },
  { label: 'Keep the last 30', value: 30 },
];

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// Scheduled times are wall-clock times in the zone the schedule was set from,
// which is not necessarily this browser's or the server's, so every moment the
// panel shows is rendered in that same zone. Otherwise "runs at 03:00" and
// "next run 09:00" appear side by side and both are right.
function formatInZone(value: string | null, timeZone: string) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(parsed);
  } catch {
    return parsed.toLocaleString();
  }
}

function clockValue(schedule: BackupSchedule) {
  return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
}

function scheduleSummary(schedule: BackupSchedule) {
  if (schedule.running) return 'An automatic backup is running now.';
  if (schedule.waiting) return schedule.waiting.reason;
  if (schedule.nextRunAt) return `Next automatic backup: ${formatInZone(schedule.nextRunAt, schedule.timeZone)}.`;
  return '';
}

function AutomaticBackupsPanel({ busy, destinations, onSave, running, schedule }: {
  busy: string;
  destinations: BackupDestination[];
  onSave: (next: Partial<BackupSchedule>) => void;
  running: boolean;
  schedule: BackupSchedule;
}) {
  const locked = Boolean(busy) || running;
  const zone = schedule.timeZone || browserTimeZone();
  const usable = destinations.filter((destination) => destination.ready);
  // A destination the schedule targets but that is not reachable right now
  // stays in the list: dropping it would silently repoint the schedule at
  // whichever drive happened to be plugged in.
  const options = usable.some((destination) => destination.id === schedule.destinationId) || !schedule.destinationId
    ? usable.map((destination) => ({ id: destination.id, label: destination.label }))
    : [...usable.map((destination) => ({ id: destination.id, label: destination.label })), { id: schedule.destinationId, label: `${schedule.destinationLabel || 'Chosen destination'} (not available)` }];
  const canEnable = options.length > 0;

  return <section className="mos-panel suite-card suite-backup-panel">
    <div>
      <h2 className="mos-card-title">Automatic backups</h2>
      <p className="suite-meta">Without a schedule, the newest backup you have is the one you last remembered to take. Apps pause for a few minutes while a backup runs, which is why it is worth putting somewhere quiet.</p>
    </div>
    <Switch
      checked={schedule.enabled}
      description={canEnable ? 'MOS runs a whole-suite backup on its own and reports the result here.' : 'Connect a writable drive or object storage first.'}
      disabled={locked || !canEnable}
      label="Back up automatically"
      onChange={(event) => onSave({ destinationId: schedule.destinationId || options[0]?.id || null, enabled: event.currentTarget.checked })}
    />
    {schedule.enabled ? <>
      <div className="suite-form-grid">
        <Select
          disabled={locked}
          label="Back up to"
          onChange={(event) => onSave({ destinationId: event.currentTarget.value })}
          value={schedule.destinationId || ''}
        >
          {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </Select>
        <Select
          disabled={locked}
          label="How often"
          onChange={(event) => onSave({ frequency: event.currentTarget.value === 'weekly' ? 'weekly' : 'daily' })}
          value={schedule.frequency}
        >
          <option value="daily">Every day</option>
          <option value="weekly">Once a week</option>
        </Select>
        {schedule.frequency === 'weekly' ? <Select
          disabled={locked}
          label="Day"
          onChange={(event) => onSave({ weekday: Number(event.currentTarget.value) })}
          value={String(schedule.weekday)}
        >
          {WEEKDAY_NAMES.map((name, index) => <option key={name} value={String(index)}>{name}</option>)}
        </Select> : null}
        <TextInput
          disabled={locked}
          helperText={`Times are in ${zone}, the time zone this schedule was set from.${browserTimeZone() === zone ? '' : ` This browser is in ${browserTimeZone()}.`}`}
          label="At"
          onChange={(event) => {
            const [hour, minute] = event.currentTarget.value.split(':');
            if (hour === undefined || minute === undefined) return;
            onSave({ hour: Number(hour), minute: Number(minute) });
          }}
          type="time"
          value={clockValue(schedule)}
        />
        <Select
          disabled={locked}
          helperText="Backups you take yourself are never removed automatically."
          label="Keep"
          onChange={(event) => onSave({ keepLast: Number(event.currentTarget.value) })}
          value={String(schedule.keepLast)}
        >
          {RETENTION_OPTIONS.map((option) => <option key={option.value} value={String(option.value)}>{option.label}</option>)}
        </Select>
      </div>
      <p className="suite-meta">{scheduleSummary(schedule)}</p>
      {schedule.lastResult ? <p className="suite-meta">
        <strong>{schedule.lastResult.status === 'failed' ? 'Last automatic backup failed' : 'Last automatic backup'}</strong>
        {` · ${formatInZone(schedule.lastResult.at, zone)} · ${schedule.lastResult.message}`}
      </p> : null}
    </> : null}
  </section>;
}

// One row of the destination list. A drive and a bucket are the same kind of
// thing to choose between, so they share the row and differ only in what they
// can say about themselves: a drive has space and can be mounted, a bucket has
// an address and can be edited or disconnected.
function DestinationItem({ busy, destination, onDisconnect, onEdit, onMount, onSelect, onUnlock, running, selected }: {
  busy: string;
  destination: BackupDestination;
  onDisconnect: () => void;
  onEdit: () => void;
  onMount: () => void;
  onSelect: () => void;
  onUnlock: () => void;
  running: boolean;
  selected: boolean;
}) {
  const address = destinationAddress(destination);
  const usage = destination.repository;
  const spaceKnown = Boolean(destination.sizeBytes && destination.availableBytes);
  const unlocking = busy === `unlock:${destination.id}`;
  // A locked destination cannot be selected, so its card is not a button. That
  // lets the unlock control live inside the card, where it is unmistakable
  // which backups the key is for.
  const body = <>
      <span className="suite-drive-icon"><Icon name={driveIconName(destination)} /></span>

      <div className="suite-drive-info">
        <div className="suite-drive-header">
          <strong>{destination.label}</strong>
          <span className="suite-drive-badges">
            <span className="suite-category-pill">{destinationKindLabel(destination)}</span>
            {destination.ready ? <span className="suite-category-pill">{destination.kind === 'object' ? 'Connected' : 'Writable'}</span> : null}
          </span>
        </div>

        {address ? <div className="suite-drive-path">{address}</div> : null}

        {destination.ready ? <>
          {destination.kind !== 'object' && spaceKnown ? <>
            <div className="suite-drive-space">
              <span>{formatBytes(destination.availableBytes)} free of {formatBytes(destination.sizeBytes)}</span>
            </div>
            <div className="suite-drive-bar">
              <div className="suite-drive-bar-fill" style={{ width: `${100 - usagePercent(destination.availableBytes as number, destination.sizeBytes as number)}%` }} />
            </div>
          </> : null}
          {destination.kind !== 'object' && !spaceKnown ? <div className="suite-drive-status">Calculating space...</div> : null}
          {usage && usage.restorePoints > 0
            ? <div className="suite-drive-space">
                <span>Encrypted store holds {usage.restorePoints} restore point{usage.restorePoints === 1 ? '' : 's'}{usage.storedBytes ? ` in ${formatBytes(usage.storedBytes)}` : ''}</span>
              </div>
            : destination.kind === 'object' ? <div className="suite-drive-space"><span>No backups stored here yet</span></div> : null}
        </> : <div className="suite-drive-status">{unlocking ? 'Unlocking these backups...' : destination.notReadyReason || 'This destination is not available.'}</div>}
        {destination.locked ? <div className="suite-drive-unlock">
          <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={Boolean(busy) || running} onClick={onUnlock} type="button">
            {unlocking ? <><Spinner />Unlocking...</> : 'Enter recovery key'}
          </button>
        </div> : null}
      </div>

      <div className="suite-drive-selector">
        {selected ? <span className="suite-drive-check">&#10003;</span> : null}
      </div>
  </>;
  return <div className={`suite-drive-item ${selected ? 'is-selected' : ''}`}>
    {destination.locked
      ? <div className="suite-drive-select is-locked">{body}</div>
      : <button className="suite-drive-select" disabled={!destination.ready || running || Boolean(busy)} onClick={onSelect} type="button">{body}</button>}

    {destination.kind === 'object'
      ? <div className="suite-drive-actions">
          <ActionMenu ariaLabel="Storage connection actions" disabled={Boolean(busy) || running} items={[
            { label: 'Edit connection', onSelect: onEdit },
            { label: 'Disconnect', onSelect: onDisconnect },
          ]} />
        </div>
      : !destination.ready && destination.canMount
        ? <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={Boolean(busy) || running} onClick={onMount} type="button">
            {busy === `mount:${destination.id}` ? 'Mounting...' : 'Mount'}
          </button>
        : null}
  </div>;
}

// One dialog for both times an owner meets their recovery key: the first, where
// MOS shows it unasked and will not take a backup until they say they have kept
// it, and every later one, where a signed-in owner asks to see it again and
// proves the owner password first. The two differ only in what has to happen
// before the key appears, which is why they are not two dialogs.
function RecoveryKeyDialog({ busy, error, mode, onAcknowledge, onClose, onReveal, revealed, status }: {
  busy: string;
  error: string;
  mode: 'reveal' | 'save';
  onAcknowledge: () => void;
  onClose: () => void;
  onReveal: (password: string) => void;
  revealed: RevealedRecoveryKey | null;
  status: RecoveryKeyState | null;
}) {
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const locked = Boolean(busy);

  return <Dialog
    footer={mode === 'save'
      ? <>
          <button className="mos-btn mos-btn-primary" disabled={!saved || !revealed || locked} onClick={onAcknowledge} type="button">
            {busy === 'recovery-acknowledge' ? 'Saving...' : 'I have saved it'}
          </button>
          <button className="mos-btn mos-btn-secondary" disabled={!revealed || locked} onClick={() => revealed && downloadKit(revealed)} type="button">Download recovery kit</button>
        </>
      : <>
          {revealed
            ? <button className="mos-btn mos-btn-primary" onClick={() => downloadKit(revealed)} type="button">Download recovery kit</button>
            : <button className="mos-btn mos-btn-primary" disabled={!password || locked} onClick={() => onReveal(password)} type="button">
                {busy === 'recovery-reveal' ? 'Checking...' : 'Show recovery key'}
              </button>}
          <button className="mos-btn mos-btn-secondary" disabled={locked} onClick={onClose} type="button">Close</button>
        </>}
    onClose={() => { if (!locked) onClose(); }}
    title={mode === 'save' ? 'Save your recovery key' : 'Your recovery key'}
  >
    <Notice title="This is the only thing that can open your backups on another server" variant={mode === 'save' ? 'warning' : 'info'}>
      <p>Every backup MOS writes is encrypted with this key. This server keeps a copy so scheduled backups run without you, which means a stolen drive or a breached storage bucket cannot be read &mdash; but a stolen server can. Keep your own copy somewhere else: a password manager, or paper in a drawer that is not in this building. Without it, a replacement server cannot read a single backup, and nobody can recover it for you.</p>
    </Notice>

    {mode === 'reveal' && !revealed ? <TextInput
      autoFocus
      disabled={locked}
      helperText="Asked because the key is being shown again. It is checked on this server and never stored in your browser."
      label="Your owner password"
      onChange={(event) => setPassword(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && password && !locked) onReveal(password); }}
      type="password"
      value={password}
    /> : null}

    {revealed ? <SecretText label="recovery key" value={revealed.key} /> : null}
    {revealed ? <p className="suite-meta">The recovery kit is a text file with this key, the storage you have connected, and the steps to recover onto another machine. It holds no access key or password for your storage provider.</p> : null}

    {mode === 'save' && revealed ? <Checkbox checked={saved} disabled={locked} onChange={(event) => setSaved(event.currentTarget.checked)}>
      I have saved this recovery key somewhere I can still reach if this server is gone.
    </Checkbox> : null}

    {error ? <Notice title="That did not work" variant="error"><p>{error}</p></Notice> : null}

    <AdvancedPanel facts={[
      { code: true, label: 'Key fingerprint', value: status?.fingerprint || 'unknown' },
      { code: true, label: 'Key file on this server', value: status?.keyFile || 'unknown' },
    ]} reveal="technical-mode" />
  </Dialog>;
}

// Handing this machine the key to backups another server wrote. The same
// forgiving entry as the kit promises: case, spaces and hyphens do not matter,
// and a slip is answered as a slip.
function UnlockDestinationDialog({ busy, destination, error, onCancel, onUnlock }: {
  busy: string;
  destination: BackupDestination;
  error: string;
  onCancel: () => void;
  onUnlock: (recoveryKey: string) => void;
}) {
  const [entered, setEntered] = useState('');
  const locked = Boolean(busy);

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={!entered.trim() || locked} onClick={() => onUnlock(entered)} type="button">
        {busy === `unlock:${destination.id}` ? <><Spinner />Unlocking...</> : 'Unlock these backups'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={locked} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!locked) onCancel(); }}
    title="Enter the recovery key for these backups"
  >
    <Notice title="These backups were written by another server" variant="info">
      <p>MOS can reach {destination.label}, but the backups in it are encrypted with the recovery key of the server that wrote them. Enter that key and MOS will list them here so you can restore one.</p>
    </Notice>
    <TextInput
      autoFocus
      disabled={locked}
      helperText="From that server's recovery kit. Capitals, spaces and dashes do not matter."
      label="Recovery key"
      onChange={(event) => setEntered(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && entered.trim() && !locked) onUnlock(entered); }}
      placeholder="MOS-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
      value={entered}
    />
    {error ? <Notice title="MOS could not use that key" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}

function ObjectStorageDialog({ busy, draft, onCancel, onChange, onSave, onTest, testResult }: {
  busy: string;
  draft: ObjectDraft;
  onCancel: () => void;
  onChange: (next: ObjectDraft) => void;
  onSave: () => void;
  onTest: () => void;
  testResult: { locked?: boolean; message: string; ok: boolean } | null;
}) {
  const editing = Boolean(draft.id);
  const field = (key: keyof ObjectDraft) => (event: { currentTarget: { value: string } }) => onChange({ ...draft, [key]: event.currentTarget.value });
  const complete = Boolean(draft.endpoint.trim() && draft.bucket.trim() && draft.accessKeyId.trim() && (draft.secretAccessKey.trim() || editing));

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={!complete || Boolean(busy)} onClick={onSave} type="button">
        {busy === 'object-save' ? 'Saving...' : editing ? 'Save changes' : 'Connect storage'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={!complete || Boolean(busy)} onClick={onTest} type="button">
        {busy === 'object-test' ? 'Testing...' : 'Test connection'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title={editing ? 'Edit storage connection' : 'Connect object storage'}
  >
    <Notice title="Your backups are encrypted with your recovery key" variant="info">
      <p>MOS encrypts every backup before it leaves this machine, so the storage provider cannot read what you store. The key that opens them is your recovery key: this server keeps a copy so backups run without you, and you keep a copy so a replacement server can read this bucket after this one is gone. A key on the server protects against a breached bucket, not against a compromised server.</p>
    </Notice>
    <div className="suite-form-grid">
      <TextInput
        helperText="Your provider's S3 address, for example https://s3.eu-central-003.backblazeb2.com."
        label="Endpoint"
        onChange={field('endpoint')}
        placeholder="https://s3.example.com"
        value={draft.endpoint}
      />
      <TextInput
        helperText="A bucket that already exists. MOS does not create one."
        label="Bucket"
        onChange={field('bucket')}
        placeholder="my-backups"
        value={draft.bucket}
      />
      <TextInput
        helperText="Optional. Lets one bucket hold the backups of more than one server."
        label="Folder inside the bucket"
        onChange={field('folder')}
        placeholder="home-server"
        value={draft.folder}
      />
      <TextInput
        helperText="Optional. Some providers need it; leave it empty if yours does not."
        label="Region"
        onChange={field('region')}
        placeholder="eu-central-1"
        value={draft.region}
      />
      <TextInput
        helperText="Use a key that can only reach this bucket."
        label="Access key ID"
        onChange={field('accessKeyId')}
        value={draft.accessKeyId}
      />
      <TextInput
        helperText={editing ? 'Leave empty to keep the key already saved.' : 'Stored on this server only, readable by root.'}
        label="Secret access key"
        onChange={field('secretAccessKey')}
        placeholder={editing ? 'Unchanged' : ''}
        type="password"
        value={draft.secretAccessKey}
      />
      <TextInput
        helperText="Optional. What this connection is called on this screen."
        label="Name"
        onChange={field('label')}
        placeholder="Backblaze B2"
        value={draft.label}
      />
    </div>
    {testResult ? <Notice
      title={testResult.ok ? 'Storage reachable' : testResult.locked ? 'These backups were written by another server' : 'MOS could not use this storage'}
      variant={testResult.ok ? 'success' : testResult.locked ? 'info' : 'error'}
    >
      <p>{testResult.message}</p>
    </Notice> : null}
  </Dialog>;
}

function getBackupButtonState(destinations: BackupDestination[], selectedId: string) {
  const selected = destinations.find((destination) => destination.id === selectedId);
  if (destinations.length === 0) return { enabled: false, message: 'No backup destinations yet. Connect a drive or object storage.' };
  if (!selected) return { enabled: false, message: 'Select a backup destination to continue.' };
  if (!selected.ready) return { enabled: false, message: selected.notReadyReason || 'The selected destination is not ready.' };
  // Object storage has no free-space figure to quote: providers sell what is
  // stored rather than reserving a size.
  const room = selected.kind === 'object' ? '' : ` · ${formatBytes(selected.availableBytes)} available`;
  return { enabled: true, message: `Ready to back up to ${selected.label}${room}` };
}

export function BackupsScreen() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [selectedDestinationId, setSelectedDestinationId] = useState('');
  const [selectedRestore, setSelectedRestore] = useState<BackupEntry | null>(null);
  const [selectedDelete, setSelectedDelete] = useState<BackupEntry | null>(null);
  const [noteEditor, setNoteEditor] = useState<{ backup: BackupEntry; value: string } | null>(null);
  const [backupNote, setBackupNote] = useState('');
  const [visibleBackups, setVisibleBackups] = useState(3);
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [restoreAddress, setRestoreAddress] = useState<'' | 'copy' | 'move'>('');
  const [restoreStarted, setRestoreStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState<'restore' | 'expired' | ''>('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [objectDraft, setObjectDraft] = useState<ObjectDraft | null>(null);
  const [objectDisconnect, setObjectDisconnect] = useState<BackupDestination | null>(null);
  const [objectTest, setObjectTest] = useState<{ locked?: boolean; message: string; ok: boolean } | null>(null);
  // `then` is the action the gate interrupted, so an owner who was taking a
  // backup gets the backup once they have saved their key, rather than having to
  // find the button again.
  const [keyDialog, setKeyDialog] = useState<{ mode: 'reveal' | 'save'; then?: () => Promise<void> } | null>(null);
  const [revealedKey, setRevealedKey] = useState<RevealedRecoveryKey | null>(null);
  const [keyError, setKeyError] = useState('');
  const [unlockTarget, setUnlockTarget] = useState<BackupDestination | null>(null);
  const [unlockError, setUnlockError] = useState('');
  const [unlockResult, setUnlockResult] = useState('');
  const activeJob = status?.currentJob || null;
  const running = restoreStarted || isRunning(activeJob);
  const backupList = status?.backups || [];
  // Only worth saying while such a backup is actually sitting on a drive.
  const unreadableCount = backupList.filter((backup) => backup.restorable === false).length;
  const storageSummary = [
    `${backupList.filter((backup) => backup.restorable !== false).length} encrypted restore points`,
    unreadableCount ? `${unreadableCount} in the retired format` : null,
    backupList.find((backup) => backup.engineName)?.engineName || null,
  ].filter(Boolean).join(' · ');
  const restoreInFlight = restoreStarted || (activeJob?.kind === 'restore' && isRunning(activeJob));
  const selectedDestination = status?.destinations.find((destination) => destination.id === selectedDestinationId);
  const buttonState = status ? getBackupButtonState(status.destinations, selectedDestinationId) : { enabled: false, message: '' };
  const recoveryKey = status?.recoveryKey || null;
  // Until the key is saved, taking a backup or enabling a schedule goes through
  // the dialog instead. The agent refuses them too, so a page left open from
  // before cannot slip past this.
  const keySaved = recoveryKey === null || recoveryKey.acknowledged;

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
      const firstUsable = next.destinations.find((destination) => destination.ready);
      if (firstUsable) setSelectedDestinationId(firstUsable.id);
    }
  }

  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load backups.')); }, []);
  // A scheduled backup starts without anyone clicking anything, so an open page
  // polls slowly even when idle — otherwise the screen keeps showing "nothing
  // is happening" through an automatic backup it never noticed.
  useEffect(() => {
    if (!running && !status?.schedule?.enabled) return undefined;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, running ? 4000 : 30000);
    return () => window.clearInterval(timer);
  }, [running, status?.schedule?.enabled]);
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

  // The gate. Anything that would create a backup only this machine can read
  // runs through here; everything else — mounting, connecting, listing,
  // restoring — is deliberately not gated, because a replacement machine has to
  // reach the surviving destination before it can enter the key that opens it.
  function gateOnRecoveryKey(run: () => Promise<void>) {
    if (keySaved) {
      void run();
      return;
    }
    setKeyError('');
    setKeyDialog({ mode: 'save', then: run });
    void revealRecoveryKey('');
  }

  async function revealRecoveryKey(password: string) {
    setBusy('recovery-reveal');
    setKeyError('');
    try {
      setRevealedKey(await jsonResponse<RevealedRecoveryKey>(await fetch('/suite-manager/api/backups/recovery-key/reveal', {
        body: JSON.stringify({ password }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to show the recovery key.'));
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : 'Unable to show the recovery key.');
    } finally {
      setBusy('');
    }
  }

  async function acknowledgeRecoveryKey() {
    const pending = keyDialog?.then;
    setBusy('recovery-acknowledge');
    setKeyError('');
    try {
      await jsonResponse(await fetch('/suite-manager/api/backups/recovery-key/acknowledge', {
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to record that you saved the recovery key.');
      closeKeyDialog();
      await load().catch(() => undefined);
      if (pending) await pending();
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : 'Unable to record that you saved the recovery key.');
    } finally {
      setBusy('');
    }
  }

  // The key is held only while its dialog is open: nothing keeps it in the page
  // once the owner is done with it.
  function closeKeyDialog() {
    setKeyDialog(null);
    setRevealedKey(null);
    setKeyError('');
  }

  async function unlockDestination(destination: BackupDestination, recoveryKeyInput: string) {
    setBusy(`unlock:${destination.id}`);
    setUnlockError('');
    try {
      const result = await jsonResponse<{ result: { adopted: boolean; message: string } }>(await fetch('/suite-manager/api/backups/destinations/unlock', {
        body: JSON.stringify({ destinationId: destination.id, recoveryKey: recoveryKeyInput }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to unlock these backups.');
      setUnlockTarget(null);
      setUnlockResult(result.result.message);
      await load().catch(() => undefined);
    } catch (caught) {
      setUnlockError(caught instanceof Error ? caught.message : 'Unable to unlock these backups.');
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

  // Each control is a setting that applies when it changes, so the whole
  // schedule is resent with the one field the owner touched. The stored time
  // zone is preserved rather than overwritten with this browser's: opening MOS
  // from a laptop in another country must not quietly move a home server's
  // backup window.
  async function saveSchedule(next: Partial<BackupSchedule>) {
    const current = status?.schedule;
    if (!current) return;
    const merged = { ...current, ...next };
    await runAction('schedule', async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/schedule', {
        body: JSON.stringify({
          destinationId: merged.destinationId || '',
          destinationLabel: destinationLabelFor(merged.destinationId) || merged.destinationLabel || '',
          enabled: merged.enabled,
          frequency: merged.frequency,
          hour: merged.hour,
          keepLast: merged.keepLast,
          minute: merged.minute,
          timeZone: current.timeZone || browserTimeZone(),
          weekday: merged.weekday,
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to save the backup schedule.');
    });
  }

  function destinationLabelFor(destinationId: string | null) {
    return status?.destinations.find((destination) => destination.id === destinationId)?.label || null;
  }

  function openObjectDialog(destination?: BackupDestination) {
    setObjectTest(null);
    setObjectDraft(destination
      ? {
          accessKeyId: destination.accessKeyId || '',
          bucket: destination.bucket || '',
          endpoint: destination.endpoint || '',
          folder: destination.folder || '',
          id: destination.id,
          label: destination.label,
          region: destination.region || '',
          secretAccessKey: '',
        }
      : { ...EMPTY_OBJECT_DRAFT });
  }

  // The test reports into the dialog rather than the page banner, because it is
  // an answer about what is on screen and the owner is about to act on it.
  async function testObjectStorage() {
    if (!objectDraft) return;
    setBusy('object-test');
    setObjectTest(null);
    try {
      const response = await jsonResponse<{ result: { message: string; ok: boolean } }>(await fetch('/suite-manager/api/backups/destinations/object/test', {
        body: JSON.stringify(objectDraft),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to reach this storage.');
      setObjectTest(response.result);
    } catch (caught) {
      setObjectTest({ message: caught instanceof Error ? caught.message : 'Unable to reach this storage.', ok: false });
    } finally {
      setBusy('');
    }
  }

  async function saveObjectStorage() {
    if (!objectDraft) return;
    const draft = objectDraft;
    await runAction('object-save', async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/destinations/object', {
        body: JSON.stringify(draft),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to save this storage connection.');
      setObjectDraft(null);
      setObjectTest(null);
    });
  }

  async function disconnectObjectStorage(destination: BackupDestination) {
    setObjectDisconnect(null);
    await runAction(`disconnect:${destination.id}`, async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/destinations/object/remove', {
        body: JSON.stringify({ destinationId: destination.id }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to disconnect this storage.');
      if (selectedDestinationId === destination.id) setSelectedDestinationId('');
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

  async function checkBackup(backup: BackupEntry) {
    await runAction(`validate:${backup.path}`, async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/validate', {
        body: JSON.stringify({ backupPath: backup.path }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to check this backup.');
    });
  }

  async function saveNote(backup: BackupEntry, note: string) {
    setNoteEditor(null);
    await runAction(`note:${backup.path}`, async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/note', {
        body: JSON.stringify({ backupPath: backup.path, note }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to save the backup note.');
    });
  }

  async function deleteBackup(backup: BackupEntry) {
    setSelectedDelete(null);
    await runAction(`delete:${backup.path}`, async () => {
      await jsonResponse(await fetch('/suite-manager/api/backups/delete', {
        body: JSON.stringify({ backupPath: backup.path }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      }), 'Unable to delete this backup.');
    });
  }

  async function startRestore() {
    if (!selectedRestore) return;
    setBusy('restore');
    setError('');
    try {
      await jsonResponse(await fetch('/suite-manager/api/backups/restore', {
        body: JSON.stringify({
          ...(needsAddressChoice(selectedRestore, status) && restoreAddress ? { address: restoreAddress } : {}),
          backupPath: selectedRestore.path,
          confirmation: restoreConfirmation,
        }),
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

  if (status?.serverLoginUnsaved) {
    return <section className="mos-shell suite-backups">
      <div className="mos-page">
        <div className="suite-hero">
          <h1>Backup & Restore</h1>
          <p className="suite-lead mos-body-lg">Save a whole-suite copy to a drive on this server or to a storage bucket somewhere else, then restore it if you need to recover the system.</p>
        </div>
        <ServerLoginNotice what="Backups and restores" />
      </div>
    </section>;
  }

  return <section className="mos-shell suite-backups">
    <div className="mos-page">
      <div className="suite-hero">
        <h1>Backup & Restore</h1>
        <p className="suite-lead mos-body-lg">Save a whole-suite copy to a drive on this server or to a storage bucket somewhere else, then restore it if you need to recover the system.</p>
        <Notice title="A backup holds every secret this server has" variant={keySaved ? 'info' : 'warning'}>
          <p>Any backup contains app data, owner and app credentials, Suite Manager state, and HTTPS/provider secrets. All of it is encrypted with your recovery key before it is written anywhere, so a stolen drive or a breached bucket cannot be read. This server keeps a copy of that key so backups run without you, which means a stolen server is still a stolen backup &mdash; and you keep a copy, because it is the only thing that can open these backups on a replacement machine.</p>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running} onClick={() => {
            setKeyError('');
            setRevealedKey(null);
            if (keySaved) { setKeyDialog({ mode: 'reveal' }); return; }
            setKeyDialog({ mode: 'save' });
            void revealRecoveryKey('');
          }} type="button">{keySaved ? 'Show recovery key' : 'Save your recovery key'}</button>
        </Notice>
      </div>

      {error ? <Notice title="Backup needs attention" variant="error"><p>{error}</p></Notice> : null}
      {unlockResult ? <Notice title="These backups are readable here now" variant="success">
        <p>{unlockResult}</p>
        <button className="mos-btn mos-btn-secondary" onClick={() => setUnlockResult('')} type="button">Got it</button>
      </Notice> : null}
      {sessionEnded ? <Notice title={sessionEnded === 'restore' ? 'The restore signed you out' : 'Your session ended'} variant="info">
        <p>{sessionEnded === 'restore'
          ? 'Suite Manager restarted with the restored state, which ended this session. Sign in with the owner account saved in that backup — accounts and passwords now match the backup, not what was set just before the restore. After signing in, check the restore result here under Latest activity.'
          : 'Sign in again to manage backups.'}</p>
        <button className="mos-btn mos-btn-primary" onClick={() => window.location.reload()} type="button">Go to sign-in</button>
      </Notice> : null}
      {status?.interruptedRestore && !running ? <Notice title="A restore did not finish" variant="error">
        <p>A restore stopped {restorePhaseWords(status.interruptedRestore.phase)}, so this system may not match the backup it was restoring. A complete rescue copy of the pre-restore state was kept on the server{status.interruptedRestore.rescuePath ? ` at ${status.interruptedRestore.rescuePath}` : ''}. New backups and restores stay blocked until you dismiss this record; the rescue copy stays on disk either way.</p>
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
              <p className="suite-meta">A drive attached to this server, or a bucket at a storage provider. A drive is fastest to restore from; a bucket survives the building the server is in.</p>
            </div>
            <div className="suite-backup-header-actions">
              <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running} onClick={() => openObjectDialog()} type="button">
                <Icon name="cloud-storage" />
                Connect object storage
              </button>
              <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy) || running} onClick={() => void load()} type="button">
                {busy === 'refresh' ? <span className="suite-spinner" /> : <Icon name="refresh" />}
                Refresh drives
              </button>
            </div>
          </div>

          {status.destinations.length ? <div className="suite-drive-list">
            {status.destinations.map((destination) => <DestinationItem
              busy={busy}
              destination={destination}
              key={destination.id}
              onDisconnect={() => setObjectDisconnect(destination)}
              onEdit={() => openObjectDialog(destination)}
              onMount={() => void mount(destination)}
              onSelect={() => setSelectedDestinationId(destination.id)}
              onUnlock={() => { setUnlockError(''); setUnlockResult(''); setUnlockTarget(destination); }}
              running={running}
              selected={selectedDestinationId === destination.id}
            />)}
          </div> :
            <div className="suite-empty-state">
              <p className="suite-meta">No backup destinations yet.</p>
              <p className="suite-meta">Own hardware: connect an external drive to this machine. Cloud server: attach and mount a provider block-storage volume. Then click Refresh drives. Or connect a bucket at a storage provider to keep backups away from this building.</p>
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
            <button className="mos-btn mos-btn-primary" disabled={!buttonState.enabled || Boolean(busy) || running} onClick={() => gateOnRecoveryKey(startBackup)} type="button">
              {busy === 'backup' ? 'Starting backup...' : 'Back up now'}
            </button>
          </div>
        </section>

        {status.schedule ? <AutomaticBackupsPanel
          busy={busy}
          destinations={status.destinations}
          onSave={(next) => ({ ...status.schedule, ...next }).enabled ? gateOnRecoveryKey(() => saveSchedule(next)) : void saveSchedule(next)}
          running={running}
          schedule={status.schedule}
        /> : null}

        {(status.currentJob || status.lastJob) ? <section className="mos-panel suite-card suite-backup-panel">
          <h2 className="mos-card-title">{running ? 'Working on it' : 'Latest activity'}</h2>
          <p>{jobMessage(status.currentJob || status.lastJob)}</p>
          {restoreAddressNote(status.currentJob || status.lastJob) ? <p className="suite-meta">{restoreAddressNote(status.currentJob || status.lastJob)}</p> : null}
          {(status.currentJob || status.lastJob)?.error ? <p className="suite-error">{(status.currentJob || status.lastJob)?.error}</p> : null}
          {((status.currentJob || status.lastJob)?.validation?.warnings || []).map((warning) => <p className="suite-meta" key={warning}>{warning}</p>)}
        </section> : null}

        <section className="mos-panel suite-card suite-backup-panel">
          <h2 className="mos-card-title">Restore from a backup</h2>
          <p className="suite-meta">Restore replaces the current install with the backup, verifies the result against it, and keeps a complete rescue copy of the previous state on the server.</p>
          <p className="suite-meta">It has passed recovery drills on this and replacement hardware, including power loss partway through a restore.</p>
          {unreadableCount ? <p className="suite-meta"><strong>Backups in the retired format are listed but cannot be restored.</strong> MOS 0.19 and earlier wrote unencrypted bundles; this version reads only encrypted restore points. Delete them here to reclaim their space once you no longer need them.</p> : null}
          {status.backups.length ? <div className="suite-backup-bundle-list">
            {status.backups.slice(0, visibleBackups).map((backup) => <article key={backup.path}>
              <div>
                <strong>{backup.createdAt ? formatDate(backup.createdAt) : 'MOS backup'}</strong>
                {backup.note ? <span className="suite-backup-note">{backup.note}</span> : null}
                <span>{backupDescription(backup)} · {backup.destinationLabel || 'Backup drive'}</span>
                <span className="suite-category-pill">{backup.restorable === false ? 'Retired format' : 'Encrypted'}</span>
                {writtenElsewhere(backup, status) ? <span className="suite-category-pill">Written by {writtenElsewhere(backup, status)}</span> : null}
              </div>
              <ActionMenu ariaLabel="Backup actions" disabled={Boolean(busy) || running} items={backup.restorable === false ? [
                { label: 'Delete', onSelect: () => setSelectedDelete(backup) },
              ] : [
                { label: 'Restore', onSelect: () => { setSelectedRestore(backup); setRestoreConfirmation(''); setRestoreAddress(''); } },
                { label: 'Check', onSelect: () => void checkBackup(backup) },
                { label: backup.note ? 'Edit note' : 'Add note', onSelect: () => setNoteEditor({ backup, value: backup.note || '' }) },
                { label: 'Delete', onSelect: () => setSelectedDelete(backup) },
              ]} />
            </article>)}
            {status.backups.length > visibleBackups ? <div className="suite-backup-show-more">
              <button className="suite-subtle-button" onClick={() => setVisibleBackups((current) => current + 10)} type="button">
                Show {Math.min(10, status.backups.length - visibleBackups)} more
              </button>
            </div> : null}
          </div> : <p className="suite-meta">Backups found on connected drives will appear here.</p>}
        </section>

        <AdvancedPanel className="suite-backup-advanced" facts={[
          { label: 'Detected apps', value: String(status.inventory?.summary.appCount ?? 0) },
          { label: 'Detected app data stores', value: String(status.inventory?.summary.declaredVolumeCount ?? 0) },
          { label: 'App connections', value: String(status.inventory?.summary.relationshipCount ?? 0) },
          { label: 'Warnings', value: status.inventory?.warnings.map((warning) => `${warning.packageId}: ${warning.message}`).join(', ') || 'None' },
          { label: 'Backup storage', value: storageSummary },
          { label: 'Restore guarantee', value: status.restoreGuarantee || 'unknown' },
          { code: true, label: 'Recovery key fingerprint', value: recoveryKey?.fingerprint || 'unknown' },
          { code: true, label: 'Recovery key file', value: recoveryKey?.keyFile || 'unknown' },
          { label: 'Pre-release key kept for old repositories', value: recoveryKey?.legacyKeyPresent ? 'yes' : 'no' },
        ]} reveal="technical-mode" />
      </div> : null}

      {keyDialog ? <RecoveryKeyDialog
        busy={busy}
        error={keyError}
        mode={keyDialog.mode}
        onAcknowledge={() => void acknowledgeRecoveryKey()}
        onClose={closeKeyDialog}
        onReveal={(password) => void revealRecoveryKey(password)}
        revealed={revealedKey}
        status={recoveryKey}
      /> : null}

      {unlockTarget ? <UnlockDestinationDialog
        busy={busy}
        destination={unlockTarget}
        error={unlockError}
        onCancel={() => { setUnlockTarget(null); setUnlockError(''); }}
        onUnlock={(entered) => void unlockDestination(unlockTarget, entered)}
      /> : null}

      {objectDraft ? <ObjectStorageDialog
        busy={busy}
        draft={objectDraft}
        onCancel={() => { setObjectDraft(null); setObjectTest(null); }}
        onChange={setObjectDraft}
        onSave={() => void saveObjectStorage()}
        onTest={() => void testObjectStorage()}
        testResult={objectTest}
      /> : null}

      {objectDisconnect ? <Dialog
        footer={<>
          <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={() => void disconnectObjectStorage(objectDisconnect)} type="button">
            {busy === `disconnect:${objectDisconnect.id}` ? 'Disconnecting...' : 'Disconnect'}
          </button>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => setObjectDisconnect(null)} type="button">Cancel</button>
        </>}
        onClose={() => { if (!busy) setObjectDisconnect(null); }}
        title="Disconnect this storage?"
      >
        <Notice title="Your backups stay where they are" variant="info"><p>MOS forgets the address and the key for this bucket, so its backups stop being listed here and no new ones are written to it. Nothing in the bucket is deleted, and connecting it again with the same details brings the list back.</p></Notice>
        <p className="suite-meta">{objectDisconnect.label} · {destinationAddress(objectDisconnect)}</p>
      </Dialog> : null}

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
        <Notice title="This cannot be undone" variant="warning"><p>{selectedDelete.restorable === false ? 'This backup is in the retired format and cannot be restored by this version of MOS. Deleting it removes its folder from the drive and frees that space.' : 'This restore point is permanently removed and the space it alone was using is reclaimed, which can take a moment. Data still needed by other restore points is kept. If you need it later, only a copy stored elsewhere can bring it back.'}</p></Notice>
        <p className="suite-meta">{formatDate(selectedDelete.createdAt)} · {backupDescription(selectedDelete)} · {selectedDelete.destinationLabel || 'backup storage'}</p>
      </Dialog> : null}

      {selectedRestore ? <Dialog
        footer={<>
          <button className="mos-btn mos-btn-primary" disabled={restoreConfirmation !== 'RESTORE' || (needsAddressChoice(selectedRestore, status) && !restoreAddress) || Boolean(busy)} onClick={() => void startRestore()} type="button">{busy === 'restore' ? 'Starting restore...' : 'Restore backup'}</button>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => setSelectedRestore(null)} type="button">Cancel</button>
        </>}
        onClose={() => { if (!busy) setSelectedRestore(null); }}
        title="Restore this backup?"
      >
        <Notice title="This will replace the current install" variant="warning"><p>MOS will stop, restore the selected backup, verify it, and start again. Apps and app data added after this backup are removed so the system matches the backup exactly. A complete rescue copy of the current state is saved on the server first. When the restore finishes you will be signed out; sign back in with the owner account saved in this backup, which may differ from the current one. A large backup can take a long time to restore — keep this page open and let it finish.</p></Notice>
        {writtenElsewhere(selectedRestore, status) ? <Notice title={`This backup was written by ${writtenElsewhere(selectedRestore, status)}`} variant="info">
          <p>This machine will become that server. After restoring, sign in with that server's owner password. This machine keeps its own console and SSH login; the other server's does not come along.</p>
          {needsAddressChoice(selectedRestore, status) ? <p>Its address <strong>{selectedRestore.sourceDomain}</strong> can only point at one machine at a time, and right now it points at the machine that wrote this backup. Choose what this machine should do with it:</p> : null}
        </Notice> : null}
        {needsAddressChoice(selectedRestore, status) ? <div role="radiogroup" aria-label="What to do with the address">
          <Choice checked={restoreAddress === 'move'} description={`Apps answer at their old addresses again, so links, phone apps and browser extensions keep working. Afterwards, point home.${selectedRestore.sourceDomain} at this machine's address — Settings shows how.`} name="restore-address" onChange={() => setRestoreAddress('move')} value="move">Move my address to this machine</Choice>
          <Choice checked={restoreAddress === 'copy'} description="Apps run here on this machine's own address. The domain stays as it is, so links and connected devices still point at the other machine. You can move the address here later under Settings." name="restore-address" onChange={() => setRestoreAddress('copy')} value="copy">Restore as a copy</Choice>
        </div> : null}
        <p className="suite-meta">{formatDate(selectedRestore.createdAt)} · {backupDescription(selectedRestore)} · {selectedRestore.destinationLabel || 'backup storage'}</p>
        <label className="suite-auth-field">
          <span>Type RESTORE to continue</span>
          <input autoFocus onChange={(event) => setRestoreConfirmation(event.currentTarget.value)} value={restoreConfirmation} />
        </label>
      </Dialog> : null}
    </div>
  </section>;
}