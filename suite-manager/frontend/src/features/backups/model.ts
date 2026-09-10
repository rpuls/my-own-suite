// Everything the Backup & Restore screen knows how to say, kept apart from the
// screen that says it. These are pure functions over the status the agent
// returns: no fetching, no state, no JSX. The page reads as a list of sections;
// the sentences those sections show are decided here.

export type BackupDestination = {
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
export type ObjectDraft = {
  accessKeyId: string;
  bucket: string;
  endpoint: string;
  folder: string;
  id?: string;
  label: string;
  region: string;
  secretAccessKey: string;
};

export const EMPTY_OBJECT_DRAFT: ObjectDraft = { accessKeyId: '', bucket: '', endpoint: '', folder: '', label: '', region: '', secretAccessKey: '' };

export type BackupValidation = {
  apps: Array<{ instanceId: string; packageId: string; packageVersion: string | null }>;
  backupPath: string;
  checkedAt: string;
  software: { backupVersion: string | null; currentVersion: string | null; matched: boolean };
  source?: { backupHostname: string | null; currentHostname: string | null; matched: boolean };
  volumes: Array<{ name: string; rawBytes: number | null }>;
  warnings: string[];
};

export type BackupJob = {
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

// One line of the activity list. Thinner than a job on purpose: a finished job
// is a sentence and a time, not a record to re-open.
export type RecentJob = {
  destinationId: string | null;
  error: string | null;
  id: string;
  initiator?: 'owner' | 'schedule' | 'update' | null;
  kind: string | null;
  note?: string | null;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
  updateTarget?: string | null;
};

export type BackupEntry = {
  appCount: number;
  createdAt: string | null;
  destinationId: string;
  destinationLabel: string;
  encrypted?: boolean;
  engineName?: string | null;
  id: string;
  // Who asked for this restore point: the owner, the schedule, or the update
  // that took it as its last-known-good state before changing anything.
  initiator?: 'owner' | 'schedule' | 'update';
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
  updateTarget?: string | null;
  volumeCount: number;
};

// The one destination everything that backs up on its own writes to: the
// schedule, and the backup taken before a MOS update.
export type PrimaryDestination = {
  destinationId: string;
  label: string | null;
  setAt: string | null;
};

export type BackupSchedule = {
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

export type InterruptedRestore = {
  backupPath: string | null;
  jobId: string | null;
  phase: string;
  rescuePath: string | null;
  startedAt: string | null;
};

// What this machine knows about its own recovery key. The fingerprint is a
// short digest, never the key: it is how two machines can be shown to hold the
// same one without either screen displaying it. `adoptedAt` is set when the key
// was typed off another server's kit rather than made here, which is the
// difference between "your key" and "their key, now yours".
export type RecoveryKeyState = {
  acknowledged: boolean;
  acknowledgedAt?: string | null;
  adoptedAt?: string | null;
  fingerprint: string | null;
  keyFile?: string | null;
  legacyKeyPresent?: boolean;
};

export type RevealedRecoveryKey = { key: string; kit: string; kitFilename: string };

export type BackupStatus = {
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
  primaryDestination?: PrimaryDestination | null;
  recentJobs?: RecentJob[];
  recoveryKey?: RecoveryKeyState | null;
  restoreGuarantee?: string;
  restoreGuaranteeByKind?: Record<string, string>;
  // This machine's console login is still waiting to be saved. It lives in the
  // state a backup carries and a restore replaces, so the screen waits with it.
  serverLoginUnsaved?: boolean;
  schedule?: BackupSchedule | null;
  serviceAvailable: boolean;
};

export type Tone = 'error' | 'muted' | 'ready' | 'warning';

export function formatBytes(value: number | null) {
  if (value === null || !Number.isFinite(value)) return 'Unknown space';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// The way someone says a date out loud: today and yesterday by name, this year
// without the year, anything older in full.
export function whenWords(value: string | null) {
  if (!value) return 'Unknown time';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const clock = parsed.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - parsed.getTime()) / 86_400_000);
  if (days < 0) return `Today, ${clock}`;
  if (days === 0) return `Yesterday, ${clock}`;
  const sameYear = parsed.getFullYear() === new Date().getFullYear();
  return `${parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) })}, ${clock}`;
}

export function daysSince(value: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.floor((Date.now() - parsed.getTime()) / 86_400_000);
}

export function isRunning(job: BackupJob | null) {
  return Boolean(job && (job.status === 'queued' || job.status === 'running'));
}

export function browserTimeZone() {
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
export function formatInZone(value: string | null, timeZone: string) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(parsed);
  } catch {
    return parsed.toLocaleString();
  }
}

export function clockValue(schedule: BackupSchedule) {
  return `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`;
}

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const RETENTION_OPTIONS = [
  { label: 'The last 3 automatic backups', value: 3 },
  { label: 'The last 7 automatic backups', value: 7 },
  { label: 'The last 14 automatic backups', value: 14 },
  { label: 'The last 30 automatic backups', value: 30 },
  { label: 'All of them', value: 0 },
];

export function destinationIconName(destination: BackupDestination) {
  if (destination.kind === 'object') return 'cloud-storage';
  if (destination.storageKind === 'external') return 'usb-drive';
  if (destination.storageKind === 'network') return 'network-drive';
  return 'hard-drive';
}

export function destinationKindLabel(destination: BackupDestination) {
  if (destination.kind === 'object') return 'Storage you rent online';
  if (destination.storageKind === 'external') return 'A drive you plug in';
  if (destination.storageKind === 'network') return 'A folder on your network';
  return 'A disk in this machine';
}

// Where the backups actually go, in the terms the owner entered them: the
// bucket and folder, and the host they live on.
export function destinationAddress(destination: BackupDestination) {
  if (destination.kind !== 'object') return destination.mountPath;
  const host = (destination.endpoint || '').replace(/^https?:\/\//u, '');
  return `${destination.bucket || ''}${destination.folder ? `/${destination.folder}` : ''} · ${host}`;
}

// A restore point's size is the suite data it restores, not space it takes on
// the drive — points share the store's deduplicated data, so sizes are not
// additive and are worded to not read that way.
export function backupDescription(backup: BackupEntry) {
  const contents = backup.appCount > 0 ? `${backup.appCount} app${backup.appCount === 1 ? '' : 's'} · ${backup.volumeCount} data store${backup.volumeCount === 1 ? '' : 's'}` : 'No apps in this backup';
  if (!Number.isFinite(backup.sizeBytes ?? NaN)) return contents;
  const size = formatBytes(backup.sizeBytes as number);
  return backup.kind === 'restore-point' ? `${contents} · ${size} to restore` : `${contents} · ${size}`;
}

// The checkpoint MOS takes before it updates itself, named by what it was taken
// before. It is the one restore point retention never removes, so an owner
// deciding what to delete can see why this one is here.
export function checkpointLabel(backup: BackupEntry) {
  if (backup.initiator !== 'update') return null;
  return backup.updateTarget ? `Before update to ${backup.updateTarget}` : 'Before a MOS update';
}

// Which machine wrote a restore point, said only when it was not this one. The
// install id decides when both sides have one — a standby may carry the same
// name on purpose — and the hostname before that; a backup naming neither
// counts as this machine's, which is the answer that never invents a warning.
export function writtenElsewhere(backup: BackupEntry, status: BackupStatus | null | undefined) {
  if (!status?.installId || backup.sourceInstallId === status.installId) return null;
  return backup.sourceHostname || 'another server';
}

// The one question a restore onto another machine has to ask: a domain can
// point at one machine at a time. Asked when the backup carries one, and when
// it is too old to say; never when it is known to carry none.
export function needsAddressChoice(backup: BackupEntry, status: BackupStatus | null | undefined) {
  return Boolean(writtenElsewhere(backup, status)) && Boolean(backup.sourceDomain);
}

// Which server's backups a destination holds, when it is not this one. Read off
// the restore points rather than stored on the destination: the store itself
// says who wrote it, and a bucket that has been unlocked has to keep saying so
// long after the sentence that announced it has gone.
export function foreignServer(destination: BackupDestination, status: BackupStatus | null | undefined) {
  const points = (status?.backups || []).filter((backup) => backup.destinationId === destination.id);
  const names = points.map((backup) => writtenElsewhere(backup, status)).filter(Boolean) as string[];
  if (!names.length) return null;
  // A store every point of which came from elsewhere is that server's; one that
  // also holds this machine's own points is shared, and named for the guest.
  return names[0] || null;
}

export function bytesLine(destination: BackupDestination) {
  const store = destination.repository;
  const points = store?.restorePoints || 0;
  if (!points) return 'Ready · no backups here yet';
  const stored = store?.storedBytes ? ` · ${formatBytes(store.storedBytes)} stored` : '';
  return `Ready · ${points} restore point${points === 1 ? '' : 's'}${stored}`;
}

export type DestinationAction = '' | 'mount' | 'retest' | 'unlock';

export type DestinationView = {
  action: DestinationAction;
  actionLabel: string;
  address: string | null;
  detail: string;
  destination: BackupDestination;
  foreign: string | null;
  id: string;
  keyLine: string;
  keyTone: Tone;
  kindLabel: string;
  label: string;
  present: boolean;
  selectable: boolean;
  selected: boolean;
  spaceLine: string;
  status: string;
  tone: Tone;
};

// One destination, reduced to the row the design draws: a status line that
// states the condition once, a detail line under it, and at most one button.
// Everything that used to be split over a pill, a helper and a footer is folded
// into `status` and `detail` here.
export function destinationView(destination: BackupDestination, status: BackupStatus | null | undefined, selectedId: string): DestinationView {
  const selected = destination.id === selectedId;
  const ready = destination.ready === true;
  const bucket = destination.kind === 'object';
  const foreign = foreignServer(destination, status);
  const adopted = Boolean(status?.recoveryKey?.adoptedAt);
  const present = ready || destination.locked === true || bucket || destination.mountState === 'unmounted' || destination.mountState === 'unsupported-mount';

  let tone: Tone = 'ready';
  let line = bytesLine(destination);
  let detail = '';
  let action: DestinationAction = '';
  let actionLabel = '';

  if (destination.locked) {
    tone = 'warning';
    line = 'Holds backups written by another server';
    detail = "Enter that server's recovery key to read them.";
    action = 'unlock';
    actionLabel = 'Enter recovery key';
  } else if (ready) {
    detail = bucket ? `At ${(destination.endpoint || '').replace(/^https?:\/\//u, '') || 'your storage provider'}` : '';
  } else if (bucket) {
    tone = 'error';
    line = 'MOS could not reach this storage';
    detail = 'Check the internet connection, then try again.';
    action = 'retest';
    actionLabel = 'Try again';
  } else if (destination.canMount) {
    tone = 'warning';
    line = 'Plugged in, but MOS has not opened it yet';
    detail = 'Opening it lets MOS read and write the backups on it.';
    action = 'mount';
    actionLabel = 'Open this drive';
  } else if (destination.mountState === 'mounted' && !destination.writable) {
    tone = 'warning';
    line = 'MOS can read this drive but cannot write to it';
    detail = 'It may be locked by a switch on the drive itself.';
  } else if (!present) {
    tone = selected ? 'warning' : 'muted';
    line = 'Not connected';
    detail = selected
      ? 'This is still where automatic backups go — MOS waits for it.'
      : 'Plug it in to use it.';
  } else {
    tone = 'warning';
    line = destination.notReadyReason || 'This destination is not available';
  }

  let keyLine = '';
  let keyTone: Tone = 'ready';
  if (destination.locked) {
    keyLine = 'Needs the recovery key of the server that wrote it. Your own key does not open this one yet.';
    keyTone = 'warning';
  } else if (foreign && adopted) {
    keyLine = `Your recovery key is ${foreign}'s key — this server took it on when you unlocked this place.`;
  } else if (foreign) {
    keyLine = `Opens with your recovery key and with ${foreign}'s key. Keep both.`;
  }

  const spaceKnown = Boolean(destination.sizeBytes && destination.availableBytes);
  return {
    action,
    actionLabel,
    address: destinationAddress(destination),
    detail,
    destination,
    foreign,
    id: destination.id,
    keyLine,
    keyTone,
    kindLabel: destinationKindLabel(destination),
    label: destination.label,
    present,
    selectable: ready,
    selected,
    spaceLine: !bucket && ready && spaceKnown ? `${formatBytes(destination.availableBytes)} free of ${formatBytes(destination.sizeBytes)}` : '',
    status: line,
    tone,
  };
}

// The list the page draws, in the order it draws it: the selected place first,
// then whatever is usable, then whatever needs attention, then whatever is
// away. A selected destination that is not in the list at all — a drive in a
// drawer — is put back, because dropping it would silently repoint automatic
// backups at whichever drive happens to be plugged in.
export function destinationViews(status: BackupStatus | null | undefined): DestinationView[] {
  const primary = status?.primaryDestination || null;
  const selectedId = primary?.destinationId || '';
  const listed = status?.destinations || [];
  const known = listed.some((destination) => destination.id === selectedId);
  const withAbsent: BackupDestination[] = known || !primary ? [...listed] : [...listed, {
    availableBytes: null,
    id: primary.destinationId,
    label: primary.label || 'The place you chose',
    mountPath: null,
    ready: false,
    sizeBytes: null,
    storageKind: 'external',
    writable: false,
  }];
  const rank = (view: DestinationView) => (view.selected ? 0 : view.selectable ? 1 : view.present ? 2 : 3);
  return withAbsent
    .map((destination) => destinationView(destination, status, selectedId))
    .sort((left, right) => rank(left) - rank(right));
}

// What the recovery key opens, said as one sentence beside the list it
// describes. Before the first backup it is the only thing on the row that
// matters; afterwards it is a quiet fact with the exceptions named.
export function keyCoverage(views: DestinationView[], key: RecoveryKeyState | null | undefined) {
  const names = (list: DestinationView[]) => {
    const labels = list.map((view) => view.label);
    return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}` : labels[0] || '';
  };
  if (!key || !key.acknowledged) {
    return {
      detail: 'MOS will not back up until you have saved it.',
      summary: 'Save your recovery key before your first backup.',
      tone: 'warning' as Tone,
    };
  }
  const guests = views.filter((view) => view.foreign && !view.destination.locked);
  const strangers = views.filter((view) => view.destination.locked);
  const detail = [
    guests.length ? `It also opens ${names(guests)}.` : '',
    strangers.length ? `${names(strangers)} still needs the key of the server that wrote it.` : '',
  ].filter(Boolean).join(' ');
  return {
    detail,
    summary: key.adoptedAt
      ? 'One recovery key opens everything this server made, and the backups it took over.'
      : 'One recovery key opens everything this server made.',
    tone: (strangers.length ? 'warning' : 'ready') as Tone,
  };
}

// The one sentence at the top of the page: am I safe, where does it go, when
// was the last one. Everything else on the screen is a detail of this.
export function bannerState(status: BackupStatus | null | undefined, views: DestinationView[], busyBackup: boolean) {
  const selected = views.find((view) => view.selected) || null;
  const newest = (status?.backups || []).filter((backup) => backup.restorable !== false)
    .slice().sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())[0] || null;
  const schedule = status?.schedule || null;
  const nextRun = schedule?.enabled && schedule.nextRunAt ? ` · Next ${formatInZone(schedule.nextRunAt, schedule.timeZone)}` : '';

  if (busyBackup) return { detail: 'Your apps pause for a few minutes and come back on their own.', title: 'Backing up now.', tone: 'ready' as Tone };
  if (!newest) {
    return selected
      ? { detail: `Nothing has been backed up yet. The first one goes to ${selected.label}.`, title: 'You have no backups yet.', tone: 'warning' as Tone }
      : { detail: 'Pick a place below and MOS starts keeping copies.', title: 'You have no backups yet.', tone: 'warning' as Tone };
  }
  if (schedule?.lastResult?.status === 'failed') {
    return { detail: schedule.lastResult.message, title: 'The last automatic backup did not finish.', tone: 'error' as Tone };
  }
  const age = daysSince(newest.createdAt);
  if (selected && !selected.selectable) {
    return {
      detail: `${selected.label} is not connected. Plug it in and MOS backs up on its own.`,
      title: age && age > 1 ? `Your last backup was ${age} days ago.` : 'Your backups are up to date.',
      tone: 'warning' as Tone,
    };
  }
  if (age !== null && age > 3) {
    return { detail: `Last backup ${whenWords(newest.createdAt)} to ${newest.destinationLabel}${nextRun}`, title: `Your last backup was ${age} days ago.`, tone: 'warning' as Tone };
  }
  return { detail: `Last backup ${whenWords(newest.createdAt)} to ${newest.destinationLabel}${nextRun}`, title: 'Your backups are up to date.', tone: 'ready' as Tone };
}

// Why Back up now is not available, in the words of the thing the owner has to
// go and do. An empty string means it is available.
export function backupBlockReason(status: BackupStatus | null | undefined, views: DestinationView[], target: DestinationView | null) {
  if (status?.interruptedRestore) return 'A restore did not finish. Read what happened before backing up again.';
  if (!status?.recoveryKey?.acknowledged) return 'Save your recovery key first.';
  if (!views.length) return 'Choose where your backups should go first.';
  if (!target) {
    const selected = views.find((view) => view.selected);
    if (selected) return `${selected.label} is not connected. Plug it in, or pick another place below.`;
    return 'Pick a place below to make it the one MOS uses.';
  }
  return '';
}

// The live line under the schedule summary: what it is doing right now, or what
// it is waiting for, in that order.
export function scheduleLive(schedule: BackupSchedule | null | undefined, selected: DestinationView | null): { text: string; tone: Tone } {
  if (!schedule) return { text: '', tone: 'muted' };
  if (!selected) return { text: 'Waiting: no place is chosen yet. Pick one above and automatic backups start on the next run.', tone: 'warning' };
  if (schedule.running) return { text: 'An automatic backup is running now.', tone: 'ready' };
  if (schedule.waiting) return { text: `Waiting: ${schedule.waiting.reason}`, tone: 'warning' };
  if (!schedule.enabled) return { text: 'Off. MOS only backs up when you ask it to, and before it updates itself.', tone: 'muted' };
  if (schedule.lastResult?.status === 'failed') return { text: `Last automatic backup stopped: ${schedule.lastResult.message}`, tone: 'error' };
  if (schedule.nextRunAt) return { text: `Next backup ${formatInZone(schedule.nextRunAt, schedule.timeZone)}.`, tone: 'ready' };
  return { text: '', tone: 'muted' };
}

export function scheduleSummary(schedule: BackupSchedule | null | undefined, selected: DestinationView | null) {
  if (!schedule || !schedule.enabled) return 'No schedule yet.';
  const keep = schedule.keepLast ? `keep the last ${schedule.keepLast}` : 'keep all of them';
  const when = schedule.frequency === 'weekly' ? `Every ${WEEKDAY_NAMES[schedule.weekday] || 'Sunday'}` : 'Every day';
  return `${when} at ${clockValue(schedule)} · ${keep} · to ${selected ? selected.label : 'nowhere yet'}`;
}

// A job in the owner's words. The stage names the agent writes are the engine's
// step; these are what that step means to someone whose photos are in it.
const STAGE_WORDS: Record<string, string> = {
  'Checking required space': 'Checking there is room',
  'Checking the backup': 'Reading the backup',
  'Copying suite state': 'Copying your settings and accounts',
  'Deleting backup and reclaiming space': 'Removing it and freeing the space',
  'Opening the backup repository on the destination': 'Opening the backup store',
  'Preparing backup': 'Getting ready',
  'Rebuilding app runtime': 'Building your apps again',
  'Reclaiming space from an interrupted backup': 'Tidying up after a backup that stopped',
  'Restarting runtime': 'Starting your apps again',
  'Restoring app volumes': 'Putting your app data back',
  'Restoring suite state': 'Putting your settings and accounts back',
  'Saving pre-restore rescue copy': 'Saving a rescue copy of what is here now',
  'Starting restored control plane': 'Starting the restored server',
  'Stopping app runtime for a consistent snapshot': 'Pausing your apps',
  'Stopping current runtime': 'Stopping your apps',
  'Storing app volumes': 'Copying your app data',
  'Verifying restored state': 'Checking the result against the backup',
  'Writing manifest': 'Finishing up',
};

const BACKUP_STAGES = ['Preparing backup', 'Checking required space', 'Opening the backup repository on the destination', 'Stopping app runtime for a consistent snapshot', 'Copying suite state', 'Storing app volumes', 'Writing manifest', 'Restarting runtime'];
const RESTORE_STAGES = ['Checking the backup', 'Checking required space', 'Stopping current runtime', 'Saving pre-restore rescue copy', 'Restoring suite state', 'Restoring app volumes', 'Rebuilding app runtime', 'Verifying restored state', 'Starting restored control plane'];

export function stageWords(stage: string | null | undefined) {
  if (!stage) return 'Getting ready';
  return STAGE_WORDS[stage] || stage;
}

// Where a running job has got to, as a step of a known number rather than a
// guess: the agent writes its stages in a fixed order, so the position in that
// order is the honest answer.
export function stageProgress(job: BackupJob | null) {
  const order = job?.kind === 'restore' ? RESTORE_STAGES : BACKUP_STAGES;
  const index = job?.stage ? order.indexOf(job.stage) : -1;
  if (index < 0) return { percent: 4, step: 0, steps: order.length };
  return { percent: Math.round(((index + 1) / order.length) * 100), step: index + 1, steps: order.length };
}

const RESTORE_PHASE_WORDS: Record<string, string> = {
  'reconciling-apps': 'while it was rebuilding your apps',
  rescue: 'while it was saving a rescue copy of the current state',
  'restoring-state': 'while it was putting your settings and accounts back',
  'restoring-volumes': 'while it was putting your app data back',
  'stopping-runtime': 'before it had changed anything, while it was stopping your apps',
  verifying: 'while it was checking the result against the backup',
};

export function restorePhaseWords(phase: string | null | undefined) {
  return RESTORE_PHASE_WORDS[String(phase || '')] || 'at a step it could not name';
}

// One finished job, as one sentence. The activity list is history, so every
// line says what happened and where, and a failure says what to do.
export function activityLine(job: RecentJob, destinations: DestinationView[]) {
  const place = destinations.find((view) => view.id === job.destinationId)?.label || '';
  const at = place ? ` on ${place}` : '';
  const kind = job.kind === 'restore' ? 'Restore' : job.kind === 'validate' ? 'Backup check' : job.kind === 'delete' ? 'Delete' : 'Backup';
  if (job.status === 'failed') return `${kind} stopped${at}: ${job.error || 'MOS could not say why.'}`;
  if (job.status === 'queued' || job.status === 'running') return `${kind} in progress${at} — ${stageWords(job.stage)}.`;
  if (job.kind === 'restore') return `Restore finished. This machine now matches the backup it restored.`;
  if (job.kind === 'validate') return `Backup check passed${at}. It is readable and complete.`;
  if (job.kind === 'delete') return `Backup deleted${at}. The space only it was using has been freed.`;
  if (job.initiator === 'update') return `Backup taken${at} before updating MOS${job.updateTarget ? ` to ${job.updateTarget}` : ''}.`;
  if (job.initiator === 'schedule') return `Automatic backup finished${at}.`;
  return `Backup finished${at}${job.note ? `, with your note "${job.note}"` : ''}.`;
}

export function restoreAddressNote(job: BackupJob | null) {
  if (job?.kind !== 'restore' || job.status !== 'succeeded' || !job.address?.domain) return null;
  if (job.address.plan === 'copy') return `This machine was restored as a copy. Apps answer on this machine's own address, and ${job.address.domain} still points at the machine that wrote the backup; Settings offers to move it here.`;
  if (job.address.plan === 'move') return `This machine now serves ${job.address.domain}. To finish the move, point that name at this machine's address; Settings shows how.`;
  return null;
}

// The kit is text the browser saves, not a file the server serves: it holds the
// recovery key, and a URL that returns one is a URL that can be requested again.
export function downloadKit(revealed: RevealedRecoveryKey) {
  const url = URL.createObjectURL(new Blob([revealed.kit], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.download = revealed.kitFilename || 'mos-recovery-kit.txt';
  link.href = url;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
