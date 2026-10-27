// One wording for storage, so Settings, the pickers, the start page, Backups and
// an app's page agree. Consumers choose by what an entry can do, never by its kind.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { IconName } from '../../components/ui';
import { jsonResponse, postJson } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import type { AppJob, DriveStep } from '../apps/types';

export type StorageState = 'available' | 'away' | 'ejected' | 'failed' | 'read-only' | 'ready' | 'unreachable';
export type DriveAction = 'check' | 'eject' | 'use';
export type StorageKind = 'bucket' | 'drive' | 'system';
export type AppNames = Map<string, string>;

// An archive another server made here, which this server reads and never writes.
export type OtherServerArchive = {
  id: string;
  keyState: 'borrowed' | 'locked';
  newestAt: string | null;
  restorePoints: number | null;
  writtenBy: { hostname: string | null } | null;
};

export type StorageBackups = {
  lastBackupAt: string | null;
  otherServers: OtherServerArchive[];
  // This server's backups are kept here.
  ours: boolean;
  // Automatic backups go here.
  primary: boolean;
  restorePoints: number;
  storedBytes: number | null;
};

export type StorageEntry = {
  apps: string[];
  availableBytes: number | null;
  backups: StorageBackups | null;
  bucket?: { accessKeyId: string; bucket: string; endpoint: string; folder: string; region: string };
  capabilities: { browsable: boolean; checkable: boolean; ejectable: boolean; holdsAppFolders: boolean; holdsBackups: boolean; renamable: boolean; writable: boolean };
  connected: boolean;
  // The kernel's, the command's or the provider's own words when it is not working.
  detail: string | null;
  devicePath?: string | null;
  diskSizeBytes?: number | null;
  encrypted?: boolean;
  fileSystem?: string | null;
  id: string;
  job: AppJob<DriveStep> | null;
  kind: StorageKind;
  label: string;
  model?: string | null;
  mountPath?: string | null;
  name: string;
  named: boolean;
  reason: string | null;
  removable?: boolean;
  sizeBytes: number | null;
  state: StorageState;
  systemUsage?: { appsBytes: number; systemBytes: number } | null;
  transport?: string | null;
};

export type InstallerStick = { devicePath: string; job: AppJob<DriveStep> | null; model: string | null; sizeBytes: number | null };
export type StorageInventory = {
  // Package id to display name, for every app that claims storage.
  appNames: Record<string, string>;
  backupsKnown: boolean;
  // The volume label a formatted install stick gets, as the storage module sets it.
  formattedLabel?: string;
  installerSticks: InstallerStick[];
  storage: StorageEntry[];
};
export type StorageUsage = {
  backups: Array<{ bytes: number; driveId: string }>;
  folders: Array<{ app: string; appName: string; bytes: number; driveId: string; installed: boolean; name: string }>;
};

export type BucketDraft = { accessKeyId: string; bucket: string; endpoint: string; folder: string; id?: string; label: string; region: string; secretAccessKey: string };
export const EMPTY_BUCKET_DRAFT: BucketDraft = { accessKeyId: '', bucket: '', endpoint: '', folder: '', label: '', region: '', secretAccessKey: '' };
export type ConnectionTest = { locked?: boolean; message: string; ok: boolean } | null;

export const WINDOWS_CHECK_STEPS = 'Plug it into a Windows computer, open the drive\'s Properties, choose Tools and then Check, and eject it before plugging it back in here.';
export const BACKUPS_UNKNOWN_LINE = 'MOS could not read what backups are here.';

export function storageIcon(entry: StorageEntry): IconName {
  if (entry.kind === 'bucket') return 'cloud-bucket';
  if (entry.kind === 'system') return 'hard-drive';
  if (entry.removable) return 'usb-stick';
  return entry.transport === 'usb' ? 'usb-drive' : 'hard-drive';
}

// A drive whose format MOS cannot use for anything is only mentioned, never listed.
export function unusableFormat(entry: StorageEntry) {
  return entry.kind === 'drive' && entry.connected && !entry.capabilities.holdsAppFolders && !entry.capabilities.holdsBackups;
}

export function isAttention(entry: Pick<StorageEntry, 'state'>) {
  return entry.state === 'read-only' || entry.state === 'failed' || entry.state === 'unreachable';
}

type Condition = Pick<StorageEntry, 'connected' | 'kind' | 'reason' | 'state'>;

// The one word for a condition, on every pill and at the head of every row.
const STATE_LABELS: Record<StorageState, string> = {
  available: '',
  away: 'Not connected',
  ejected: 'Ejected',
  failed: 'Could not be opened',
  'read-only': 'Needs a check',
  ready: 'Ready',
  unreachable: 'Cannot connect',
};

export function stateLabel(entry: Pick<Condition, 'connected' | 'state'>) {
  return entry.state === 'ejected' && entry.connected ? 'Safe to unplug' : STATE_LABELS[entry.state];
}

export function statePill(entry: Pick<Condition, 'connected' | 'state'>) {
  return `mos-pill${isAttention(entry) ? ' mos-pill-warning' : entry.state === 'ready' ? ' mos-pill-accent' : ''}`;
}

// Why storage in this condition cannot be used: the server's own reason where it
// gave one, these words where it did not. Empty when it is working.
export function stateSentence(entry: Condition) {
  switch (entry.state) {
    case 'read-only': return entry.reason || 'Apps can read it; nothing can be saved to it until it is checked.';
    case 'failed': return entry.reason || 'MOS could not open this drive.';
    case 'away': return 'Plug it in to use it again.';
    case 'ejected': return entry.connected ? 'Use it again, or unplug it.' : 'Plug it back in to use it again.';
    case 'unreachable': return entry.reason || (entry.kind === 'bucket' ? 'MOS could not reach this storage. Check the internet connection, then look again.' : 'MOS could not read your storage right now.');
    default: return '';
  }
}

function transportWord(entry: StorageEntry) {
  if (entry.transport === 'usb' || entry.transport === 'removable') return 'USB';
  if (entry.transport === 'image') return 'Disk image';
  return 'Inside the server';
}

// "Seagate Expansion · USB · 1 TB": what the drive is, before anything about its state.
export function hardwareLine(entry: StorageEntry) {
  const model = entry.model && entry.model !== entry.name ? entry.model : '';
  return [model, transportWord(entry), entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : ''].filter(Boolean).join(' · ');
}

export function appNamesFor(entry: StorageEntry, names: AppNames) {
  return entry.apps.map((app) => names.get(app) || app);
}

export function joinNames(list: string[]) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '';
}

type RowFacts = { backupsKnown: boolean; names: AppNames };

// The one line under a row's name in Settings → Storage. A row not simply
// working begins with its state word, so a line can stand alone anywhere.
export function rowLine(entry: StorageEntry, { backupsKnown, names }: RowFacts) {
  if (entry.kind === 'system') return `${entry.diskSizeBytes ? `${formatBytes(entry.diskSizeBytes)} · ` : ''}the drive MOS and your apps run from`;
  if (entry.kind === 'bucket') {
    if (entry.state === 'unreachable') return stateSentence(entry);
    if (!backupsKnown) return BACKUPS_UNKNOWN_LINE;
    if (entry.backups?.otherServers.length && !entry.backups.ours) return 'Holds backups another server made';
    if (!entry.backups?.ours) return 'Connected · not holding anything yet';
    return entry.backups.storedBytes ? `Holds your backups · about ${formatBytes(entry.backups.storedBytes)} stored` : 'Holds your backups · none yet';
  }
  const apps = appNamesFor(entry, names);
  const label = stateLabel(entry);
  switch (entry.state) {
    case 'read-only':
    case 'failed': return `${label} — ${stateSentence(entry)}`;
    case 'away':
      if (!apps.length) return `${label} — plug it in to use it again`;
      return `${label} — ${joinNames(apps)} ${apps.length === 1 ? 'gets its' : 'get their'} files back when it returns`;
    case 'ejected': return entry.connected
      ? `${label} — ${apps.length ? `${joinNames(apps)} ${apps.length > 1 ? 'are' : 'is'} paused` : 'nothing is using it'} until it is back`
      : `${label} — plug it back in to use it again`;
    case 'available': return entry.backups?.ours ? hardwareLine(entry) : `${hardwareLine(entry)} · ${entry.reason || 'not opened yet'}`;
    default: return backupsKnown && entry.backups?.otherServers.length ? `${hardwareLine(entry)} · also holds backups another server made` : hardwareLine(entry);
  }
}

export function freeLine(entry: StorageEntry) {
  if (entry.kind === 'bucket') return 'No size limit';
  if (entry.kind === 'system' && entry.availableBytes !== null) return `${formatBytes(entry.availableBytes)} free for apps`;
  if (entry.availableBytes !== null) return `${formatBytes(entry.availableBytes)} free`;
  return entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : '';
}

// Why Browse files is not offered for a drive right now, or '' when it is.
export function browseReason(entry: StorageEntry) {
  if (entry.capabilities.browsable) return '';
  switch (entry.state) {
    case 'away': return 'Plug the drive in to browse its files.';
    case 'ejected': return entry.connected ? 'Use the drive again to browse its files.' : 'Plug the drive back in to browse its files.';
    default: return entry.reason || 'MOS could not open this drive.';
  }
}

export type PickerContext = 'apps' | 'backups';
export type PickerOffer = { entry: StorageEntry; facts: string; selectable: boolean; warning: string };

function spaceFact(entry: StorageEntry) {
  return entry.availableBytes !== null ? `${formatBytes(entry.availableBytes)} free` : entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : '';
}

export function kindFact(entry: StorageEntry) {
  if (entry.kind === 'bucket') return 'Storage online';
  return entry.transport === 'usb' || entry.transport === 'removable' ? 'USB drive' : 'Drive';
}

// Why something that could hold this cannot be picked right now, or ''.
function stateFact(entry: StorageEntry) {
  if (entry.state === 'read-only' || (entry.state === 'failed' && entry.capabilities.checkable)) return 'Needs a check first — check it in Storage, then pick it here';
  if (entry.state === 'failed') return entry.reason || 'MOS could not open this drive.';
  if (entry.state === 'ejected') return entry.connected ? 'Ejected — use it again in Storage, then pick it here' : 'Ejected — plug it back in first';
  if (entry.state === 'away') return 'Not connected — plug it in first';
  if (entry.state === 'unreachable') return 'Cannot connect — look at it in Storage';
  return '';
}

// The honesty line for storage that cannot hold this kind of thing.
function incapableFact(entry: StorageEntry) {
  return entry.kind === 'bucket' ? 'Can\'t hold app files yet — drives do that today' : 'Formatted for Linux — app files need a drive formatted as exFAT, NTFS or FAT32';
}

// Every entry a picker shows, in its order: what can be chosen first, then what
// can hold this one day or after a fix, with the reason it cannot now.
export function pickerOffers(storage: StorageEntry[], context: PickerContext, { backupsKnown, exclude = [], names }: RowFacts & { exclude?: string[] }): PickerOffer[] {
  const holds = (entry: StorageEntry) => (context === 'apps' ? entry.capabilities.holdsAppFolders : entry.capabilities.holdsBackups);
  const offered = storage.filter((entry) => entry.kind !== 'system' && !exclude.includes(entry.id) && !unusableFormat(entry)
    && (holds(entry) || entry.kind === 'bucket' || (context === 'apps' && entry.capabilities.holdsBackups && entry.connected)));
  const offers = offered.map((entry) => {
    const blocked = holds(entry) ? stateFact(entry) : incapableFact(entry);
    const selectable = holds(entry) && !blocked;
    const apps = appNamesFor(entry, names);
    const alsoBackups = backupsKnown && entry.backups?.ours ? context === 'apps' ? 'also holds your backups' : 'holds your backups' : '';
    const stored = entry.kind === 'bucket' && backupsKnown && entry.backups?.storedBytes ? `about ${formatBytes(entry.backups.storedBytes)} stored` : '';
    const facts = blocked || [kindFact(entry), entry.kind === 'bucket' ? stored : spaceFact(entry), alsoBackups].filter(Boolean).join(' · ');
    // A library's backup on the drive the library lives on fails with it.
    const warning = context === 'backups' && selectable && apps.length
      ? `Your ${joinNames(apps)} files live here — a backup on the same drive won't survive the drive failing`
      : '';
    return { entry, facts, selectable, warning };
  });
  return [...offers.filter((offer) => offer.selectable), ...offers.filter((offer) => !offer.selectable)];
}

// The drive an app's folders are on while it is not simply working, which pauses
// the app. The one answer for the card and the detail.
export function pausedByDrive(appId: string, storage: StorageEntry[] | null) {
  return storage?.find((entry) => entry.apps.includes(appId) && (entry.state === 'ejected' || entry.state === 'away' || entry.state === 'failed')) || null;
}

export type AppDriveNotice = { body: string; linkLabel: string; title: string; variant: 'info' | 'warning' };

// What an app's own page says when its drive is not simply working, or null. The
// link goes to Settings → Storage; the view renders it after the body.
export function appDriveNotice(appName: string, entry: StorageEntry | undefined, folders: string): AppDriveNotice | null {
  if (!entry || entry.state === 'ready') return null;
  const drive = entry.name;
  switch (entry.state) {
    case 'read-only': return { body: `${appName} can show what is in ${folders}, but nothing can be saved there until ${drive} is checked.`, linkLabel: 'Check it in Settings → Storage', title: `${appName} can read its ${drive} but not save to it`, variant: 'warning' };
    case 'away': return { body: `${appName} cannot show your ${folders} until ${drive} is plugged back in.`, linkLabel: 'See it in Settings → Storage', title: `${appName}'s ${drive} is not connected`, variant: 'warning' };
    case 'ejected': return { body: `Plug the drive back in and ${appName} returns on its own. Or use the drive again without touching the cable.`, linkLabel: 'Use it again in Settings → Storage', title: `${appName} is paused — its ${drive} was ejected`, variant: 'info' };
    default: return { body: `${appName} cannot show your ${folders}. ${stateSentence(entry)}`, linkLabel: 'See it in Settings → Storage', title: `${appName}'s ${drive} could not be opened`, variant: 'warning' };
  }
}

type Snapshot = { error: string; inventory: StorageInventory | null; names: AppNames };
type Listener = () => void;

const EMPTY: Snapshot = { error: '', inventory: null, names: new Map() };
const NOTHING_LISTED: StorageInventory = { appNames: {}, backupsKnown: false, installerSticks: [], storage: [] };

// One inventory for every screen: one event stream, one idle timer, one job
// timer, running only while something on the page reads it.
const store = {
  changeListeners: new Set<Listener>(),
  events: null as EventSource | null,
  idleTimer: 0,
  jobTimer: 0,
  listeners: new Set<Listener>(),
  snapshot: EMPTY,
  ticket: 0,
};

function anyJobRunning(inventory: StorageInventory | null) {
  return Boolean(inventory && [...inventory.storage, ...inventory.installerSticks].some((item) => item.job?.status === 'running'));
}

// Every two seconds while a check, eject, "use it again" or format runs, which
// is how they report back.
function watchJobs() {
  const running = store.listeners.size > 0 && anyJobRunning(store.snapshot.inventory);
  if (running && !store.jobTimer) store.jobTimer = window.setInterval(() => void reloadStorage(), 2_000);
  if (!running && store.jobTimer) {
    window.clearInterval(store.jobTimer);
    store.jobTimer = 0;
  }
}

function publish(next: Partial<Snapshot>) {
  store.snapshot = { ...store.snapshot, ...next };
  for (const listener of store.listeners) listener();
  watchJobs();
}

// A slow answer never overwrites a newer one.
export async function reloadStorage() {
  store.ticket += 1;
  const ticket = store.ticket;
  try {
    const listed = await fetch('/suite-manager/api/storage').then((response) => jsonResponse<StorageInventory>(response, 'Unable to list your storage.'));
    if (ticket === store.ticket) publish({ error: '', inventory: listed, names: new Map(Object.entries(listed.appNames || {})) });
    return listed;
  } catch (caught) {
    if (ticket === store.ticket) publish({ error: caught instanceof Error ? caught.message : 'Unable to list your storage.', inventory: store.snapshot.inventory || NOTHING_LISTED });
    return null;
  }
}

// Told by the server when a drive is plugged, pulled or changed, so no page shows
// a state that is no longer true. EventSource reconnects by itself.
function openStream() {
  if (store.events || typeof EventSource === 'undefined') return;
  store.events = new EventSource('/suite-manager/api/storage/events');
  store.events.addEventListener('changed', () => {
    for (const listener of store.changeListeners) listener();
    if (store.listeners.size) void reloadStorage();
  });
}

// Starts and stops what the current subscribers need.
function settle() {
  if (store.listeners.size || store.changeListeners.size) openStream();
  else {
    store.events?.close();
    store.events = null;
  }
  if (store.listeners.size && !store.idleTimer) {
    void reloadStorage();
    store.idleTimer = window.setInterval(() => {
      if (!document.hidden) void reloadStorage();
    }, 60_000);
  }
  if (!store.listeners.size && store.idleTimer) {
    window.clearInterval(store.idleTimer);
    store.idleTimer = 0;
  }
  watchJobs();
}

function subscribe(listener: Listener) {
  store.listeners.add(listener);
  settle();
  return () => {
    store.listeners.delete(listener);
    settle();
  };
}

function subscribeChanges(listener: Listener) {
  store.changeListeners.add(listener);
  settle();
  return () => {
    store.changeListeners.delete(listener);
    settle();
  };
}

const snapshot = () => store.snapshot;
const unsubscribed = () => () => undefined;
const nothing = () => EMPTY;

export async function actOnDrive(driveId: string, action: DriveAction) {
  const started = await fetch(`/suite-manager/api/storage/drives/${encodeURIComponent(driveId)}/${action}`, { method: 'POST' })
    .then((response) => jsonResponse<{ job: AppJob<DriveStep> }>(response, action === 'check' ? 'The drive could not be checked.' : action === 'eject' ? 'The drive could not be ejected.' : 'The drive could not be opened again.'));
  await reloadStorage();
  return started.job;
}

export async function formatInstallerStick(devicePath: string) {
  const started = await postJson<{ job: AppJob<DriveStep> }>('/suite-manager/api/storage/installer-stick/format', { confirmed: true, devicePath }, 'MOS could not format the stick.');
  await reloadStorage();
  return started.job;
}

export function useStorage(enabled = true) {
  const { error, inventory, names } = useSyncExternalStore(enabled ? subscribe : unsubscribed, enabled ? snapshot : nothing);
  return { act: actOnDrive, error, inventory, names, reload: reloadStorage, storage: inventory?.storage || null };
}

// For a screen that keeps its own reading of storage and re-reads it when the
// server says something changed.
export function useStorageChanges(onChanged: () => void) {
  const latest = useRef(onChanged);
  useEffect(() => {
    latest.current = onChanged;
  }, [onChanged]);
  useEffect(() => subscribeChanges(() => latest.current()), []);
}

export function useStorageUsage(key: string) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  useEffect(() => {
    let stale = false;
    void fetch('/suite-manager/api/storage/usage')
      .then((response) => jsonResponse<StorageUsage>(response, 'Unable to read what is on your drives.'))
      .then((read) => { if (!stale) setUsage(read); }, () => { if (!stale) setUsage(null); });
    return () => { stale = true; };
  }, [key]);
  return usage;
}
