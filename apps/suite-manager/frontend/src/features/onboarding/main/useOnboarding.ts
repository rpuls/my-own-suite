import { useEffect, useState } from 'react';

import type { OnboardingModel } from '../shared/types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; model: OnboardingModel }
  | { kind: 'error'; message: string };

async function loadModel(token: string): Promise<OnboardingModel> {
  const headers = token ? { 'x-bootstrap-token': token } : undefined;
  const response = await fetch('/api/onboarding', { headers });
  const body = await response.json();

  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : 'Unable to load onboarding state.');
  }

  return body as OnboardingModel;
}

export function useOnboarding() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [token, setToken] = useState(() => window.sessionStorage.getItem('suite-manager-bootstrap-token') || '');
  const [tokenDraft, setTokenDraft] = useState(token);

  async function refreshModel(activeToken: string): Promise<void> {
    const nextModel = await loadModel(activeToken);
    setState({ kind: 'loaded', model: nextModel });
  }

  useEffect(() => {
    let cancelled = false;

    void loadModel(token)
      .then((model) => {
        if (!cancelled) {
          setState({ kind: 'loaded', model });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Unable to load onboarding state.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  function unlock(): void {
    window.sessionStorage.setItem('suite-manager-bootstrap-token', tokenDraft);
    setToken(tokenDraft);
  }

  function lock(): void {
    window.sessionStorage.removeItem('suite-manager-bootstrap-token');
    setToken('');
    setTokenDraft('');
  }

  return {
    lock,
    refreshModel,
    setTokenDraft,
    state,
    token,
    tokenDraft,
    unlock,
  };
}
