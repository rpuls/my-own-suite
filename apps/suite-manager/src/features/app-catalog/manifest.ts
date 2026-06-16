import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import YAML from 'yaml';

import type {
  CatalogAppManifest,
  CatalogControlPlaneManifest,
  CatalogManifestSet,
} from './types.ts';

const require = createRequire(import.meta.url);
const { loadCatalogApps } = require('./package-loader.cjs') as {
  loadCatalogApps: (catalogDir: string) => Array<{
    backup: {
      includeVolumes: string[];
      restoreNotes?: string;
    };
    category: string;
    compose: {
      envTemplates: string[];
      profile: string;
      services: string[];
      volumes: string[];
    };
    dependencies?: Array<{ id: string; kind: 'required' | 'recommended' }>;
    doctor: CatalogAppManifest['doctor'];
    docs: {
      app: string;
    };
    env: {
      projections: Array<{ key: string; serviceEnv: string; value: string }>;
    };
    homepage: {
      contributions: {
        services: string[];
        widgets: string[];
      };
      tile: CatalogAppManifest['homepage'];
    } | null;
    id: string;
    lifecycle: CatalogAppManifest['lifecycle'];
    name: string;
    package: {
      dir: string;
      source: string;
    };
    provisioning: {
      mode: CatalogAppManifest['provisioning']['mode'];
      postInstallActionLabel: string | null;
      setupHelper: CatalogAppManifest['provisioning']['setupHelper'];
    };
    routes: {
      internal: Array<{ asset: string; id: string }>;
      public: CatalogAppManifest['routes'];
    };
    summary: string;
  }>;
};

export function getDefaultCatalogDir(): string {
  return path.resolve(import.meta.dirname, '../../..', 'catalog');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function normalizePackageApp(app: ReturnType<typeof loadCatalogApps>[number]): CatalogAppManifest {
  return {
    backup: app.backup,
    category: app.category,
    compose: app.compose,
    dependencies: app.dependencies,
    doctor: app.doctor,
    docs: app.docs,
    env: app.env,
    homepage: app.homepage?.tile ?? null,
    homepageContributions: app.homepage?.contributions ?? { services: [], widgets: [] },
    id: app.id,
    lifecycle: app.lifecycle,
    name: app.name,
    package: app.package,
    provisioning: app.provisioning,
    routeContributions: {
      internal: app.routes.internal,
    },
    routes: app.routes.public,
    summary: app.summary,
  };
}

function validateControlPlaneShape(raw: unknown, source: string): CatalogControlPlaneManifest {
  if (!isObject(raw)) {
    throw new Error(`${source} must contain a JSON object.`);
  }
  if (raw.id !== 'control-plane') {
    throw new Error(`${source} id must be control-plane.`);
  }
  if (!Array.isArray(raw.components)) {
    throw new Error(`${source} components must be an array.`);
  }

  return {
    components: raw.components.map((component, index) => {
      if (!isObject(component)) {
        throw new Error(`${source} components[${index}] must be an object.`);
      }
      return {
        composeServices: requireStringArray(
          component.composeServices,
          `${source} components[${index}].composeServices`,
        ),
        envTemplates: requireStringArray(component.envTemplates, `${source} components[${index}].envTemplates`),
        id: requireString(component.id, `${source} components[${index}].id`),
        name: requireString(component.name, `${source} components[${index}].name`),
        volumes: requireStringArray(component.volumes, `${source} components[${index}].volumes`),
      };
    }),
    hostAgents: requireStringArray(raw.hostAgents, `${source} hostAgents`),
    id: 'control-plane',
    name: requireString(raw.name, `${source} name`),
  };
}

export async function loadCatalogManifests(catalogDir = getDefaultCatalogDir()): Promise<CatalogManifestSet> {
  const apps = loadCatalogApps(catalogDir).map(normalizePackageApp);
  const controlPlane = validateControlPlaneShape(
    await readJsonFile<unknown>(path.join(catalogDir, 'control-plane.json')),
    'catalog/control-plane.json',
  );

  return {
    apps,
    controlPlane,
  };
}

export async function validateCatalogAgainstRepo(
  repoRoot: string,
  catalog: CatalogManifestSet,
): Promise<string[]> {
  const errors: string[] = [];
  const composePath = path.join(repoRoot, 'deploy/vps/docker-compose.yml');
  const compose = YAML.parse(await fs.readFile(composePath, 'utf8')) as {
    services?: Record<string, { profiles?: string[] }>;
    volumes?: Record<string, unknown>;
  };
  const composeServices = compose.services || {};
  const composeVolumes = compose.volumes || {};
  const appIds = new Set(catalog.apps.map((app) => app.id));

  for (const app of catalog.apps) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(app.id)) {
      errors.push(`${app.id}: id must be kebab-case.`);
    }

    for (const serviceName of app.compose.services) {
      const service = composeServices[serviceName];
      if (!service) {
        errors.push(`${app.id}: compose service ${serviceName} does not exist.`);
        continue;
      }
      if (!service.profiles?.includes(app.compose.profile)) {
        errors.push(`${app.id}: compose service ${serviceName} is missing profile ${app.compose.profile}.`);
      }
    }

    for (const volumeName of app.compose.volumes) {
      if (!Object.prototype.hasOwnProperty.call(composeVolumes, volumeName)) {
        errors.push(`${app.id}: compose volume ${volumeName} does not exist.`);
      }
    }

    for (const volumeName of app.backup.includeVolumes) {
      if (!app.compose.volumes.includes(volumeName)) {
        errors.push(`${app.id}: backup volume ${volumeName} is not listed in compose.volumes.`);
      }
    }

    for (const envTemplate of app.compose.envTemplates) {
      try {
        await fs.access(path.join(repoRoot, envTemplate));
      } catch {
        errors.push(`${app.id}: env template ${envTemplate} does not exist.`);
      }
    }

    for (const projection of app.env.projections) {
      try {
        await fs.access(path.join(repoRoot, 'deploy/vps', projection.serviceEnv));
      } catch {
        const templatePath = path.join(repoRoot, 'deploy/vps', projection.serviceEnv.replace(/\.env$/, '.env.template'));
        try {
          await fs.access(templatePath);
        } catch {
          errors.push(`${app.id}: env projection target ${projection.serviceEnv} does not exist.`);
        }
      }
    }

    for (const asset of [...app.homepageContributions.services, ...app.homepageContributions.widgets]) {
      try {
        await fs.access(path.join(app.package.dir, asset));
      } catch {
        errors.push(`${app.id}: package asset ${asset} does not exist.`);
      }
    }

    for (const asset of [app.provisioning.setupHelper?.backend, app.provisioning.setupHelper?.frontend]) {
      if (!asset) {
        continue;
      }
      try {
        await fs.access(path.join(app.package.dir, asset));
      } catch {
        errors.push(`${app.id}: setup helper asset ${asset} does not exist.`);
      }
    }

    if (app.lifecycle.installable && app.provisioning.mode === 'assisted') {
      if (!app.provisioning.setupHelper?.backend || !app.provisioning.setupHelper?.frontend) {
        errors.push(`${app.id}: assisted installable apps must declare setup helper backend and frontend assets.`);
      }
    }

    if (app.doctor) {
      const doctorEnvTemplate = path.join(repoRoot, 'deploy/vps', app.doctor.serviceEnv.replace(/\.env$/, '.env.template'));
      try {
        await fs.access(doctorEnvTemplate);
      } catch {
        errors.push(`${app.id}: doctor service env ${app.doctor.serviceEnv} does not have a matching template.`);
      }
    }

    for (const route of app.routes) {
      if (!route.upstream.includes(':')) {
        errors.push(`${app.id}: route ${route.host} upstream should include service and port.`);
      }
      const upstreamService = route.upstream.split(':')[0] || '';
      if (!app.compose.services.includes(upstreamService)) {
        errors.push(`${app.id}: route ${route.host} upstream service ${upstreamService} is not part of the app.`);
      }
    }

    for (const route of app.routeContributions.internal) {
      try {
        await fs.access(path.join(app.package.dir, route.asset));
      } catch {
        errors.push(`${app.id}: internal route asset ${route.asset} does not exist.`);
      }
    }

    for (const dependency of app.dependencies || []) {
      if (!appIds.has(dependency.id)) {
        errors.push(`${app.id}: dependency ${dependency.id} does not exist in the catalog.`);
      }
    }
  }

  for (const component of catalog.controlPlane.components) {
    for (const serviceName of component.composeServices) {
      if (!composeServices[serviceName]) {
        errors.push(`control-plane/${component.id}: compose service ${serviceName} does not exist.`);
      }
    }
    for (const volumeName of component.volumes) {
      if (!Object.prototype.hasOwnProperty.call(composeVolumes, volumeName)) {
        errors.push(`control-plane/${component.id}: compose volume ${volumeName} does not exist.`);
      }
    }
    for (const envTemplate of component.envTemplates) {
      try {
        await fs.access(path.join(repoRoot, envTemplate));
      } catch {
        errors.push(`control-plane/${component.id}: env template ${envTemplate} does not exist.`);
      }
    }
  }

  return errors;
}
