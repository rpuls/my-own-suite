// An app that needs a drive opens on the first one that can take its folders; one
// that can do without opens on "no drive", so a backup drive never becomes a photo
// folder by accident.

import { useEffect, useState } from 'react';

import { AddStorageDialog } from '../storage/AddStorageDialog';
import { pickerOffers, useAppNames, useStorage, type StorageEntry } from '../storage/model';
import { StoragePicker } from '../storage/StoragePicker';
import type { AppStorage } from './types';

export function driveChoiceLabel(storage: AppStorage) {
  return storage.label || 'Drive for its files';
}

// What one service reads from a drive, for the app page's list of services.
export function driveFoldersLine(storage: AppStorage, serviceId: string) {
  const folders = storage.folders.filter((folder) => folder.service === serviceId);
  const several = folders.length > 1;
  const named = several ? `${folderList(folders)} folders` : `a ${folderList(folders)} folder`;
  return `${storage.required ? 'Reads' : 'Can read'} ${named} on a drive you pick, without changing ${several ? 'them' : 'it'}. ${several ? 'They are' : 'It is'} not backed up.`;
}

export function folderList(folders: Array<{ name: string }>) {
  const names = folders.map((folder) => folder.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '';
}

// The storage the server has, and the drive picked. Null storage means still asking.
export function useDriveChoice(storage: AppStorage | null, enabled: boolean) {
  const { reload, storage: entries } = useStorage(enabled);
  const names = useAppNames();
  const [drive, setDrive] = useState('');
  const [chosen, setChosen] = useState(false);
  const required = storage?.required === true;

  useEffect(() => {
    if (!entries || chosen || !required) return;
    setDrive(pickerOffers(entries, 'apps', names).find((offer) => offer.selectable)?.entry.id || '');
  }, [chosen, entries, names, required]);

  return {
    drive,
    entries,
    missing: enabled && required && !drive,
    names,
    reload,
    setDrive: (next: string) => { setChosen(true); setDrive(next); },
  };
}

export function DriveChoice({ appName, busy, drive, entries, names, onChange, onReload, storage }: {
  appName: string;
  busy: boolean;
  drive: string;
  entries: StorageEntry[] | null;
  names: Map<string, string>;
  onChange: (drive: string) => void;
  onReload: () => Promise<unknown>;
  storage: AppStorage;
}) {
  const [adding, setAdding] = useState(false);
  const folders = folderList(storage.folders);
  const several = storage.folders.length > 1;
  return <>
    <StoragePicker
      addHint="Plug in a drive, or connect cloud storage"
      busy={busy}
      context="apps"
      empty={storage.required ? <>
        <strong>No storage yet</strong>
        <p className="suite-meta">{appName} needs a drive for its files. Plug one into the server and it appears here.</p>
      </> : null}
      label={driveChoiceLabel(storage)}
      names={names}
      none={storage.required ? null : { facts: storage.description || `${appName} works without a drive. Pick one to also show what is in a ${folders} folder on it.`, label: 'No drive' }}
      onAdd={() => setAdding(true)}
      onChange={onChange}
      question={`Where should ${appName} keep its files?`}
      storage={entries}
      value={drive}
    >
      <p className="suite-meta">{appName} makes {several ? `a ${storage.folders.map((folder) => folder.name).join(' and a ')} folder` : `a ${folders} folder`} there. You fill {several ? 'them' : 'it'} from any computer. Files on the drive are not part of MOS backups.</p>
    </StoragePicker>
    {adding ? <AddStorageDialog onClose={() => { setAdding(false); void onReload(); }} onConnected={() => { setAdding(false); void onReload(); }} /> : null}
  </>;
}
