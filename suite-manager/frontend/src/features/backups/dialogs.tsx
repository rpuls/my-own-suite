import { useState } from 'react';

import { AdvancedPanel, Checkbox, Choice, Dialog, Icon, Notice, Panel, PanelItem, PanelList, SecretText, Select, Spinner, Stepper, TextArea, TextInput } from '../../components/ui';
import {
  RETENTION_OPTIONS,
  WEEKDAY_NAMES,
  backupDescription,
  browserTimeZone,
  clockValue,
  archiveKeyLine,
  destinationIconName,
  downloadKit,
  needsAddressChoice,
  whenWords,
  writtenElsewhere,
  type ArchiveKey,
  type BackupEntry,
  type BackupSchedule,
  type BackupStatus,
  type DestinationView,
  type ObjectDraft,
  type RecoveryKeyState,
  type RevealedRecoveryKey,
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
        {working ? <><Spinner />Opening</> : 'Open these backups'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={working} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!working) onCancel(); }}
    title="Enter recovery key"
  >
    <p>The backups in <strong>{view.label}</strong> were written by another server. Type that server&rsquo;s recovery key to read them. It starts with MOS-.</p>
    <p className="suite-meta">MOS keeps the key here to open this {view.destination.kind === 'object' ? 'bucket' : 'drive'} and changes nothing in the backups themselves.</p>
    <TextInput
      autoFocus
      disabled={working}
      helperText={error || "From that server's recovery kit. Capitals, spaces and dashes do not matter."}
      label="Recovery key"
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
export function RecoveryKeyDialog({ busy, error, keyState, mode, onAcknowledge, onClose, onReveal, revealed, views }: {
  busy: string;
  error: string;
  keyState: RecoveryKeyState | null;
  mode: 'reveal' | 'save';
  onAcknowledge: () => void;
  onClose: () => void;
  onReveal: (password: string) => void;
  revealed: RevealedRecoveryKey | null;
  views: DestinationView[];
}) {
  const [password, setPassword] = useState('');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const locked = Boolean(busy);
  const opens = views.filter((view) => !view.destination.locked);
  const missing = views.filter((view) => view.destination.locked);

  return <Dialog
    footer={mode === 'save'
      ? <>
          <button className="mos-btn mos-btn-primary" disabled={!saved || !revealed || locked} onClick={onAcknowledge} type="button">
            {busy === 'recovery-acknowledge' ? <><Spinner />Saving</> : 'Done'}
          </button>
        </>
      : <button className="mos-btn mos-btn-secondary" disabled={locked} onClick={onClose} type="button">Close</button>}
    onClose={() => { if (!locked) onClose(); }}
    title="Your recovery key"
  >
    <p>This key is the only thing that opens your backups on a new machine. If this server is lost and the key is lost, the backups cannot be read &mdash; not by us, not by anyone.</p>

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

    {revealed ? <>
      <SecretText label="recovery key" value={revealed.key} />
      <div className="suite-bk-key-actions">
        <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => {
          void navigator.clipboard?.writeText(revealed.key).then(() => setCopied(true)).catch(() => setCopied(false));
        }} type="button"><Icon name="copy" />{copied ? 'Copied' : 'Copy'}</button>
        <button className="mos-btn mos-btn-secondary mos-btn-sm" onClick={() => downloadKit(revealed)} type="button">
          <Icon name="upload" />Download recovery kit
        </button>
      </div>
      <p className="suite-meta">The kit is a plain text file with the key, where your backups are kept, and the steps to get everything back. It holds no access key or password for your storage provider.</p>
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

    {mode === 'save' && revealed ? <Checkbox checked={saved} disabled={locked} onChange={(event) => setSaved(event.currentTarget.checked)}>
      I have saved this recovery key somewhere I can still reach if this server is gone.
    </Checkbox> : null}

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
// confirmation field, and the one question a restore onto another machine has
// to ask — which machine answers for the address — is asked as a choice, before
// anything is touched.
export function RestoreDialog({ backup, busy, address, confirmation, onCancel, onAddress, onConfirmation, onStart, status }: {
  address: '' | 'copy' | 'move';
  backup: BackupEntry;
  busy: string;
  confirmation: string;
  onAddress: (next: 'copy' | 'move') => void;
  onCancel: () => void;
  onConfirmation: (next: string) => void;
  onStart: () => void;
  status: BackupStatus;
}) {
  const elsewhere = writtenElsewhere(backup, status);
  const asksAddress = needsAddressChoice(backup, status);

  return <Dialog
    footer={<>
      <button
        className="mos-btn mos-btn-primary"
        disabled={confirmation.trim().toUpperCase() !== 'RESTORE' || (asksAddress && !address) || Boolean(busy)}
        onClick={onStart}
        type="button"
      >{busy === 'restore' ? <><Spinner />Starting</> : 'Restore'}</button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title="Restore this backup"
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

    {elsewhere ? <Notice title={`This backup was written by ${elsewhere}`} variant="info">
      <p>This machine will become that server. After restoring, sign in with that server&rsquo;s owner password. This machine keeps its own console and SSH login; the other server&rsquo;s does not come along.</p>
    </Notice> : null}

    {asksAddress ? <>
      <p>This backup carries the address <strong>{backup.sourceDomain}</strong>. A name can point at one machine at a time, so choose before anything is touched:</p>
      <div role="radiogroup" aria-label="What to do with the address">
        <Choice
          checked={address === 'move'}
          description={`Apps answer at their old addresses again, so links, phone apps and browser extensions keep working. You point the name at this machine yourself afterwards, as after any address change.`}
          name="restore-address"
          onChange={() => onAddress('move')}
          value="move"
        >Move the address here</Choice>
        <Choice
          checked={address === 'copy'}
          description="Keep this machine's own address. The old machine keeps answering for that name, so links and connected devices still point at it. You can move the address here later under Settings."
          name="restore-address"
          onChange={() => onAddress('copy')}
          value="copy"
        >Restore as a copy</Choice>
      </div>
    </> : null}

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

// Disconnecting a bucket. Refused while it is the selected place, because the
// answer to "where do automatic backups go" must never become "nowhere" as a
// side effect of tidying up.
export function DisconnectDialog({ busy, onCancel, onDisconnect, view }: {
  busy: string;
  onCancel: () => void;
  onDisconnect: () => void;
  view: DestinationView;
}) {
  if (view.selected) {
    return <Dialog
      footer={<button className="mos-btn mos-btn-primary" onClick={onCancel} type="button">Got it</button>}
      onClose={onCancel}
      title="Choose another place first"
    >
      <p>This is where automatic backups go. Pick another place, then disconnect this one.</p>
    </Dialog>;
  }
  return <Dialog
    footer={<>
      <button className="mos-btn mos-btn-primary" disabled={Boolean(busy)} onClick={onDisconnect} type="button">
        {busy === `disconnect:${view.id}` ? <><Spinner />Disconnecting</> : 'Disconnect'}
      </button>
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title={`Disconnect ${view.label}?`}
  >
    <p>The backups stay in the storage. MOS just stops using it, and stops listing what is in it.</p>
    <p className="suite-meta">Connecting it again with the same details brings the list back.</p>
  </Dialog>;
}

const WIZARD_STEPS = ['Kind', 'Details', 'Name'];

export type WizardKind = '' | 'drive' | 'online';

export type ConnectionTest = { locked?: boolean; message: string; ok: boolean } | null;

// Reachable and empty, and reachable but holding another server's backups, are
// both connections that worked. Only the second needs a recovery key later, and
// that is a thing to do on the destination, not a reason to refuse it here.
function connected(result: ConnectionTest) {
  return Boolean(result && (result.ok || result.locked));
}

// Adding a place to keep backups, one question at a time. MOS finds drives on
// its own, so the drive branch is a list of what it found rather than a form;
// only storage rented online has details to type. Leaving the details step
// tries the connection and stays put if it did not work, so the owner never
// carries a wrong endpoint forward and finds out at the end. A kind MOS does
// not support is not offered: the list is what this version can actually do.
export function AddDestinationWizard({ busy, draft, drives, initialKind, onCancel, onChange, onFinish, onMount, onTest, testResult }: {
  busy: string;
  draft: ObjectDraft;
  drives: DestinationView[];
  initialKind: WizardKind;
  onCancel: () => void;
  onChange: (next: ObjectDraft) => void;
  onFinish: (useForAutomatic: boolean) => void;
  onMount: (view: DestinationView) => void;
  onTest: () => Promise<ConnectionTest>;
  testResult: ConnectionTest;
}) {
  const [kind, setKind] = useState<WizardKind>(initialKind);
  const [step, setStep] = useState(initialKind ? 1 : 0);
  const [useForAutomatic, setUseForAutomatic] = useState(true);
  const editing = Boolean(draft.id);
  const testing = busy === 'object-test';
  const field = (key: keyof ObjectDraft) => (event: { currentTarget: { value: string } }) => onChange({ ...draft, [key]: event.currentTarget.value });
  const complete = Boolean(draft.endpoint.trim() && draft.bucket.trim() && draft.accessKeyId.trim() && (draft.secretAccessKey.trim() || editing));
  const titles: Array<[string, string]> = [
    ['Where should the copy go?', 'Pick the kind of place. MOS then asks only for what that kind needs.'],
    kind === 'drive'
      ? ['A drive you plug in', 'MOS found these drives. Choose one to open — anything already on it is left alone.']
      : ['Storage you rent online', 'Your provider gives you these when you create the storage. Copy them across exactly, and MOS will try them before going on.'],
    ['Give it a name', 'This place answered and MOS can write to it. Name it and it joins the list.'],
  ];
  const [title, blurb] = titles[step] ?? titles[0] as [string, string];

  // Leaving the details step is the moment the connection is tried, so a wrong
  // endpoint is caught here rather than three screens later.
  async function leaveDetails() {
    if (connected(await onTest())) setStep(2);
  }

  const next = step === 0 || (step === 1 && kind === 'drive') ? ''
    : step === 1 ? (testing ? 'Trying it now...' : 'Connect and continue')
    : 'Add this destination';

  return <Dialog
    footer={<>
      {step > 0 && !testing ? <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => setStep(step - 1)} type="button">Back</button> : null}
      {next ? <button
        className="mos-btn mos-btn-primary"
        disabled={Boolean(busy) || (step === 1 && !complete)}
        onClick={() => { if (step === 1) void leaveDetails(); else onFinish(useForAutomatic); }}
        type="button"
      >{busy === 'object-save' ? <><Spinner />Adding</> : testing ? <><Spinner />{next}</> : next}</button> : null}
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={onCancel} type="button">Cancel</button>
    </>}
    onClose={() => { if (!busy) onCancel(); }}
    title="Add a backup destination"
  >
    <Stepper currentStepIndex={step} steps={WIZARD_STEPS} />
    <div>
      <h3 className="mos-card-title">{title}</h3>
      <p className="suite-meta">{blurb}</p>
    </div>

    {step === 0 ? <div className="suite-bk-kinds">
      <button className={`suite-bk-kind-card${kind === 'drive' ? ' is-picked' : ''}`} onClick={() => { setKind('drive'); setStep(1); }} type="button">
        <span><Icon name="usb-drive" /><strong>A drive you plug in</strong>{drives.length ? <span className="suite-bk-chip">{drives.length} found</span> : null}</span>
        <span>A USB drive or a disk in this server. Fastest to restore from, and you can put it in a drawer.</span>
      </button>
      <button className={`suite-bk-kind-card${kind === 'online' ? ' is-picked' : ''}`} onClick={() => { setKind('online'); setStep(1); }} type="button">
        <span><Icon name="cloud-storage" /><strong>Storage you rent online</strong><span className="suite-bk-chip">S3-compatible</span></span>
        <span>Storage from a provider, reached over the internet. The only kind that survives a fire or a theft at home.</span>
      </button>
      <p className="suite-meta">More kinds of place can be added to MOS later. When one arrives it appears in this list &mdash; nothing else on the page changes.</p>
    </div> : null}

    {step === 1 && kind === 'drive' ? (drives.length ? <Panel density="tight">
      <PanelList>
        {drives.map((view) => <PanelItem className="suite-bk-row" key={view.id}>
          <span />
          <div className="suite-bk-row-body">
            <div className="suite-bk-row-title"><span className="suite-bk-row-icon"><Icon name={destinationIconName(view.destination)} /></span><strong>{view.label}</strong></div>
            <p className="suite-bk-detail">{view.status}</p>
          </div>
          <div className="suite-bk-row-actions">
            <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={Boolean(busy)} onClick={() => onMount(view)} type="button">
              {busy === `mount:${view.id}` ? <><Spinner />Opening</> : 'Open this drive'}
            </button>
          </div>
        </PanelItem>)}
      </PanelList>
    </Panel> : <p className="suite-meta">No drive is waiting to be opened. Plug one into the server and it appears here within a few seconds.</p>) : null}

    {step === 1 && kind === 'online' ? <>
      <div className="suite-form-grid">
        <TextInput disabled={testing} helperText="Your provider's S3 address, for example https://s3.eu-central-003.backblazeb2.com." label="Address" onChange={field('endpoint')} placeholder="https://s3.example.com" value={draft.endpoint} />
        <TextInput disabled={testing} helperText="A bucket that already exists. MOS does not create one." label="Bucket" onChange={field('bucket')} placeholder="my-backups" value={draft.bucket} />
        <TextInput disabled={testing} helperText="Optional. Lets one bucket hold the backups of more than one server." label="Folder (optional)" onChange={field('folder')} placeholder="home-server" value={draft.folder} />
        <TextInput disabled={testing} helperText="Optional. Some providers need it; leave it empty if yours does not." label="Region" onChange={field('region')} placeholder="eu-central-1" value={draft.region} />
        <TextInput disabled={testing} helperText="Use a key that can only reach this bucket." label="Access key id" onChange={field('accessKeyId')} placeholder="AKIA…" value={draft.accessKeyId} />
        <TextInput disabled={testing} helperText={editing ? 'Leave empty to keep the key already saved.' : 'Stored on this server only, readable by root.'} label="Secret access key" onChange={field('secretAccessKey')} placeholder={editing ? 'Unchanged' : '••••••••'} type="password" value={draft.secretAccessKey} />
      </div>
      {testing ? <p className="suite-bk-working"><Spinner />Trying it now. This takes a few seconds.</p> : null}
      {!testing && testResult && !connected(testResult) ? <Notice title="That did not work" variant="error">
        <p>{testResult.message}</p>
      </Notice> : null}
    </> : null}

    {step === 2 ? <>
      <Notice title={testResult?.locked ? 'It works, and it already holds backups' : 'It works'} variant={testResult?.locked ? 'info' : 'success'}>
        <p>{testResult?.locked
          ? 'MOS reached this storage and can write to it. The backups already in it were written by another server — add it, then choose Enter recovery key on it to read them.'
          : 'MOS reached this storage and can write to it. It holds no backups yet.'}</p>
      </Notice>
      <TextInput autoFocus helperText="The name you will see on this page." label="Call it" onChange={field('label')} placeholder="Off-site bucket" value={draft.label} />
      <Checkbox checked={useForAutomatic} onChange={(event) => setUseForAutomatic(event.currentTarget.checked)}>
        Send automatic backups here from now on.
      </Checkbox>
    </> : null}
  </Dialog>;
}
