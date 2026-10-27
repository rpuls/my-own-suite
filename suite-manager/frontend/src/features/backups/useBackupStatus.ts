import { useCallback, useEffect, useRef, useState } from 'react';

import { jsonResponse } from '../../lib/api';
import { useStorageChanges } from '../storage/model';
import { isRunning, type BackupStatus, type JobProgress } from './model';

// `at` is when MOS last answered, kept across failures so the screen can say how
// long the silence has lasted rather than only that there is one.
export type Contact = { at: number; state: 'ok' | 'unreachable' | 'wrong-address' };

// A restore stops Suite Manager for minutes at a time, so silence is said late:
// long enough to outlast a service restart, short enough that nobody watches a lie.
const SILENCE_BEFORE_SAYING_SO_MS = 90_000;

export function silenceWords(since: number, now: number) {
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 2) return 'for a minute or so';
  if (minutes < 60) return `for ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? 'for over an hour' : `for over ${hours} hours`;
}

// The backup status and how it is kept current: after every action, when the
// storage stream says something changed, slowly while a schedule may start a run,
// and from the file Caddy serves while Suite Manager is down for a restore.
export function useBackupStatus() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [contact, setContact] = useState<Contact>({ at: Date.now(), state: 'ok' });
  const [publicProgress, setPublicProgress] = useState<JobProgress | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sessionEnded, setSessionEnded] = useState<'restore' | 'expired' | ''>('');
  const [restoreStarted, setRestoreStarted] = useState(false);
  const [error, setError] = useState('');
  const activeJob = status?.currentJob || null;
  const running = restoreStarted || isRunning(activeJob);
  const restoreInFlight = restoreStarted || (activeJob?.kind === 'restore' && isRunning(activeJob));
  const restoring = useRef(restoreInFlight);
  useEffect(() => {
    restoring.current = restoreInFlight;
  }, [restoreInFlight]);

  // Never fails quietly: a poll ends in one of four places, and the screen is
  // told which — signed out, refused at this address, unreachable, or answered.
  const load = useCallback(async () => {
    setError('');
    let response: Response;
    try {
      response = await fetch('/suite-manager/api/backups/status');
    } catch {
      setContact((previous) => previous.state === 'ok' ? { at: previous.at, state: 'unreachable' } : previous);
      return;
    }
    // A restore replaces Suite Manager state, so the session that started it is gone once it is back.
    if (response.status === 401) {
      setContact({ at: Date.now(), state: 'ok' });
      setSessionEnded(restoring.current ? 'restore' : 'expired');
      setStatus(null);
      setRestoreStarted(false);
      return;
    }
    // MOS is running and refusing this address: an answer, not a wait.
    if (response.status === 421) {
      setContact((previous) => ({ at: previous.at, state: 'wrong-address' }));
      return;
    }
    if (!response.ok) {
      setContact((previous) => previous.state === 'ok' ? { at: previous.at, state: 'unreachable' } : previous);
      return;
    }
    try {
      const next = await jsonResponse<BackupStatus>(response, 'Unable to load backups.');
      setContact({ at: Date.now(), state: 'ok' });
      setPublicProgress(null);
      setStatus(next);
      if (!isRunning(next.currentJob)) setRestoreStarted(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load backups.');
    }
  }, []);

  // Caddy answers this itself while Suite Manager is stopped, and 204 when no job
  // runs at all, which during a restore means the job is over.
  async function loadPublicProgress() {
    try {
      const response = await fetch('/mos-status/progress.json', { cache: 'no-store' });
      if (response.status === 204) { setPublicProgress(null); return; }
      if (!response.ok) return;
      const next = await response.json() as JobProgress;
      setPublicProgress(next && typeof next === 'object' && next.steps ? next : null);
    } catch {}
  }

  useEffect(() => { void load(); }, [load]);
  useStorageChanges(load);
  // A scheduled backup starts without anyone clicking, so an open page polls slowly even when idle.
  useEffect(() => {
    if (!running && !status?.schedule?.enabled) return undefined;
    const timer = window.setInterval(() => void load(), running ? 4000 : 30000);
    return () => window.clearInterval(timer);
  }, [load, running, status?.schedule?.enabled]);
  // While MOS is not answering, only the file Caddy serves knows where the job is.
  useEffect(() => {
    if (contact.state !== 'unreachable') return undefined;
    void loadPublicProgress();
    const timer = window.setInterval(() => void loadPublicProgress(), 4000);
    return () => window.clearInterval(timer);
  }, [contact.state]);
  // Silence has to age on screen even when nothing else changes.
  useEffect(() => {
    if (contact.state === 'ok') return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, [contact.state]);
  // Leaving mid-restore drops the owner onto a raw error page while the control plane is down.
  useEffect(() => {
    if (!restoreInFlight) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [restoreInFlight]);

  return {
    activeJob,
    contact,
    error,
    load,
    now,
    publicProgress,
    restoreInFlight,
    running,
    sessionEnded,
    setRestoreStarted,
    silent: contact.state !== 'ok' && now - contact.at > SILENCE_BEFORE_SAYING_SO_MS,
    status,
  };
}
