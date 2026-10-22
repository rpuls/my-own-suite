import { useCallback, useEffect, useRef, useState } from 'react';

import { useStorage } from '../storage/model';
import { filesLocation, listFiles, openFiles, type FilesListing } from './model';

function useLocation() {
  const [location, setLocation] = useState(() => filesLocation() || { driveId: '', path: '' });
  useEffect(() => {
    const update = () => { const next = filesLocation(); if (next) setLocation(next); };
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return location;
}

// The drive and folder the address names, the drive as storage knows it, and the
// folder's listing, re-read whenever the drive's state or the address changes.
export function useFilesListing() {
  const { driveId, path } = useLocation();
  const { error: storageError, storage } = useStorage();
  const entry = storage?.find((item) => item.id === driveId) || null;
  const browsable = Boolean(entry?.capabilities.browsable);
  const writable = Boolean(entry?.capabilities.writable);
  const [listing, setListing] = useState<FilesListing | null>(null);
  const [error, setError] = useState('');
  const shown = useRef(path);

  const reload = useCallback(async () => {
    if (!driveId || !browsable) return;
    try {
      const listed = await listFiles(driveId, path);
      if (!listed) {
        openFiles(driveId, path.split('/').slice(0, -1).join('/'), { replace: true });
        return;
      }
      if (listed.path !== shown.current) return;
      setListing(listed);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The files on this drive could not be listed.');
    }
  }, [browsable, driveId, path]);

  useEffect(() => {
    shown.current = path;
    setListing((current) => (current?.path === path ? current : null));
  }, [path]);
  useEffect(() => { void reload(); }, [reload, entry?.state]);

  const segments = listing?.segments || (path ? path.split('/') : []);
  const driveName = listing?.drive.name || entry?.name || 'Drive';
  return {
    browsable,
    driveId,
    driveName,
    entry,
    error,
    folderName: segments.at(-1) || listing?.drive.name || entry?.name || 'this drive',
    listing,
    path,
    reload,
    segments,
    shown,
    storage,
    storageError,
    writable,
  };
}
