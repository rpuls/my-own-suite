import { useEffect, useState, type ReactNode } from 'react';

import { Checkbox, ChoiceRow, Dialog, Notice, Panel, PanelItem, PanelList, Spinner, TextInput } from '../../components/ui';
import { formatBytes } from '../../lib/bytes';
import { itemsLabel, listMoveTargets, sizeOf, type FileEntry, type MoveTarget } from './model';

function useSubmit(onDone: () => void, fallback: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(work: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await work();
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
      setBusy(false);
    }
  }
  return { busy, error, submit };
}

// New folder and Rename are one shape: a name, made on the drive at once.
export function NameDialog({ action, initial = '', note, onClose, onDone, onSubmit, title }: {
  action: string;
  initial?: string;
  note: string;
  onClose: () => void;
  onDone: () => void;
  onSubmit: (name: string) => Promise<unknown>;
  title: string;
}) {
  const [name, setName] = useState(initial);
  const { busy, error, submit } = useSubmit(onDone, 'That did not work.');
  const ready = Boolean(name.trim()) && name !== initial;
  return <Dialog
    footer={<><button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button><button className="mos-btn mos-btn-primary" disabled={busy || !ready} form="suite-files-name" type="submit">{busy ? <><Spinner />{action}</> : action}</button></>}
    onClose={() => { if (!busy) onClose(); }}
    title={title}
  >
    <form id="suite-files-name" onSubmit={(event) => { event.preventDefault(); if (ready) void submit(() => onSubmit(name)); }}>
      <TextInput autoFocus helperText={note} label="Name" maxLength={255} onChange={(event) => setName(event.currentTarget.value)} value={name} />
    </form>
    {error ? <Notice title="Not done" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}

export function MoveDialog({ driveId, driveName, entries, from, onClose, onDone, onMove }: {
  driveId: string;
  driveName: string;
  entries: FileEntry[];
  from: string;
  onClose: () => void;
  onDone: () => void;
  onMove: (to: string) => Promise<unknown>;
}) {
  const [targets, setTargets] = useState<MoveTarget[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const { busy, error, submit } = useSubmit(onDone, 'Nothing was moved.');
  useEffect(() => {
    listMoveTargets(driveId).then(setTargets, (caught: Error) => setLoadError(caught.message));
  }, [driveId]);
  const moving = entries.filter((entry) => entry.kind === 'folder').map((entry) => (from ? `${from}/${entry.name}` : entry.name));
  const insideMoved = (path: string) => moving.some((folder) => path === folder || path.startsWith(`${folder}/`));
  const one = entries.length === 1;
  const option = (key: string, body: ReactNode, { checked = false, disabled = false, onPick = () => undefined }: { checked?: boolean; disabled?: boolean; onPick?: () => void }) => <PanelItem flush key={key} quiet={disabled} selected={checked}>
    <ChoiceRow disabled={disabled || busy} icon="folder" radio={{ checked, name: 'destination', onChange: onPick, value: key }}>{body}</ChoiceRow>
  </PanelItem>;
  return <Dialog
    footer={<><button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button><button className="mos-btn mos-btn-primary" disabled={busy || to === null} onClick={() => { if (to !== null) void submit(() => onMove(to)); }} type="button">{busy ? <><Spinner />Moving</> : 'Move here'}</button></>}
    onClose={() => { if (!busy) onClose(); }}
    title={one ? `Move ${entries[0]!.name}` : `Move ${itemsLabel(entries.length)}`}
  >
    <p className="suite-meta">Pick where on {driveName} {one ? 'it should' : 'they should'} live.</p>
    {targets === null && !loadError ? <p className="suite-meta suite-storage-flow-working"><Spinner />Looking at the folders on the drive…</p> : null}
    {targets ? <Panel density="tight">
      <div aria-label="Where to move" role="radiogroup">
        <PanelList>
          {targets.filter((target) => !insideMoved(target.path)).map((target) => (target.path === from
            ? option(target.path, <><span>{target.label}</span><span className="suite-meta">already here</span></>, { disabled: true })
            : option(target.path, <span>{target.label}</span>, { checked: to === target.path, onPick: () => setTo(target.path) })))}
          {option('another-drive', <><span>Another drive</span><span className="mos-pill">Later</span></>, { disabled: true })}
        </PanelList>
      </div>
    </Panel> : null}
    <p className="suite-meta">Moving within this drive is instant, even for a whole library.</p>
    {loadError || error ? <Notice title="Not moved" variant="error"><p>{loadError || error}</p></Notice> : null}
  </Dialog>;
}

export function DeleteDialog({ driveName, entries, onClose, onDelete, onDone }: {
  driveName: string;
  entries: FileEntry[];
  onClose: () => void;
  onDelete: () => Promise<unknown>;
  onDone: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  const { busy, error, submit } = useSubmit(onDone, 'Nothing was deleted.');
  const one = entries.length === 1;
  const bytes = sizeOf(entries);
  const size = bytes !== null ? ` — ${formatBytes(bytes)}` : '';
  const leftovers = entries.every((entry) => entry.appState);
  const first = entries[0]!;
  const appName = first.appName || first.name;
  const title = leftovers
    ? (one ? `Delete ${appName}'s files?` : `Delete the files of ${entries.length} apps?`)
    : (one ? `Delete ${first.name}?` : `Delete ${itemsLabel(entries.length)}?`);
  return <Dialog
    footer={<><button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button><button className="mos-btn mos-btn-danger" disabled={busy || !understood} onClick={() => void submit(onDelete)} type="button">{busy ? <><Spinner />Deleting</> : 'Delete'}</button></>}
    onClose={() => { if (!busy) onClose(); }}
    title={title}
  >
    {leftovers
      ? <p>{one ? `${appName} ${first.appState === 'elsewhere' ? 'keeps its files on another drive now' : 'is not installed'}. Its folder stayed on` : 'These apps are not using this drive. Their folders stayed on'} {driveName}{size}. Deleting {one ? 'it' : 'them'} deletes the only copies; they are not in your backups.{one && first.appState === 'not-installed' ? ` If you install ${appName} again, it starts with empty folders.` : ''}</p>
      : <p>{one ? 'This lives' : 'These live'} only on {driveName}{size}. Deleting {one ? 'it deletes the only copy; it is' : 'them deletes the only copies; they are'} not in your backups.</p>}
    <Checkbox checked={understood} disabled={busy} onChange={(event) => setUnderstood(event.currentTarget.checked)}>
      I understand {one && !leftovers ? 'this is the only copy' : 'these are the only copies'}
    </Checkbox>
    {error ? <Notice title="Not deleted" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}
