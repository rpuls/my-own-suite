import { useEffect, useRef, useState } from 'react';

import { Checkbox, Dialog, Notice, Spinner, TextInput } from '../../components/ui';
import { postJson } from '../../lib/api';
import type { AppJob, DriveStep } from '../apps/types';
import { formatInstallerStick, joinNames, useStorage, WINDOWS_CHECK_STEPS, type DriveAction, type InstallerStick, type StorageEntry } from './model';

type Act = (driveId: string, action: DriveAction) => Promise<AppJob<DriveStep>>;

// Where a flow that started a drive job stands. Only the job this dialog started
// counts, so an eject from last week never reads as this one's result, and its
// outcome is kept once seen, because the drive's next job replaces it in the list.
function useDriveJob(entry: StorageEntry, act: Act) {
  const [started, setStarted] = useState<{ action: DriveAction; at: string } | null>(null);
  const [error, setError] = useState('');
  const [settled, setSettled] = useState<AppJob<DriveStep> | null>(null);
  const live = started && entry.job && entry.job.startedAt >= started.at && entry.job.steps[0]?.id === started.action ? entry.job : null;
  useEffect(() => {
    if (live && live.status !== 'running') setSettled(live);
  }, [live]);
  const job = settled || live;
  const phase = error || job?.status === 'failed' ? 'failed' : !started ? 'ask' : job?.status === 'succeeded' ? 'done' : 'working';
  async function start(action: DriveAction) {
    setError('');
    try {
      setStarted({ action, at: (await act(entry.id, action)).startedAt });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not start.');
    }
  }
  return { failure: error || job?.error?.message || '', phase, start };
}

type DriveJob = ReturnType<typeof useDriveJob>;

// How "use it again" went, said the same way from the eject flow and from the row.
function UseAgainOutcome({ appNames, using }: { appNames: string[]; using: DriveJob }) {
  if (using.phase === 'working') return <p className="suite-storage-flow-working"><Spinner />Opening the drive again…</p>;
  if (using.phase === 'done') return <Notice title="In use again" variant="success"><p>{appNames.length ? `${joinNames(appNames)} ${appNames.length > 1 ? 'are' : 'is'} starting again.` : 'The drive is open again.'}</p></Notice>;
  if (using.phase === 'failed') return <Notice title="The drive was not opened" variant="warning"><p>{using.failure} Unplug it and plug it back in.</p></Notice>;
  return null;
}

export function EjectDialog({ act, appNames, entry, onClose }: { act: Act; appNames: string[]; entry: StorageEntry; onClose: () => void }) {
  const { failure, phase, start } = useDriveJob(entry, act);
  const using = useDriveJob(entry, act);
  const working = phase === 'working' || using.phase === 'working';
  const footer = phase === 'ask'
    ? <><button className="mos-btn mos-btn-secondary" onClick={onClose} type="button">Cancel</button><button className="mos-btn mos-btn-primary" onClick={() => void start('eject')} type="button">Eject</button></>
    : phase === 'done' && using.phase !== 'done'
      ? <><button className="mos-btn mos-btn-secondary" disabled={working} onClick={() => void using.start('use')} type="button">{using.phase === 'working' ? <><Spinner />Opening it</> : 'Use it again'}</button><button className="mos-btn mos-btn-primary" disabled={working} onClick={onClose} type="button">Done</button></>
      : <button className="mos-btn mos-btn-primary" disabled={working} onClick={onClose} type="button">{phase === 'failed' ? 'Close' : 'Done'}</button>;
  return <Dialog footer={footer} onClose={() => { if (!working) onClose(); }} title={`Eject the ${entry.name}?`}>
    {phase === 'ask' ? (appNames.length
      ? <><p>These apps pause while the drive is out, and come back when it returns:</p><ul className="suite-storage-flow-list">{appNames.map((name) => <li key={name}>{name}</li>)}</ul></>
      : <p>Nothing on this server is using it, so nothing pauses.</p>) : null}
    {phase === 'working' ? <>
      <p className="suite-storage-flow-working"><Spinner />Ejecting…</p>
      <p className="suite-meta">{appNames.length ? `Pausing ${joinNames(appNames)}, then closing the drive.` : 'Closing the drive.'}</p>
    </> : null}
    {phase === 'done' && using.phase === 'ask' ? <Notice title="Safe to unplug" variant="success"><p>Plug it back in any time — the apps return on their own. Or use it again without touching the cable.</p></Notice> : null}
    {phase === 'done' ? <UseAgainOutcome appNames={appNames} using={using} /> : null}
    {phase === 'failed' ? <Notice title="The drive was not ejected" variant="warning"><p>{failure}</p></Notice> : null}
  </Dialog>;
}

// "Use it again" from the row, so its outcome is seen the same way as from Eject.
export function UseAgainDialog({ act, appNames, entry, onClose }: { act: Act; appNames: string[]; entry: StorageEntry; onClose: () => void }) {
  const using = useDriveJob(entry, act);
  const begun = useRef(false);
  const { start } = using;
  useEffect(() => {
    if (begun.current) return;
    begun.current = true;
    void start('use');
  }, [start]);
  const working = using.phase !== 'done' && using.phase !== 'failed';
  return <Dialog
    footer={<button className="mos-btn mos-btn-primary" disabled={working} onClick={onClose} type="button">{using.phase === 'failed' ? 'Close' : 'Done'}</button>}
    onClose={() => { if (!working) onClose(); }}
    title={`Using the ${entry.name} again`}
  >
    {working ? <UseAgainOutcome appNames={appNames} using={{ ...using, phase: 'working' }} /> : <UseAgainOutcome appNames={appNames} using={using} />}
  </Dialog>;
}

export function CheckDialog({ act, appNames, entry, onClose }: { act: Act; appNames: string[]; entry: StorageEntry; onClose: () => void }) {
  const { phase, start } = useDriveJob(entry, act);
  const [how, setHow] = useState(false);
  const footer = phase === 'ask'
    ? <><button className="mos-btn mos-btn-secondary" onClick={onClose} type="button">Not now</button><button className="mos-btn mos-btn-primary" onClick={() => void start('check')} type="button">Check drive</button></>
    : <button className="mos-btn mos-btn-primary" disabled={phase === 'working'} onClick={onClose} type="button">Done</button>;
  return <Dialog footer={footer} onClose={() => { if (phase !== 'working') onClose(); }} title={`Check the ${entry.name}?`}>
    {phase === 'ask' ? <p>The drive was unplugged without Eject, so it opened read-only to keep your files safe. The check fixes that. Apps using the drive restart when it finishes.</p> : null}
    {phase === 'working' ? <>
      <p className="suite-storage-flow-working"><Spinner />Checking the drive…</p>
      <p className="suite-meta">Usually under a minute. The drive and its apps come back by themselves.</p>
    </> : null}
    {phase === 'done' ? <Notice title="Working again" variant="success"><p>{appNames.length ? `${joinNames(appNames)} restarted · drive is fully usable` : 'The drive is fully usable'}</p></Notice> : null}
    {phase === 'failed' ? <Notice title="The quick check wasn't enough" variant="warning">
      <p>Your files are still readable. For a full repair, plug the drive into a Windows computer and run its check. {how ? null : <button className="mos-link suite-link-button" onClick={() => setHow(true)} type="button">How</button>}</p>
      {how ? <p>{WINDOWS_CHECK_STEPS}</p> : null}
    </Notice> : null}
  </Dialog>;
}

export function RenameDialog({ entry, onClose, onRenamed }: { entry: StorageEntry; onClose: () => void; onRenamed: () => void }) {
  const [name, setName] = useState(entry.named ? entry.name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true);
    try {
      await postJson(`/suite-manager/api/storage/${encodeURIComponent(entry.id)}/rename`, { name }, 'MOS could not rename it.');
      onRenamed();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not rename it.');
      setBusy(false);
    }
  }
  return <Dialog
    footer={<><button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button><button className="mos-btn mos-btn-primary" disabled={busy || (entry.kind === 'bucket' && !name.trim())} onClick={() => void save()} type="button">{busy ? <><Spinner />Saving</> : 'Save'}</button></>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Rename ${entry.name}`}
  >
    <TextInput
      autoFocus
      helperText={entry.kind === 'drive' ? `Only MOS uses this name. On other computers the drive keeps its own, ${entry.label}. Leave it empty to use that here too.` : 'The name you see for it in MOS.'}
      label="Name"
      maxLength={60}
      onChange={(event) => setName(event.currentTarget.value)}
      placeholder={entry.label}
      value={name}
    />
    {error ? <Notice title="Not renamed" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}

// The format runs as a job the storage list reports back; the stick leaves the
// list of sticks and comes back as a drive when it is done.
export function FormatStickDialog({ onClose, onFormatted, stick }: { onClose: () => void; onFormatted: () => void; stick: InstallerStick }) {
  const { inventory } = useStorage();
  const [understood, setUnderstood] = useState(false);
  const [startedAt, setStartedAt] = useState('');
  const [error, setError] = useState('');
  const live = inventory?.installerSticks.find((item) => item.devicePath === stick.devicePath) || null;
  const job = startedAt && live?.job && live.job.startedAt >= startedAt ? live.job : null;
  const gone = Boolean(startedAt && inventory && !live);
  const phase = error || job?.status === 'failed' ? 'failed' : !startedAt ? 'ask' : gone ? 'done' : 'working';
  const reported = useRef(false);
  useEffect(() => {
    if (phase !== 'done' || reported.current) return;
    reported.current = true;
    onFormatted();
  }, [onFormatted, phase]);

  async function format() {
    setError('');
    try {
      setStartedAt((await formatInstallerStick(stick.devicePath)).startedAt);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not format the stick.');
    }
  }
  const working = phase === 'working';
  return <Dialog
    footer={phase === 'ask'
      ? <><button className="mos-btn mos-btn-secondary" onClick={onClose} type="button">Cancel</button><button className="mos-btn mos-btn-danger" disabled={!understood} onClick={() => void format()} type="button">Format for storage</button></>
      : <button className="mos-btn mos-btn-primary" disabled={working} onClick={onClose} type="button">{phase === 'failed' ? 'Close' : 'Done'}</button>}
    onClose={() => { if (!working) onClose(); }}
    title="Format the install stick for storage?"
  >
    {phase === 'ask' ? <>
      <p>The stick becomes an ordinary drive that opens on any computer, and appears in Storage when it is done.</p>
      <Checkbox checked={understood} onChange={(event) => setUnderstood(event.currentTarget.checked)}>
        I understand the installer on this stick is erased. A new install stick can be made from the download on any computer.
      </Checkbox>
    </> : null}
    {working ? <>
      <p className="suite-storage-flow-working"><Spinner />Formatting…</p>
      <p className="suite-meta">Usually under a minute. The stick appears in the list as a drive when it is done.</p>
    </> : null}
    {phase === 'failed' ? <Notice title="The stick was not formatted" variant="error"><p>{error || job?.error?.message || 'MOS could not format the stick.'}</p></Notice> : null}
  </Dialog>;
}

export function DisconnectDialog({ entry, onClose, onDisconnected }: { entry: StorageEntry; onClose: () => void; onDisconnected: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function disconnect() {
    setBusy(true);
    try {
      await postJson('/suite-manager/api/storage/buckets/remove', { id: entry.id }, 'MOS could not disconnect it.');
      onDisconnected();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not disconnect it.');
      setBusy(false);
    }
  }
  return <Dialog
    footer={<><button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button><button className="mos-btn mos-btn-primary" disabled={busy} onClick={() => void disconnect()} type="button">{busy ? <><Spinner />Disconnecting</> : 'Disconnect'}</button></>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Disconnect ${entry.name}?`}
  >
    <p>MOS forgets how to reach this storage. Nothing in it is deleted: connect it again and the backups in it are listed again.</p>
    {error ? <Notice title="Still connected" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}
