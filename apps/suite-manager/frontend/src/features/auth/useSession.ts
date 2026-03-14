import { useEffect, useState } from 'react';

import { withSetupPath } from '../../lib/base-path';
import type { AuthenticatedOwner, SessionState } from './types';

type SessionResponse = {
  authenticated: boolean;
  owner: AuthenticatedOwner | null;
};

async function readSession(): Promise<SessionResponse> {
  const response = await fetch(withSetupPath('/api/auth/session'));
  const body = (await response.json()) as SessionResponse;

  if (!response.ok) {
    throw new Error('Unable to verify current session.');
  }

  return body;
}

export function useSession() {
  const [state, setState] = useState<SessionState>({ kind: 'loading' });

  async function refresh(): Promise<void> {
    const session = await readSession();
    if (session.authenticated && session.owner) {
      setState({ kind: 'authenticated', owner: session.owner });
      return;
    }

    setState({ kind: 'unauthenticated', error: null });
  }

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to verify current session.',
      });
    });
  }, []);

  async function login(email: string, password: string): Promise<void> {
    const response = await fetch(withSetupPath('/api/auth/login'), {
      body: JSON.stringify({ email, password }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    const body = (await response.json().catch(() => ({ error: 'Unable to sign in.' }))) as {
      error?: string;
      owner?: AuthenticatedOwner;
    };

    if (!response.ok || !body.owner) {
      setState({
        kind: 'unauthenticated',
        error: typeof body.error === 'string' ? body.error : 'Unable to sign in.',
      });
      return;
    }

    setState({ kind: 'authenticated', owner: body.owner });
  }

  async function logout(): Promise<void> {
    await fetch(withSetupPath('/api/auth/logout'), {
      method: 'POST',
    });
    setState({ kind: 'unauthenticated', error: null });
  }

  return {
    login,
    logout,
    refresh,
    state,
  };
}

