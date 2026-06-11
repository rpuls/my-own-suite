import fs from 'node:fs';
import path from 'node:path';

import type { CatalogAppManifest, CatalogInstallPlan, InstalledCatalogApp, InstalledCatalogState } from './types.ts';

export class InstalledCatalogStateStore {
  private readonly stateDir: string;
  private readonly stateFilePath: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.stateFilePath = path.join(stateDir, 'installed-apps.json');
  }

  getStateFilePath(): string {
    return this.stateFilePath;
  }

  load(): InstalledCatalogState {
    this.ensureStateDir();

    if (!fs.existsSync(this.stateFilePath)) {
      return {
        apps: [],
        updatedAt: null,
        version: 1,
      };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFilePath, 'utf8')) as Partial<InstalledCatalogState>;
      return {
        apps: Array.isArray(parsed.apps) ? parsed.apps.filter(isInstalledCatalogApp) : [],
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
        version: 1,
      };
    } catch {
      return {
        apps: [],
        updatedAt: null,
        version: 1,
      };
    }
  }

  markPendingApply(app: CatalogAppManifest, plan: CatalogInstallPlan, now = new Date()): InstalledCatalogState {
    const state = this.load();
    const routeHosts = app.routes.map((route) => route.host);
    const existingApp = state.apps.find((installedApp) => installedApp.appId === app.id);
    const nextApp: InstalledCatalogApp = {
      appId: app.id,
      installedAt: existingApp?.installedAt || now.toISOString(),
      installPlan: plan,
      lastApply: {
        message: 'Install plan recorded. Runtime Compose apply is not wired yet.',
        status: 'pending',
        updatedAt: now.toISOString(),
      },
      manifestVersion: 1,
      routeHosts,
      serviceNames: app.compose.services,
      status: 'pending-apply',
      volumeNames: app.compose.volumes,
    };
    const apps = state.apps.filter((installedApp) => installedApp.appId !== app.id);
    apps.push(nextApp);
    apps.sort((a, b) => a.appId.localeCompare(b.appId));

    return this.save({
      apps,
      updatedAt: now.toISOString(),
      version: 1,
    });
  }

  markInstalled(app: CatalogAppManifest, now = new Date()): InstalledCatalogState {
    return this.markPendingApply(app, buildInstallPlan(app), now);
  }

  updateApplyResult(
    appId: string,
    result: {
      message: string | null;
      status: 'succeeded' | 'failed';
    },
    now = new Date(),
  ): InstalledCatalogState {
    const state = this.load();
    return this.save({
      apps: state.apps.map((app) =>
        app.appId === appId
          ? {
              ...app,
              lastApply: {
                message: result.message,
                status: result.status,
                updatedAt: now.toISOString(),
              },
              status: result.status === 'succeeded' ? 'installed' : 'failed',
            }
          : app,
      ),
      updatedAt: now.toISOString(),
      version: 1,
    });
  }

  private ensureStateDir(): void {
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  private save(nextState: InstalledCatalogState): InstalledCatalogState {
    this.ensureStateDir();
    fs.writeFileSync(this.stateFilePath, JSON.stringify(nextState, null, 2), 'utf8');
    return nextState;
  }
}

export function buildInstallPlan(app: CatalogAppManifest): CatalogInstallPlan {
  return {
    appId: app.id,
    backupVolumes: app.backup.includeVolumes,
    composeProfile: app.compose.profile,
    composeServices: app.compose.services,
    envTemplates: app.compose.envTemplates,
    homepage: app.homepage,
    routeHosts: app.routes.map((route) => route.host),
    routes: app.routes,
    volumes: app.compose.volumes,
  };
}

function isInstalledCatalogApp(value: unknown): value is InstalledCatalogApp {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<InstalledCatalogApp>;
  return (
    typeof candidate.appId === 'string' &&
    typeof candidate.installedAt === 'string' &&
    typeof candidate.manifestVersion === 'number' &&
    Array.isArray(candidate.routeHosts) &&
    Array.isArray(candidate.serviceNames) &&
    Array.isArray(candidate.volumeNames) &&
    typeof candidate.status === 'string'
  );
}
