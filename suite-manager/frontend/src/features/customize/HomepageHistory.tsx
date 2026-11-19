import { useEffect, useState } from 'react';

import { Dialog, Notice, Panel, PanelBody, PanelHead, PanelItem, PanelList, RowAction } from '../../components/ui';
import { whenWords } from '../../lib/dates';

const API = '/suite-manager/api/customize/history';

type Checkpoint = { actor: string; at: string; current: boolean; id: number; summary: string };
type History = { checkpoints: Checkpoint[]; kept: number };
type ApiError = Error & { code?: string; details?: string[] };

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API}${path}`, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, method: 'POST' });
  const payload = await response.json().catch(() => ({ error: 'The history could not be changed.' }));
  if (!response.ok) throw Object.assign(new Error(payload.error || 'The history could not be changed.'), payload);
  return payload as T;
}

function lowerFirst(text: string) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function RestoreDialog({ checkpoint, onClose, onRestored }: { checkpoint: Checkpoint; onClose: () => void; onRestored: (history: History) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const reopens = error?.code === 'HOMEPAGE_RESTORE_OPENS_ADDRESSES';

  async function restore(confirmAddresses: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ history: History }>('/restore', { confirmAddresses, id: checkpoint.id });
      onRestored(result.history);
    } catch (caught) {
      setError(caught as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" disabled={busy} onClick={() => void restore(reopens)} type="button">{busy ? 'Going back...' : reopens ? 'Go back and open them' : 'Go back'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title="Go back to this version?"
  >
    <p>Your dashboard goes back to how it was after “{checkpoint.summary}”, {lowerFirst(whenWords(checkpoint.at))}. Tiles of your apps stay as they are now. Going back is saved as a version too, so you can undo it.</p>
    {error ? <Notice title={reopens ? 'This brings back addresses' : 'The dashboard could not go back'} variant={reopens ? 'warning' : 'error'}><p>{error.message}</p></Notice> : null}
  </Dialog>;
}

// Every saved change to the dashboard, newest first, so an owner can step back
// without a backup and clear the steps once they are happy.
export function HomepageHistory({ onRestored, refreshKey }: { onRestored: () => void; refreshKey: number }) {
  const [history, setHistory] = useState<History | null>(null);
  const [restoring, setRestoring] = useState<Checkpoint | null>(null);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    call<History>('').then(setHistory, () => setHistory(null));
  }, [refreshKey]);

  // The activity page's Undo lands here; the list arrives after the page does.
  useEffect(() => {
    if (history && window.location.hash === '#history') document.getElementById('history')?.scrollIntoView({ block: 'start' });
  }, [Boolean(history)]);

  async function change(path: string, body?: unknown) {
    setError('');
    try {
      setHistory(await call<History>(path, body ?? {}));
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    }
  }

  if (!history) return null;
  const older = history.checkpoints.filter((checkpoint) => !checkpoint.current);
  return <section id="history">
    <Panel>
      <PanelHead actions={older.length ? <button className="mos-btn mos-btn-ghost" onClick={() => setClearing(true)} type="button">Keep only the current one</button> : null} heading="h2" title="History">
        <p>Every change to your dashboard is saved here, the last {history.kept}, so you can go back to an earlier version.</p>
      </PanelHead>
      {error ? <PanelBody><Notice title="Something went wrong" variant="error"><p>{error}</p></Notice></PanelBody> : null}
      {history.checkpoints.length ? <PanelList>
        {history.checkpoints.map((checkpoint) => <PanelItem key={checkpoint.id}>
          <div className="suite-source-row">
            <div className="suite-source-main">
              <strong>{checkpoint.summary}</strong>
              <span className="suite-meta">{checkpoint.actor} · {lowerFirst(whenWords(checkpoint.at))}</span>
            </div>
            <span className="suite-source-trailing">
              {checkpoint.current
                ? <span className="mos-pill">Now</span>
                : <>
                  <button className="mos-btn mos-btn-secondary" onClick={() => setRestoring(checkpoint)} type="button">Go back</button>
                  <RowAction danger icon="x" label={`Delete the version “${checkpoint.summary}”`} onClick={() => void change('/delete', { id: checkpoint.id })} />
                </>}
            </span>
          </div>
        </PanelItem>)}
      </PanelList> : <PanelBody><p className="suite-meta">No changes saved yet. The next change to your dashboard starts the history.</p></PanelBody>}
    </Panel>
    {restoring ? <RestoreDialog checkpoint={restoring} onClose={() => setRestoring(null)} onRestored={(next) => { setHistory(next); setRestoring(null); onRestored(); }} /> : null}
    {clearing ? <Dialog
      footer={<>
        <button className="mos-btn mos-btn-secondary" onClick={() => setClearing(false)} type="button">Cancel</button>
        <button className="mos-btn mos-btn-danger" onClick={() => void change('/keep-current').then((done) => { if (done) setClearing(false); })} type="button">Delete {older.length === 1 ? 'it' : `all ${older.length}`}</button>
      </>}
      onClose={() => setClearing(false)}
      title="Keep only the current version?"
    >
      <p>The {older.length === 1 ? 'earlier version is' : `${older.length} earlier versions are`} deleted, and you can no longer go back to {older.length === 1 ? 'it' : 'them'}. Your dashboard stays as it is.</p>
    </Dialog> : null}
  </section>;
}
