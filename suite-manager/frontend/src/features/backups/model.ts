// Everything the Backup & Restore screen knows how to say, as pure functions over
// the status the agent returns: no fetching, no state, no JSX.

import type { IconName } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { whenWords } from '../../lib/dates';
import { type StorageState } from '../storage/model';

type PlaceKind = 'disk' | 'object';

// A place a backup can go: every connected drive that can hold backups and every
// storage connection. Its state and reason are the storage module's own words.
export type BackupPlace = {
  accessKeyId?: string;
  availableBytes: number | null;
  bucket?: string;
  checkedAt?: string | null;
  endpoint?: string;
  folder?: string;
  holdsAppFiles?: boolean;
  id: string;
  kind: PlaceKind;
  label: string;
  lastBackupAt: string | null;
  ownArchive: { id: string; restorePoints: number | null; storedBytes: number | null } | null;
  reason: string | null;
  region?: string;
  sizeBytes: number | null;
  state: StorageState;
  storageKind: 'external' | 'local' | 'object';
};

// One set of backups — an encrypted repository and its restore points — and whose
// it is, as the backup agent states it. This screen never works that out itself.
export type Archive = {
  id: string;
  keyState: 'borrowed' | 'locked' | 'own';
  newestAt: string | null;
  owner: 'other' | 'this';
  placeId: string;
  placeKind: PlaceKind;
  placeLabel: string;
  reason: string | null;
  restorePoints: number | null;
  storedBytes: number | null;
  writtenBy: { hostname: string | null; installId: string | null } | null;
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

type PlanState = 'done' | 'next' | 'now';

// Where a running job is, in the agent's own words. The busy page Caddy serves
// reads the same record, so the two never drift.
export type JobProgress = {
  count: JobCount | null;
  expect: { sentence: string } | null;
  headline: string;
  kind: string | null;
  plan: Array<{ sentence: string; state: PlanState; steps: Array<{ sentence: string; state: PlanState }> }>;
  sentence: string;
  stage: string | null;
  startedAt: string | null;
  step: number;
  steps: number;
  updatedAt: string | null;
};

// How long a check or a restore will take here, said before it starts; `basis` is
// whether that came from this server's history or is a stated range.
type JobExpectation = { basis: 'guess' | 'measured' | 'partly'; note: string | null; sentence: string };

type BackupJob = {
  // The domain the backup carried and the restore set aside; null when nothing was.
  address?: { domain: string | null } | null;
  appsNotStarted?: Array<{ displayName: string; packageId: string }>;
  // Whether the restored routes went live: a web server that refused the new
  // config keeps serving the old one.
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

// One line of the activity list: a finished job is a sentence and a time.
type RecentJob = {
  destinationId: string | null;
  error: string | null;
  id: string;
  initiator?: 'owner' | 'schedule' | 'update' | null;
  kind: string | null;
  note?: string | null;
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
  archiveId: string;
  createdAt: string | null;
  encrypted?: boolean;
  engineName?: string | null;
  expect?: { check: JobExpectation; restore: JobExpectation } | null;
  id: string;
  initiator?: 'owner' | 'schedule' | 'update';
  note?: string | null;
  owner: 'other' | 'this';
  path: string;
  placeId: string;
  placeLabel: string;
  repositoryId?: string | null;
  sizeBytes?: number | null;
  // The domain the writing server served; null for none, absent on a restore
  // point too old to say.
  sourceDomain?: string | null;
  sourceHostname?: string | null;
  sourceInstallId?: string | null;
  sourceVersion: string | null;
  updateTarget?: string | null;
  volumeCount: number;
};

// Where everything that backs up on its own writes: the schedule, and the backup
// taken before a MOS update.
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

// The fingerprint is a short digest, never the key; `adoptedAt` is set when the
// key was typed off another server's kit rather than made here.
export type RecoveryKeyState = {
  acknowledged: boolean;
  acknowledgedAt?: string | null;
  adoptedAt?: string | null;
  fingerprint: string | null;
  keyFile?: string | null;
};

export type BackupStatus = {
  archives: Archive[];
  backups: BackupEntry[];
  currentJob: BackupJob | null;
  error?: string | null;
  hostname?: string | null;
  interruptedRestore?: InterruptedRestore | null;
  inventory?: {
    summary: { appCount: number; declaredVolumeCount: number; relationshipCount: number; warningCount: number };
    warnings: Array<{ message: string; packageId: string }>;
  };
  lastJob: BackupJob | null;
  places: BackupPlace[];
  primaryDestination?: PrimaryDestination | null;
  recentJobs?: RecentJob[];
  recoveryKey?: RecoveryKeyState | null;
  restoreGuarantee?: string;
  restoreGuaranteeByKind?: Record<string, string>;
  schedule?: BackupSchedule | null;
  serviceAvailable: boolean;
};

type Tone = 'error' | 'muted' | 'ready' | 'warning';

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

// Scheduled times are wall-clock times in the zone the schedule was set from, so
// every moment the panel shows is rendered in that same zone.
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

type Place = { kind?: string; storageKind?: string | null };

export function placeOf(kind: PlaceKind): Place {
  return { kind, storageKind: kind === 'object' ? 'object' : 'external' };
}

export function destinationIconName(place: Place): IconName {
  if (place.kind === 'object') return 'cloud-bucket';
  if (place.storageKind === 'external') return 'usb-drive';
  if (place.storageKind === 'network') return 'network-drive';
  return 'hard-drive';
}

function destinationKindLabel(place: Place) {
  if (place.kind === 'object') return 'Storage online';
  if (place.storageKind === 'external') return 'A drive you plug in';
  if (place.storageKind === 'network') return 'A folder on your network';
  return 'A drive inside this server';
}

// A restore point's size is the suite data it restores, not space on the drive:
// points share the archive's data, so sizes are not additive.
export function backupDescription(backup: BackupEntry) {
  const contents = backup.appCount > 0 ? `${backup.appCount} app${backup.appCount === 1 ? '' : 's'} · ${backup.volumeCount} data store${backup.volumeCount === 1 ? '' : 's'}` : 'No apps in this restore point';
  if (!Number.isFinite(backup.sizeBytes ?? NaN)) return contents;
  return `${contents} · ${formatBytes(backup.sizeBytes as number)} to restore`;
}

// The restore point MOS takes before it updates itself, which retention never
// removes; named so an owner deciding what to delete can see why it is here.
export function checkpointLabel(backup: BackupEntry) {
  if (backup.initiator !== 'update') return null;
  return backup.updateTarget ? `Before update to ${backup.updateTarget}` : 'Before a MOS update';
}

// Which server made a restore point in another server's archive: restoring it
// makes this server that server.
export function writtenElsewhere(backup: BackupEntry) {
  return backup.owner === 'other' ? backup.sourceHostname || 'another server' : null;
}

// The domain a restore onto this server will set aside, or null.
export function carriedDomain(backup: BackupEntry) {
  return backup.owner === 'other' ? backup.sourceDomain || null : null;
}

// The default backup destination: where scheduled backups and the one before a
// MOS update go. Named from the agent's record, so a drive in a drawer still is.
export type AutomaticPlace = { id: string; label: string; place: BackupPlace | null };

export function automaticPlace(status: BackupStatus | null | undefined): AutomaticPlace | null {
  const chosen = status?.primaryDestination;
  if (!chosen) return null;
  const place = (status?.places || []).find((entry) => entry.id === chosen.destinationId) || null;
  return { id: chosen.destinationId, label: place?.label || chosen.label || 'the place you chose', place };
}

// Why a backup cannot go to the default destination right now, or ''.
function automaticBlocked(auto: AutomaticPlace | null) {
  if (!auto) return '';
  if (!auto.place) return `${auto.label} is not connected.`;
  return auto.place.state === 'ready' ? '' : auto.place.reason || `${auto.label} cannot take backups right now.`;
}

// Another server's archive, as its row in "Backups from another server".
export type OtherArchiveView = {
  action: 'restore' | 'unlock';
  actionLabel: string;
  archive: Archive;
  // On a drive the owner may erase it; a bucket's is the provider's to delete.
  erasable: boolean;
  from: string | null;
  id: string;
  keyLine: string;
  kindLabel: string;
  label: string;
  status: string;
};

export function otherArchiveViews(status: BackupStatus | null | undefined): OtherArchiveView[] {
  return (status?.archives || []).filter((archive) => archive.owner === 'other').map((archive) => {
    const from = archive.writtenBy?.hostname || null;
    const locked = archive.keyState === 'locked';
    const points = archive.restorePoints || 0;
    return {
      action: locked ? 'unlock' : 'restore',
      actionLabel: locked ? 'Enter recovery key' : 'Restore from these…',
      archive,
      erasable: archive.placeKind === 'disk',
      from,
      id: archive.id,
      keyLine: locked
        ? "Opens only with the recovery key of the server that made it, not this server's."
        : `Opens with ${from || 'that server'}'s key, kept on this server. Nothing in these backups was changed.`,
      kindLabel: destinationKindLabel(placeOf(archive.placeKind)),
      label: archive.placeLabel,
      status: locked ? 'Made by another server' : `${points} restore point${points === 1 ? '' : 's'} to restore from`,
    };
  });
}

export type ArchiveKey = {
  createdAt?: string | null;
  current?: boolean;
  hostname?: string | null;
  id: string;
  username?: string | null;
};

// A key in an archive's key list, said as the server it was made on and when,
// which is what an owner recognises when deciding whether it still belongs there.
export function archiveKeyLine(key: ArchiveKey) {
  const where = key.hostname ? `Made on ${key.hostname}` : 'Made on an unnamed server';
  return key.createdAt ? `${where} · ${whenWords(key.createdAt)}` : where;
}

type Banner = { detail: string; title: string; tone: Tone };

// The one sentence at the top of the page: am I safe, where does it go, when was
// the last one. Only this server's own archives count towards "am I safe".
export function bannerState(status: BackupStatus | null | undefined, busyBackup: boolean): Banner {
  const auto = automaticPlace(status);
  const blocked = automaticBlocked(auto);
  const newest = (status?.backups || []).filter((backup) => backup.owner === 'this')
    .slice().sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())[0] || null;
  const schedule = status?.schedule || null;
  const nextRun = auto && schedule?.enabled && schedule.nextRunAt ? ` · Next ${formatInZone(schedule.nextRunAt, schedule.timeZone)}` : '';

  if (busyBackup) return { detail: 'Your apps pause for a few minutes and come back on their own.', title: 'Backing up now.', tone: 'ready' };
  if (!newest) {
    const title = 'No backups of this server yet.';
    if (!status?.places.length) return { detail: 'Connect a drive or storage online in Settings → Storage, then make the first backup here.', title, tone: 'warning' };
    if (blocked) return { detail: blocked, title, tone: 'warning' };
    return { detail: auto ? `Automatic backups go to ${auto.label}.` : 'Back up now to any connected drive or storage online.', title, tone: 'warning' };
  }
  if (schedule?.lastResult?.status === 'failed') {
    return { detail: schedule.lastResult.message, title: 'The last automatic backup did not finish.', tone: 'error' };
  }
  const age = daysSince(newest.createdAt);
  if (blocked) {
    return { detail: blocked, title: age && age > 1 ? `Your last backup was ${age} days ago.` : 'Your backups are up to date.', tone: 'warning' };
  }
  if (age !== null && age > 3) {
    return { detail: `Last backup ${whenWords(newest.createdAt)} to ${newest.placeLabel}${nextRun}`, title: `Your last backup was ${age} days ago.`, tone: 'warning' };
  }
  // A drive just written to that is not where automatic backups go is on its way
  // back to a drawer, and only out of reach once unplugged; said once, now.
  const writtenTo = (status?.places || []).find((place) => place.id === newest.placeId) || null;
  if (age === 0 && writtenTo && writtenTo.id !== auto?.id && writtenTo.storageKind === 'external' && writtenTo.state === 'ready') {
    return {
      detail: `Backed up to ${writtenTo.label}. Unplug it and keep it somewhere else: a drive that stays plugged in can be erased by anything that gets into this server.`,
      title: 'Your backups are up to date.',
      tone: 'ready',
    };
  }
  return { detail: `Last backup ${whenWords(newest.createdAt)} to ${newest.placeLabel}${nextRun}`, title: 'Your backups are up to date.', tone: 'ready' };
}

// Why Back up now is not available, in the words of the thing the owner has to
// go and do. An empty string means it is available.
export function backupBlockReason(status: BackupStatus | null | undefined) {
  if (status?.interruptedRestore) return 'A restore did not finish. Read what happened before backing up again.';
  return '';
}

// The live line under the schedule summary: what it is doing right now, or what
// it is waiting for, in that order.
export function scheduleLive(schedule: BackupSchedule | null | undefined, auto: AutomaticPlace | null): { text: string; tone: Tone } {
  if (!schedule) return { text: '', tone: 'muted' };
  if (!auto) return { text: 'No default backup destination yet. Choose one with Change, and automatic backups start on the next run.', tone: 'warning' };
  if (schedule.running) return { text: 'An automatic backup is running now.', tone: 'ready' };
  if (schedule.waiting) return { text: `Waiting: ${schedule.waiting.reason}`, tone: 'warning' };
  if (!schedule.enabled) return { text: 'Off. MOS only backs up when you ask it to, and before it updates itself.', tone: 'muted' };
  if (schedule.lastResult?.status === 'failed') return { text: `Last automatic backup stopped: ${schedule.lastResult.message}`, tone: 'error' };
  if (schedule.nextRunAt) return { text: `Next backup ${formatInZone(schedule.nextRunAt, schedule.timeZone)}.`, tone: 'ready' };
  return { text: '', tone: 'muted' };
}

export function scheduleSummary(schedule: BackupSchedule | null | undefined, auto: AutomaticPlace | null) {
  if (!schedule || !schedule.enabled) return auto ? `No schedule yet · before a MOS update, MOS backs up to ${auto.label}` : 'No schedule yet.';
  const keep = schedule.keepLast ? `keep the last ${schedule.keepLast}` : 'keep all of them';
  const when = schedule.frequency === 'weekly' ? `Every ${WEEKDAY_NAMES[schedule.weekday] || 'Sunday'}` : 'Every day';
  return `${when} at ${clockValue(schedule)} · ${keep} · to ${auto ? auto.label : 'nowhere yet'}`;
}

// The words for a running job are the agent's (system-agents/backup/progress.cjs);
// "Getting ready" is for a job it has not described yet.
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

// The share of a counted stage that is done: a proportion of items, never of time.
export function countShare(count: JobCount | null | undefined) {
  if (!count || count.total <= 0) return 0;
  return Math.round(Math.max(0, Math.min(1, count.done / count.total)) * 100);
}

// Why the controls are dead while a job that is not a backup holds the page.
export function jobWorkingLine(job: BackupJob | null) {
  if (!isRunning(job)) return '';
  if (job?.kind === 'delete') return `Deleting a restore point: ${jobLine(job)}. This can take a few minutes.`;
  if (job?.kind === 'validate') return `Verifying a restore point: ${jobLine(job)}. Backups and restores wait until it finishes.`;
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

// One finished job, as one sentence: what happened and where, and for a failure what to do.
export function activityLine(job: RecentJob, places: BackupPlace[]) {
  const place = places.find((entry) => entry.id === job.destinationId)?.label || '';
  const at = place ? ` on ${place}` : '';
  const kind = job.kind === 'restore' ? 'Restore' : job.kind === 'validate' ? 'Verification' : job.kind === 'delete' ? 'Delete' : 'Backup';
  if (job.status === 'failed') return `${kind} stopped${at}: ${job.error || 'MOS could not say why.'}`;
  if (job.status === 'queued' || job.status === 'running') return `${kind} in progress${at}: ${job.sentence || 'Getting ready'}${stepLine(job)}.`;
  if (job.kind === 'restore') return 'Restore finished. This server now matches the restore point it restored.';
  if (job.kind === 'validate') return `Verification passed${at}. The restore point is readable and complete.`;
  if (job.kind === 'delete') return `Restore point deleted${at}. The space only it was using has been freed.`;
  if (job.initiator === 'update') return `Backup taken${at} before updating MOS${job.updateTarget ? ` to ${job.updateTarget}` : ''}.`;
  if (job.initiator === 'schedule') return `Automatic backup finished${at}.`;
  return `Backup finished${at}${job.note ? `, with your note "${job.note}"` : ''}.`;
}

// What a restore that worked has left its owner to finish: a suite whose phones
// and laptops still ask for another server is not done, however fine the browser looks.
type RestoreAftermath = {
  appsNotStarted: string[];
  domain: string | null;
  left: number;
  routesDetail: string | null;
  routesLive: boolean;
};

export function restoreAftermath(job: BackupJob | null | undefined): RestoreAftermath | null {
  if (job?.kind !== 'restore' || job.status !== 'succeeded') return null;
  const appsNotStarted = (job.appsNotStarted || []).map((app) => app.displayName);
  const domain = job.address?.domain || null;
  const routesLive = job.controlPlane ? job.controlPlane.routesLive : true;
  const left = [appsNotStarted.length > 0, Boolean(domain), !routesLive].filter(Boolean).length;
  if (!left) return null;
  return { appsNotStarted, domain, left, routesDetail: job.controlPlane?.detail || null, routesLive };
}

// What a rotation reached. A copy that was not attached carries the previous key
// until it is next plugged in, when MOS finishes the change itself.
export type RotationResult = {
  destinations: Array<{ id: string; label: string; state: 'foreign' | 'pending' | 'rotated' }>;
  ok?: boolean;
  pending: Array<{ id: string; label: string }>;
  sentence?: string;
};
