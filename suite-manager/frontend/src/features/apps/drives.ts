// One wording for a drive, so Settings, the start page and an app's page agree.

import { useCallback, useEffect, useState } from 'react';

import { jsonResponse } from '../../lib/api';
import { formatBytes } from '../../lib/bytes';
import type { StorageDrive } from './types';

export type DriveAction = 'check' | 'eject';

// Drives MOS keeps something on. Any other drive is only a choice in a picker.
export function keptDrives(drives: StorageDrive[], folderDrives: string[] = []) {
  return drives.filter((drive) => drive.state !== 'available' || drive.apps.length || folderDrives.includes(drive.id));
}

export function driveStateLabel(drive: StorageDrive) {
  switch (drive.state) {
    case 'read-only': return 'Needs a check';
    case 'failed': return 'Could not be opened';
    case 'away': return 'Not connected';
    case 'ejected': return drive.connected ? 'Safe to unplug' : 'Ejected';
    default: return 'Working';
  }
}

// Warnings are the states where an app is reading less than it should; the rest are facts.
export function driveNeedsAttention(drive: StorageDrive) {
  return drive.state === 'read-only' || drive.state === 'failed';
}

export function driveStateLine(drive: StorageDrive) {
  switch (drive.state) {
    case 'read-only': return 'Your apps can read this drive, but nothing can be saved to it until it is checked. It was unplugged or lost power without being ejected.';
    case 'failed': return drive.reason || 'MOS could not open this drive.';
    case 'away': return 'Plug it back in and its apps get their files back.';
    case 'ejected': return drive.connected ? 'Its apps are paused until you plug it back in.' : 'Plug it back in and its apps start again.';
    default: {
      const space = drive.availableBytes !== null && drive.sizeBytes !== null
        ? `${formatBytes(drive.availableBytes)} free of ${formatBytes(drive.sizeBytes)}`
        : drive.sizeBytes !== null ? formatBytes(drive.sizeBytes) : '';
      return [space, drive.holdsBackups ? 'also holds your backups' : ''].filter(Boolean).join(' · ');
    }
  }
}

// Check drive is ntfsfix's quick repair, so it is offered only where it can help.
export function canCheck(drive: StorageDrive) {
  return drive.connected && drive.fileSystem === 'ntfs' && (drive.state === 'read-only' || drive.state === 'failed');
}

export function canEject(drive: StorageDrive) {
  return drive.connected && (drive.state === 'ready' || drive.state === 'read-only');
}

// What an app's own page says when its drive is not simply working, or null.
export function appDriveNotice(appName: string, drive: StorageDrive | undefined, folders: string) {
  if (!drive || drive.state === 'ready') return null;
  switch (drive.state) {
    case 'read-only': return { body: `${appName} can show what is in ${folders}, but nothing can be saved there until ${drive.label} is checked. Check it in Settings, under Storage drives.`, title: `${appName} can read its drive but not save to it`, variant: 'warning' as const };
    case 'away': return { body: `${appName} cannot show your ${folders} until you plug ${drive.label} back in.`, title: `${appName}'s drive is not connected`, variant: 'warning' as const };
    case 'ejected': return { body: `${appName} is paused until you plug ${drive.label} back in.`, title: `${drive.label} was ejected`, variant: 'info' as const };
    default: return { body: `${appName} cannot show your ${folders}. ${driveStateLine(drive)}`, title: `${appName}'s drive could not be opened`, variant: 'warning' as const };
  }
}

// Read again every minute, as the Apps screen is, so a plug or unplug shows without a
// refresh, and every two seconds while a check or eject runs, which is how it reports back.
export function useStorageDrives(enabled = true) {
  const [drives, setDrives] = useState<StorageDrive[] | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const listed = await fetch('/suite-manager/api/apps/storage/drives').then((response) => jsonResponse<{ drives: StorageDrive[] }>(response, 'Unable to list your drives.'));
      setDrives(listed.drives);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to list your drives.');
      setDrives((current) => current || []);
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

  const working = Boolean(drives?.some((drive) => drive.job?.status === 'running'));
  useEffect(() => {
    if (!working) return undefined;
    const timer = window.setInterval(() => void reload(), 2_000);
    return () => window.clearInterval(timer);
  }, [reload, working]);

  const act = useCallback(async (driveId: string, action: DriveAction) => {
    await fetch(`/suite-manager/api/apps/storage/drives/${encodeURIComponent(driveId)}/${action}`, { method: 'POST' })
      .then((response) => jsonResponse(response, action === 'check' ? 'The drive could not be checked.' : 'The drive could not be ejected.'));
    await reload();
  }, [reload]);

  return { act, drives, error, reload };
}
