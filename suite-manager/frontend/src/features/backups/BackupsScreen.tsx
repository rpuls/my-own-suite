import { useEffect, useState } from 'react';

import { AdvancedPanel, ChoiceRow, DisclosureRow, Notice, Panel, PanelBody, PanelHead, PanelItem, PanelList, ProgressBar, Select, Spinner } from '../../components/ui';
import { postJson } from '../../lib/api';
import { whenWords } from '../../lib/dates';
import { fetchRecoveryKey, markRecoveryKeySaved, type RevealedRecoveryKey } from '../../lib/recovery-key';
import { readVaultView, startupOf, type VaultView } from '../../lib/vault';
import { EraseBackupsDialog } from '../archives/EraseBackupsDialog';
import { AddDestinationDialog } from './AddDestinationDialog';
import { DestinationsPanel, OtherServersPanel } from './DestinationsPanel';
import { ProgressPlan } from './ProgressPlan';
import { RestorePointsPanel } from './RestorePointsPanel';
import {
  ArchiveKeysDialog,
  BackupDialog,
  DeleteDialog,
  NoteDialog,
  RecoveryKeyDialog,
  RestoreDialog,
  ScheduleDialog,
  UnlockDialog,
  type ArchiveRef,
} from './dialogs';
import {
  activityLine,
  backupBlockReason,
  bannerState,
  browserTimeZone,
  countShare,
  destinationViews,
  isRunning,
  jobLine,
  jobWorkingLine,
  otherArchiveViews,
  restoreAftermath,
  restorePhaseWords,
  scheduleLive,
  scheduleSummary,
  stageWords,
  stepLine,
  type ArchiveKey,
  type BackupEntry,
  type BackupSchedule,
  type DestinationView,
  type OtherArchiveView,
  type RotationResult,
} from './model';
import { silenceWords, useBackupStatus } from './useBackupStatus';

type Dialog =
  | { kind: 'backup' }
  | { kind: 'delete'; backup: BackupEntry }
  | { kind: 'key'; mode: 'reveal' | 'rotate' | 'save'; then?: () => Promise<void> }
  | { kind: 'note'; backup: BackupEntry; value: string }
  | { kind: 'restore'; backup: BackupEntry }
  | { kind: 'schedule' }
  | { kind: 'keys'; archive: ArchiveRef }
  | { kind: 'unlock'; archive: ArchiveRef }
  | { kind: 'erase'; view: OtherArchiveView }
  | { kind: 'add' }
  | null;

export function BackupsScreen() {
  const { activeJob, contact, error: loadError, load, now, publicProgress, restoreInFlight, running, sessionEnded, setRestoreStarted, silent, status } = useBackupStatus();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [backupTargetId, setBackupTargetId] = useState('');
  const [backupNote, setBackupNote] = useState('');
  const [restoreConfirmation, setRestoreConfirmation] = useState('');
  const [activityOpen, setActivityOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [revealedKey, setRevealedKey] = useState<RevealedRecoveryKey | null>(null);
  const [rotation, setRotation] = useState<RotationResult | null>(null);
  const [keyError, setKeyError] = useState('');
  const [unlockError, setUnlockError] = useState('');
  const [archiveKeys, setArchiveKeys] = useState<ArchiveKey[] | null>(null);
  const [archiveKeysError, setArchiveKeysError] = useState('');
  const [checking, setChecking] = useState('');
  // Read once: a vault is created at install and never appears or disappears afterwards.
  const [vaultView, setVaultView] = useState<VaultView | null>(null);

  const backingUp = isRunning(activeJob) && activeJob?.kind !== 'restore' && activeJob?.kind !== 'validate' && activeJob?.kind !== 'delete';
  const views = destinationViews(status);
  const otherViews = otherArchiveViews(status);
  const readyViews = views.filter((view) => view.selectable);
  const selected = views.find((view) => view.selected) || null;
  const backupTarget = readyViews.find((view) => view.id === backupTargetId)
    || (selected && selected.selectable ? selected : null)
    || readyViews[0]
    || null;
  const blockReason = status ? backupBlockReason(status, views, backupTarget) : '';
  const banner = bannerState(status, views, Boolean(backingUp));
  const blockNote = blockReason === banner.detail ? '' : blockReason;
  const workingLine = jobWorkingLine(activeJob);
  const recoveryKey = status?.recoveryKey || null;
  // Until the key is saved, taking a backup or enabling a schedule goes through
  // the dialog instead. The agent refuses them too.
  const keySaved = recoveryKey === null || recoveryKey.acknowledged;
  const aftermath = restoreAftermath(status?.lastJob);

  useEffect(() => {
    if (!isRunning(status?.currentJob || null)) setChecking('');
  }, [status]);
  // Only decides one sentence in the key dialog, whose fallback is true on every server.
  useEffect(() => {
    let cancelled = false;
    void readVaultView()
      .then((view) => { if (!cancelled) setVaultView(view); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function runAction(name: string, action: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await action();
      await load();
    } catch (caught) {
      // Refreshed first so the page shows reality before the error does.
      await load();
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  }

  function post<T>(path: string, body: unknown, message: string) {
    return postJson<T>(`/suite-manager/api/backups/${path}`, body, message);
  }

  // The gate. Only what would create a backup this server alone can read runs
  // through here; mounting, connecting, listing and restoring are never gated.
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
      setRevealedKey(await fetchRecoveryKey(password));
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : 'Unable to show the recovery key.');
    } finally {
      setBusy('');
    }
  }

  // The new key is shown in the same dialog the first one was, with the same confirmation.
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
      await load();
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
      await markRecoveryKeySaved();
      closeDialog();
      await load();
      if (pending) await pending();
    } catch (caught) {
      setKeyError(caught instanceof Error ? caught.message : 'Unable to record that you saved the recovery key.');
    } finally {
      setBusy('');
    }
  }

  // The key is held only while its dialog is open.
  function closeDialog() {
    setDialog(null);
    setRevealedKey(null);
    setRotation(null);
    setKeyError('');
    setUnlockError('');
  }

  async function unlockArchive(archive: ArchiveRef, recoveryKeyInput: string) {
    setBusy(`unlock:${archive.id}`);
    setUnlockError('');
    try {
      await post('archives/unlock', { archiveId: archive.id, recoveryKey: recoveryKeyInput }, 'Unable to unlock these backups.');
      closeDialog();
      await load();
    } catch (caught) {
      setUnlockError(caught instanceof Error ? caught.message : 'Unable to unlock these backups.');
    } finally {
      setBusy('');
    }
  }

  // The key is entered here and used for the read; it is never kept.
  async function listArchiveKeys(archive: ArchiveRef, recoveryKeyInput: string) {
    setBusy(`keys:${archive.id}`);
    setArchiveKeysError('');
    try {
      const result = await post<{ result: { keys: ArchiveKey[] } }>('archives/keys', { archiveId: archive.id, recoveryKey: recoveryKeyInput }, 'Unable to read the keys on these backups.');
      setArchiveKeys(result?.result?.keys || []);
    } catch (caught) {
      setArchiveKeysError(caught instanceof Error ? caught.message : 'Unable to read the keys on these backups.');
    } finally {
      setBusy('');
    }
  }

  async function removeArchiveKey(archive: ArchiveRef, recoveryKeyInput: string, keyId: string) {
    setBusy(`key-remove:${keyId}`);
    setArchiveKeysError('');
    try {
      await post('archives/keys/remove', { archiveId: archive.id, keyId, recoveryKey: recoveryKeyInput }, 'Unable to remove that key.');
      setBusy(`keys:${archive.id}`);
      const result = await post<{ result: { keys: ArchiveKey[] } }>('archives/keys', { archiveId: archive.id, recoveryKey: recoveryKeyInput }, 'Unable to read the keys on these backups.');
      setArchiveKeys(result?.result?.keys || []);
    } catch (caught) {
      setArchiveKeysError(caught instanceof Error ? caught.message : 'Unable to remove that key.');
    } finally {
      setBusy('');
    }
  }

  // Only this server forgets the key; the archive it opens is not changed.
  async function forgetArchiveKey(view: OtherArchiveView) {
    await runAction(`forget-key:${view.id}`, async () => {
      await post('archives/forget-key', { archiveId: view.id }, 'Unable to forget this key.');
    });
  }

  // Stops MOS saying a copy is out there on a drive that is not here; touches nothing on the drive.
  async function forgetDrive(view: DestinationView) {
    await runAction(`forget-drive:${view.id}`, async () => {
      await postJson(`/suite-manager/api/storage/drives/${encodeURIComponent(view.id)}/forget`, {}, 'Unable to forget this drive.');
    });
  }

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

  // The stored time zone is kept: opening MOS from a laptop in another country
  // must not move a home server's backup window.
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

  // The storage stays set up in Settings → Storage; only the backups claim on it goes.
  async function stopUsing(view: DestinationView) {
    await runAction(`release:${view.id}`, async () => {
      await post('destinations/release', { storageId: view.id }, 'Unable to stop using this for backups.');
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
      await post('validate', { backupPath: backup.path }, 'Unable to verify this restore point.');
    });
  }

  async function saveNote(backup: BackupEntry, note: string) {
    setDialog(null);
    await runAction(`note:${backup.path}`, async () => {
      await post('note', { backupPath: backup.path, note }, 'Unable to save the note.');
    });
  }

  async function deleteBackup(backup: BackupEntry) {
    await runAction(`delete:${backup.path}`, async () => {
      await post('delete', { backupPath: backup.path }, 'Unable to delete this restore point.');
      setDialog(null);
    });
  }

  async function startRestore(backup: BackupEntry) {
    setBusy('restore');
    setError('');
    try {
      await post('restore', {
        backupPath: backup.path,
        confirmation: restoreConfirmation,
      }, 'Unable to start restore.');
      setDialog(null);
      setRestoreConfirmation('');
      setRestoreStarted(true);
      await load();
    } catch (caught) {
      await load();
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
    if (view.action === 'retest') void runAction(`retest:${view.id}`, async () => undefined);
  }

  function archiveRef(id: string, label: string): ArchiveRef {
    const archive = status?.archives.find((entry) => entry.id === id);
    return { id, label, placeKind: archive?.placeKind || 'disk' };
  }

  // Unlocking reads another server's archive; restoring from it, newest first,
  // is the one thing this server can then do with it.
  function otherArchiveAction(view: OtherArchiveView) {
    if (view.action === 'unlock') { setUnlockError(''); setDialog({ kind: 'unlock', archive: archiveRef(view.id, view.label) }); return; }
    const newest = (status?.backups || []).filter((backup) => backup.archiveId === view.id)
      .sort((left, right) => new Date(right.createdAt || 0).getTime() - new Date(left.createdAt || 0).getTime())[0];
    if (newest) { setRestoreConfirmation(''); setDialog({ kind: 'restore', backup: newest }); }
  }

  function openArchiveKeys(archiveId: string, label: string) {
    setArchiveKeys(null);
    setArchiveKeysError('');
    setDialog({ kind: 'keys', archive: archiveRef(archiveId, label) });
  }

  const hero = <div className="suite-hero">
    <h1>Backup &amp; Restore</h1>
    <p className="suite-lead mos-body-lg">A backup is a complete copy of your suite &mdash; your apps and everything in them. Keep it somewhere other than this server, and you can get everything back.</p>
  </div>;

  // The status read probes every destination, so until it lands the page has
  // nothing true to say; a headline over an empty page reads as broken.
  if (!status && !error && !loadError && !sessionEnded) {
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

  // A restore takes the page over. The API's answer when there is one, the file
  // Caddy serves when there is not, never the last thing the API said before it went quiet.
  if (restoreInFlight) {
    const stale = contact.state !== 'ok';
    const progress = stale ? publicProgress : activeJob?.progress || null;
    const count = progress?.count || null;
    return <section className="mos-shell suite-backups">
      <div className="mos-page">
        {hero}

        {contact.state === 'wrong-address' ? <Notice title="This server no longer answers at this address" variant="warning">
          <p>MOS is running here and refused this address, which means the restored suite is being served under a different name than the one in your browser. Nothing is wrong with the restore or your data.</p>
          <p>Open MOS at the address of the server you restored from. If that name does not point at this server yet, reach it on this server&rsquo;s own address — the one printed on its screen when it starts.</p>
        </Notice> : null}

        {silent && contact.state === 'unreachable' ? <Notice title={progress ? 'MOS is not answering this page' : 'MOS has stopped answering'} variant={progress ? 'info' : 'warning'}>
          {progress
            ? <p>Suite Manager is stopped for the middle of a restore, which is expected. The steps below are coming from the server itself, so they are current even though this page cannot reach it. Leave the server on.</p>
            : <p>This page has had no answer {silenceWords(contact.at, now)}, and the server is not reporting a restore running either. It may have finished and signed you out, or it may have stopped. Leave the server on and reload this page; if it does not come back, the server&rsquo;s own screen shows its address and what it is doing.</p>}
        </Notice> : null}

        <Panel>
          <PanelHead title={progress?.headline || 'Restoring your backup'}>
            <p className="suite-bk-working">
              {progress || !silent ? <Spinner /> : null}
              {progress ? progress.sentence : silent ? 'MOS is not saying where this has got to.' : stageWords(activeJob)}{stepLine(progress)}
            </p>
            {count ? <>
              <p className="suite-meta">{count.sentence}{count.note ? ` ${count.note}` : ''}</p>
              <div className="suite-bk-progress"><ProgressBar label={count.sentence} value={countShare(count) / 100} /></div>
            </> : null}
          </PanelHead>
          {progress?.plan.length ? <ProgressPlan plan={progress.plan} /> : null}
          <PanelBody>
            <p className="suite-meta">{progress?.expect?.sentence ? `${progress.expect.sentence} ` : ''}Your apps are stopped while it runs. <strong>Do not turn the server off.</strong> When it is done everyone is signed out, because this becomes the restored server.</p>
          </PanelBody>
        </Panel>
      </div>
    </section>;
  }

  return <section className="mos-shell suite-backups">
    <div className="mos-page">
      {hero}

      {error || loadError ? <Notice title="Backup needs attention" variant="error"><p>{error || loadError}</p></Notice> : null}
      {sessionEnded ? <Notice title={sessionEnded === 'restore' ? 'The restore signed you out' : 'Your session ended'} variant="info">
        <p>{sessionEnded === 'restore'
          ? 'The restore is done. Everyone is signed out because this is now the restored server. Sign in with the password you used on the server you restored — accounts and passwords now match the restore point, not what was set just before the restore.'
          : 'Sign in again to manage backups.'}</p>
        <button className="mos-btn mos-btn-primary" onClick={() => window.location.reload()} type="button">Go to sign-in</button>
      </Notice> : null}

      {status && !status.serviceAvailable ? <Notice title="Backup is not available yet" variant="warning">
        <p>The host backup service is not running on this install. Update or restart the MOS host services, then come back here.</p>
      </Notice> : null}

      {status?.serviceAvailable ? <div className="suite-bk-page" aria-busy={running}>
        {/* What a restore that worked has left undone, at the top rather than in
            the activity list: the browser looking fine is why nobody would look for it. */}
        {aftermath ? <Notice title={`Your suite is restored — ${['', 'one thing is', 'two things are', 'three things are'][aftermath.left]} left`} variant="warning">
          {aftermath.appsNotStarted.length ? <p><strong>{new Intl.ListFormat('en', { type: 'conjunction' }).format(aftermath.appsNotStarted)} did not start.</strong> {aftermath.appsNotStarted.length > 1 ? 'Their data is' : 'Its data is'} restored, and every other app is running. Open {aftermath.appsNotStarted.length > 1 ? 'each one' : 'it'} under <a className="mos-link" href="/suite-manager/apps">Apps</a> to see why, and choose Restart to try again.</p> : null}
          {aftermath.routesLive ? null :<p><strong>This server is still serving the routes it had before the restore.</strong> The web server refused the restored ones, so some apps may not open yet. Restarting this server picks them up.</p>}
          {aftermath.domain ? <>
            <p>Your suite is running here, on this server&rsquo;s own address, and you are signed in to it. Anything set up against <strong>{aftermath.domain}</strong> — phone apps, sync clients, browser extensions — keeps failing until that name points at this server, because it still points at the server this restore point came from.</p>
            <p>Settings offers to serve <strong>{aftermath.domain}</strong> from here in one step: MOS kept that domain&rsquo;s credential from the backup, so it needs no token from you. Pointing the name at this server is the part MOS cannot do for you — change it at your DNS provider, and in any override your own network holds for it.</p>
            <p className="suite-meta">Turn the old server off first if it is still running. Two servers answering for one suite means two copies of your data drifting apart.</p>
            <a className="mos-btn mos-btn-primary" href="/suite-manager/settings">Finish moving {aftermath.domain}</a>
          </> : null}
          {aftermath.routesDetail ? <AdvancedPanel
            facts={[{ label: 'Restored domain', value: aftermath.domain || 'none' }]}
            output={aftermath.routesDetail}
            reveal="on-failure"
          /> : null}
        </Notice> : null}

        {/* A block is the answer to "am I safe", so it takes that slot. Never more than one. */}
        {status.interruptedRestore ? <Notice title="A restore did not finish" variant="error">
          <p>A restore stopped {restorePhaseWords(status.interruptedRestore.phase)}, so this server may be part way between what it held before and the restore point it was restoring. A complete rescue copy of what it held before is kept on the server. Backups and restores stay paused until you have read this.</p>
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
          {!backingUp && !workingLine && (blockNote || (backupTarget && !backupTarget.selected && selected))
            ? <div className="suite-bk-banner-note">
              {blockNote ? <p className="suite-bk-detail">{blockNote}</p> : null}
              {backupTarget && !backupTarget.selected && selected
                ? <p className="suite-bk-detail">This one backup goes to {backupTarget.label}. Automatic backups still go to {selected ? selected.label : 'the selected place'}.</p>
                : null}
            </div>
            : null}
        </section> : null}

        {otherViews.length ? <OtherServersPanel
          busy={busy}
          onAction={otherArchiveAction}
          onErase={(view) => setDialog({ kind: 'erase', view })}
          onForgetKey={(view) => void forgetArchiveKey(view)}
          onKeys={openArchiveKeys}
          running={running}
          views={otherViews}
        /> : null}

        {/* A fresh install shows one question instead of four empty sections. */}
        {views.length ? null : <Panel>
          <PanelHead heading="h2" title="You have no backups yet.">
            <p className="suite-meta">Choose where they should go &mdash; a drive you plug into this server, or storage online.</p>
          </PanelHead>
          <PanelList>
            <PanelItem flush>
              <ChoiceRow icon="backup" onPick={() => setDialog({ kind: 'add' })}>
                <strong>Select a backup destination for this server</strong>
                <span className="suite-meta">A drive is fastest to restore from. Storage online survives a fire or a theft at home.</span>
              </ChoiceRow>
            </PanelItem>
          </PanelList>
        </Panel>}

        {views.length ? <DestinationsPanel
          busy={busy}
          onAction={destinationAction}
          onAdd={() => setDialog({ kind: 'add' })}
          onForgetDrive={(view) => void forgetDrive(view)}
          onKeys={openArchiveKeys}
          onSelect={(view) => void choosePrimary(view)}
          onStopUsing={(view) => void stopUsing(view)}
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

        {views.length || otherViews.length ? <RestorePointsPanel
          busy={busy}
          checking={checking}
          onCheck={(backup) => void checkBackup(backup)}
          onDelete={(backup) => setDialog({ kind: 'delete', backup })}
          onEditNote={(backup) => setDialog({ kind: 'note', backup, value: backup.note || '' })}
          onRestore={(backup) => { setRestoreConfirmation(''); setDialog({ kind: 'restore', backup }); }}
          running={running}
          status={status}
          views={views}
        /> : null}

        {views.length || otherViews.length ? <Panel>
          <DisclosureRow expanded={activityOpen} onToggle={() => setActivityOpen(!activityOpen)}>
            <strong>Recent activity</strong>
            <span className="suite-bk-detail suite-bk-activity-line">{status.recentJobs?.[0] ? activityLine(status.recentJobs[0], views) : 'Nothing has happened yet.'}</span>
          </DisclosureRow>
          {activityOpen ? <PanelBody className="suite-bk-activity-body">
            {(status.recentJobs || []).map((job) => <p key={job.id}>
              <span className="suite-bk-point-when">{whenWords(job.updatedAt)}</span>
              <span>{activityLine(job, views)}</span>
            </p>)}
            <AdvancedPanel
              facts={[
                { label: 'Detected apps', value: String(status.inventory?.summary.appCount ?? 0) },
                { label: 'Detected app data stores', value: String(status.inventory?.summary.declaredVolumeCount ?? 0) },
                { label: 'App connections', value: String(status.inventory?.summary.relationshipCount ?? 0) },
                { label: 'Warnings', value: status.inventory?.warnings.map((warning) => `${warning.packageId}: ${warning.message}`).join(', ') || 'None' },
                { label: 'Storage engine', value: status.backups.find((backup) => backup.engineName)?.engineName || 'unknown' },
                { label: 'Restore guarantee', value: status.restoreGuarantee || 'unknown' },
                { code: true, label: 'Recovery key fingerprint', value: recoveryKey?.fingerprint || 'unknown' },
                { code: true, label: 'This server', value: status.hostname || 'unknown' },
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
        archives={status?.archives || []}
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
      /> : null}

      {dialog?.kind === 'keys' ? <ArchiveKeysDialog
        archive={dialog.archive}
        busy={busy}
        error={archiveKeysError}
        keys={archiveKeys}
        onClose={closeDialog}
        onList={(entered) => void listArchiveKeys(dialog.archive, entered)}
        onRemove={(entered, keyId) => void removeArchiveKey(dialog.archive, entered, keyId)}
      /> : null}

      {dialog?.kind === 'unlock' ? <UnlockDialog
        archive={dialog.archive}
        busy={busy}
        error={unlockError}
        onCancel={closeDialog}
        onUnlock={(entered) => void unlockArchive(dialog.archive, entered)}
      /> : null}

      {dialog?.kind === 'erase' ? <EraseBackupsDialog
        archive={{ from: dialog.view.from, id: dialog.view.id, label: dialog.view.label, newestAt: dialog.view.archive.newestAt, restorePoints: dialog.view.archive.restorePoints }}
        onClose={closeDialog}
        onErased={() => { closeDialog(); void load(); }}
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
        backup={dialog.backup}
        busy={busy}
        confirmation={restoreConfirmation}
        onCancel={closeDialog}
        onConfirmation={setRestoreConfirmation}
        onStart={() => void startRestore(dialog.backup)}
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

      {dialog?.kind === 'add' ? <AddDestinationDialog
        firstDestination={!selected}
        onAdded={() => { closeDialog(); void load(); }}
        onClose={closeDialog}
      /> : null}
    </div>
  </section>;
}
