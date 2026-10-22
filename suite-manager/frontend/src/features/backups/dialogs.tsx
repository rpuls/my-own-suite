import { useState } from 'react';

import { AdvancedPanel, Checkbox, Dialog, Icon, Notice, Panel, PanelItem, PanelList, Select, Spinner, TextArea, TextInput } from '../../components/ui';
import { RecoveryKeySecret, type RevealedRecoveryKey } from '../../components/RecoveryKeySecret';
import { postJson } from '../../lib/api';
import { whenWords } from '../../lib/dates';
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
  placeOf,
  writtenElsewhere,
  type Archive,
  type ArchiveKey,
  type BackupEntry,
  type BackupSchedule,
  type DestinationView,
  type RecoveryKeyState,
  type RotationResult,
} from './model';

// The archive a key dialog is about: its id, the place it is on, and which kind of place that is.
export type ArchiveRef = { id: string; label: string; placeKind: 'disk' | 'object' };

// Taking a backup by hand. The destination was chosen before this opened, so all
// that is left is the note and the go-ahead.
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
      helperText="Shown next to this restore point later, so you can tell them apart."
      label="Add a note (optional)"
      maxLength={200}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder="e.g. Before the holiday"
      rows={3}
      value={note}
    />
  </Dialog>;
}

// Handing this server the key to backups another server wrote. Case, spaces and
// hyphens do not matter, as the kit promises.
export function UnlockDialog({ archive, busy, error, onCancel, onUnlock }: {
  archive: ArchiveRef;
  busy: string;
  error: string;
  onCancel: () => void;
  onUnlock: (recoveryKey: string) => void;
}) {
  const [entered, setEntered] = useState('');
  const working = busy === `unlock:${archive.id}`;

  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={!entered.trim() || working} onClick={() => onUnlock(entered)} type="button">
        {working ? <><Spinner />Unlocking</> : 'Unlock'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={working} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!working) onCancel(); }}
    title={`Unlock the backups on ${archive.label}`}
  >
    <p>Another server made these. Enter <strong>that server&rsquo;s</strong> recovery key, from its recovery kit. This server&rsquo;s own key does not open them.</p>
    <p className="suite-meta">Unlocking only reads: MOS keeps the key here to open these backups, and nothing in them changes. Lock again forgets the key.</p>
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

// Who can open an archive, and taking one of them back out. Reading the list needs
// a key that already opens the archive; the asking key and the last one are never offered.
export function ArchiveKeysDialog({ archive, busy, error, keys, onClose, onList, onRemove }: {
  archive: ArchiveRef;
  busy: string;
  error: string;
  keys: ArchiveKey[] | null;
  onClose: () => void;
  onList: (recoveryKey: string) => void;
  onRemove: (recoveryKey: string, keyId: string) => void;
}) {
  const [entered, setEntered] = useState('');
  const listing = busy === `keys:${archive.id}`;
  const working = listing || busy.startsWith('key-remove:');

  return <Dialog
    footer={<>
      {keys ? null : <button className="mos-btn mos-btn-primary" disabled={!entered.trim() || working} onClick={() => onList(entered)} type="button">
        {listing ? <><Spinner />Reading</> : 'Show the keys'}
      </button>}
      <button className="mos-btn mos-btn-secondary" disabled={working} onClick={onClose} type="button">{keys ? 'Done' : 'Cancel'}</button>
    </>}
    onClose={() => { if (!working) onClose(); }}
    title={`Keys that open the backups on ${archive.label}`}
  >
    <p>Anyone holding one of these keys can read these backups on <strong>{archive.label}</strong>. To see them, enter a recovery key that already opens them.</p>

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
      <p className="suite-meta">Removing a key takes away that server&rsquo;s access to these backups. Nothing stored here is changed or re-encrypted, and the other keys keep working.</p>
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

// One dialog for both times an owner meets their recovery key: the first, shown
// unasked and gating the first backup, and every later one, behind the owner password.
export function RecoveryKeyDialog({ archives, busy, error, keyState, mode, onAcknowledge, onClose, onReveal, onRotate, onStartRotation, revealed, rotation, startup }: {
  archives: Archive[];
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
}) {
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const locked = Boolean(busy);
  const opens = archives.filter((archive) => archive.owner === 'this');
  const others = archives.filter((archive) => archive.owner === 'other');
  const icon = (archive: Archive) => destinationIconName(placeOf(archive.placeKind));
  // A rotation ends where a first handover does: a key on screen that has to be saved.
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
      <p>MOS makes a new key, changes this server&rsquo;s system drive over to it, and changes every backup it can reach over to it. The key you have now stops opening them.</p>
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
      {/* The one thing rotation does not undo, said without hedging. */}
      <Notice title="What changing the key does not undo" variant="warning">
        <p>Your system drive and every backup from now on need the new key. Anyone who already had the old key <strong>and</strong> a copy of your storage can still read the backups that existed before today. If you think that happened, start a fresh archive rather than trusting this one.</p>
      </Notice>
      {rotation.pending.length ? <Notice title="Some copies still open with your old key" variant="info">
        <p>{rotation.pending.map((entry) => entry.label).join(', ')} {rotation.pending.length === 1 ? 'was' : 'were'} not attached, so {rotation.pending.length === 1 ? 'it keeps' : 'they keep'} the old key until next plugged in. MOS finishes the change by itself then; keep your old kit until it has.</p>
      </Notice> : null}
    </> : null}

    <p className="suite-meta">{keyState?.adoptedAt
      ? 'This key came from the server this one restored from. Taking that server’s place made its key this key, so everything here opens with it.'
      : 'This key was made on this server at your first backup. Backups another server wrote keep their own key: MOS holds that key to read them and never changes what is in them.'}</p>

    {opens.length ? <div className="suite-bk-key-list">
      <p className="mos-eyebrow">This key opens</p>
      {opens.map((archive) => <p key={archive.id}><Icon name={icon(archive)} /><strong>{archive.placeLabel}</strong><span>This server&rsquo;s backups</span></p>)}
    </div> : null}
    {others.length ? <div className="suite-bk-key-list is-missing">
      <p className="mos-eyebrow">This key does not open</p>
      {others.map((archive) => <p key={archive.id}><Icon name={icon(archive)} /><strong>{archive.placeLabel}</strong><span>{archive.keyState === 'borrowed'
        ? `Made by ${archive.writtenBy?.hostname || 'another server'} · opens with that server's key, kept here`
        : 'Made by another server · needs that server’s recovery key'}</span></p>)}
    </div> : null}

    {confirming && revealed ? <Checkbox checked={saved} disabled={locked} onChange={(event) => setSaved(event.currentTarget.checked)}>
      I have saved this recovery key somewhere I can still reach if this server is gone.
    </Checkbox> : null}

    {mode === 'reveal' && revealed ? <>
      <p className="suite-meta">If you think someone else has seen this key, change it. MOS makes a new one and moves this server&rsquo;s system drive and every backup it can reach over to it.</p>
      <button className="mos-btn mos-btn-ghost mos-btn-sm" disabled={locked} onClick={onStartRotation} type="button">
        <Icon name="key" />
        Change recovery key
      </button>
    </> : null}

    {error ? <Notice title="That did not work" variant="error"><p>{error}</p></Notice> : null}

    <AdvancedPanel facts={[
      { code: true, label: 'Key fingerprint', value: keyState?.fingerprint || 'unknown' },
      { code: true, label: 'Key file on this server', value: keyState?.keyFile || 'unknown' },
    ]} reveal="technical-mode" />
  </Dialog>;
}

// When automatic backups run and how many are kept. Where they go is the place
// selected on the page, stated here as a fact.
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
        helperText="Restore points you took yourself are never removed."
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

// Putting a restore point back. Everything that cannot be undone is said before the
// confirmation field, and a restore onto another server states what happens to the address.
export function RestoreDialog({ backup, busy, confirmation, onCancel, onConfirmation, onStart }: {
  backup: BackupEntry;
  busy: string;
  confirmation: string;
  onCancel: () => void;
  onConfirmation: (next: string) => void;
  onStart: () => void;
}) {
  const elsewhere = writtenElsewhere(backup);
  const domain = carriedDomain(backup);

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
    title={elsewhere ? `Make this server ${elsewhere}?` : 'Restore from this restore point'}
  >
    <p>This replaces everything on this server with the restore point from <strong>{whenWords(backup.createdAt)}</strong>. Your apps stop while it runs, and everyone is signed out at the end.</p>
    <p className="suite-meta">{backupDescription(backup)} · {backup.placeLabel}</p>
    {/* The estimate is the agent's, from this server's own jobs or a stated range. */}
    {backup.expect ? <p>{backup.expect.restore.sentence}</p> : null}
    {backup.expect?.restore.note ? <p className="suite-meta">{backup.expect.restore.note}</p> : null}
    <Notice title="A rescue copy is kept" variant="info">
      <p>MOS saves a complete copy of what is on this server now before it changes anything, so a restore that stops partway can be looked at rather than guessed about. Apps and app data added after this restore point are removed, so the system matches it exactly.</p>
    </Notice>

    {elsewhere ? <Notice title={`This restore point was made by ${elsewhere}`} variant="info">
      <p>This server becomes that server. It takes over {elsewhere}&rsquo;s recovery key, for these backups and this server&rsquo;s encrypted system drive, and the key it was installed with stops opening anything. Keep {elsewhere}&rsquo;s recovery kit: from now on it is this server&rsquo;s, and {backup.placeLabel} becomes one of this server&rsquo;s backup places.</p>
      <p>After restoring, sign in with that server&rsquo;s owner password. This server keeps its own console and SSH login; the other server&rsquo;s does not come along.</p>
    </Notice> : null}

    {domain ? <Notice title={`${domain} does not come with it`} variant="info">
      <p>That is the address of the server this restore point was written on, and a name points at one server at a time. Your suite comes back on <strong>this server&rsquo;s own address</strong> — the one you are reading this on — so you can sign in and use it as soon as the restore finishes.</p>
      <p>Anything set up against the old address keeps failing until that name points here: phone apps, desktop sync clients, browser extensions. Afterwards <strong>Settings</strong> offers <strong>{domain}</strong> back, and Backup &amp; Restore says what is left to do.</p>
      <p className="suite-meta">If the server that wrote this restore point is still running, turn it off before pointing the name here. Two servers answering for one suite means two copies of your data drifting apart.</p>
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

export function DeleteDialog({ backup, busy, onCancel, onDelete }: {
  backup: BackupEntry;
  busy: string;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [understood, setUnderstood] = useState(false);
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
      <button className="mos-btn mos-btn-danger" disabled={Boolean(busy) || !understood} onClick={onDelete} type="button">
        {busy === `delete:${backup.path}` ? <><Spinner />Deleting</> : 'Delete'}
      </button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title="Delete this restore point?"
  >
    <p>The restore point from <strong>{whenWords(backup.createdAt)}</strong> is removed from {backup.placeLabel} and cannot be brought back.</p>
    <p className="suite-meta">The space only this restore point was using is reclaimed, which can take a moment. Data still needed by other restore points is kept.</p>
    <Checkbox checked={understood} disabled={Boolean(busy)} onChange={(event) => setUnderstood(event.currentTarget.checked)}>
      I understand this restore point is gone for good.
    </Checkbox>
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
      helperText="Shown next to this restore point so you can tell them apart. Leave it empty to remove the note."
      label="What was happening when you took this backup?"
      maxLength={200}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder="e.g. Before installing a new app"
      rows={3}
      value={value}
    />
  </Dialog>;
}
