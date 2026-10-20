import { useState } from 'react';

import { AdvancedPanel, Checkbox, Dialog, Icon, Notice, Panel, PanelItem, PanelList, Select, Spinner, TextArea, TextInput } from '../../components/ui';
import { RecoveryKeySecret, type RevealedRecoveryKey } from '../../components/RecoveryKeySecret';
import { postJson } from '../../lib/api';
import { type VaultStartup } from '../../lib/vault';
import {
  RETENTION_OPTIONS,
  WEEKDAY_NAMES,
  backupDescription,
  browserTimeZone,
  clockValue,
  archiveKeyLine,
  destinationIconName,
  carriedDomain,
  whenWords,
  writtenElsewhere,
  type ArchiveKey,
  type BackupEntry,
  type BackupSchedule,
  type BackupStatus,
  type DestinationView,
  type ForeignStore,
  type RecoveryKeyState,
  type RotationResult,
} from './model';

// Taking a backup by hand. The destination is stated rather than asked: it was
// chosen before this dialog opened, on the page or in the picker beside the
// button, so all that is left is the note and the go-ahead.
export function BackupDialog({ busy, note, onCancel, onChange, onStart, target }: {
  busy: string;
  note: string;
  onCancel: () => void;
  onChange: (next: string) => void;
  onStart: () => void;
  target: DestinationView;
}) {
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={onStart} type="button">
        {busy === 'backup' ? <><Spinner />Starting</> : 'Start backup'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title="Back up now"
  >
    <p>This copies your whole suite to <strong>{target.label}</strong>. Your apps pause for a few minutes and come back on their own.</p>
    <TextArea
      helperText="Shown next to this backup later, so you can tell them apart."
      label="Add a note (optional)"
      maxLength={200}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder="e.g. Before the holiday"
      rows={3}
      value={note}
    />
  </Dialog>;
}

// Handing this machine the key to backups another server wrote. The same
// forgiving entry as the kit promises: case, spaces and hyphens do not matter,
// and a slip is answered as a slip.
export function UnlockDialog({ busy, error, onCancel, onUnlock, view }: {
  busy: string;
  error: string;
  onCancel: () => void;
  onUnlock: (recoveryKey: string) => void;
  view: DestinationView;
}) {
  const [entered, setEntered] = useState('');
  const working = busy === `unlock:${view.id}`;

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={!entered.trim() || working} onClick={() => onUnlock(entered)} type="button">
        {working ? <><Spinner />Unlocking</> : 'Unlock'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={working} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!working) onCancel(); }}
    title={`Unlock the backups on ${view.label}`}
  >
    <p>Another server made these. Enter <strong>that server&rsquo;s</strong> recovery key, from its recovery kit. This server&rsquo;s own key does not open them.</p>
    <p className="suite-meta">Unlocking only reads: MOS keeps the key here to open this {view.destination.kind === 'object' ? 'bucket' : 'drive'}, and nothing in it changes. Lock again forgets the key.</p>
    <TextInput
      autoFocus
      disabled={working}
      helperText={error || "From that server's recovery kit. Capitals, spaces and dashes do not matter."}
      label="The other server's recovery key"
      onChange={(event) => setEntered(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && entered.trim() && !working) onUnlock(entered); }}
      placeholder="MOS-XXXX-XXXX-XXXX-XXXX"
      value={entered}
    />
    {working ? <p className="suite-bk-working"><Spinner />Checking the key and opening the backups. This takes a few seconds.</p> : null}
  </Dialog>;
}

// Who can open an archive, and taking one of them back out. Reading the key
// list needs a key that already opens the archive, so the dialog asks for one
// before it can show anything — which is also why this is not something a
// passer-by can use to lock the owner out. The key doing the asking is never
// offered for removal, and neither is the last one left.
export function ArchiveKeysDialog({ busy, error, keys, onClose, onList, onRemove, view }: {
  busy: string;
  error: string;
  keys: ArchiveKey[] | null;
  onClose: () => void;
  onList: (recoveryKey: string) => void;
  onRemove: (recoveryKey: string, keyId: string) => void;
  view: DestinationView;
}) {
  const [entered, setEntered] = useState('');
  const listing = busy === `keys:${view.id}`;
  const working = listing || busy.startsWith('key-remove:');

  return <Dialog
    footer={<>
      {keys ? null : <button className="mos-btn mos-btn-primary" disabled={!entered.trim() || working} onClick={() => onList(entered)} type="button">
        {listing ? <><Spinner />Reading</> : 'Show the keys'}
      </button>}
      <button className="mos-btn mos-btn-secondary" disabled={working} onClick={onClose} type="button">{keys ? 'Done' : 'Cancel'}</button>
    </>}
    onClose={() => { if (!working) onClose(); }}
    title={`Keys that open ${view.label}`}
  >
    <p>Anyone holding one of these keys can read the backups in <strong>{view.label}</strong>. To see them, enter a recovery key that already opens this {view.destination.kind === 'object' ? 'bucket' : 'drive'}.</p>

    {keys ? <>
      <Panel density="tight">
        <PanelList>
          {keys.map((key) => <PanelItem className="suite-bk-keyrow" key={key.id}>
            <div>
              <strong>{archiveKeyLine(key)}</strong>
              <p className="suite-meta">{key.current ? 'This is the key you entered.' : `Key ${key.id.slice(0, 8)}`}</p>
            </div>
            {key.current || keys.length < 2 ? null : <button
              className="mos-btn mos-btn-secondary mos-btn-sm"
              disabled={working}
              onClick={() => onRemove(entered, key.id)}
              type="button"
            >{busy === `key-remove:${key.id}` ? <><Spinner />Removing</> : 'Remove'}</button>}
          </PanelItem>)}
        </PanelList>
      </Panel>
      {error ? <Notice title="That did not work" variant="error">{error}</Notice> : null}
      <p className="suite-meta">Removing a key takes away that machine&rsquo;s access to these backups. Nothing stored here is changed or re-encrypted, and the other keys keep working.</p>
    </> : <TextInput
      autoFocus
      disabled={working}
      helperText={error || 'Capitals, spaces and dashes do not matter.'}
      label="Recovery key"
      onChange={(event) => setEntered(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && entered.trim() && !working) onList(entered); }}
      placeholder="MOS-XXXX-XXXX-XXXX-XXXX"
      value={entered}
    />}
  </Dialog>;
}

// One dialog for both times an owner meets their recovery key: the first, where
// MOS shows it unasked and will not take a backup until they say they have kept
// it, and every later one, where a signed-in owner asks to see it again and
// proves the owner password first. The two differ only in what has to happen
// before the key appears, which is why they are not two dialogs. What it opens
// is listed by name, because one key for the whole server is only reassuring
// once you can see which places that covers.
export function RecoveryKeyDialog({ busy, error, keyState, mode, onAcknowledge, onClose, onReveal, onRotate, onStartRotation, revealed, rotation, startup, views }: {
  busy: string;
  error: string;
  keyState: RecoveryKeyState | null;
  mode: 'reveal' | 'rotate' | 'save';
  onAcknowledge: () => void;
  onClose: () => void;
  onReveal: (password: string) => void;
  onRotate: (password: string) => void;
  onStartRotation: () => void;
  revealed: RevealedRecoveryKey | null;
  rotation: RotationResult | null;
  startup: VaultStartup;
  views: DestinationView[];
}) {
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const locked = Boolean(busy);
  const opens = views.filter((view) => !view.destination.locked);
  const missing = views.filter((view) => view.destination.locked);
  // A rotation ends in the same place a first handover does: a key on screen
  // that has to be saved before the dialog is done with.
  const confirming = mode === 'save' || (mode === 'rotate' && Boolean(rotation));

  return <Dialog
    footer={confirming
      ? <>
          <button className="mos-btn mos-btn-primary" disabled={!saved || !revealed || locked} onClick={onAcknowledge} type="button">
            {busy === 'recovery-acknowledge' ? <><Spinner />Saving</> : 'Done'}
          </button>
        </>
      : <button className="mos-btn mos-btn-secondary" disabled={locked} onClick={onClose} type="button">Close</button>}
    onClose={() => { if (!locked) onClose(); }}
    title={mode === 'rotate' && !rotation ? 'Change your recovery key' : 'Your recovery key'}
  >
    {mode === 'rotate' && !rotation ? <>
      <p>MOS makes a new key, changes this server's disk over to it, and changes every backup it can reach over to it. The key you have now stops opening them.</p>
      <p>You are shown the new key once here, with a new recovery kit to download. Nothing else about your backups changes and none of them are rewritten.</p>
      <TextInput
        autoFocus
        disabled={locked}
        helperText="Checked on this server. The new key is shown as soon as it is made."
        label="Enter your password to change the key"
        onChange={(event) => setPassword(event.currentTarget.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && password && !locked) onRotate(password); }}
        type="password"
        value={password}
      />
      <button className="mos-btn mos-btn-primary" disabled={!password || locked} onClick={() => onRotate(password)} type="button">
        {busy === 'recovery-rotate' ? <><Spinner />Changing the key</> : 'Change my recovery key'}
      </button>
    </> : null}

    {mode === 'reveal' && !revealed ? <TextInput
      autoFocus
      disabled={locked}
      helperText="Asked because the key is being shown again. It is checked on this server and never stored in your browser."
      label="Enter your password to see the key"
      onChange={(event) => setPassword(event.currentTarget.value)}
      onKeyDown={(event) => { if (event.key === 'Enter' && password && !locked) onReveal(password); }}
      type="password"
      value={password}
    /> : null}
    {mode === 'reveal' && !revealed ? <button className="mos-btn mos-btn-primary" disabled={!password || locked} onClick={() => onReveal(password)} type="button">
      {busy === 'recovery-reveal' ? <><Spinner />Checking</> : 'Show recovery key'}
    </button> : null}

    {revealed ? <RecoveryKeySecret revealed={revealed} startup={startup} /> : null}

    {rotation ? <>
      {/* Said without hedging, because it is the one thing rotation does not
          fix and the owner is the only one who can decide what to do about it.
          The disk half has no equivalent: reaching what is under a LUKS
          passphrase needs the disk in hand, and at that point the data is
          already gone. */}
      <Notice title="What changing the key does not undo" variant="warning">
        <p>Your disk and every backup from now on need the new key. Anyone who already had the old key <strong>and</strong> a copy of your bucket or drive can still read the backups that existed before today. If you think that happened, start a fresh archive rather than trusting this one.</p>
      </Notice>
      {rotation.pending.length ? <Notice title="Some copies still open with your old key" variant="info">
        <p>{rotation.pending.map((entry) => entry.label).join(', ')} {rotation.pending.length === 1 ? 'was' : 'were'} not attached, so {rotation.pending.length === 1 ? 'it keeps' : 'they keep'} the old key until next plugged in. MOS finishes the change by itself then; keep your old kit until it has.</p>
      </Notice> : null}
    </> : null}

    <p className="suite-meta">{keyState?.adoptedAt
      ? 'This key came from the server this one restored from. Taking that server\u2019s place made its key this key, so everything here opens with it.'
      : 'This key was made on this server at your first backup. Backups another server wrote keep their own key: MOS holds that key to read them and never changes what is in them.'}</p>

    {opens.length ? <div className="suite-bk-key-list">
      <p className="mos-eyebrow">This key opens</p>
      {opens.map((view) => <p key={view.id}><Icon name={destinationIconName(view.destination)} /><strong>{view.label}</strong><span>{view.foreign ? `Brought in from ${view.foreign} · opens with ${view.foreign}'s key, kept here` : 'Made here'}</span></p>)}
    </div> : null}
    {missing.length ? <div className="suite-bk-key-list is-missing">
      <p className="mos-eyebrow">This key does not open</p>
      {missing.map((view) => <p key={view.id}><Icon name={destinationIconName(view.destination)} /><strong>{view.label}</strong><span>Needs the recovery key of the server that wrote it</span></p>)}
    </div> : null}

    {confirming && revealed ? <Checkbox checked={saved} disabled={locked} onChange={(event) => setSaved(event.currentTarget.checked)}>
      I have saved this recovery key somewhere I can still reach if this server is gone.
    </Checkbox> : null}

    {mode === 'reveal' && revealed ? <>
      <p className="suite-meta">If you think someone else has seen this key, change it. MOS makes a new one and moves this server's disk and every backup it can reach over to it.</p>
      <button className="mos-btn mos-btn-ghost mos-btn-sm" disabled={locked} onClick={onStartRotation} type="button">
        <Icon name="key" />
        Change recovery key
      </button>
    </> : null}


    {error ? <Notice title="That did not work" variant="error"><p>{error}</p></Notice> : null}

    <AdvancedPanel facts={[
      { code: true, label: 'Key fingerprint', value: keyState?.fingerprint || 'unknown' },
      { code: true, label: 'Key file on this server', value: keyState?.keyFile || 'unknown' },
      { label: 'Pre-release key kept for old repositories', value: keyState?.legacyKeyPresent ? 'yes' : 'no' },
    ]} reveal="technical-mode" />
  </Dialog>;
}

// When automatic backups run and how many are kept. Where they go is not asked
// here: it is the place selected on the page, stated as a fact so the two
// questions stay in the two boxes that answer them.
export function ScheduleDialog({ busy, onCancel, onSave, schedule, selected }: {
  busy: string;
  onCancel: () => void;
  onSave: (next: Partial<BackupSchedule>) => void;
  schedule: BackupSchedule;
  selected: DestinationView | null;
}) {
  const [draft, setDraft] = useState<BackupSchedule>(schedule);
  const zone = draft.timeZone || browserTimeZone();
  const change = (next: Partial<BackupSchedule>) => setDraft((current) => ({ ...current, ...next }));

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={() => onSave(draft)} type="button">
        {busy === 'schedule' ? <><Spinner />Saving</> : 'Save'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title="Automatic backups"
  >
    <Checkbox checked={draft.enabled} disabled={Boolean(busy) || !selected} onChange={(event) => change({ enabled: event.currentTarget.checked })}>
      Back up on a schedule
    </Checkbox>
    {selected ? null : <Notice title="Pick a place first" variant="warning"><p>Choose where backups should go on the page behind this, then turn the schedule on.</p></Notice>}

    {draft.enabled ? <>
      <Select
        disabled={Boolean(busy)}
        label="How often"
        onChange={(event) => change({ frequency: event.currentTarget.value === 'weekly' ? 'weekly' : 'daily' })}
        value={draft.frequency}
      >
        <option value="daily">Every day</option>
        <option value="weekly">Once a week</option>
      </Select>
      {draft.frequency === 'weekly' ? <Select
        disabled={Boolean(busy)}
        label="Day"
        onChange={(event) => change({ weekday: Number(event.currentTarget.value) })}
        value={String(draft.weekday)}
      >
        {WEEKDAY_NAMES.map((name, index) => <option key={name} value={String(index)}>{name}</option>)}
      </Select> : null}
      <TextInput
        disabled={Boolean(busy)}
        helperText={`Times are in ${zone}, the zone of the browser that set this.${browserTimeZone() === zone ? '' : ` This browser is on ${browserTimeZone()} time.`}`}
        label="At"
        onChange={(event) => {
          const [hour, minute] = event.currentTarget.value.split(':');
          if (hour === undefined || minute === undefined) return;
          change({ hour: Number(hour), minute: Number(minute) });
        }}
        type="time"
        value={clockValue(draft)}
      />
      <Select
        disabled={Boolean(busy)}
        helperText="Backups you took yourself are never removed."
        label="Keep"
        onChange={(event) => change({ keepLast: Number(event.currentTarget.value) })}
        value={String(draft.keepLast)}
      >
        {RETENTION_OPTIONS.map((option) => <option key={option.value} value={String(option.value)}>{option.label}</option>)}
      </Select>
      <p className="suite-meta">They go to {selected ? selected.label : 'nowhere yet'} — the place selected on the page. Change that there, not here.</p>
    </> : null}
  </Dialog>;
}

// Putting a backup back. Everything that cannot be undone is said before the
// confirmation field, and a restore onto another machine states what will
// happen to the address the backup carried rather than asking. The question it
// used to ask was answered blind — the consequences only became visible twenty
// minutes later, on a screen the answer could take away.
export function RestoreDialog({ backup, busy, confirmation, onCancel, onConfirmation, onStart, status }: {
  backup: BackupEntry;
  busy: string;
  confirmation: string;
  onCancel: () => void;
  onConfirmation: (next: string) => void;
  onStart: () => void;
  status: BackupStatus;
}) {
  const elsewhere = writtenElsewhere(backup, status);
  const domain = carriedDomain(backup, status);

  return <Dialog
    footer={<>
      <button
        className="mos-btn mos-btn-primary"
        disabled={confirmation.trim().toUpperCase() !== 'RESTORE' || Boolean(busy)}
        onClick={onStart}
        type="button"
      >{busy === 'restore' ? <><Spinner />Starting</> : elsewhere ? 'Restore and take over' : 'Restore'}</button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title={elsewhere ? `Make this server ${elsewhere}?` : 'Restore this backup'}
  >
    <p>This replaces everything on this machine with the backup from <strong>{whenWords(backup.createdAt)}</strong>. Your apps stop while it runs, and everyone is signed out at the end.</p>
    <p className="suite-meta">{backupDescription(backup)} · {backup.destinationLabel}</p>
    {/* The estimate is the agent's: read off this machine's own jobs and app
        build times, or a stated range when it has none, and it says which. */}
    {backup.expect ? <p>{backup.expect.restore.sentence}</p> : null}
    {backup.expect?.restore.note ? <p className="suite-meta">{backup.expect.restore.note}</p> : null}
    <Notice title="A rescue copy is kept" variant="info">
      <p>MOS saves a complete copy of what is on this machine now before it changes anything, so a restore that stops partway can be looked at rather than guessed about. Apps and app data added after this backup are removed, so the system matches the backup exactly.</p>
    </Notice>

    {elsewhere ? <Notice title={`This backup was made by ${elsewhere}`} variant="info">
      <p>This machine becomes that server. It takes over {elsewhere}&rsquo;s recovery key, for these backups and this machine&rsquo;s encrypted disk, and the key it was installed with stops opening anything. Keep {elsewhere}&rsquo;s recovery kit: from now on it is this server&rsquo;s, and {backup.destinationLabel} becomes one of this server&rsquo;s backup places.</p>
      <p>After restoring, sign in with that server&rsquo;s owner password. This machine keeps its own console and SSH login; the other server&rsquo;s does not come along.</p>
    </Notice> : null}

    {domain ? <Notice title={`${domain} does not come with it`} variant="info">
      <p>That is the address of the server this backup was written on, and a name points at one machine at a time. Your suite comes back on <strong>this machine&rsquo;s own address</strong> — the one you are reading this on — so you can sign in and use it as soon as the restore finishes.</p>
      <p>Anything set up against the old address keeps failing until that name points here: phone apps, desktop sync clients, browser extensions. Afterwards <strong>Settings</strong> offers <strong>{domain}</strong> back, and Backup &amp; Restore says what is left to do.</p>
      <p className="suite-meta">If the server that wrote this backup is still running, turn it off before pointing the name here. Two machines answering for one suite means two copies of your data drifting apart.</p>
    </Notice> : null}

    <TextInput
      autoFocus
      disabled={Boolean(busy)}
      label="Type RESTORE to continue"
      onChange={(event) => onConfirmation(event.currentTarget.value)}
      placeholder="RESTORE"
      value={confirmation}
    />
  </Dialog>;
}

// Erasing another server's backups from a drive, so this server can use it for
// its own. Opened from the drive's row in Backups, from Settings → Storage, and
// from Add destination when the drive picked turns out to hold them.
export function EraseBackupsDialog({ onClose, onErased, primary = false, store }: {
  onClose: () => void;
  onErased: () => void;
  primary?: boolean;
  store: ForeignStore;
}) {
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const points = `${store.restorePoints} restore point${store.restorePoints === 1 ? '' : 's'}`;
  async function erase() {
    setBusy(true);
    setError('');
    try {
      await postJson('/suite-manager/api/backups/destinations/erase', { confirmation: 'ERASE', destinationId: store.destinationId, primary }, 'MOS could not erase these backups.');
      onErased();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'MOS could not erase these backups.');
      setBusy(false);
    }
  }
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={onClose} type="button">Cancel</button>
      <button className="mos-btn mos-btn-primary" disabled={busy || !understood} onClick={() => void erase()} type="button">{busy ? <><Spinner />Erasing</> : primary ? 'Erase and use for backups' : 'Erase these backups'}</button>
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={`Erase the backups on ${store.label}?`}
  >
    <p>{store.label} holds {points} that {store.from || 'another server'} made{store.newestAt ? `, the newest ${whenWords(store.newestAt).toLowerCase()}` : ''}. They belong to that server, so this server cannot add its own backups to them.</p>
    <p className="suite-meta">Erasing them frees the drive for this server&rsquo;s backups. Keep them instead if you may still want to restore from them: that needs the other server&rsquo;s recovery key, entered on the drive in Backups.</p>
    <Checkbox checked={understood} disabled={busy} onChange={(event) => setUnderstood(event.currentTarget.checked)}>
      I understand these {points} are erased for good. No key brings them back.
    </Checkbox>
    {error ? <Notice title="Nothing was erased" variant="error"><p>{error}</p></Notice> : null}
  </Dialog>;
}

export function DeleteDialog({ backup, busy, onCancel, onDelete }: {
  backup: BackupEntry;
  busy: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={onDelete} type="button">
        {busy === `delete:${backup.path}` ? <><Spinner />Deleting</> : 'Delete'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title="Delete this backup"
  >
    <p>Delete the backup from <strong>{whenWords(backup.createdAt)}</strong>? It is removed from {backup.destinationLabel} and cannot be brought back.</p>
    <p className="suite-meta">{backup.restorable === false
      ? 'This backup is in the retired format and cannot be restored by this version of MOS. Deleting it frees the space its folder takes.'
      : 'The space only this restore point was using is reclaimed, which can take a moment. Data still needed by other restore points is kept.'}</p>
  </Dialog>;
}

export function NoteDialog({ backup, busy, onCancel, onChange, onSave, value }: {
  backup: BackupEntry;
  busy: string;
  onCancel: () => void;
  onChange: (next: string) => void;
  onSave: () => void;
  value: string;
}) {
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={onSave} type="button">Save note</button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title={backup.note ? 'Edit the note' : 'Add a note'}
  >
    <p className="suite-meta">{whenWords(backup.createdAt)} · {backupDescription(backup)}</p>
    <TextArea
      autoFocus
      helperText="Shown next to this backup so you can tell restore points apart. Leave it empty to remove the note."
      label="What was happening when you took this backup?"
      maxLength={200}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder="e.g. Before installing a new app"
      rows={3}
      value={value}
    />
  </Dialog>;
}
