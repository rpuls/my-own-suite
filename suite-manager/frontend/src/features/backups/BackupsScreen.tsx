import { useEffect, useState } from 'react';

import { ServerLoginNotice } from '../../components/ServerLoginNotice';
import { AdvancedPanel, Icon, Notice, Select, Spinner } from '../../components/ui';
import { jsonResponse } from '../../lib/api';
import { DestinationsPanel } from './DestinationsPanel';
import { RestorePointsPanel } from './RestorePointsPanel';
import {
  AddDestinationWizard,
  BackupDialog,
  DeleteDialog,
  DisconnectDialog,
  NoteDialog,
  RecoveryKeyDialog,
  RestoreDialog,
  ScheduleDialog,
  UnlockDialog,
} from './dialogs';
import {
  EMPTY_OBJECT_DRAFT,
  activityLine,
  backupBlockReason,
  bannerState,
  browserTimeZone,
  destinationViews,
  isRunning,
  restoreAddressNote,
  restorePhaseWords,
  scheduleLive,
  scheduleSummary,
  stageProgress,
  stageWords,
  whenWords,
  type BackupEntry,
  type BackupSchedule,
  type BackupStatus,
  type DestinationView,
  type ObjectDraft,
  type RevealedRecoveryKey,
} from './model';

type Dialog =
  | { kind: 'backup' }
  | { kind: 'delete'; backup: BackupEntry }
  | { kind: 'disconnect'; view: DestinationView }
  | { kind: 'key'; mode: 'reveal' | 'save'; then?: () => Promise<void> }
  | { kind: 'note'; backup: BackupEntry; value: string }
  | { kind: 'restore'; backup: BackupEntry }
  | { kind: 'schedule' }
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
  const [objectTest, setObjectTest] = useState<{ locked?: boolean; message: string; ok: boolean } | null>(null);
  const [revealedKey, setRevealedKey] = useState<RevealedRecoveryKey | null>(null);
  const [keyError, setKeyError] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [checking, setChecking] = useState('');

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
  async function testObjectStorage() {
    setBusy('object-test');
    setObjectTest(null);
    try {
      const response = await post<{ result: { message: string; ok: boolean } }>('destinations/object/test', objectDraft, 'Unable to reach this storage.');
      setObjectTest(response.result);
    } catch (caught) {
      setObjectTest({ message: caught instanceof Error ? caught.message : 'Unable to reach this storage.', ok: false });
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
    setDialog(null);
    await runAction(`delete:${backup.path}`, async () => {
      await post('delete', { backupPath: backup.path }, 'Unable to delete this backup.');
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

  function openKey(mode: 'reveal' | 'save') {
    setKeyError('');
    setRevealedKey(null);
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
    const progress = stageProgress(activeJob);
    return <section className="mos-shell suite-backups">
      <div className="mos-page">
        {hero}
        <section className="mos-panel suite-bk-panel suite-bk-progress">
          <p className="suite-bk-working"><Spinner />Restoring</p>
          <h2 className="mos-card-title">{stageWords(activeJob?.stage)}</h2>
          <div className="suite-bk-bar"><span style={{ width: `${progress.percent}%` }} /></div>
          <p className="suite-meta">Step {progress.step || 1} of {progress.steps}. This takes 10 to 20 minutes. Your apps are stopped while it runs. <strong>Do not turn the machine off.</strong> When it is done everyone is signed out, because this becomes the restored server.</p>
        </section>
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
            {backingUp ? <p className="suite-bk-working"><Spinner />{stageWords(activeJob?.stage)} &mdash; step {stageProgress(activeJob).step} of {stageProgress(activeJob).steps}. Apps come back on their own.</p> : <>
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
              {blockReason ? <p className="suite-bk-detail">{blockReason}</p> : null}
              {backupTarget && !backupTarget.selected && readyViews.length > 1
                ? <p className="suite-bk-detail">This one backup goes to {backupTarget.label}. Automatic backups still go to {selected ? selected.label : 'the selected place'}.</p>
                : null}
            </>}
          </div>
        </section> : null}

        {/* A fresh install has nothing to schedule, nothing to restore and
            nothing to report, so it shows one question instead of four empty
            sections. */}
        {views.length ? null : <section className="mos-panel suite-bk-panel suite-bk-empty-state">
          <h2 className="mos-card-title">You have no backups yet.</h2>
          <p className="suite-meta">Choose where they should go &mdash; a drive you plug into this server, or storage you rent online. You can add the other one later.</p>
          <div className="suite-bk-kinds">
            <button className="suite-bk-kind" onClick={() => setDialog({ kind: 'wizard', start: 'drive' })} type="button">
              <span><Icon name="usb-drive" /><strong>Use a drive</strong></span>
              <span>Plug a USB drive into this server. Fastest to restore from.</span>
            </button>
            <button className="suite-bk-kind" onClick={() => setDialog({ kind: 'wizard', start: 'online' })} type="button">
              <span><Icon name="cloud-storage" /><strong>Connect storage online</strong></span>
              <span>Storage you rent from a provider. Survives a fire or a theft at home.</span>
            </button>
          </div>
        </section>}

        {views.length ? <DestinationsPanel
          busy={busy}
          keyState={recoveryKey}
          onAction={destinationAction}
          onAdd={() => { setObjectDraft({ ...EMPTY_OBJECT_DRAFT }); setObjectTest(null); setDialog({ kind: 'wizard', start: '' }); }}
          onDisconnect={(view) => setDialog({ kind: 'disconnect', view })}
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

        {views.length && status.schedule ? <section className="mos-panel suite-bk-panel suite-bk-schedule">
          <div className="suite-bk-panel-head">
            <div>
              <p className="suite-bk-eyebrow">Automatic backups</p>
              <strong>{scheduleSummary(status.schedule, selected)}</strong>
              <p className={`suite-bk-status is-${scheduleLive(status.schedule, selected).tone}`}>
                <span className={`suite-bk-dot is-${scheduleLive(status.schedule, selected).tone}`} />
                {scheduleLive(status.schedule, selected).text}
              </p>
            </div>
            <button className="mos-btn mos-btn-secondary mos-btn-sm" disabled={Boolean(busy) || running} onClick={() => setDialog({ kind: 'schedule' })} type="button">Change</button>
          </div>
        </section> : null}

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

        {views.length ? <section className="mos-panel suite-bk-panel suite-bk-activity">
          <button aria-expanded={activityOpen} className="suite-bk-activity-head" onClick={() => setActivityOpen(!activityOpen)} type="button">
            <span className={`suite-bk-chevron${activityOpen ? ' is-open' : ''}`}><Icon name="chevron-right" /></span>
            <strong>Recent activity</strong>
            <span className="suite-bk-detail">{status.recentJobs?.[0] ? activityLine(status.recentJobs[0], views) : 'Nothing has happened yet.'}</span>
          </button>
          {activityOpen ? <div className="suite-bk-activity-body">
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
          </div> : null}
        </section> : null}
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
        onAcknowledge={() => void acknowledgeRecoveryKey()}
        onClose={closeDialog}
        onReveal={(password) => void revealRecoveryKey(password)}
        revealed={revealedKey}
        views={views}
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
        onTest={() => void testObjectStorage()}
        testResult={objectTest}
      /> : null}
    </div>
  </section>;
}
