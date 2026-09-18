import { useEffect, useState } from 'react';

import { ServerLoginNotice } from '../../components/ServerLoginNotice';
import { AdvancedPanel, Icon, Notice, Panel, PanelBody, PanelHead, PanelItem, PanelList, Select, Spinner } from '../../components/ui';
import { jsonResponse } from '../../lib/api';
import { DestinationsPanel } from './DestinationsPanel';
import { RestorePointsPanel } from './RestorePointsPanel';
import {
  AddDestinationWizard,
  ArchiveKeysDialog,
  BackupDialog,
  DeleteDialog,
  DisconnectDialog,
  NoteDialog,
  RecoveryKeyDialog,
  RestoreDialog,
  ScheduleDialog,
  UnlockDialog,
  type ConnectionTest,
} from './dialogs';
import {
  EMPTY_OBJECT_DRAFT,
  activityLine,
  backupBlockReason,
  bannerState,
  browserTimeZone,
  countShare,
  destinationViews,
  isRunning,
  jobLine,
  jobWorkingLine,
  restoreAddressNote,
  restorePhaseWords,
  scheduleLive,
  scheduleSummary,
  stageWords,
  stepLine,
  whenWords,
  type BackupEntry,
  type BackupSchedule,
  type BackupStatus,
  type DestinationView,
  type ObjectDraft,
  type ArchiveKey,
  type RotationResult,
} from './model';
import { type RevealedRecoveryKey } from '../../components/RecoveryKeySecret';
import { readVaultView, startupOf, type VaultView } from '../../lib/vault';

type Dialog =
  | { kind: 'backup' }
  | { kind: 'delete'; backup: BackupEntry }
  | { kind: 'disconnect'; view: DestinationView }
  | { kind: 'key'; mode: 'reveal' | 'rotate' | 'save'; then?: () => Promise<void> }
  | { kind: 'note'; backup: BackupEntry; value: string }
  | { kind: 'restore'; backup: BackupEntry }
  | { kind: 'schedule' }
  | { kind: 'keys'; view: DestinationView }
  | { kind: 'unlock'; view: DestinationView }
  | { kind: 'wizard'; start: '' | 'drive' | 'online' }
  | null;

export function BackupsScreen() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [backupTargetId, setBackupTargetId] = useState('');
  const [backupNote, setBackupNote] = useState('');
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [restoreAddress, setRestoreAddress] = useState<'' | 'copy' | 'move'>('');
  const [restoreStarted, setRestoreStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState<'restore' | 'expired' | ''>('');
  const [activityOpen, setActivityOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [objectDraft, setObjectDraft] = useState<ObjectDraft>({ ...EMPTY_OBJECT_DRAFT });
  const [objectTest, setObjectTest] = useState<ConnectionTest>(null);
  const [revealedKey, setRevealedKey] = useState<RevealedRecoveryKey | null>(null);
  const [rotation, setRotation] = useState<RotationResult | null>(null);
  const [keyError, setKeyError] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [archiveKeys, setArchiveKeys] = useState<ArchiveKey[] | null>(null);
  const [archiveKeysError, setArchiveKeysError] = useState('');
  const [checking, setChecking] = useState('');
  // How this machine's disk opens, which decides what the key dialog says the
  // key is for. Read once: a vault is created at install and never appears or
  // disappears afterwards.
  const [vaultView, setVaultView] = useState<VaultView | null>(null);

  const activeJob = status?.currentJob || null;
  const running = restoreStarted || isRunning(activeJob);
  const restoreInFlight = restoreStarted || (activeJob?.kind === 'restore' && isRunning(activeJob));
  const backingUp = isRunning(activeJob) && activeJob?.kind !== 'restore' && activeJob?.kind !== 'validate' && activeJob?.kind !== 'delete';

  const views = destinationViews(status);
  const readyViews = views.filter((view) => view.selectable);
  const selected = views.find((view) => view.selected) || null;
  const backupTarget = readyViews.find((view) => view.id === backupTargetId)
    || (selected && selected.selectable ? selected : null)
    || readyViews[0]
    || null;
  const blockReason = status ? backupBlockReason(status, views, backupTarget) : '';
  const banner = bannerState(status, views, Boolean(backingUp));
  const workingLine = jobWorkingLine(activeJob);
  const recoveryKey = status?.recoveryKey || null;
  // Until the key is saved, taking a backup or enabling a schedule goes through
  // the dialog instead. The agent refuses them too, so a page left open from
  // before cannot slip past this.
  const keySaved = recoveryKey === null || recoveryKey.acknowledged;

  // Reads the status and nothing else. Every action calls this when it is done
  // and the idle poll calls it on its own, so it must not touch the busy state:
  // whichever action is in flight is what the screen should still be showing.
  async function load() {
    setError('');
    const response = await fetch('/suite-manager/api/backups/status');
    if (response.status === 401) {
      // A restore replaces Suite Manager state, so the session that started it
      // no longer exists once the restored control plane comes back.
      setSessionEnded(restoreInFlight ? 'restore' : 'expired');
      setStatus(null);
      setRestoreStarted(false);
      return;
    }
    const next = await jsonResponse<BackupStatus>(response, 'Unable to load backups.');
    setStatus(next);
    if (!isRunning(next.currentJob) && restoreStarted) setRestoreStarted(false);
    if (!isRunning(next.currentJob) && checking) setChecking('');
  }

  useEffect(() => { void load().catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to load backups.')); }, []);
  // A failure here is silent on purpose. It only decides one sentence in the key
  // dialog, and the fallback sentence — the key opens your backups — is true on
  // every machine; the screen must not refuse to load backups over it.
  useEffect(() => {
    let cancelled = false;
    void readVaultView()
      .then((view) => { if (!cancelled) setVaultView(view); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // A scheduled backup starts without anyone clicking anything, so an open page
  // polls slowly even when idle — otherwise the screen keeps showing "nothing
  // is happening" through an automatic backup it never noticed.
  useEffect(() => {
    if (!running && !status?.schedule?.enabled) return undefined;
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, running ? 4000 : 30000);
    return () => window.clearInterval(timer);
  }, [running, status?.schedule?.enabled]);
  // Leaving or refreshing mid-restore drops the operator onto a raw server
  // error page while the control plane is intentionally down; browsers only
  // show a generic confirmation, so the patient-waiting guidance lives in the
  // visible restore panel instead.
  useEffect(() => {
    if (!restoreInFlight) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [restoreInFlight]);

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await action();
      await load();
    } catch (caught) {
      // Refresh first so the page reflects reality (a vanished drive, a
      // finished job) before the error shows — load() clears the banner, so
      // the order matters.
      await load().catch(() => undefined);
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  }

  async function post<T>(path: string, body: unknown, message: string) {
    return jsonResponse<T>(await fetch(`/suite-manager/api/backups/${path}`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }), message);
  }

  // The gate. Anything that would create a backup only this machine can read
  // runs through here; everything else — mounting, connecting, listing,
  // restoring — is deliberately not gated, because a replacement machine has to
  // reach the surviving destination before it can enter the key that opens it.
  function gateOnRecoveryKey(run: () => Promise<void>) {
    if (keySaved) {
      void run();
      return;
    }
    setKeyError('');
    setDialog({ kind: 'key', mode: 'save', then: run });
    void revealRecoveryKey('');
  }

  async function revealRecoveryKey(password: string) {
    setBusy('recovery-reveal');
    setKeyError('');
    try {
      setRevealedKey(await post<RevealedRecoveryKey>('recovery-key/reveal', { password }, 'Unable to show the recovery key.'));
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : 'Unable to show the recovery key.');
    } finally {
      setBusy('');
    }
  }

  // Changing the key. The new one is shown in the same dialog the first one was
  // shown in, with the same confirmation, because there is one place an owner
  // ever reads a recovery key and it should not matter which of the two
  // occasions brought them there.
  async function rotateRecoveryKey(password: string) {
    setBusy('recovery-rotate');
    setKeyError('');
    try {
      const result = await post<RotationResult & RevealedRecoveryKey>('recovery-key/rotate', { password }, 'Unable to change the recovery key.');
      if (result.ok === false) {
        setKeyError(result.sentence || 'Unable to change the recovery key.');
        return;
      }
      setRotation({ destinations: result.destinations || [], pending: result.pending || [] });
      setRevealedKey(result);
      await load().catch(() => undefined);
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : 'Unable to change the recovery key.');
    } finally {
      setBusy('');
    }
  }

  async function acknowledgeRecoveryKey() {
    const pending = dialog?.kind === 'key' ? dialog.then : undefined;
    setBusy('recovery-acknowledge');
    setKeyError('');
    try {
      await post('recovery-key/acknowledge', {}, 'Unable to record that you saved the recovery key.');
      closeDialog();
      await load().catch(() => undefined);
      if (pending) await pending();
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : 'Unable to record that you saved the recovery key.');
    } finally {
      setBusy('');
    }
  }

  // The key is held only while its dialog is open: nothing keeps it in the page
  // once the owner is done with it.
  function closeDialog() {
    setDialog(null);
    setRevealedKey(null);
    setRotation(null);
    setKeyError('');
    setUnlockError('');
  }

  async function unlockDestination(view: DestinationView, recoveryKeyInput: string) {
    setBusy(`unlock:${view.id}`);
    setUnlockError('');
    try {
      await post('destinations/unlock', { destinationId: view.id, recoveryKey: recoveryKeyInput }, 'Unable to unlock these backups.');
      closeDialog();
      await load().catch(() => undefined);
    } catch (caught) {
      setUnlockError(caught instanceof Error ? caught.message : 'Unable to unlock these backups.');
    } finally {
      setBusy('');
    }
  }

  // Who can open an archive. The key is entered here and used for the read; it
  // is never kept, which is why removing one asks for it again.
  async function listArchiveKeys(view: DestinationView, recoveryKeyInput: string) {
    setBusy(`keys:${view.id}`);
    setArchiveKeysError('');
    try {
      const result = await post<{ result: { keys: ArchiveKey[] } }>('destinations/keys', { destinationId: view.id, recoveryKey: recoveryKeyInput }, 'Unable to read the keys on this archive.');
      setArchiveKeys(result?.result?.keys || []);
    } catch (caught) {
      setArchiveKeysError(caught instanceof Error ? caught.message : 'Unable to read the keys on this archive.');
    } finally {
      setBusy('');
    }
  }

  async function removeArchiveKey(view: DestinationView, recoveryKeyInput: string, keyId: string) {
    setBusy(`key-remove:${keyId}`);
    setArchiveKeysError('');
    try {
      await post('destinations/keys/remove', { destinationId: view.id, keyId, recoveryKey: recoveryKeyInput }, 'Unable to remove that key.');
      setBusy(`keys:${view.id}`);
      const result = await post<{ result: { keys: ArchiveKey[] } }>('destinations/keys', { destinationId: view.id, recoveryKey: recoveryKeyInput }, 'Unable to read the keys on this archive.');
      setArchiveKeys(result?.result?.keys || []);
    } catch (caught) {
      setArchiveKeysError(caught instanceof Error ? caught.message : 'Unable to remove that key.');
    } finally {
      setBusy('');
    }
  }

  // Handing the key back. Only this machine forgets it: the archive it opens
  // was never changed and is not changed now.
  async function forgetDestinationKey(view: DestinationView) {
    await runAction(`forget-key:${view.id}`, async () => {
      await post('destinations/forget-key', { destinationId: view.id }, 'Unable to forget this key.');
    });
  }
  // Forgetting a drive MOS is not holding. It stops MOS saying a copy of the
  // owner's data is out there on that drive, which is worth stopping once it is
  // no longer true — and it touches nothing on the drive, which is not here.
  async function forgetDrive(view: DestinationView) {
    await runAction(`forget-drive:${view.id}`, async () => {
      await post('destinations/forget-drive', { fsUuid: view.destination.fsUuid || '' }, 'Unable to forget this drive.');
    });
  }

  async function mount(view: DestinationView) {
    await runAction(`mount:${view.id}`, async () => {
      const result = await post<{ destination: { id: string } }>('mount', { destinationId: view.id }, 'Unable to open this drive.');
      if (!selected) await choosePrimaryQuietly(result.destination.id);
      setDialog(null);
    });
  }

  // Selecting a place is the one choice on this screen: it is where the
  // schedule and the backup before a MOS update write, and the default for a
  // backup taken by hand.
  async function choosePrimaryQuietly(destinationId: string) {
    await post('primary', { destinationId }, 'Unable to select this destination.');
  }

  async function choosePrimary(view: DestinationView) {
    if (view.selected) return;
    setBackupTargetId('');
    await runAction(`primary:${view.id}`, () => choosePrimaryQuietly(view.id));
  }

  async function startBackup() {
    if (!backupTarget) return;
    await runAction('backup', async () => {
      await post('start', { destinationId: backupTarget.id, note: backupNote }, 'Unable to start backup.');
      setBackupNote('');
      setDialog(null);
    });
  }

  // The stored time zone is preserved rather than overwritten with this
  // browser's: opening MOS from a laptop in another country must not quietly
  // move a home server's backup window.
  async function saveSchedule(next: BackupSchedule) {
    const current = status?.schedule;
    if (!current) return;
    await runAction('schedule', async () => {
      await post('schedule', {
        enabled: next.enabled,
        frequency: next.frequency,
        hour: next.hour,
        keepLast: next.keepLast,
        minute: next.minute,
        timeZone: current.timeZone || browserTimeZone(),
        weekday: next.weekday,
      }, 'Unable to save the backup schedule.');
      setDialog(null);
    });
  }

  // The test reports into the dialog rather than the page banner, because it is
  // an answer about what is on screen and the owner is about to act on it.
  async function testObjectStorage(): Promise<ConnectionTest> {
    setBusy('object-test');
    setObjectTest(null);
    try {
      const response = await post<{ result: ConnectionTest }>('destinations/object/test', objectDraft, 'Unable to reach this storage.');
      setObjectTest(response.result);
      return response.result;
    } catch (caught) {
      const failed = { message: caught instanceof Error ? caught.message : 'Unable to reach this storage.', ok: false };
      setObjectTest(failed);
      return failed;
    } finally {
      setBusy('');
    }
  }

  async function saveObjectStorage(useForAutomatic: boolean) {
    const draft = objectDraft;
    await runAction('object-save', async () => {
      const saved = await post<{ destination: { id: string } }>('destinations/object', draft, 'Unable to save this storage connection.');
      if (useForAutomatic && saved?.destination?.id) await choosePrimaryQuietly(saved.destination.id);
      setObjectDraft({ ...EMPTY_OBJECT_DRAFT });
      setObjectTest(null);
      setDialog(null);
    });
  }

  async function disconnectObjectStorage(view: DestinationView) {
    setDialog(null);
    await runAction(`disconnect:${view.id}`, async () => {
      await post('destinations/object/remove', { destinationId: view.id }, 'Unable to disconnect this storage.');
      if (backupTargetId === view.id) setBackupTargetId('');
    });
  }

  async function acknowledgeInterrupted() {
    await runAction('acknowledge', async () => {
      await post('restore/acknowledge', { confirmation: 'ACKNOWLEDGE' }, 'Unable to dismiss the interrupted restore record.');
    });
  }

  async function checkBackup(backup: BackupEntry) {
    setChecking(backup.path);
    await runAction(`validate:${backup.path}`, async () => {
      await post('validate', { backupPath: backup.path }, 'Unable to check this backup.');
    });
  }

  async function saveNote(backup: BackupEntry, note: string) {
    setDialog(null);
    await runAction(`note:${backup.path}`, async () => {
      await post('note', { backupPath: backup.path, note }, 'Unable to save the backup note.');
    });
  }

  async function deleteBackup(backup: BackupEntry) {
    await runAction(`delete:${backup.path}`, async () => {
      await post('delete', { backupPath: backup.path }, 'Unable to delete this backup.');
      setDialog(null);
    });
  }

  async function startRestore(backup: BackupEntry) {
    setBusy('restore');
    setError('');
    try {
      await post('restore', {
        ...(restoreAddress ? { address: restoreAddress } : {}),
        backupPath: backup.path,
        confirmation: restoreConfirmation,
      }, 'Unable to start restore.');
      setDialog(null);
      setRestoreConfirmation('');
      setRestoreAddress('');
      setRestoreStarted(true);
      await load().catch(() => undefined);
    } catch (caught) {
      await load().catch(() => undefined);
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  }

  function openKey(mode: 'reveal' | 'rotate' | 'save') {
    setKeyError('');
    setRevealedKey(null);
    setRotation(null);
    setDialog({ kind: 'key', mode });
    if (mode === 'save') void revealRecoveryKey('');
  }

  function destinationAction(view: DestinationView) {
    if (view.action === 'unlock') { setUnlockError(''); setDialog({ kind: 'unlock', view }); return; }
    if (view.action === 'mount') { void mount(view); return; }
    if (view.action === 'retest') void runAction(`retest:${view.id}`, async () => undefined);
  }

  const hero = <div className="suite-hero">
    <h1>Backup &amp; Restore</h1>
    <p className="suite-lead mos-body-lg">A backup is a complete copy of your suite &mdash; your apps and everything in them. Keep it somewhere other than this machine, and you can get everything back.</p>
  </div>;

  // The status read probes every destination, so it can take several seconds
  // on a machine with a bucket attached. Until it lands the page has nothing
  // true to say, and a headline over an empty page reads as broken, not busy.
  if (!status && !error && !sessionEnded) {
    return <section className="mos-shell suite-backups">
      <div className="mos-page">
        {hero}
        <Panel>
          <PanelBody>
            <p className="suite-bk-working"><Spinner />Loading your backups</p>
          </PanelBody>
        </Panel>
      </div>
    </section>;
  }

  if (status?.serverLoginUnsaved) {
    return <section className="mos-shell suite-backups">
      <div className="mos-page">
        {hero}
        <ServerLoginNotice what="Backups and restores" />
      </div>
    </section>;
  }

  // A restore takes the page over. Nothing else on it is reachable or true
  // while the machine is being replaced by the backup.
  if (restoreInFlight) {
    const progress = activeJob?.progress || null;
    const count = progress?.count || null;
    return <section className="mos-shell suite-backups">
      <div className="mos-page">
        {hero}
        <Panel>
          <PanelHead title={progress?.headline || 'Restoring your backup'}>
            <p className="suite-bk-working"><Spinner />{stageWords(activeJob)}{stepLine(progress)}</p>
            {count ? <>
              <p className="suite-meta">{count.sentence}{count.note ? ` ${count.note}` : ''}</p>
              <div className="suite-bk-bar"><span style={{ width: `${countShare(count)}%` }} /></div>
            </> : null}
          </PanelHead>
          {progress?.plan.length ? <PanelList>
            {progress.plan.map((entry, index) => <PanelItem className={`suite-bk-step is-${entry.state}`} key={index} quiet={entry.state === 'next'}>
              <span className={`suite-bk-dot is-${entry.state === 'next' ? 'muted' : 'ready'}`} />
              <span>{entry.sentence}</span>
            </PanelItem>)}
          </PanelList> : null}
          <PanelBody>
            <p className="suite-meta">{progress?.expect?.sentence ? `${progress.expect.sentence} ` : ''}Your apps are stopped while it runs. <strong>Do not turn the machine off.</strong> When it is done everyone is signed out, because this becomes the restored server.</p>
          </PanelBody>
        </Panel>
      </div>
    </section>;
  }

  return <section className="mos-shell suite-backups">
    <div className="mos-page">
      {hero}

      {error ? <Notice title="Backup needs attention" variant="error"><p>{error}</p></Notice> : null}
      {sessionEnded ? <Notice title={sessionEnded === 'restore' ? 'The restore signed you out' : 'Your session ended'} variant="info">
        <p>{sessionEnded === 'restore'
          ? 'The restore is done. Everyone is signed out because this is now the restored server. Sign in with the password you used on the machine you restored — accounts and passwords now match the backup, not what was set just before the restore.'
          : 'Sign in again to manage backups.'}</p>
        <button className="mos-btn mos-btn-primary" onClick={() => window.location.reload()} type="button">Go to sign-in</button>
      </Notice> : null}

      {status && !status.serviceAvailable ? <Notice title="Backup is not available yet" variant="warning">
        <p>The host backup service is not running on this install. Update or restart the MOS host services, then come back here.</p>
      </Notice> : null}

      {status?.serviceAvailable ? <div className="suite-bk-page" aria-busy={running}>
        {/* A block is the answer to "am I safe", so it takes that slot rather
            than sitting beside it. Never more than one at a time. */}
        {status.interruptedRestore ? <Notice title="A restore did not finish" variant="error">
          <p>A restore stopped {restorePhaseWords(status.interruptedRestore.phase)}, so this system may not match the backup it was restoring. Your suite is as it was before it started, and a complete rescue copy of what was in progress is kept on the server. Backups and restores stay paused until you have read this.</p>
          <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => void acknowledgeInterrupted()} type="button">
            {busy === 'acknowledge' ? <><Spinner />Unblocking</> : 'I have read this'}
          </button>
        </Notice> : views.length ? <section className={`mos-panel suite-bk-banner is-${banner.tone}`}>
          <div className="suite-bk-banner-text">
            <span className={`suite-bk-dot is-${banner.tone}`} />
            <div>
              <strong>{banner.title}</strong>
              <p className="suite-meta">{banner.detail}</p>
            </div>
          </div>
          <div className="suite-bk-banner-action">
            {backingUp ? <p className="suite-bk-working"><Spinner />{jobLine(activeJob)}. Apps come back on their own.</p>
              : workingLine ? <p className="suite-bk-working"><Spinner />{workingLine}</p> : <>
              <div className="suite-bk-backup-controls">
                {readyViews.length > 1 && !blockReason ? <Select
                  aria-label="Where to back up"
                  disabled={Boolean(busy) || running}
                  onChange={(event) => setBackupTargetId(event.currentTarget.value)}
                  value={backupTarget?.id || ''}
                >
                  {readyViews.map((view) => <option key={view.id} value={view.id}>
                    {view.selected ? `Back up to ${view.label} (the usual place)` : `Back up to ${view.label}`}
                  </option>)}
                </Select> : null}
                <button
                  className="mos-btn mos-btn-primary"
                  disabled={Boolean(blockReason) || Boolean(busy) || running}
                  onClick={() => gateOnRecoveryKey(async () => setDialog({ kind: 'backup' }))}
                  type="button"
                >Back up now</button>
              </div>
            </>}
          </div>
          {!backingUp && !workingLine && (blockReason || (backupTarget && !backupTarget.selected && readyViews.length > 1))
            ? <div className="suite-bk-banner-note">
              {blockReason ? <p className="suite-bk-detail">{blockReason}</p> : null}
              {backupTarget && !backupTarget.selected && readyViews.length > 1
                ? <p className="suite-bk-detail">This one backup goes to {backupTarget.label}. Automatic backups still go to {selected ? selected.label : 'the selected place'}.</p>
                : null}
            </div>
            : null}
        </section> : null}

        {/* A fresh install has nothing to schedule, nothing to restore and
            nothing to report, so it shows one question instead of four empty
            sections. */}
        {views.length ? null : <Panel>
          <PanelBody>
          <h2 className="mos-card-title">You have no backups yet.</h2>
          <p className="suite-meta">Choose where they should go &mdash; a drive you plug into this server, or storage you rent online. You can add the other one later.</p>
          <div className="suite-bk-kinds">
            <button className="suite-bk-kind-card" onClick={() => setDialog({ kind: 'wizard', start: 'drive' })} type="button">
              <span><Icon name="usb-drive" /><strong>Use a drive</strong></span>
              <span>Plug a USB drive into this server. Fastest to restore from.</span>
            </button>
            <button className="suite-bk-kind-card" onClick={() => setDialog({ kind: 'wizard', start: 'online' })} type="button">
              <span><Icon name="cloud-storage" /><strong>Connect storage online</strong></span>
              <span>Storage you rent from a provider. Survives a fire or a theft at home.</span>
            </button>
          </div>
          </PanelBody>
        </Panel>}

        {views.length ? <DestinationsPanel
          busy={busy}
          onAction={destinationAction}
          onAdd={() => { setObjectDraft({ ...EMPTY_OBJECT_DRAFT }); setObjectTest(null); setDialog({ kind: 'wizard', start: '' }); }}
          onDisconnect={(view) => setDialog({ kind: 'disconnect', view })}
          onForgetDrive={(view) => void forgetDrive(view)}
          onForgetKey={(view) => void forgetDestinationKey(view)}
          onKeys={(view) => { setArchiveKeys(null); setArchiveKeysError(''); setDialog({ kind: 'keys', view }); }}
          onEdit={(view) => {
            const destination = view.destination;
            setObjectDraft({
              accessKeyId: destination.accessKeyId || '',
              bucket: destination.bucket || '',
              endpoint: destination.endpoint || '',
              folder: destination.folder || '',
              id: destination.id,
              label: destination.label,
              region: destination.region || '',
              secretAccessKey: '',
            });
            setObjectTest(null);
            setDialog({ kind: 'wizard', start: 'online' });
          }}
          onSelect={(view) => void choosePrimary(view)}
          onShowKey={() => openKey(keySaved ? 'reveal' : 'save')}
          running={running}
          views={views}
        /> : null}

        {views.length && status.schedule ? <Panel>
          <PanelHead
            actions={<button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={Boolean(busy) || running} onClick={() => setDialog({ kind: 'schedule' })} type="button">Change</button>}
            title="Automatic backups"
          >
            <strong>{scheduleSummary(status.schedule, selected)}</strong>
            <p className={`suite-bk-status is-${scheduleLive(status.schedule, selected).tone}`}>
              <span className={`suite-bk-dot is-${scheduleLive(status.schedule, selected).tone}`} />
              {scheduleLive(status.schedule, selected).text}
            </p>
          </PanelHead>
        </Panel> : null}

        {views.length ? <RestorePointsPanel
          busy={busy}
          checking={checking}
          onCheck={(backup) => void checkBackup(backup)}
          onDelete={(backup) => setDialog({ kind: 'delete', backup })}
          onEditNote={(backup) => setDialog({ kind: 'note', backup, value: backup.note || '' })}
          onRestore={(backup) => { setRestoreConfirmation(''); setRestoreAddress(''); setDialog({ kind: 'restore', backup }); }}
          running={running}
          status={status}
          views={views}
        /> : null}

        {views.length ? <Panel>
          <button aria-expanded={activityOpen} className="suite-bk-activity-head" onClick={() => setActivityOpen(!activityOpen)} type="button">
            <span className={`suite-bk-chevron${activityOpen ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
            <strong>Recent activity</strong>
            <span className="suite-bk-detail">{status.recentJobs?.[0] ? activityLine(status.recentJobs[0], views) : 'Nothing has happened yet.'}</span>
          </button>
          {activityOpen ? <PanelBody className="suite-bk-activity-body">
            {(status.recentJobs || []).map((job) => <p key={job.id}>
              <span className="suite-bk-point-when">{whenWords(job.updatedAt)}</span>
              <span>{activityLine(job, views)}</span>
            </p>)}
            {restoreAddressNote(status.lastJob) ? <p className="suite-meta">{restoreAddressNote(status.lastJob)}</p> : null}
            <AdvancedPanel
              facts={[
                { label: 'Detected apps', value: String(status.inventory?.summary.appCount ?? 0) },
                { label: 'Detected app data stores', value: String(status.inventory?.summary.declaredVolumeCount ?? 0) },
                { label: 'App connections', value: String(status.inventory?.summary.relationshipCount ?? 0) },
                { label: 'Warnings', value: status.inventory?.warnings.map((warning) => `${warning.packageId}: ${warning.message}`).join(', ') || 'None' },
                { label: 'Storage engine', value: status.backups.find((backup) => backup.engineName)?.engineName || 'unknown' },
                { label: 'Restore guarantee', value: status.restoreGuarantee || 'unknown' },
                { code: true, label: 'Recovery key fingerprint', value: recoveryKey?.fingerprint || 'unknown' },
                { code: true, label: 'This machine', value: status.hostname || 'unknown' },
              ]}
              output={status.lastJob?.error ? (status.lastJob.logs || []).map((entry) => entry.message || '').join('\n') : undefined}
              reveal={status.lastJob?.status === 'failed' ? 'on-failure' : 'technical-mode'}
            />
          </PanelBody> : null}
        </Panel> : null}
      </div> : null}

      {dialog?.kind === 'backup' && backupTarget ? <BackupDialog
        busy={busy}
        note={backupNote}
        onCancel={closeDialog}
        onChange={setBackupNote}
        onStart={() => void startBackup()}
        target={backupTarget}
      /> : null}

      {dialog?.kind === 'key' ? <RecoveryKeyDialog
        busy={busy}
        error={keyError}
        keyState={recoveryKey}
        mode={dialog.mode}
        startup={startupOf(vaultView)}
        onAcknowledge={() => void acknowledgeRecoveryKey()}
        onClose={closeDialog}
        onReveal={(password) => void revealRecoveryKey(password)}
        onRotate={(password) => void rotateRecoveryKey(password)}
        onStartRotation={() => openKey('rotate')}
        revealed={revealedKey}
        rotation={rotation}
        views={views}
      /> : null}

      {dialog?.kind === 'keys' ? <ArchiveKeysDialog
        busy={busy}
        error={archiveKeysError}
        keys={archiveKeys}
        onClose={closeDialog}
        onList={(entered) => void listArchiveKeys(dialog.view, entered)}
        onRemove={(entered, keyId) => void removeArchiveKey(dialog.view, entered, keyId)}
        view={dialog.view}
      /> : null}

      {dialog?.kind === 'unlock' ? <UnlockDialog
        busy={busy}
        error={unlockError}
        onCancel={closeDialog}
        onUnlock={(entered) => void unlockDestination(dialog.view, entered)}
        view={dialog.view}
      /> : null}

      {dialog?.kind === 'schedule' && status?.schedule ? <ScheduleDialog
        busy={busy}
        onCancel={closeDialog}
        onSave={(next) => {
          const merged = { ...(status.schedule as BackupSchedule), ...next };
          if (merged.enabled) gateOnRecoveryKey(() => saveSchedule(merged));
          else void saveSchedule(merged);
        }}
        schedule={status.schedule}
        selected={selected}
      /> : null}

      {dialog?.kind === 'restore' ? <RestoreDialog
        address={restoreAddress}
        backup={dialog.backup}
        busy={busy}
        confirmation={restoreConfirmation}
        onAddress={setRestoreAddress}
        onCancel={closeDialog}
        onConfirmation={setRestoreConfirmation}
        onStart={() => void startRestore(dialog.backup)}
        status={status as BackupStatus}
      /> : null}

      {dialog?.kind === 'delete' ? <DeleteDialog
        backup={dialog.backup}
        busy={busy}
        onCancel={closeDialog}
        onDelete={() => void deleteBackup(dialog.backup)}
      /> : null}

      {dialog?.kind === 'note' ? <NoteDialog
        backup={dialog.backup}
        busy={busy}
        onCancel={closeDialog}
        onChange={(value) => setDialog({ kind: 'note', backup: dialog.backup, value })}
        onSave={() => void saveNote(dialog.backup, dialog.value)}
        value={dialog.value}
      /> : null}

      {dialog?.kind === 'disconnect' ? <DisconnectDialog
        busy={busy}
        onCancel={closeDialog}
        onDisconnect={() => void disconnectObjectStorage(dialog.view)}
        view={dialog.view}
      /> : null}

      {dialog?.kind === 'wizard' ? <AddDestinationWizard
        busy={busy}
        draft={objectDraft}
        drives={views.filter((view) => view.action === 'mount')}
        initialKind={dialog.start}
        onCancel={() => { setObjectDraft({ ...EMPTY_OBJECT_DRAFT }); setObjectTest(null); closeDialog(); }}
        onChange={setObjectDraft}
        onFinish={(useForAutomatic) => void saveObjectStorage(useForAutomatic)}
        onMount={(view) => void mount(view)}
        onTest={() => testObjectStorage()}
        testResult={objectTest}
      /> : null}
    </div>
  </section>;
}
