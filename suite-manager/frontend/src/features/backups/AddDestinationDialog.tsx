import { useState } from 'react';

import { Checkbox, Dialog, Notice, Spinner } from '../../components/ui';
import { postJson } from '../../lib/api';
import { AddStorageDialog } from '../storage/AddStorageDialog';
import { useAppNames, useStorage } from '../storage/model';
import { StoragePicker } from '../storage/StoragePicker';
import { EraseBackupsDialog } from './dialogs';
import { whenWords, type ForeignStore } from './model';

// Making storage a backup destination. The storage itself is set up in Settings →
// Storage, or from the picker's last row, which opens the same dialog right here:
// on a fresh server that is the way to the bucket holding the backups to restore.
export function AddDestinationDialog({ firstDestination, onAdded, onClose, onUnlock, startOnline = false }: {
  firstDestination: boolean;
  onAdded: () => void;
  onClose: () => void;
  onUnlock: (destinationId: string) => void;
  startOnline?: boolean;
}) {
  const { reload, storage } = useStorage();
  const names = useAppNames();
  const [picked, setPicked] = useState('');
  const [adding, setAdding] = useState(startOnline);
  const [primary, setPrimary] = useState(firstDestination);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // What is on a drive is only known once MOS has opened it, so another server's
  // backups are found here, after the pick, and the owner decides what happens.
  const [foreign, setForeign] = useState<ForeignStore | null>(null);
  const [erasing, setErasing] = useState(false);
  const already = (storage || []).filter((entry) => entry.backups?.destination).map((entry) => entry.id);

  async function add() {
    setBusy(true);
    setError('');
    try {
      const added = await postJson<{ foreignStore: ForeignStore | null }>('/suite-manager/api/backups/destinations/add', { primary, storageId: picked }, 'MOS could not make this a backup destination.');
      if (added.foreignStore) { setForeign(added.foreignStore); setBusy(false); return; }
      onAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not make this a backup destination.');
      setBusy(false);
    }
  }

  if (foreign && erasing) return <EraseBackupsDialog onClose={() => setErasing(false)} onErased={onAdded} primary={primary} store={foreign} />;

  if (foreign) {
    const points = `${foreign.restorePoints} restore point${foreign.restorePoints === 1 ? '' : 's'}`;
    return <Dialog
      footer={<>
        <button className="mos-btn mos-btn-secondary" onClick={onAdded} type="button">Keep them</button>
        <button className="mos-btn mos-btn-secondary" onClick={() => onUnlock(foreign.destinationId)} type="button">Enter its recovery key</button>
        <button className="mos-btn mos-btn-primary" onClick={() => setErasing(true)} type="button">Erase them…</button>
      </>}
      onClose={onAdded}
      title={`${foreign.label} holds another server's backups`}
    >
      <p>{points} on {foreign.label} were made by {foreign.from || 'another server'}{foreign.newestAt ? `, the newest ${whenWords(foreign.newestAt).toLowerCase()}` : ''}. This server cannot add its own backups to them.</p>
      <p className="suite-meta">To restore from them, enter that server&rsquo;s recovery key. To use the drive for this server&rsquo;s backups, erase them. Keeping them leaves the drive listed under &ldquo;Brought in from other servers&rdquo;, and you can decide later.</p>
    </Dialog>;
  }

  if (adding) {
    return <AddStorageDialog
      initialStep={startOnline ? 'online' : 'choose'}
      onClose={() => { setAdding(false); void reload(); if (startOnline) onClose(); }}
      onConnected={(storageId) => { setAdding(false); void reload().then(() => setPicked(storageId)); }}
    />;
  }

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" disabled={busy || !picked} onClick={() => void add()} type="button">{busy ? <><Spinner />Opening it</> : 'Use for backups'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title="Add a backup destination"
  >
    <StoragePicker
      addHint="Set up a drive or cloud storage"
      busy={busy}
      context="backups"
      empty={<><strong>No storage yet</strong><p className="suite-meta">Plug a drive into the server, or connect storage you rent online, and it appears here.</p></>}
      exclude={already}
      label="Where backups go"
      names={names}
      onAdd={() => setAdding(true)}
      onChange={setPicked}
      question="Where should backups go?"
      storage={storage}
      value={picked}
    >
      <p className="suite-meta">Backups are encrypted — only your recovery key opens them.</p>
    </StoragePicker>
    <Checkbox checked={primary} disabled={busy} onChange={(event) => setPrimary(event.currentTarget.checked)}>
      Send automatic backups here from now on.
    </Checkbox>
    {error ? <Notice title="Not added" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}
