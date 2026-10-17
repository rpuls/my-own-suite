// An app that needs a drive opens on the first one plugged in; one that can do
// without opens on "no drive", so a backup drive never becomes a photo folder by accident.

import { useEffect, useState } from 'react';

import { Row, RowSelect } from '../../components/ui';
import { jsonResponse } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import type { AppStorage, StorageDrive } from './types';

function driveOption(drive: StorageDrive) {
  const space = drive.availableBytes !== null ? `${formatBytes(drive.availableBytes)} free` : drive.sizeBytes !== null ? formatBytes(drive.sizeBytes) : '';
  return [drive.label, space, drive.holdsBackups ? 'also holds your backups' : ''].filter(Boolean).join(' · ');
}

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

// The drives the server has, and the one picked. Null drives means still asking.
export function useDriveChoice(storage: AppStorage | null, enabled: boolean) {
  const [drives, setDrives] = useState<StorageDrive[] | null>(null);
  const [drive, setDrive] = useState('');
  const required = storage?.required === true;

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    void fetch('/suite-manager/api/apps/storage/drives')
      .then((response) => jsonResponse<{ drives: StorageDrive[] }>(response, 'Unable to list drives.'))
      .then(({ drives: listed }) => {
        if (!current) return;
        setDrives(listed);
        if (required) setDrive(listed.find((item) => item.usable)?.id || '');
      })
      .catch(() => { if (current) setDrives([]); });
    return () => { current = false; };
  }, [enabled, required]);

  return { drive, drives, missing: enabled && required && !drive, setDrive };
}

export function DriveChoice({ appName, busy, drive, drives, onChange, storage }: {
  appName: string;
  busy: boolean;
  drive: string;
  drives: StorageDrive[] | null;
  onChange: (drive: string) => void;
  storage: AppStorage;
}) {
  const usable = (drives || []).filter((item) => item.usable);
  const folders = folderList(storage.folders);
  const several = storage.folders.length > 1;
  return <Row
    help={drive
      ? `MOS makes ${several ? `${folders} folders` : `a ${folders} folder`} for ${appName} on this drive. Fill ${several ? 'them' : 'it'} from any computer. Files on the drive are not backed up.`
      : storage.description || `${appName} works without a drive. Pick one to also show what is in a ${folders} folder on it.`}
    label={driveChoiceLabel(storage)}
    layout="stacked"
  >
    <RowSelect
      aria-label={driveChoiceLabel(storage)}
      disabled={busy || drives === null}
      onChange={(event) => onChange(event.currentTarget.value)}
      state={storage.required ? (drive ? 'filled' : 'missing') : undefined}
      value={drive}
    >
      {drives === null ? <option value="">Looking for drives...</option> : null}
      {!storage.required && drives !== null ? <option value="">No drive</option> : null}
      {usable.map((item) => <option key={item.id} value={item.id}>{driveOption(item)}</option>)}
    </RowSelect>
  </Row>;
}
