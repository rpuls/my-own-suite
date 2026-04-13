import { useEffect, useState } from 'react';

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

  async function refresh(): Promise<UpdatesStatus> {
    const nextStatus = await loadStatus();
    setState({ kind: 'loaded', status: nextStatus });
    return nextStatus;
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

  return {
    refresh,
    state,
  };
}
