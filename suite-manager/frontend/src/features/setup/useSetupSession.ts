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

// Signing in normally hands the owner straight to their Homepage dashboard.
// That handover waits while the terms are unanswered: an acceptance a redirect
// can jump over is not an acceptance, and first run is exactly when it matters.
function termsPending(status: SetupStatusResponse): boolean {
  return status.status === 'signed-in' && Boolean(status.terms?.version) && !status.terms?.accepted;
}

export function useSetupSession() {
  const [state, setState] = useState<SetupSessionState>({ kind: 'loading' });

  async function refresh(): Promise<void> {
    setState(stateFromStatus(await readStatus()));
  }

  // Shared tail of owner creation and sign-in: show the terms gate if it is
  // owed, otherwise hand over to the Homepage dashboard as before.
  async function completeSignIn(): Promise<void> {
    const status = await readStatus();
    if (termsPending(status) || !enterHomeDashboard()) {
      setState(stateFromStatus(status));
    }
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

    await completeSignIn();
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

    await completeSignIn();
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
    // Deliberately no handover to the Homepage dashboard. Accepting the terms
    // only happens on first run, which is the one moment Suite Manager has
    // things to say that arrive nowhere else — the server login to save, the
    // state of the install. Dropping the owner on Homepage here would skip past
    // all of it. Ordinary sign-ins, where the terms are already accepted, still
    // hand over as before.
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
