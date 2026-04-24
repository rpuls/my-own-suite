import { useEffect, useRef, useState } from 'react';

import { withSetupPath } from '../../lib/base-path';
import type { UpdatesStatus } from './types';

type UpdatesState =
  | { kind: 'loading' }
  | { kind: 'loaded'; status: UpdatesStatus }
  | { kind: 'error'; message: string };

async function loadStatus(): Promise<UpdatesStatus> {
  const response = await fetch(withSetupPath('/api/updates'));
  const body = (await response.json().catch(() => ({ error: 'Unable to load update status.' }))) as
    | UpdatesStatus
    | { error?: string };

  if (!response.ok) {
    throw new Error('error' in body && typeof body.error === 'string' ? body.error : 'Unable to load update status.');
  }

  return body as UpdatesStatus;
}

export function useUpdates() {
  const [state, setState] = useState<UpdatesState>({ kind: 'loading' });
  const [isApplying, setIsApplying] = useState(false);
  const previousJobStatusRef = useRef<string | null>(null);
  const isJobRunning =
    state.kind === 'loaded' &&
    Boolean(state.status.currentJob && (state.status.currentJob.status === 'running' || state.status.currentJob.status === 'queued'));

  async function refresh(): Promise<UpdatesStatus> {
    const nextStatus = await loadStatus();
    setState({ kind: 'loaded', status: nextStatus });
    return nextStatus;
  }

  async function applyUpdate(): Promise<void> {
    setIsApplying(true);
    try {
      const response = await fetch(withSetupPath('/api/updates/apply'), {
        method: 'POST',
      });
      const body = (await response.json().catch(() => ({ error: 'Unable to start update.' }))) as { error?: string };
      if (!response.ok) {
        throw new Error(typeof body.error === 'string' ? body.error : 'Unable to start update.');
      }
      await refresh();
    } finally {
      setIsApplying(false);
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
            message: error instanceof Error ? error.message : 'Unable to load update status.',
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

  useEffect(() => {
    if (state.kind !== 'loaded') {
      return;
    }

    const currentStatus = state.status.currentJob?.status || null;
    const previousStatus = previousJobStatusRef.current;

    if (
      previousStatus &&
      (previousStatus === 'queued' || previousStatus === 'running') &&
      currentStatus === 'succeeded'
    ) {
      window.setTimeout(() => {
        window.location.reload();
      }, 1200);
    }

    previousJobStatusRef.current = currentStatus;
  }, [state]);

  return {
    applyUpdate,
    isJobRunning,
    isApplying,
    refresh,
    state,
  };
}
