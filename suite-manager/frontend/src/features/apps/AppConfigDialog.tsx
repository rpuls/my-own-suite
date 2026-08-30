// One dialog for an app's configuration, opened in three states: before install
// with nothing to fill, before install with settings the package needs, and
// after install once it is running. Install is simply the first time it opens,
// which is why there is no separate "Prepare" surface and no second technical
// dialog — an owner configures an app in one place.
//
// Everything here is built from one element: a row, label left, value right,
// hairline between neighbours. The only distinction it draws is colour. A value
// the owner can type into is bright; a value they cannot change is grey and is
// stated as a fact rather than shown as a disabled field, because "not yet" and
// "this is how it is" are different sentences and a disabled input says the
// wrong one.
//
// What is *not* here is deliberate. Setup fields are never editable after
// install. They are seed values: the package reads most of them once, when it
// first starts, and the manifest cannot say which ones. Some feed two services
// at once — a database password that seeds the database on its first boot and
// is also the live credential the server connects with — so editing one
// afterwards would leave an app unable to reach its own storage, with nothing
// in the manifest to warn us. After install they are facts, and the app's own
// admin page is where they change.

import { useState } from 'react';

import { AdvancedPanel, Dialog, Notice, Row, RowAction, RowInput, RowSwitch, RowTrailing, RowValue, Rows, TextArea } from '../../components/ui';
import { ProgressSteps, setStep, type ProgressStep } from './ProgressSteps';
import type { Owner } from '../setup/types';

export type OwnerEnvEntry = {
  fingerprint: string | null;
  name: string;
  redactedLabel: string | null;
  secret: boolean;
  service: string;
  updatedAt: string;
  value?: unknown;
};

// A field the package asks for. `generated` means MOS makes the value itself
// and never shows the owner a box to fill.
export type SetupField = { default?: unknown; generated: boolean; id: string; label: string; required: boolean; secret: boolean; type: string };

// A stored setup value on an installed instance. A secret one carries a
// fingerprint and a label to render, never its value.
export type InstanceConfigEntry = { fingerprint: string | null; generated: boolean; key: string; redactedLabel: string | null; secret: boolean; source: string; updatedAt: string; value?: unknown };

export type SetupSource = { setup: { fields: SetupField[] } };

type EditorRow = {
  // Stable across re-renders so a row keeps its input focus while its name is
  // being typed, which a name-keyed list cannot do.
  key: string;
  name: string;
  secret: boolean;
  // Set once the owner uses the eye control, after which the name heuristic
  // stops second-guessing them: a decision they made explicitly must not be
  // undone by typing another character into the name.
  secretTouched: boolean;
  // Carried per row rather than taken from the dialog when saving: a row stored
  // against another service would otherwise be silently moved to this one.
  service: string;
  // The fingerprint of a hidden value already on the server. Present means the
  // row has something stored that the owner cannot see; editing is replace-only.
  stored: string | null;
  value: string;
};

type SaveStep = ProgressStep & { id: 'validate' | 'apply' | 'health' };

type SaveResult =
  | { errorCode: string; reason: string; status: 'rolled-back' }
  | { status: 'applied' };

type SaveResponse = SaveResult & {
  details?: Array<{ index: number; message: string }>;
  error?: string;
  instance?: { env?: OwnerEnvEntry[] } | null;
};

// Names that upstream projects use for things worth masking by default. The
// owner can flip any row either way; this only decides where the row starts.
const SECRET_LOOKING_NAME = /_(secret|token|key|password)$/iu;

const SAVE_STEPS: SaveStep[] = [
  { detail: 'Checking the names against the settings MOS manages.', id: 'validate', label: 'Checking variables', status: 'pending' },
  { detail: 'Rebuilding the app with its new environment.', id: 'apply', label: 'Applying', status: 'pending' },
  { detail: 'Waiting for the app to answer again. This can take a minute.', id: 'health', label: 'Checking the app came back', status: 'pending' },
];

// A manifest setup field carries one `label`, so an author with something to
// explain has nowhere to put it but that string — "Time zone, such as
// Europe/Amsterdam". A row wants a short label and a separate line of help, so
// a label that runs into its own explanation is split at the first natural
// break. A short label is left exactly as written, and the full text stays on
// the input's accessible name, so nothing an author wrote is lost.
//
// The real fix is a `help` field on the manifest, which is a change to a locked
// public contract and deliberately not made for a presentation problem.
const LABEL_SPLIT = /^(.{4,44}?)(?:\s[-–—]\s|,\s(?=such as\b)|\.\s+)(\S.*)$/su;

export function splitFieldLabel(label: string): { help: string; label: string } {
  const trimmed = label.trim();
  const match = LABEL_SPLIT.exec(trimmed);
  return match ? { help: match[2]!.trim(), label: match[1]!.trim() } : { help: '', label: trimmed };
}

// Non-secret manifest defaults may reference the signed-in owner
// (`${owner.name}`, `${owner.email}`) so setup forms open personalized.
export function ownerDefault(value: string, owner: Owner) {
  return value.replace(/\$\{owner\.email\}/gu, owner.email).replace(/\$\{owner\.name\}/gu, owner.name);
}

export function setupFieldsNeedInput(app: SetupSource) {
  return app.setup.fields.filter((field) => !field.generated);
}

export function initialSetupConfig(app: SetupSource, owner: Owner) {
  return Object.fromEntries(
    setupFieldsNeedInput(app).map((field) => [
      field.id,
      typeof field.default === 'string' ? ownerDefault(field.default, owner) : field.type === 'email' ? owner.email : '',
    ]),
  );
}

export function requiredSetupMissing(app: SetupSource, setupConfig: Record<string, string>) {
  return setupFieldsNeedInput(app).some((field) => field.required && !String(setupConfig[field.id] || '').trim());
}

let rowSequence = 0;
function nextKey() {
  rowSequence += 1;
  return `row-${rowSequence}`;
}

function rowsFrom(entries: OwnerEnvEntry[]): EditorRow[] {
  return entries.map((entry) => ({
    key: nextKey(),
    name: entry.name,
    secret: entry.secret,
    secretTouched: true,
    service: entry.service,
    stored: entry.secret ? entry.fingerprint : null,
    value: entry.secret ? '' : typeof entry.value === 'string' ? entry.value : String(entry.value ?? ''),
  }));
}

// A fingerprint is a sha256 of the value; the last few characters are enough to
// tell one stored secret from another without being anything on their own.
function fingerprintTail(fingerprint: string | null) {
  return fingerprint ? fingerprint.replace(/^sha256:/u, '').slice(-6) : '';
}

// People copy KEY=value blocks out of upstream documentation, so that is the
// shape this accepts. Blank lines and # comments are ignored; everything after
// the first = is the value, verbatim, quotes and all.
export function parsePastedVariables(text: string): { error: string; rows: Array<{ name: string; value: string }> } {
  const rows: Array<{ name: string; value: string }> = [];
  const lines = text.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return { error: `Line ${index + 1} is not a NAME=value line.`, rows: [] };
    }
    const name = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      return { error: `Line ${index + 1} does not start with a valid variable name.`, rows: [] };
    }
    rows.push({ name, value: trimmed.slice(separator + 1) });
  }
  if (!rows.length) return { error: 'There were no NAME=value lines to add.', rows: [] };
  return { error: '', rows };
}

// What a stored setup value says on the right of its row once the app is
// running. A generated value never had an owner behind it, so it says so; a
// secret the owner typed is masked; everything else is shown.
function factValue(field: SetupField, stored: InstanceConfigEntry | undefined) {
  if (field.generated || stored?.generated) {
    const tail = fingerprintTail(stored?.fingerprint ?? null);
    return <RowValue>{tail ? `Generated by MOS · ${tail}` : 'Generated by MOS'}</RowValue>;
  }
  if (field.secret || stored?.secret) return <RowValue mask />;
  const value = stored?.value;
  return <RowValue>{typeof value === 'string' ? value : String(value ?? '')}</RowValue>;
}

export function AppConfigDialog({
  appName,
  config,
  entries,
  fields,
  homepageAvailable,
  installed,
  installing,
  onClose,
  onInstall,
  onSaved,
  owner,
  packageId,
  running,
  service,
  webAddress,
}: {
  appName: string;
  config: InstanceConfigEntry[];
  entries: OwnerEnvEntry[];
  fields: SetupField[];
  homepageAvailable: boolean;
  // Two separate facts, and conflating them strands a half-installed app. An
  // instance row means the package's setup values are already stored, so they
  // are shown as facts and never collected again. A runtime that has been
  // applied is what makes the primary action Save rather than Install — an app
  // whose install stopped after the instance was created still has an install
  // to finish, and this dialog is where it is finished.
  installed: boolean;
  installing: boolean;
  onClose: () => void;
  onInstall: (options: { config: Record<string, string>; showOnHomepage: boolean }) => void;
  onSaved: () => Promise<void>;
  owner: Owner;
  packageId: string;
  running: boolean;
  service: string;
  webAddress: string;
}) {
  const [rows, setRows] = useState<EditorRow[]>(() => rowsFrom(entries));
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [setupConfig, setSetupConfig] = useState<Record<string, string>>(() => initialSetupConfig({ setup: { fields } }, owner));
  const [showOnHomepage, setShowOnHomepage] = useState(homepageAvailable);
  const [error, setError] = useState('');
  const [steps, setSteps] = useState<SaveStep[]>([]);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState('');
  const [copied, setCopied] = useState(false);

  const busy = saving || installing;
  const ownerFields = fields.filter((field) => !field.generated);
  const generatedFields = fields.filter((field) => field.generated);
  const storedFor = (id: string) => config.find((entry) => entry.key === id);
  // Nothing is collected once the values are stored, so nothing can be missing.
  const canInstall = installed || !requiredSetupMissing({ setup: { fields } }, setupConfig);

  const lede = installed
    ? ownerFields.length ? '' : `Nothing to set. ${appName} looks after its own settings.`
    : ownerFields.length ? `A few details before ${appName} starts.` : `Nothing to set up. ${appName} is ready to install as it is.`;

  // An instance exists but its runtime never came up: the values are already
  // stored, so there is nothing to fill in and the only thing left is to run
  // the install again.
  const resuming = installed && !running;

  function update(index: number, patch: Partial<EditorRow>) {
    setRows((current) => current.map((row, position) => (position === index ? { ...row, ...patch } : row)));
    setRowErrors((current) => {
      if (!(index in current)) return current;
      const next = { ...current };
      delete next[index];
      return next;
    });
  }

  function applyPaste() {
    const parsed = parsePastedVariables(pasteText);
    if (parsed.error) {
      setPasteError(parsed.error);
      return;
    }
    setRows((current) => {
      const next = [...current];
      for (const pasted of parsed.rows) {
        const existing = next.findIndex((row) => row.name === pasted.name);
        if (existing >= 0) next[existing] = { ...next[existing]!, stored: null, value: pasted.value };
        else next.push({ key: nextKey(), name: pasted.name, secret: SECRET_LOOKING_NAME.test(pasted.name), secretTouched: false, service, stored: null, value: pasted.value });
      }
      return next;
    });
    setPasteText('');
    setPasteError('');
    setPasteOpen(false);
    setRowErrors({});
  }

  // MOS on plain HTTP is a non-secure origin with no navigator.clipboard, which
  // is the normal state of a fresh install rather than an edge case. The
  // address stays selectable text, so failing quietly loses nothing.
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(webAddress);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch { /* selectable either way */ }
  }

  async function save() {
    setSaving(true);
    setError('');
    setResult(null);
    setRowErrors({});
    setSteps(SAVE_STEPS.map((step) => (step.id === 'validate' ? { ...step, status: 'running' } : step)));
    // The save is one round trip, so the stages advance on elapsed time rather
    // than on progress the server reports. They are genuinely ordered and the
    // first two are quick, so the display is only ever ahead of the truth by
    // seconds — and a failure response overwrites it with the stage that really
    // failed. Reporting per-stage progress properly means an operation record
    // the UI polls, which this one feature does not justify building.
    const timers = [
      window.setTimeout(() => setSteps((current) => setStep(setStep(current, 'validate', 'complete'), 'apply', 'running')), 900),
      window.setTimeout(() => setSteps((current) => setStep(setStep(current, 'apply', 'complete'), 'health', 'running')), 8_000),
    ];
    const failRunning = (current: SaveStep[]) => {
      const running = current.find((step) => step.status === 'running');
      return running ? setStep(current, running.id, 'failed') : current;
    };
    try {
      const response = await fetch(`/suite-manager/api/apps/packages/${encodeURIComponent(packageId)}/env`, {
        body: JSON.stringify({
          entries: rows.map((row) => ({
            name: row.name.trim(),
            secret: row.secret,
            service: row.service,
            // A hidden value the owner did not retype is submitted without one,
            // which the backend reads as "keep the stored secret".
            ...(row.secret && row.stored && !row.value ? {} : { value: row.value }),
          })),
        }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const body = await response.json().catch(() => ({})) as SaveResponse;
      if (!response.ok) {
        if (Array.isArray(body.details) && body.details.length) {
          setRowErrors(Object.fromEntries(body.details.map((detail) => [detail.index, detail.message])));
        }
        setSteps(failRunning);
        setError(typeof body.error === 'string' ? body.error : `Unable to save ${appName} settings.`);
        return;
      }
      setSteps((current) => setStep(setStep(current, 'validate', 'complete'), 'apply', 'complete'));
      if (body.status === 'rolled-back') {
        setSteps((current) => setStep(current, 'health', 'failed'));
        setResult(body);
      } else {
        setSteps((current) => setStep(current, 'health', 'complete'));
        setResult({ status: 'applied' });
      }
      // Re-seeded from what the server now holds, so a value just saved as
      // hidden flips to its stored, masked presentation rather than sitting
      // there as typed text.
      if (body.instance?.env) setRows(rowsFrom(body.instance.env));
      await onSaved();
    } catch (caught) {
      setSteps(failRunning);
      setError(caught instanceof Error ? caught.message : `Unable to save ${appName} settings.`);
    } finally {
      for (const timer of timers) window.clearTimeout(timer);
      setSaving(false);
    }
  }

  return <Dialog
    className="suite-app-config-dialog"
    footer={<>
      <button className="mos-btn mos-btn-ghost" disabled={busy} onClick={onClose} type="button">
        {result?.status === 'applied' ? 'Done' : 'Cancel'}
      </button>
      {running
        ? <button className="mos-btn mos-btn-primary" disabled={busy} onClick={() => void save()} type="button">{saving ? 'Saving...' : 'Save'}</button>
        : <button className="mos-btn mos-btn-primary" disabled={busy || !canInstall} onClick={() => onInstall({ config: { ...setupConfig }, showOnHomepage: homepageAvailable && showOnHomepage })} type="button">{installing ? 'Installing...' : 'Install'}</button>}
    </>}
    onClose={() => { if (!busy) onClose(); }}
    title={running ? `${appName} settings` : `Install ${appName}`}
  >
    {lede ? <p className="suite-app-config-lede">{lede}</p> : null}

    {result?.status === 'rolled-back' ? <Notice title="Your changes were put back" variant="error">
      <p>{result.reason}</p>
      <p className="suite-meta">{result.errorCode}</p>
    </Notice> : null}
    {result?.status === 'applied' ? <Notice title="Saved" variant="success">
      <p>{appName} restarted with the new variables and came back healthy.</p>
    </Notice> : null}

    {ownerFields.length ? <div className="suite-app-config-group">
      {installed ? <p className="suite-app-config-group-title">Set when {appName} was created</p> : null}
      <Rows lead={!installed}>
        {ownerFields.map((field) => {
          const { help, label } = splitFieldLabel(field.label);
          const stored = storedFor(field.id);
          // A fact carries only the one line worth reading — what MOS did with
          // the value. The field's own help explains how to *enter* a value,
          // which is advice for a box that is no longer there.
          if (installed) {
            return <Row
              help={field.secret ? `MOS used this once, when ${appName} was created. Change it inside ${appName}.` : undefined}
              key={field.id}
              label={label}
            >{factValue(field, stored)}</Row>;
          }
          return <Row
            help={field.secret ? `Set once. Later you change it inside ${appName}.` : help || undefined}
            helpTone={field.secret ? 'permanent' : 'muted'}
            key={field.id}
            label={label}
            layout="stacked"
          >
            <RowInput
              aria-label={field.label}
              autoComplete={field.secret ? 'new-password' : 'off'}
              disabled={busy}
              // Read before the updater: React clears currentTarget when the
              // handler returns, and an updater can run later than that.
              onChange={(event) => { const { value } = event.currentTarget; setSetupConfig((current) => ({ ...current, [field.id]: value })); }}
              spellCheck={false}
              state={field.required ? (String(setupConfig[field.id] || '').trim() ? 'filled' : 'missing') : undefined}
              type={field.secret ? 'password' : field.type === 'email' ? 'email' : field.type === 'url' ? 'url' : 'text'}
              value={setupConfig[field.id] || ''}
            />
          </Row>;
        })}
      </Rows>
    </div> : null}

    <Rows lead={!ownerFields.length}>
      {webAddress ? <Row label="Web address">
        <RowTrailing>
          <RowValue>{webAddress}</RowValue>
          {/* The confirmation is the icon, not a line of text: a row that grows
              by a line when you copy pushes everything under it down. */}
          <RowAction icon={copied ? 'check' : 'copy'} label={copied ? 'Address copied' : 'Copy web address'} onClick={() => void copyAddress()} />
        </RowTrailing>
      </Row> : null}

      {/* Only while installing: turning a shortcut back off again needs a
          remove-from-homepage path MOS does not have yet, and a switch that
          silently only works one way is worse than not offering it. */}
      {homepageAvailable && !running ? <RowSwitch
        checked={showOnHomepage}
        disabled={busy}
        label="Show on Homepage"
        onChange={(event) => setShowOnHomepage(event.currentTarget.checked)}
      /> : null}

      {/* Everything MOS generated, plus the variables an owner added. It sits
          behind technical controls because none of it is a decision an ordinary
          owner has to make — the app is configured correctly without it. */}
      <AdvancedPanel layout="row" reveal="technical-mode">
        {generatedFields.length || rows.length ? <Rows lead>
          {generatedFields.map((field) => <Row key={field.id} label={splitFieldLabel(field.label).label}>
            {factValue(field, storedFor(field.id))}
          </Row>)}
          {rows.map((row, index) => <div className="mos-row" key={row.key}>
            <div className="mos-row-main">
              <input
                aria-label="Variable name"
                autoComplete="off"
                className="mos-row-input suite-env-name"
                disabled={busy}
                // A name that reads like a credential starts masked, until the
                // owner says otherwise with the eye control beside it.
                onChange={(event) => update(index, {
                  name: event.currentTarget.value,
                  ...(row.secretTouched ? {} : { secret: SECRET_LOOKING_NAME.test(event.currentTarget.value) }),
                })}
                placeholder="EXAMPLE_API_KEY"
                spellCheck={false}
                value={row.name}
              />
              <RowTrailing>
                {row.secret && row.stored && !row.value ? <>
                  <RowValue mask />
                  <RowValue code>{fingerprintTail(row.stored)}</RowValue>
                  <RowAction disabled={busy} icon="refresh" label={`Replace ${row.name || 'this value'}`} onClick={() => update(index, { stored: null })} />
                </> : <RowInput
                  aria-label="Variable value"
                  autoComplete="off"
                  code
                  disabled={busy}
                  onChange={(event) => update(index, { value: event.currentTarget.value })}
                  spellCheck={false}
                  type={row.secret ? 'password' : 'text'}
                  value={row.value}
                />}
                <RowAction
                  disabled={busy}
                  icon={row.secret ? 'eye-off' : 'eye'}
                  label={row.secret ? `Stop hiding ${row.name || 'this value'}` : `Hide ${row.name || 'this value'}`}
                  onClick={() => update(index, { secret: !row.secret, secretTouched: true, stored: null, value: row.stored ? '' : row.value })}
                />
                <RowAction
                  danger
                  disabled={busy}
                  icon="x"
                  label={`Remove ${row.name || 'this variable'}`}
                  onClick={() => setRows((current) => current.filter((_item, position) => position !== index))}
                />
              </RowTrailing>
            </div>
            {rowErrors[index] ? <p className="mos-row-help mos-row-invalid" role="alert">{rowErrors[index]}</p> : null}
          </div>)}
        </Rows> : null}

        <p className="mos-row-help">
          Variables are given to the <code>{service}</code> service when {appName} starts. Add one only if the
          app&apos;s own documentation asked you to. A wrong value can stop it starting; MOS puts the previous
          settings back on its own if that happens.
        </p>

        <div className="suite-editor-actions">
          <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={() => setRows((current) => [...current, { key: nextKey(), name: '', secret: false, secretTouched: false, service, stored: null, value: '' }])} type="button">
            Add variable
          </button>
          <button className="mos-btn mos-btn-secondary" disabled={busy} onClick={() => setPasteOpen((open) => !open)} type="button">
            {pasteOpen ? 'Close paste box' : 'Paste variables'}
          </button>
        </div>

        {pasteOpen ? <div className="suite-env-paste">
          <TextArea
            disabled={busy}
            helperText="One NAME=value per line, the way upstream documentation writes them. Blank lines and lines starting with # are ignored."
            label="Paste variables"
            onChange={(event) => { setPasteText(event.currentTarget.value); setPasteError(''); }}
            placeholder={'EXAMPLE_CLIENT_ID=abc123\nEXAMPLE_CLIENT_SECRET=shh'}
            rows={5}
            spellCheck={false}
            value={pasteText}
          />
          {pasteError ? <p className="mos-row-help mos-row-invalid" role="alert">{pasteError}</p> : null}
          <div className="suite-editor-actions">
            <button className="mos-btn mos-btn-secondary" disabled={busy || !pasteText.trim()} onClick={applyPaste} type="button">Add these</button>
          </div>
        </div> : null}
      </AdvancedPanel>
    </Rows>

    {resuming ? <p className="mos-row-help">
      {appName} was set up but never finished starting. Install it again to pick up where it stopped &mdash;
      the settings above are already saved and are not asked for twice.
    </p> : null}
    {!canInstall ? <p className="mos-row-help mos-row-help-permanent">
      Fill in the highlighted settings to install {appName}.
    </p> : null}

    <ProgressSteps error={error} errorTitle={`${appName} settings need attention`} steps={steps} />
  </Dialog>;
}
