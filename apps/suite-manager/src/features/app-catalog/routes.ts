import { Hono } from 'hono';

import type { SuiteManagerConfig } from '../../config.ts';
import { writeComposeSelection, type WrittenComposeSelection } from './compose-selection.ts';
import { buildInstallPlan, InstalledCatalogStateStore } from './state-store.ts';
import type { CatalogAppManifest, CatalogInstallPlan, InstalledCatalogState } from './types.ts';
import { loadCatalogManifests } from './manifest.ts';
import type { ServiceAgentService } from '../service-agent/service.ts';
import type { ServiceCapabilityStatus } from '../service-agent/service.ts';
import type { HomepageConfigService } from '../homepage-config/service.ts';

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

type CatalogOutputReconcileResult = {
  composeSelection: WrittenComposeSelection;
  hostSync:
    | {
        message: string | null;
        synced: boolean;
      }
    | null;
};

async function reconcileCatalogOutputs(
  config: SuiteManagerConfig,
  installedState: InstalledCatalogState,
  serviceAgentService?: ServiceAgentService,
  knownCapabilities?: ServiceCapabilityStatus,
): Promise<CatalogOutputReconcileResult> {
  const composeSelection = writeComposeSelection(config.stateDir, installedState);
  let hostSync: CatalogOutputReconcileResult['hostSync'] = null;

  if (!serviceAgentService) {
    return { composeSelection, hostSync };
  }

  const capabilities = knownCapabilities || (await serviceAgentService.getCapabilities());
  if (!capabilities.appCatalogComposeSelectionApplyAvailable) {
    if (capabilities.serviceAvailable) {
      hostSync = {
        message: 'Service agent is available but cannot sync app catalog Compose selection yet.',
        synced: false,
      };
    }
    return { composeSelection, hostSync };
  }

  try {
    await serviceAgentService.applyAppCatalogComposeSelection({
      applyServices: false,
      composeYaml: composeSelection.composeYaml,
      selectionJson: composeSelection.selectionJson,
    });
    hostSync = {
      message: null,
      synced: true,
    };
  } catch (error: unknown) {
    hostSync = {
      message:
        error instanceof Error
          ? error.message
          : 'Unable to sync app catalog Compose selection.',
      synced: false,
    };
  }

  return { composeSelection, hostSync };
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

export function createAppCatalogRouter(
  config: SuiteManagerConfig,
  serviceAgentService?: ServiceAgentService,
  homepageConfigService?: HomepageConfigService,
): Hono {
  const router = new Hono();
  const stateStore = new InstalledCatalogStateStore(config.stateDir);

  router.get('/app-catalog', async (c) => {
    const catalog = await loadCatalogManifests();
    const installedState = stateStore.load();
    const reconciled = await reconcileCatalogOutputs(config, installedState, serviceAgentService);

    return c.json({
      ...catalogResponse(catalog, installedState),
      composeSelection: {
        hostSync: reconciled.hostSync,
        profiles: reconciled.composeSelection.selection.profiles,
      },
    });
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
      let installedState = stateStore.markPendingApply(app, plan);
      let composeSelection = writeComposeSelection(config.stateDir, installedState);
      let hostApply:
        | {
            applied: boolean;
            message: string | null;
            output?: string;
          }
        | null = null;

      if (serviceAgentService) {
        const capabilities = await serviceAgentService.getCapabilities();
        if (capabilities.appCatalogComposeSelectionApplyAvailable) {
          try {
            const result = await serviceAgentService.applyAppCatalogComposeSelection({
              applyServices: true,
              composeYaml: composeSelection.composeYaml,
              selectionJson: composeSelection.selectionJson,
            });
            if (homepageConfigService && app.homepage) {
              await homepageConfigService.upsertCatalogAppTile({
                ...app.homepage,
                id: app.id,
              });
              if (capabilities.homepageRestartAvailable) {
                await serviceAgentService.restartHomepage();
              }
            }
            installedState = stateStore.updateApplyResult(app.id, {
              message: 'App services applied through the self-host service agent.',
              status: 'succeeded',
            });
            const reconciled = await reconcileCatalogOutputs(config, installedState, serviceAgentService, capabilities);
            composeSelection = reconciled.composeSelection;
            hostApply = {
              applied: true,
              message: reconciled.hostSync?.message || null,
              output: result.output,
            };
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : 'App catalog Compose apply failed.';
            installedState = stateStore.updateApplyResult(app.id, {
              message,
              status: 'failed',
            });
            composeSelection = writeComposeSelection(config.stateDir, installedState);
            hostApply = {
              applied: false,
              message,
            };
          }
        } else if (capabilities.serviceAvailable) {
          hostApply = {
            applied: false,
            message: 'Service agent is available but cannot apply app catalog Compose selection yet.',
          };
        }
      }

      return c.json(
        {
          ...catalogResponse(catalog, installedState),
          composeSelection: {
            hostApply,
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
