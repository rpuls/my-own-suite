import { useEffect, useState } from 'react';

import { withSetupPath } from '../../../lib/base-path';
import type { OnboardingModel } from '../shared/types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'loaded'; model: OnboardingModel }
  | { kind: 'error'; message: string };

async function loadModel(): Promise<OnboardingModel> {
  const response = await fetch(withSetupPath('/api/onboarding'));
  const body = await response.json();

  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : 'Unable to load onboarding state.');
  }

  return body as OnboardingModel;
}

export function useOnboarding() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  async function refreshModel(): Promise<void> {
    const nextModel = await loadModel();
    setState({ kind: 'loaded', model: nextModel });
  }

  useEffect(() => {
    let cancelled = false;

    void loadModel()
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
  }, []);

  return {
    refreshModel,
    state,
  };
}
