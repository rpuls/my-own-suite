// Everything the Backup & Restore screen knows how to say, kept apart from the
// screen that says it. These are pure functions over the status the agent
// returns: no fetching, no state, no JSX. The page reads as a list of sections;
// the sentences those sections show are decided here.

import { formatBytes } from '../../lib/bytes';

type BackupDestination = {
  accessKeyId?: string;
  availableBytes: number | null;
  bucket?: string;
  checkedAt?: string | null;
  endpoint?: string;
  folder?: string;
  // How a drive stays the same drive across being unplugged: where it is
  // mounted is a fact about this boot, the filesystem on it is not.
  fsUuid?: string | null;
  holdsAppFiles?: boolean;
  id: string;
  kind?: 'disk' | 'object';
  label: string;
  lastBackupAt?: string | null;
  lastSeenAt?: string | null;
  // Reached, and holding backups written with another server's key. Neither
  // usable nor broken: one recovery key away from both.
  borrowedKey?: boolean;
  // Holds a store another server made, locked or opened with its key. This server
  // restores from it but never backs up into it.
  foreignStore?: boolean;
  locked?: boolean;
  mountBlockedReason?: string | null;
  mountPath: string | null;
  // `away` is the only state describing something MOS cannot see: a drive it
  // has backed up to before and that is not plugged in now.
  mountState?: 'away' | 'mounted';
  notReadyReason?: string | null;
  ready?: boolean;
  // Why this server cannot back up here right now, in the agent's words, or null.
  refusal?: string | null;
  region?: string;
  repository?: { engineName: string | null; restorePoints: number; storedBytes: number | null } | null;
  sizeBytes: number | null;
  storageKind?: 'external' | 'local' | 'network' | 'object' | null;
  writable: boolean;
};

type BackupValidation = {
  apps: Array<{ instanceId: string; packageId: string; packageVersion: string | null }>;
  backupPath: string;
  checkedAt: string;
  software: { backupVersion: string | null; currentVersion: string | null; matched: boolean };
  source?: { backupHostname: string | null; currentHostname: string | null; matched: boolean };
  volumes: Array<{ name: string; rawBytes: number | null }>;
  warnings: string[];
};

// Which item of how many the current stage is on, named by its app.
type JobCount = { current: string | null; done: number; note: string | null; sentence: string; total: number; unit: string };

// Where a running job is, in the agent's own words. The agent knows its own
// sequence, so the step count and the plan are facts it reports, not a guess
// this screen keeps beside it; the busy page Caddy serves reads the same
// record, so the two never drift.
type PlanState = 'done' | 'next' | 'now';

export type JobProgress = {
  count: JobCount | null;
  expect: { sentence: string } | null;
  headline: string;
  kind: string | null;
  // One entry per group of stages, each carrying the stages it is made of.
  plan: Array<{ sentence: string; state: PlanState; steps: Array<{ sentence: string; state: PlanState }> }>;
  sentence: string;
  stage: string | null;
  startedAt: string | null;
  step: number;
  steps: number;
  updatedAt: string | null;
};

// How long a check or a restore of one restore point will take on this
// machine, said before it starts. `basis` is whether that came from this
// machine's history or is a stated range; the sentence already says which.
type JobExpectation = { basis: 'guess' | 'measured' | 'partly'; note: string | null; sentence: string };

type BackupJob = {
  // The domain the backup carried and the restore set aside, or null when the
  // backup came from this machine and there was nothing to set aside.
  address?: { domain: string | null } | null;
  // Whether the restored routes went live. A web server that refused the new
  // config keeps serving the old one, so this is the difference between a
  // restored suite and a restored suite its owner can reach.
  controlPlane?: { detail: string | null; routesLive: boolean } | null;
  error: string | null;
  id: string;
  kind: string | null;
  logs?: Array<{ at?: string; message?: string }>;
  outputPath: string | null;
  progress?: JobProgress | null;
  rescuePath: string | null;
  stage: string | null;
  status: string | null;
  updatedAt: string | null;
  validation?: BackupValidation | null;
};

// One line of the activity list. Thinner than a job on purpose: a finished job
// is a sentence and a time, not a record to re-open.
type RecentJob = {
  destinationId: string | null;
  error: string | null;
  id: string;
  initiator?: 'owner' | 'schedule' | 'update' | null;
  kind: string | null;
  note?: string | null;
  // The agent's words for where a running job is, and its step; null once
  // the job is over.
  sentence?: string | null;
  stage: string | null;
  status: string | null;
  step?: number | null;
  steps?: number | null;
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
  // What checking or restoring this point will take here; absent on a backup
  // in the retired format, which can be neither.
  expect?: { check: JobExpectation; restore: JobExpectation } | null;
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
type PrimaryDestination = {
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

type InterruptedRestore = {
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
  schedule?: BackupSchedule | null;
  serviceAvailable: boolean;
};

type Tone = 'error' | 'muted' | 'ready' | 'warning';

export { formatBytes };

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

function daysSince(value: string | null) {
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
  if (destination.kind === 'object') return 'cloud-bucket';
  if (destination.storageKind === 'external') return 'usb-drive';
  if (destination.storageKind === 'network') return 'network-drive';
  return 'hard-drive';
}

function destinationKindLabel(destination: BackupDestination) {
  if (destination.kind === 'object') return 'Storage you rent online';
  if (destination.storageKind === 'external') return 'A drive you plug in';
  if (destination.storageKind === 'network') return 'A folder on your network';
  return 'A disk in this machine';
}

// Where the backups actually go, in the terms the owner entered them: the
// bucket and folder, and the host they live on.
function destinationAddress(destination: BackupDestination) {
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
  // Every fresh install is called "mos", so a name this machine shares tells the owner nothing.
  return backup.sourceHostname && backup.sourceHostname !== status.hostname ? backup.sourceHostname : 'another server';
}

// The domain a restore onto this machine will set aside, or null. It used to be
// a question — move the name here, or keep this machine's own address — asked
// before a restore and acted on in the middle of one, which is the stretch
// where Suite Manager is down and no screen can report what happened. It is a
// statement now: the suite comes back on this machine's own address, and the
// name is offered back afterwards, in the open.
export function carriedDomain(backup: BackupEntry, status: BackupStatus | null | undefined) {
  return writtenElsewhere(backup, status) ? backup.sourceDomain || null : null;
}

// Which server's backups a destination holds, when it is not this one. Read off
// the restore points rather than stored on the destination: the store itself
// says who wrote it, and a bucket that has been unlocked has to keep saying so
// long after the sentence that announced it has gone.
function foreignServer(destination: BackupDestination, status: BackupStatus | null | undefined) {
  const points = (status?.backups || []).filter((backup) => backup.destinationId === destination.id);
  const names = points.map((backup) => writtenElsewhere(backup, status)).filter(Boolean) as string[];
  if (!names.length) return null;
  // A store every point of which came from elsewhere is that server's; one that
  // also holds this machine's own points is shared, and named for the guest.
  return names[0] || null;
}

function bytesLine(destination: BackupDestination) {
  const store = destination.repository;
  const points = store?.restorePoints || 0;
  if (!points) return 'Ready · no backups here yet';
  const stored = store?.storedBytes ? ` · ${formatBytes(store.storedBytes)} stored` : '';
  return `Ready · ${points} restore point${points === 1 ? '' : 's'}${stored}`;
}

type DestinationAction = '' | 'restore' | 'retest' | 'unlock';

export type DestinationView = {
  action: DestinationAction;
  actionLabel: string;
  address: string | null;
  away: boolean;
  // Why this server cannot back up here, as the one sentence the page says about
  // it wherever it says it; empty when it can.
  blocked: string;
  detail: string;
  destination: BackupDestination;
  // Another server's backups on a drive that is here, which the owner may erase.
  erasable: boolean;
  foreign: string | null;
  id: string;
  keyLine: string;
  keyTone: Tone;
  // Whether someone who breaks into this server could erase this copy. MOS may
  // decline to enforce good practice, but it must never imply protection the
  // owner does not have.
  reachLine: string;
  kindLabel: string;
  label: string;
  newestAt: string | null;
  present: boolean;
  // MOS can read what is there, which is all restoring needs.
  readable: boolean;
  restorePoints: number;
  // This server can back up here, so it can be chosen.
  selectable: boolean;
  selected: boolean;
  spaceLine: string;
  status: string;
  tone: Tone;
};

// Another server's backups, as the owner is told about them before erasing.
export type ForeignStore = { destinationId: string; from: string | null; label: string; newestAt: string | null; restorePoints: number };

// A place holding another server's backups, locked or opened with its key. This
// server restores from it but never backs up into it, so it is listed apart.
export function isOtherServers(view: DestinationView) {
  return view.destination.foreignStore === true || view.destination.locked === true;
}

const PICK_A_PLACE = "Pick a place under This server's backups and MOS starts keeping copies.";

export function foreignStoreOf(view: DestinationView): ForeignStore {
  return { destinationId: view.id, from: view.foreign, label: view.label, newestAt: view.newestAt, restorePoints: view.restorePoints };
}

function blockedSentence(destination: BackupDestination) {
  const { label } = destination;
  if (destination.foreignStore) {
    return destination.kind === 'object'
      ? `${label} holds backups another server made, so this server cannot back up there. Pick another place below.`
      : `${label} holds backups another server made, so this server cannot back up there. Erase them from its menu below, or pick another place.`;
  }
  if (destination.kind === 'object') return `MOS could not reach ${label}. Check the internet connection; backups go there again once it answers.`;
  if (destination.mountState !== 'mounted') return `${label} is not plugged in. Plug it in and MOS backs up on its own.`;
  if (!destination.writable) return `MOS cannot write to ${label}. It may be locked by a switch on the drive itself.`;
  return destination.refusal || destination.notReadyReason || `${label} cannot take backups right now.`;
}

// One destination, reduced to the row the design draws: a status line that
// states the condition once, a detail line under it, and at most one button.
// Everything that used to be split over a pill, a helper and a footer is folded
// into `status` and `detail` here.
function destinationView(destination: BackupDestination, status: BackupStatus | null | undefined, selectedId: string): DestinationView {
  const selected = destination.id === selectedId;
  const ready = destination.ready === true;
  const bucket = destination.kind === 'object';
  const foreign = foreignServer(destination, status);
  const borrowed = destination.borrowedKey === true;
  const foreignStore = destination.foreignStore === true;
  const present = ready || destination.locked === true || bucket;
  const points = (status?.backups || []).filter((backup) => backup.destinationId === destination.id);
  const restorePoints = destination.repository?.restorePoints || points.length;

  let tone: Tone = 'ready';
  let line = bytesLine(destination);
  let detail = '';
  let action: DestinationAction = '';
  let actionLabel = '';

  if (destination.locked) {
    tone = 'warning';
    line = 'Made by another server';
    action = 'unlock';
    actionLabel = 'Enter recovery key';
  } else if (ready && foreignStore) {
    line = `${restorePoints} restore point${restorePoints === 1 ? '' : 's'} to restore from`;
    action = 'restore';
    actionLabel = 'Restore from these…';
  } else if (ready) {
    detail = bucket ? `At ${(destination.endpoint || '').replace(/^https?:\/\//u, '') || 'your storage provider'}`
      : destination.holdsAppFiles ? "Also holds your apps' files, which these backups do not include." : '';
  } else if (bucket) {
    tone = 'error';
    line = 'MOS could not reach this storage';
    detail = 'Check the internet connection, then try again.';
    action = 'retest';
    actionLabel = 'Try again';
  } else if (destination.mountState === 'mounted' && !destination.writable) {
    tone = 'warning';
    line = 'MOS can read this drive but cannot write to it';
    detail = 'It may be locked by a switch on the drive itself.';
  } else if (destination.mountState === 'away') {
    // Not a problem to fix. This is the copy that survives the thing every
    // other copy does not, and the row says so rather than reading as an error.
    tone = 'muted';
    line = destination.lastBackupAt ? `Unplugged · backed up ${whenWords(destination.lastBackupAt).toLowerCase()}` : 'Unplugged';
    detail = 'Plug it in to bring it up to date.';
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
    keyLine = "Opens only with the recovery key of the server that made it, not this server's.";
    keyTone = 'warning';
  } else if (foreign && borrowed) {
    keyLine = `Opens with ${foreign}'s key, kept on this server. Nothing in these backups was changed.`;
  } else if (foreign) {
    keyLine = 'Opens with your recovery key.';
  }

  const spaceKnown = Boolean(destination.sizeBytes && destination.availableBytes);
  const away = destination.mountState === 'away';
  const selectable = ready && !foreignStore;
  return {
    action,
    actionLabel,
    address: destinationAddress(destination),
    away,
    blocked: selectable ? '' : blockedSentence(destination),
    detail,
    destination,
    erasable: foreignStore && !bucket && destination.mountState === 'mounted',
    foreign,
    id: destination.id,
    keyLine,
    keyTone,
    reachLine: reachOf(destination),
    kindLabel: destinationKindLabel(destination),
    label: destination.label,
    newestAt: points.map((backup) => backup.createdAt || '').sort().at(-1) || null,
    present,
    readable: ready,
    restorePoints,
    selectable,
    selected,
    spaceLine: !bucket && ready && spaceKnown ? `${formatBytes(destination.availableBytes)} free of ${formatBytes(destination.sizeBytes)}` : '',
    status: line,
    tone,
  };
}

/**
 * Whether this copy is within reach of someone who gets into the server.
 *
 * It is the one thing MOS must always be able to say. Ransomware runs on an
 * unlocked machine with the owner's own credentials, so anything MOS can write
 * to, it can also delete, and anything MOS can undo an attacker with root can
 * undo. No setting on this screen changes that: only a drive that is not
 * plugged in is out of reach, which is why unplugging is worth saying out loud
 * rather than leaving as something the owner is supposed to infer.
 */
function reachOf(destination: BackupDestination) {
  if (destination.mountState === 'away') return 'Unplugged, so nothing that gets into this server can reach it.';
  if (destination.locked) return '';
  if (destination.kind === 'object') return 'Anything that gets into this server can erase this copy.';
  if (destination.mountState === 'mounted') return 'Plugged in, so anything that gets into this server can erase this copy.';
  return '';
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

export type ArchiveKey = {
  createdAt?: string | null;
  current?: boolean;
  hostname?: string | null;
  id: string;
  username?: string | null;
};

// A key in an archive's key list, said as a place rather than as a record: the
// machine it was made on and when, because that is what an owner recognises
// when deciding whether it still belongs there.
export function archiveKeyLine(key: ArchiveKey) {
  const where = key.hostname ? `Made on ${key.hostname}` : 'Made on an unnamed machine';
  return key.createdAt ? `${where} · ${whenWords(key.createdAt)}` : where;
}

// The one sentence at the top of the page: am I safe, where does it go, when
// was the last one. Everything else on the screen is a detail of this.
// Only backups in this server's own stores count towards "am I safe": a drive
// holding another server's backups can be read here, but it says nothing about
// this suite.
export function bannerState(status: BackupStatus | null | undefined, views: DestinationView[], busyBackup: boolean) {
  const selected = views.find((view) => view.selected) || null;
  const foreignStores = new Set(views.filter((view) => view.destination.foreignStore).map((view) => view.id));
  const newest = (status?.backups || []).filter((backup) => backup.restorable !== false && !foreignStores.has(backup.destinationId || ''))
    .slice().sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())[0] || null;
  const schedule = status?.schedule || null;
  const nextRun = schedule?.enabled && schedule.nextRunAt ? ` · Next ${formatInZone(schedule.nextRunAt, schedule.timeZone)}` : '';

  if (busyBackup) return { detail: 'Your apps pause for a few minutes and come back on their own.', title: 'Backing up now.', tone: 'ready' as Tone };
  if (!newest) {
    if (selected?.blocked) return { detail: selected.blocked, title: 'You have no backups yet.', tone: 'warning' as Tone };
    return selected
      ? { detail: `Nothing has been backed up yet. The first one goes to ${selected.label}.`, title: 'You have no backups yet.', tone: 'warning' as Tone }
      : { detail: PICK_A_PLACE, title: 'You have no backups yet.', tone: 'warning' as Tone };
  }
  if (schedule?.lastResult?.status === 'failed') {
    return { detail: schedule.lastResult.message, title: 'The last automatic backup did not finish.', tone: 'error' as Tone };
  }
  const age = daysSince(newest.createdAt);
  if (selected?.blocked) {
    return {
      detail: selected.blocked,
      title: age && age > 1 ? `Your last backup was ${age} days ago.` : 'Your backups are up to date.',
      tone: 'warning' as Tone,
    };
  }
  if (age !== null && age > 3) {
    return { detail: `Last backup ${whenWords(newest.createdAt)} to ${newest.destinationLabel}${nextRun}`, title: `Your last backup was ${age} days ago.`, tone: 'warning' as Tone };
  }
  // The end of the rotation, said once, at the only moment it is useful: a
  // drive that has just been written to and is not where automatic backups go
  // is a drive on its way back to a drawer, and it is only out of reach once it
  // is unplugged. Never said about the chosen destination — unplugging that one
  // would break the schedule the owner set up.
  const writtenTo = views.find((view) => view.id === newest.destinationId) || null;
  if (age === 0 && writtenTo && !writtenTo.selected && writtenTo.destination.storageKind === 'external' && writtenTo.destination.mountState === 'mounted') {
    return {
      detail: `Backed up to ${writtenTo.label}. Unplug it and keep it somewhere else: a drive that stays plugged in can be erased by anything that gets into this server.`,
      title: 'Your backups are up to date.',
      tone: 'ready' as Tone,
    };
  }
  return { detail: `Last backup ${whenWords(newest.createdAt)} to ${newest.destinationLabel}${nextRun}`, title: 'Your backups are up to date.', tone: 'ready' as Tone };
}

// Why Back up now is not available, in the words of the thing the owner has to
// go and do. An empty string means it is available.
export function backupBlockReason(status: BackupStatus | null | undefined, views: DestinationView[], target: DestinationView | null) {
  if (status?.interruptedRestore) return 'A restore did not finish. Read what happened before backing up again.';
  if (!status?.recoveryKey?.acknowledged) return 'Save your recovery key first.';
  if (!views.length) return 'Choose where your backups should go first.';
  if (!target) return views.find((view) => view.selected)?.blocked || PICK_A_PLACE;
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

// The words for a running job are the agent's (system-agents/backup/progress.cjs):
// it knows its own sequence, and the busy page reads the same record. This
// screen only renders what it was sent, and says "Getting ready" for a job the
// agent has not described yet.
export function stageWords(job: BackupJob | null | undefined) {
  return job?.progress?.sentence || 'Getting ready';
}

// " — step 4 of 9", or nothing for a job with one step or none reported.
export function stepLine(job: { step?: number | null; steps?: number | null } | null | undefined) {
  const step = job?.step || 0;
  const steps = job?.steps || 0;
  return step > 0 && steps > 1 ? ` — step ${step} of ${steps}` : '';
}

// One line for a running job: its stage, its step, and which item of how many
// inside the stage when the agent counted one.
export function jobLine(job: BackupJob | null | undefined) {
  const count = job?.progress?.count;
  return `${stageWords(job)}${stepLine(job?.progress)}${count ? ` · ${count.sentence}` : ''}`;
}

// The share of a counted stage that is done, for the one bar this screen
// draws: a proportion of items, never of time.
export function countShare(count: JobCount | null | undefined) {
  if (!count || count.total <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, count.done / count.total)) * 100);
}

// Why the controls are dead, for a job that holds the page without taking it
// over. A running job disables everything on the screen, so each kind has to
// say what it is waiting for rather than leaving a row of buttons that do
// nothing. A backup is absent because it reports its own stage and step.
export function jobWorkingLine(job: BackupJob | null) {
  if (!isRunning(job)) return '';
  if (job?.kind === 'delete') return `Deleting a backup: ${jobLine(job)}. This can take a few minutes.`;
  if (job?.kind === 'validate') return `Checking a backup: ${jobLine(job)}. Backups and restores wait until it finishes.`;
  return '';
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
  if (job.status === 'queued' || job.status === 'running') return `${kind} in progress${at}: ${job.sentence || 'Getting ready'}${stepLine(job)}.`;
  if (job.kind === 'restore') return `Restore finished. This machine now matches the backup it restored.`;
  if (job.kind === 'validate') return `Backup check passed${at}. It is readable and complete.`;
  if (job.kind === 'delete') return `Backup deleted${at}. The space only it was using has been freed.`;
  if (job.initiator === 'update') return `Backup taken${at} before updating MOS${job.updateTarget ? ` to ${job.updateTarget}` : ''}.`;
  if (job.initiator === 'schedule') return `Automatic backup finished${at}.`;
  return `Backup finished${at}${job.note ? `, with your note "${job.note}"` : ''}.`;
}

// What is left over after a restore that worked. A restore onto new hardware
// finishes with the suite reachable and some of its owner's world still
// pointing at the machine they came from, and a screen that answers "done" to
// that is the failure this reports around: the phone apps keep saying error
// while the browser says everything is fine.
type RestoreAftermath = {
  // The name the backup carried, set aside and offered back under Settings.
  domain: string | null;
  routesDetail: string | null;
  routesLive: boolean;
};

export function restoreAftermath(job: BackupJob | null | undefined): RestoreAftermath | null {
  if (job?.kind !== 'restore' || job.status !== 'succeeded') return null;
  const domain = job.address?.domain || null;
  const routesLive = job.controlPlane ? job.controlPlane.routesLive : true;
  if (!domain && routesLive) return null;
  return { domain, routesDetail: job.controlPlane?.detail || null, routesLive };
}

// The kit is text the browser saves, not a file the server serves: it holds the
// recovery key, and a URL that returns one is a URL that can be requested again.

// What a rotation reached, and what it could not. A copy that was not attached
// is not a failure: it carries the previous key until it is next plugged in,
// and MOS finishes the change itself at that moment.
export type RotationResult = {
  destinations: Array<{ id: string; label: string; state: 'foreign' | 'pending' | 'rotated' }>;
  ok?: boolean;
  pending: Array<{ id: string; label: string }>;
  sentence?: string;
};
