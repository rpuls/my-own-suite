import { useEffect, useState } from 'react';

import type { Owner, SetupSessionState, SetupStatusResponse, TermsState } from './types';

const UNKNOWN_TERMS: TermsState = { accepted: false, acceptedAt: null, version: '' };

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
        message: 'Your suite is not on a secure (HTTPS) connection yet, so owner setup is paused to keep your account safe. Right after installing this is normal for a minute or two while MOS finishes setting up its security certificate — wait a moment, then reload this page using its https:// address. If it keeps happening, your server may be blocking web traffic: check that your hosting provider allows incoming connections on ports 80 and 443.',
      };
    }
    return { kind: 'needs-owner', error: null, ownerClaimRequired: Boolean(status.ownerClaimRequired) };
  }

  if (!status.owner) {
    return { kind: 'error', message: 'Suite Manager returned an owner state without owner details.' };
  }

  if (status.status === 'signed-in') {
    return { kind: 'signed-in', owner: status.owner, terms: status.terms || UNKNOWN_TERMS };
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

  async function createOwner(input: { claimToken: string; email: string; name: string; password: string }): Promise<void> {
    const response = await fetch('/suite-manager/api/setup/owner', {
      body: JSON.stringify(input),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const body: AuthResponse & ApiErrorBody = await readJson<AuthResponse & ApiErrorBody>(response).catch(() => ({}));

    if (!response.ok || !body.owner) {
      setState((current) => ({
        kind: 'needs-owner',
        error: errorMessage(body, 'Unable to create the owner account.'),
        ownerClaimRequired: current.kind === 'needs-owner' ? current.ownerClaimRequired : false,
      }));
      return;
    }

    if (!enterHomeDashboard()) {
      await refresh();
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
      await refresh();
    }
  }

  // Accepting is recorded server-side, so it survives a new browser, a new
  // device, and a cleared cache — the acceptance belongs to the install.
  async function acceptTerms(version: string): Promise<void> {
    const response = await fetch('/suite-manager/api/setup/terms/accept', {
      body: JSON.stringify({ version }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    if (!response.ok) {
      const body = await readJson<ApiErrorBody>(response).catch(() => ({}));
      throw new Error(errorMessage(body, 'Unable to record your acceptance.'));
    }
    await refresh();
  }

  function clearOwnerError(): void {
    setState((current) => (current.kind === 'needs-owner' && current.error ? { ...current, error: null } : current));
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
    acceptTerms,
    clearOwnerError,
    createOwner,
    login,
    logout,
    refresh,
    state,
  };
}
