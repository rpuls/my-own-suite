import { useState } from 'react';

import { Checkbox, Dialog, Notice, Spinner } from '../../components/ui';
import { postJson } from '../../lib/api';
import { whenWords } from '../../lib/dates';

// An archive another server made, as both Storage and Backups know it. Counts
// are null until MOS has opened it.
export type ErasableArchive = { from: string | null; id: string; label: string; newestAt: string | null; restorePoints: number | null };

// Erasing an archive another server made on a drive. This server's own backups
// on the same drive are not touched. Opened from the drive in Settings → Storage
// and from the archive's row in Backups, which is why it lives beside neither.
export function EraseBackupsDialog({ archive, onClose, onErased }: {
  archive: ErasableArchive;
  onClose: () => void;
  onErased: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const from = archive.from || 'another server';
  const counted = typeof archive.restorePoints === 'number';
  const points = counted ? `${archive.restorePoints} restore point${archive.restorePoints === 1 ? '' : 's'}` : 'backups';
  async function erase() {
    setBusy(true);
    setError('');
    try {
      await postJson('/suite-manager/api/backups/archives/erase', { archiveId: archive.id, confirmation: 'ERASE' }, 'MOS could not erase these backups.');
      onErased();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not erase these backups.');
      setBusy(false);
    }
  }
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-danger" disabled={busy || !understood} onClick={() => void erase()} type="button">{busy ? <><Spinner />Erasing</> : 'Erase these backups'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Erase another server's backups on ${archive.label}?`}
  >
    {counted
      ? <p>{archive.label} holds {points} that {from} made{archive.newestAt ? `, the newest ${whenWords(archive.newestAt).toLowerCase()}` : ''}. They may be that server&rsquo;s only copies.</p>
      : <p>{archive.label} holds backups that {from} made. MOS has not opened them, so it cannot say how many restore points they hold or how recent they are. They may be that server&rsquo;s only copies.</p>}
    <p className="suite-meta">Erasing them gives back the space they take. This server&rsquo;s own backups on the drive are not touched. Keep them instead if you may still want to restore from them.</p>
    <Checkbox checked={understood} disabled={busy} onChange={(event) => setUnderstood(event.currentTarget.checked)}>
      I understand these {points} are erased for good. No key brings them back.
    </Checkbox>
    {error ? <Notice title="Nothing was erased" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}
