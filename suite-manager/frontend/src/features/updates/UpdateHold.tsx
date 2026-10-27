import { useEffect, useState, type ReactNode } from 'react';

import { Icon, ScreenHold, Spinner, Stepper } from '../../components/ui';
import { buildChanged, servedBuildId } from '../../frontend-build';
import { postJson } from '../../lib/api';
import { navigateTo } from '../../lib/navigation';
import { isRunning, PROGRESS_STEPS, progressStep, UPDATE_STARTED_EVENT, type UpdateJob } from './progress';

type UpdateProgress = {
  available: boolean;
  destinationLabel: string | null;
  job: UpdateJob | null;
  track: { ref: string | null; type: 'branch' | 'stable' | null };
};

type Hold =
  | { phase: 'idle' }
  | { phase: 'running' | 'reconnecting' | 'done' | 'failed'; progress: UpdateProgress };

const IDLE_POLL_MS = 10_000;
const WATCH_POLL_MS = 3_000;
const RELOAD_DELAY_MS = 2_500;
const RESTART_STEP = 3;

const STEP_TITLES = ['Backing up your suite', 'Downloading the new version', 'Building the new version of MOS', 'Restarting MOS on the new version'];

async function readProgress(): Promise<UpdateProgress | null> {
  try {
    const response = await fetch('/suite-manager/api/updates/progress', { cache: 'no-store' });
    if (!response.ok) return null;
    const progress = await response.json() as UpdateProgress;
    return progress.available ? progress : null;
  } catch {
    return null;
  }
}

// An unanswered poll while holding is MOS restarting under the update, not the update ending.
function nextHold(current: Hold, progress: UpdateProgress | null): Hold {
  const holding = current.phase === 'running' || current.phase === 'reconnecting';
  if (!progress) return holding ? { ...current, phase: 'reconnecting' } : current;
  if (isRunning(progress.job)) return { phase: 'running', progress };
  if (!holding || progress.job?.id !== current.progress.job?.id) return holding ? { phase: 'idle' } : current;
  if (progress.job?.status === 'succeeded') return { phase: 'done', progress };
  if (progress.job?.status === 'failed') return { phase: 'failed', progress };
  return { phase: 'idle' };
}

function targetOf({ job, track }: UpdateProgress) {
  if (track.type === 'branch') return `To the newest ${track.ref || 'branch'} commit`;
  return job?.checkpoint?.target ? `To MOS ${job.checkpoint.target}` : 'To the latest release';
}

function backupNote({ destinationLabel, job }: UpdateProgress) {
  const destination = destinationLabel || 'your backup place';
  const status = job?.checkpoint?.status;
  if (status === 'succeeded') return <>Backed up first to <strong>{destination}</strong></>;
  if (status === 'skipped') return <>No backup was taken first</>;
  if (status === 'running') return <>Backing up to <strong>{destination}</strong></>;
  return null;
}

function HoldHead({ icon, subtitle, title }: { icon: ReactNode; subtitle?: string; title: string }) {
  return <div className="suite-hold-head">
    <span className="suite-hold-icon">{icon}</span>
    <div>
      <h2>{title}</h2>
      {subtitle ? <p className="suite-meta">{subtitle}</p> : null}
    </div>
  </div>;
}

function WaitingForBackup({ progress }: { progress: UpdateProgress }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const id = progress.job?.id || '';

  async function answer(choice: 'cancel' | 'skip-backup') {
    setBusy(choice);
    setError('');
    try {
      await postJson(`/suite-manager/api/updates/${choice}`, { id }, choice === 'cancel' ? 'Unable to cancel the update.' : 'Unable to go on without a backup.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  }

  return <ScreenHold label="Waiting to back up before updating" tone="warning">
    <HoldHead icon={<Icon name="backup" />} subtitle={targetOf(progress)} title="Waiting to back up" />
    <Stepper currentStepIndex={0} steps={PROGRESS_STEPS} />
    <p className="suite-hold-copy">{progress.job?.checkpoint?.waiting?.reason} MOS backs up before it changes anything, and carries on by itself once it can.</p>
    {error ? <p className="suite-error">{error}</p> : null}
    <div className="suite-hold-actions">
      <button className="mos-btn mos-btn-secondary" disabled={Boolean(busy)} onClick={() => void answer('cancel')} type="button">{busy === 'cancel' ? 'Cancelling...' : 'Cancel update'}</button>
      <button className="mos-btn mos-btn-ghost" disabled={Boolean(busy)} onClick={() => void answer('skip-backup')} type="button">{busy === 'skip-backup' ? 'Starting...' : 'Update without a backup'}</button>
    </div>
  </ScreenHold>;
}

// Every Suite Manager page, while MOS updates: an update replaces the server under the
// page, so nothing may be used until it has finished, and then the new pages are loaded.
export function UpdateHold() {
  const [hold, setHold] = useState<Hold>({ phase: 'idle' });

  useEffect(() => {
    if (hold.phase === 'done' || hold.phase === 'failed') return undefined;
    let cancelled = false;
    const look = () => { void readProgress().then((progress) => { if (!cancelled) setHold((current) => nextHold(current, progress)); }); };
    look();
    const timer = window.setInterval(look, hold.phase === 'idle' ? IDLE_POLL_MS : WATCH_POLL_MS);
    window.addEventListener(UPDATE_STARTED_EVENT, look);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(UPDATE_STARTED_EVENT, look);
    };
  }, [hold.phase]);

  // A server back on new pages ends the restart even when it cannot report progress, as one
  // older or newer than this page may not.
  useEffect(() => {
    if (hold.phase !== 'reconnecting') return undefined;
    const timer = window.setInterval(() => {
      void servedBuildId().then((served) => { if (buildChanged(served)) window.location.reload(); }).catch(() => undefined);
    }, WATCH_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hold.phase]);

  useEffect(() => {
    if (hold.phase !== 'done') return undefined;
    let timer = 0;
    void servedBuildId().catch(() => '').then((served) => {
      timer = window.setTimeout(() => (buildChanged(served) ? window.location.reload() : setHold({ phase: 'idle' })), RELOAD_DELAY_MS);
    });
    return () => window.clearTimeout(timer);
  }, [hold.phase]);

  if (hold.phase === 'idle') return null;
  const { progress } = hold;

  if (hold.phase === 'done') {
    return <ScreenHold label="MOS is up to date" tone="success">
      <HoldHead icon={<Icon name="check" />} title="MOS is up to date" />
      <p className="suite-hold-copy suite-hold-working"><Spinner />Opening the new version of Suite Manager…</p>
    </ScreenHold>;
  }

  if (hold.phase === 'failed') {
    return <ScreenHold label="The update did not finish" tone="error">
      <HoldHead icon={<Icon name="x" />} subtitle={targetOf(progress)} title="The update did not finish" />
      {progress.job?.error ? <p className="suite-hold-copy">{progress.job.error}</p> : null}
      <p className="suite-meta">The Updates screen has the details.</p>
      <div className="suite-hold-actions">
        <button className="mos-btn mos-btn-primary" onClick={() => { setHold({ phase: 'idle' }); navigateTo('/suite-manager/updates'); }} type="button">Back to Suite Manager</button>
      </div>
    </ScreenHold>;
  }

  if (hold.phase === 'running' && progress.job?.checkpoint?.waiting) return <WaitingForBackup progress={progress} />;

  const restarting = hold.phase === 'reconnecting';
  const step = restarting ? RESTART_STEP : progressStep(progress.job?.stage || null);
  const note = backupNote(progress);
  return <ScreenHold label={restarting ? 'MOS is restarting' : 'MOS is updating'}>
    <HoldHead icon={<Spinner />} subtitle={targetOf(progress)} title={restarting ? 'MOS is restarting' : 'MOS is updating'} />
    <Stepper currentStepIndex={step} steps={PROGRESS_STEPS} working />
    <div className="suite-hold-copy">
      <strong>{STEP_TITLES[Math.min(step, RESTART_STEP)]}</strong>
      <p>{restarting
        ? 'Suite Manager goes away for a moment while it starts on the new version. This page reconnects by itself.'
        : step === 0
          ? 'MOS backs up before it changes anything. Your apps pause for a few minutes while they are copied.'
          : 'An update takes several minutes. Suite Manager is paused until it is done, then this page reloads by itself. Your apps keep running.'}</p>
    </div>
    {note ? <p className="suite-hold-note"><Icon name="backup" /><span>{note}</span></p> : null}
  </ScreenHold>;
}
