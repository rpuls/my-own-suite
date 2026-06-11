import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import { writeComposeSelection } from './compose-selection.ts';
import { buildInstallPlan, InstalledCatalogStateStore } from './state-store.ts';
import type { CatalogAppManifest, CatalogInstallPlan, InstalledCatalogState } from './types.ts';
import { loadCatalogManifests } from './manifest.ts';

type CatalogAppResponse = {
  category: string;
  compose: {
    profile: string;
    services: string[];
  };
  dependencies: Array<{
    id: string;
    kind: 'required' | 'recommended';
  }>;
  docs: {
    app: string;
  };
  homepage: CatalogAppManifest['homepage'];
  id: string;
  installed: {
    installedAt: string | null;
    lastApply: {
      message: string | null;
      status: 'pending' | 'succeeded' | 'failed';
      updatedAt: string;
    } | null;
    status: 'not-installed' | 'pending-apply' | 'installing' | 'installed' | 'failed' | 'disabled';
  };
  name: string;
  provisioning: CatalogAppManifest['provisioning'];
  routes: CatalogAppManifest['routes'];
  summary: string;
};

function toAppResponse(
  app: CatalogAppManifest,
  installedState: InstalledCatalogState,
): CatalogAppResponse {
  const installedApp = installedState.apps.find((stateApp) => stateApp.appId === app.id);

  return {
    category: app.category,
    compose: {
      profile: app.compose.profile,
      services: app.compose.services,
    },
    dependencies: app.dependencies || [],
    docs: app.docs,
    homepage: app.homepage,
    id: app.id,
    installed: installedApp
      ? {
          installedAt: installedApp.installedAt,
          lastApply: installedApp.lastApply,
          status: installedApp.status,
        }
      : {
          installedAt: null,
          lastApply: null,
          status: 'not-installed',
        },
    name: app.name,
    provisioning: app.provisioning,
    routes: app.routes,
    summary: app.summary,
  };
}

function catalogResponse(catalog: Awaited<ReturnType<typeof loadCatalogManifests>>, installedState: InstalledCatalogState) {
  return {
    apps: catalog.apps.map((app) => toAppResponse(app, installedState)),
    controlPlane: catalog.controlPlane,
    generatedAt: new Date().toISOString(),
    installed: installedState,
  };
}

class CatalogInstallError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

function createInstallPlan(app: CatalogAppManifest): CatalogInstallPlan {
  if (app.id !== 'stirling-pdf') {
    throw new CatalogInstallError(409, `${app.name} install is not enabled in this alpha slice yet.`);
  }

  if (app.provisioning.mode !== 'automatic') {
    throw new CatalogInstallError(400, `${app.name} requires a setup helper before it can be installed.`);
  }

  return buildInstallPlan(app);
}

export function createAppCatalogRouter(config: SuiteManagerConfig): Hono {
  const router = new Hono();
  const stateStore = new InstalledCatalogStateStore(config.stateDir);

  router.get('/app-catalog', async (c) => {
    const catalog = await loadCatalogManifests();
    const installedState = stateStore.load();

    return c.json(catalogResponse(catalog, installedState));
  });

  router.post('/app-catalog/apps/:id/install', async (c) => {
    const catalog = await loadCatalogManifests();
    const appId = c.req.param('id');
    const app = catalog.apps.find((candidate) => candidate.id === appId);

    if (!app) {
      return c.json({ error: `Catalog app not found: ${appId}` }, 404);
    }

    try {
      const plan = createInstallPlan(app);
      const installedState = stateStore.markPendingApply(app, plan);
      const composeSelection = writeComposeSelection(config.stateDir, installedState);

      return c.json(
        {
          ...catalogResponse(catalog, installedState),
          composeSelection: {
            profiles: composeSelection.selection.profiles,
          },
          plan,
        },
        202,
      );
    } catch (error: unknown) {
      if (error instanceof CatalogInstallError) {
        return c.json({ error: error.message }, error.status);
      }

      throw error;
    }
  });

  return router;
}
