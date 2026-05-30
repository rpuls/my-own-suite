import { useEffect, useState } from 'react';

import { withSetupPath } from '../../lib/base-path';
import type { BackupsStatus } from './types';

type BackupsState =
  | { kind: 'loading' }
  | { kind: 'loaded'; status: BackupsStatus }
  | { kind: 'error'; message: string };

async function loadStatus(): Promise<BackupsStatus> {
  const response = await fetch(withSetupPath('/api/backups'));
  const body = (await response.json().catch(() => ({ error: 'Unable to load backup status.' }))) as
    | BackupsStatus
    | { error?: string };

  if (!response.ok) {
    throw new Error('error' in body && typeof body.error === 'string' ? body.error : 'Unable to load backup status.');
  }

  return body as BackupsStatus;
}

export function useBackups() {
  const [state, setState] = useState<BackupsState>({ kind: 'loading' });
  const [isStarting, setIsStarting] = useState(false);
  const isJobRunning =
    state.kind === 'loaded' &&
    Boolean(state.status.currentJob && (state.status.currentJob.status === 'running' || state.status.currentJob.status === 'queued'));

  async function refresh(): Promise<BackupsStatus> {
    const nextStatus = await loadStatus();
    setState({ kind: 'loaded', status: nextStatus });
    return nextStatus;
  }

  async function startBackup(destinationId: string): Promise<void> {
    setIsStarting(true);
    try {
      const response = await fetch(withSetupPath('/api/backups/start'), {
        body: JSON.stringify({ destinationId }),
        headers: {
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });
      const body = (await response.json().catch(() => ({ error: 'Unable to start backup.' }))) as { error?: string };
      if (!response.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : 'Unable to start backup.');
      }
      await refresh();
    } finally {
      setIsStarting(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    void loadStatus()
      .then((status) => {
        if (!cancelled) {
          setState({ kind: 'loaded', status });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Unable to load backup status.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isJobRunning) {
      return;
    }

    const timer = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isJobRunning]);

  return {
    isJobRunning,
    isStarting,
    refresh,
    startBackup,
    state,
  };
}
