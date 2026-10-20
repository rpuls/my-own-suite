// One wording for storage, so Settings, the pickers, the start page and an app's
// page agree. Consumers choose by what an entry can do, never by its kind.

import { useCallback, useEffect, useState } from 'react';

import type { IconName } from '../../components/ui';
import { jsonResponse } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import type { AppJob, DriveStep } from '../apps/types';

export type StorageState = 'available' | 'away' | 'ejected' | 'failed' | 'read-only' | 'ready' | 'unreachable';
export type DriveAction = 'check' | 'eject' | 'use';

export type StorageBackups = {
  // This server backs up here.
  destination: boolean;
  lastBackupAt: string | null;
  // Archives other servers made here, which this server reads and never writes.
  otherServers: Array<{ id: string; keyState: 'borrowed' | 'locked'; writtenBy: { hostname: string | null } | null }>;
  primary: boolean;
  ready: boolean;
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
  kind: 'bucket' | 'drive' | 'system';
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

export type InstallerStick = { devicePath: string; model: string | null; sizeBytes: number | null };
export type StorageInventory = { backupsKnown: boolean; installerSticks: InstallerStick[]; storage: StorageEntry[] };
export type StorageUsage = {
  backups: Array<{ bytes: number; driveId: string }>;
  folders: Array<{ app: string; appName: string; bytes: number; driveId: string; installed: boolean; name: string }>;
};

export type BucketDraft = { accessKeyId: string; bucket: string; endpoint: string; folder: string; id?: string; label: string; region: string; secretAccessKey: string };
export const EMPTY_BUCKET_DRAFT: BucketDraft = { accessKeyId: '', bucket: '', endpoint: '', folder: '', label: '', region: '', secretAccessKey: '' };
export type ConnectionTest = { locked?: boolean; message: string; ok: boolean } | null;

export const WINDOWS_CHECK_STEPS = 'Plug it into a Windows computer, open the drive\'s Properties, choose Tools and then Check, and eject it before plugging it back in here.';

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

export function isAttention(entry: StorageEntry) {
  return entry.state === 'read-only' || entry.state === 'failed' || entry.state === 'unreachable';
}

export function stateLabel(entry: StorageEntry) {
  switch (entry.state) {
    case 'read-only': return 'Needs a check';
    case 'failed': return 'Could not be opened';
    case 'away': return 'Not connected';
    case 'ejected': return entry.connected ? 'Safe to unplug' : 'Ejected';
    case 'unreachable': return 'Cannot be reached';
    case 'available': return '';
    default: return entry.kind === 'bucket' ? 'Cloud storage' : 'Working';
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

function appNamesFor(entry: StorageEntry, names: Map<string, string>) {
  return entry.apps.map((app) => names.get(app) || app);
}

export function joinNames(list: string[]) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || '';
}

// The one line under a row's name in Settings → Storage.
export function rowLine(entry: StorageEntry, names: Map<string, string>) {
  if (entry.kind === 'system') return `${entry.diskSizeBytes ? `${formatBytes(entry.diskSizeBytes)} · ` : ''}the drive MOS and your apps run from`;
  if (entry.kind === 'bucket') {
    if (entry.state === 'unreachable') return 'MOS could not reach this storage. Check the internet connection, then look again.';
    if (entry.backups?.otherServers.length && !entry.backups.destination) return 'Holds backups another server made';
    if (!entry.backups?.destination) return 'Connected · not holding anything yet';
    return entry.backups.storedBytes ? `Holds your backups · about ${formatBytes(entry.backups.storedBytes)} stored` : 'Holds your backups · none yet';
  }
  if (entry.backups?.otherServers.length && entry.state === 'ready') return `${hardwareLine(entry)} · also holds backups another server made`;
  const apps = appNamesFor(entry, names);
  switch (entry.state) {
    case 'read-only': return 'Apps can read it; nothing can save to it until it is checked';
    case 'failed': return entry.reason || 'MOS could not open this drive.';
    case 'away': return entry.backups?.destination && !apps.length
      ? 'Not connected — backups wait and catch up when it returns'
      : `Not connected — ${apps.length ? joinNames(apps) : 'its apps'} get their files back when it returns`;
    case 'ejected': return entry.connected
      ? `Safe to unplug — ${apps.length ? `${joinNames(apps)} ${apps.length > 1 ? 'are' : 'is'} paused` : 'nothing is using it'} until it is back`
      : 'Ejected — plug it back in to use it again';
    case 'available': return entry.backups?.destination ? hardwareLine(entry) : `${hardwareLine(entry)} · nothing kept on it yet`;
    default: return hardwareLine(entry);
  }
}

export function freeLine(entry: StorageEntry) {
  if (entry.kind === 'bucket') return 'No size limit';
  if (entry.kind === 'system' && entry.availableBytes !== null) return `${formatBytes(entry.availableBytes)} free for apps`;
  if (entry.availableBytes !== null) return `${formatBytes(entry.availableBytes)} free`;
  return entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : '';
}

export type PickerContext = 'apps' | 'backups';
export type PickerOffer = { entry: StorageEntry; facts: string; selectable: boolean; warning: string };

function spaceFact(entry: StorageEntry) {
  return entry.availableBytes !== null ? `${formatBytes(entry.availableBytes)} free` : entry.sizeBytes !== null ? formatBytes(entry.sizeBytes) : '';
}

function kindFact(entry: StorageEntry) {
  if (entry.kind === 'bucket') return 'Cloud storage';
  return entry.transport === 'usb' || entry.transport === 'removable' ? 'USB drive' : 'Drive';
}

// Why something that could hold this cannot be picked right now, or ''.
function stateFact(entry: StorageEntry) {
  if (entry.state === 'read-only' || (entry.state === 'failed' && entry.capabilities.checkable)) return 'Needs a check first — check it in Storage, then pick it here';
  if (entry.state === 'failed') return entry.reason || 'MOS could not open this drive.';
  if (entry.state === 'ejected') return entry.connected ? 'Ejected — use it again in Storage, then pick it here' : 'Ejected — plug it back in first';
  if (entry.state === 'away') return 'Not connected — plug it in first';
  if (entry.state === 'unreachable') return 'MOS could not reach it — look at it in Storage';
  return '';
}

// The honesty line for storage that cannot hold this kind of thing.
function incapableFact(entry: StorageEntry) {
  return entry.kind === 'bucket' ? 'Can\'t hold app files yet — drives do that today' : 'Formatted for Linux — app files need a drive formatted as exFAT, NTFS or FAT32';
}

// Every entry a picker shows, in its order: what can be chosen first, then what
// can hold this one day or after a fix, with the reason it cannot now.
export function pickerOffers(storage: StorageEntry[], context: PickerContext, names: Map<string, string>, exclude: string[] = []): PickerOffer[] {
  const holds = (entry: StorageEntry) => (context === 'apps' ? entry.capabilities.holdsAppFolders : entry.capabilities.holdsBackups);
  const offered = storage.filter((entry) => entry.kind !== 'system' && !exclude.includes(entry.id) && !unusableFormat(entry)
    && (holds(entry) || entry.kind === 'bucket' || (context === 'apps' && entry.capabilities.holdsBackups && entry.connected)));
  const offers = offered.map((entry) => {
    const blocked = holds(entry) ? stateFact(entry) : incapableFact(entry);
    const selectable = holds(entry) && !blocked;
    const apps = appNamesFor(entry, names);
    const alsoBackups = context === 'apps' && entry.backups?.destination ? 'also holds your backups' : '';
    const stored = entry.kind === 'bucket' && entry.backups?.storedBytes ? `about ${formatBytes(entry.backups.storedBytes)} stored` : '';
    const facts = blocked || [kindFact(entry), entry.kind === 'bucket' ? stored : spaceFact(entry), alsoBackups].filter(Boolean).join(' · ');
    // A library's backup on the drive the library lives on fails with it.
    const warning = context === 'backups' && selectable && apps.length
      ? `Your ${joinNames(apps)} files live here — a backup on the same drive won't survive the drive failing`
      : '';
    return { entry, facts, selectable, warning };
  });
  return [...offers.filter((offer) => offer.selectable), ...offers.filter((offer) => !offer.selectable)];
}

// What an app's own page says when its drive is not simply working, or null.
export function appDriveNotice(appName: string, entry: StorageEntry | undefined, folders: string) {
  if (!entry || entry.state === 'ready') return null;
  const drive = entry.name;
  switch (entry.state) {
    case 'read-only': return { body: `${appName} can show what is in ${folders}, but nothing can be saved there until ${drive} is checked. Check it in`, title: `${appName} can read its ${drive} but not save to it`, variant: 'warning' as const };
    case 'away': return { body: `${appName} cannot show your ${folders} until ${drive} is plugged back in. See it in`, title: `${appName}'s ${drive} is not connected`, variant: 'warning' as const };
    case 'ejected': return { body: `Plug the drive back in and ${appName} returns on its own — or bring the drive back in`, title: `${appName} is paused — its ${drive} was ejected`, variant: 'info' as const };
    default: return { body: `${appName} cannot show your ${folders}. ${entry.reason || 'MOS could not open this drive.'} See it in`, title: `${appName}'s ${drive} could not be opened`, variant: 'warning' as const };
  }
}

// Read again every minute, so a plug or unplug shows without a refresh, and every two
// seconds while a check, eject or "use it again" runs, which is how they report back.
export function useStorage(enabled = true) {
  const [inventory, setInventory] = useState<StorageInventory | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const listed = await fetch('/suite-manager/api/storage').then((response) => jsonResponse<StorageInventory>(response, 'Unable to list your storage.'));
      setInventory(listed);
      setError('');
      return listed;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to list your storage.');
      setInventory((current) => current || { backupsKnown: false, installerSticks: [], storage: [] });
      return null;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    void reload();
    const timer = window.setInterval(() => {
      if (!document.hidden) void reload();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [enabled, reload]);

  // Told by the server when a drive is plugged, pulled or changed, so the page
  // never shows a state that is no longer true. EventSource reconnects by itself.
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return undefined;
    const events = new EventSource('/suite-manager/api/storage/events');
    events.addEventListener('changed', () => void reload());
    return () => events.close();
  }, [enabled, reload]);

  const working = Boolean(inventory?.storage.some((entry) => entry.job?.status === 'running'));
  useEffect(() => {
    if (!working) return undefined;
    const timer = window.setInterval(() => void reload(), 2_000);
    return () => window.clearInterval(timer);
  }, [reload, working]);

  const act = useCallback(async (driveId: string, action: DriveAction) => {
    const started = await fetch(`/suite-manager/api/storage/drives/${encodeURIComponent(driveId)}/${action}`, { method: 'POST' })
      .then((response) => jsonResponse<{ job: AppJob<DriveStep> }>(response, action === 'check' ? 'The drive could not be checked.' : action === 'eject' ? 'The drive could not be ejected.' : 'The drive could not be opened again.'));
    await reload();
    return started.job;
  }, [reload]);

  return { act, error, inventory, reload, storage: inventory?.storage || null };
}

export function useStorageUsage(key: string) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  useEffect(() => {
    void fetch('/suite-manager/api/storage/usage')
      .then((response) => jsonResponse<StorageUsage>(response, 'Unable to read what is on your drives.'))
      .then(setUsage, () => setUsage(null));
  }, [key]);
  return usage;
}

export function useAppNames() {
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    void fetch('/suite-manager/api/apps/packages')
      .then((response) => jsonResponse<{ packages: Array<{ id: string; name: string }> }>(response, 'Unable to list apps.'))
      .then((listed) => setNames(new Map(listed.packages.map((app) => [app.id, app.name]))), () => undefined);
  }, []);
  return names;
}

export const STORAGE_SETTINGS_PATH = '/suite-manager/settings#set-storage';

// Moves to Settings → Storage inside Suite Manager, the way the shell's own
// navigation does, from screens that are not handed the shell's navigate.
export function openStorageSettings(event: { preventDefault: () => void }) {
  event.preventDefault();
  window.history.pushState({}, '', STORAGE_SETTINGS_PATH);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
