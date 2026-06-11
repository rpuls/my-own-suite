import { useEffect, useState } from 'react';

import { withSetupPath } from '../../lib/base-path';
import type { AppCatalogInstallResponse, AppCatalogResponse } from './types';

type AppCatalogState =
  | { kind: 'loading' }
  | { catalog: AppCatalogResponse; kind: 'loaded' }
  | { kind: 'error'; message: string };

async function readJson<T extends object>(response: Response, fallback: string): Promise<T> {
  const body = (await response.json().catch(() => ({ error: fallback }))) as T | { error?: string };
  if (!response.ok) {
    throw new Error('error' in body && typeof body.error === 'string' ? body.error : fallback);
  }
  return body as T;
}

export async function installCatalogApp(appId: string): Promise<AppCatalogInstallResponse> {
  const response = await fetch(withSetupPath(`/api/app-catalog/apps/${encodeURIComponent(appId)}/install`), {
    method: 'POST',
  });
  return readJson<AppCatalogInstallResponse>(response, 'Unable to install this app.');
}

export function useAppCatalog(): {
  reload: () => Promise<void>;
  setCatalog: (catalog: AppCatalogResponse) => void;
  state: AppCatalogState;
} {
  const [state, setState] = useState<AppCatalogState>({ kind: 'loading' });

  async function reload(): Promise<void> {
    try {
      const response = await fetch(withSetupPath('/api/app-catalog'));
      const catalog = await readJson<AppCatalogResponse>(response, 'Unable to load the app catalog.');
      setState({ catalog, kind: 'loaded' });
    } catch (error: unknown) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Unable to load the app catalog.',
      });
    }
  }

  function setCatalog(catalog: AppCatalogResponse): void {
    setState({ catalog, kind: 'loaded' });
  }

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      const response = await fetch(withSetupPath('/api/app-catalog'));
      const catalog = await readJson<AppCatalogResponse>(response, 'Unable to load the app catalog.');
      if (!cancelled) {
        setState({ catalog, kind: 'loaded' });
      }
    }

    void load().catch((error: unknown) => {
      if (!cancelled) {
        setState({
          kind: 'error',
          message: error instanceof Error ? error.message : 'Unable to load the app catalog.',
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return { reload, setCatalog, state };
}
