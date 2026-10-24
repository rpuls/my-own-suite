import { useState } from 'react';

import { Checkbox, Dialog, Notice, Spinner } from '../../components/ui';
import { postJson } from '../../lib/api';
import { AddStorageDialog } from '../storage/AddStorageDialog';
import { useStorage } from '../storage/model';
import { StoragePicker } from '../storage/StoragePicker';

// Making storage a backup destination. Storage is set up in Settings → Storage or
// from the picker's last row, which on a fresh server is the way to the backups to restore.
export function AddDestinationDialog({ firstDestination, onAdded, onClose }: {
  firstDestination: boolean;
  onAdded: () => void;
  onClose: () => void;
}) {
  const { inventory, names, reload, storage } = useStorage();
  const [picked, setPicked] = useState('');
  const [adding, setAdding] = useState(false);
  const [primary, setPrimary] = useState(firstDestination);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const already = (storage || []).filter((entry) => entry.backups?.destination).map((entry) => entry.id);

  async function add() {
    setBusy(true);
    setError('');
    try {
      await postJson('/suite-manager/api/backups/destinations/add', { primary, storageId: picked }, 'MOS could not make this a backup destination.');
      onAdded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not make this a backup destination.');
      setBusy(false);
    }
  }

  if (adding) {
    return <AddStorageDialog
      onClose={() => { setAdding(false); void reload(); }}
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
      addHint="Set up a drive, or connect storage online"
      backupsKnown={inventory?.backupsKnown === true}
      busy={busy}
      context="backups"
      empty={<><strong>No storage yet</strong><p className="suite-meta">Plug a drive into the server, or connect storage online, and it appears here.</p></>}
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
