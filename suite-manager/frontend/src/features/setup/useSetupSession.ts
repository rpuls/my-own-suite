import { useEffect, useState } from 'react';

import type { Owner, SetupSessionState, SetupStatusResponse } from './types';

type ApiErrorBody = {
  error?: string;
};

type AuthResponse = {
  owner?: Owner;
  status?: string;
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function readStatus(): Promise<SetupStatusResponse> {
  const response = await fetch('/suite-manager/api/setup/status');
  const body = await readJson<SetupStatusResponse | ApiErrorBody>(response);

  if (!response.ok) {
    throw new Error('Unable to read Suite Manager setup state.');
  }

  return body as SetupStatusResponse;
}

function stateFromStatus(status: SetupStatusResponse): SetupSessionState {
  if (status.status === 'needs-owner') {
    if (status.ownerClaimRequired && !status.secureTransport) {
      return {
        kind: 'error',
        message: 'Secure owner setup is not ready. MOS could not establish HTTPS. Check that your VPS provider allows inbound TCP traffic on ports 80 and 443, then reload this page using HTTPS.',
      };
    }
    return { kind: 'needs-owner', error: null };
  }

  if (!status.owner) {
    return { kind: 'error', message: 'Suite Manager returned an owner state without owner details.' };
  }

  if (status.status === 'signed-in') {
    return { kind: 'signed-in', owner: status.owner };
  }

  return { kind: 'signed-out', error: null, owner: status.owner };
}

function errorMessage(body: ApiErrorBody, fallback: string): string {
  return typeof body.error === 'string' && body.error.trim() ? body.error : fallback;
}

function enterHomeDashboard(): boolean {
  if (window.location.pathname !== '/suite-manager/' && window.location.pathname !== '/suite-manager') {
    return false;
  }

  window.location.assign('/');
  return true;
}

export function useSetupSession() {
  const [state, setState] = useState<SetupSessionState>({ kind: 'loading' });

  async function refresh(): Promise<void> {
    setState(stateFromStatus(await readStatus()));
  }

  useEffect(() => {
    void refresh().catch((error: unknown) => {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to load Suite Manager.',
      });
    });
  }, []);

  async function createOwner(input: { email: string; name: string; password: string }): Promise<void> {
    const claimToken = new URLSearchParams(window.location.search).get('claim') || '';
    const response = await fetch('/suite-manager/api/setup/owner', {
      body: JSON.stringify({ ...input, claimToken }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const body: AuthResponse & ApiErrorBody = await readJson<AuthResponse & ApiErrorBody>(response).catch(() => ({}));

    if (!response.ok || !body.owner) {
      setState({ kind: 'needs-owner', error: errorMessage(body, 'Unable to create the owner account.') });
      return;
    }

    if (!enterHomeDashboard()) {
      setState({ kind: 'signed-in', owner: body.owner });
    }
  }

  async function login(input: { email: string; password: string; owner: Owner }): Promise<void> {
    const response = await fetch('/suite-manager/api/auth/login', {
      body: JSON.stringify({ email: input.email, password: input.password }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const body: AuthResponse & ApiErrorBody = await readJson<AuthResponse & ApiErrorBody>(response).catch(() => ({}));

    if (!response.ok || !body.owner) {
      setState({
        kind: 'signed-out',
        error: errorMessage(body, 'Unable to sign in.'),
        owner: input.owner,
      });
      return;
    }

    if (!enterHomeDashboard()) {
      setState({ kind: 'signed-in', owner: body.owner });
    }
  }

  async function logout(): Promise<void> {
    await fetch('/suite-manager/api/auth/logout', { method: 'POST' });
    const status = await readStatus();

    if (status.owner) {
      setState({ kind: 'signed-out', error: null, owner: status.owner });
      return;
    }

    setState(stateFromStatus(status));
  }

  return {
    createOwner,
    login,
    logout,
    refresh,
    state,
  };
}
