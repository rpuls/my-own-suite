import fs from 'node:fs/promises';
import path from 'node:path';

import YAML from 'yaml';

import type {
  CatalogAppManifest,
  CatalogControlPlaneManifest,
  CatalogManifestSet,
  CatalogProvisioningMode,
} from './types.ts';

const provisionModes = new Set<CatalogProvisioningMode>([
  'automatic',
  'assisted',
  'manual',
  'unsupported-alpha',
]);

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

function validateAppShape(raw: unknown, source: string): CatalogAppManifest {
  if (!isObject(raw)) {
    throw new Error(`${source} must contain a JSON object.`);
  }

  const compose = raw.compose;
  const docs = raw.docs;
  const provisioning = raw.provisioning;
  const backup = raw.backup;

  if (!isObject(compose)) {
    throw new Error(`${source} compose must be an object.`);
  }
  if (!isObject(docs)) {
    throw new Error(`${source} docs must be an object.`);
  }
  if (!isObject(provisioning)) {
    throw new Error(`${source} provisioning must be an object.`);
  }
  if (!isObject(backup)) {
    throw new Error(`${source} backup must be an object.`);
  }

  const mode = requireString(provisioning.mode, `${source} provisioning.mode`);
  if (!provisionModes.has(mode as CatalogProvisioningMode)) {
    throw new Error(`${source} provisioning.mode is not supported: ${mode}`);
  }

  const homepage = raw.homepage;
  if (homepage !== null && !isObject(homepage)) {
    throw new Error(`${source} homepage must be an object or null.`);
  }

  return {
    backup: {
      includeVolumes: requireStringArray(backup.includeVolumes, `${source} backup.includeVolumes`),
    },
    category: requireString(raw.category, `${source} category`),
    compose: {
      envTemplates: requireStringArray(compose.envTemplates, `${source} compose.envTemplates`),
      profile: requireString(compose.profile, `${source} compose.profile`),
      services: requireStringArray(compose.services, `${source} compose.services`),
      volumes: requireStringArray(compose.volumes, `${source} compose.volumes`),
    },
    dependencies: Array.isArray(raw.dependencies)
      ? raw.dependencies.map((dependency, index) => {
          if (!isObject(dependency)) {
            throw new Error(`${source} dependencies[${index}] must be an object.`);
          }
          const kind = requireString(dependency.kind, `${source} dependencies[${index}].kind`);
          if (kind !== 'required' && kind !== 'recommended') {
            throw new Error(`${source} dependencies[${index}].kind must be required or recommended.`);
          }
          return {
            id: requireString(dependency.id, `${source} dependencies[${index}].id`),
            kind,
          };
        })
      : undefined,
    docs: {
      app: requireString(docs.app, `${source} docs.app`),
    },
    homepage:
      homepage === null
        ? null
        : {
            description: requireString(homepage.description, `${source} homepage.description`),
            group: requireString(homepage.group, `${source} homepage.group`),
            hrefEnv: requireString(homepage.hrefEnv, `${source} homepage.hrefEnv`),
            icon: typeof homepage.icon === 'string' ? homepage.icon : undefined,
            name: requireString(homepage.name, `${source} homepage.name`),
          },
    id: requireString(raw.id, `${source} id`),
    name: requireString(raw.name, `${source} name`),
    provisioning: {
      mode: mode as CatalogProvisioningMode,
      setupHelper:
        provisioning.setupHelper === null ? null : requireString(provisioning.setupHelper, `${source} setupHelper`),
    },
    routes: Array.isArray(raw.routes)
      ? raw.routes.map((route, index) => {
          if (!isObject(route)) {
            throw new Error(`${source} routes[${index}] must be an object.`);
          }
          return {
            host: requireString(route.host, `${source} routes[${index}].host`),
            httpsInHttpMode: route.httpsInHttpMode === true ? true : undefined,
            upstream: requireString(route.upstream, `${source} routes[${index}].upstream`),
          };
        })
      : [],
    summary: requireString(raw.summary, `${source} summary`),
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
  const appsDir = path.join(catalogDir, 'apps');
  const entries = await fs.readdir(appsDir, { withFileTypes: true });
  const appFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  const apps = await Promise.all(
    appFiles.map(async (fileName) => {
      const source = `catalog/apps/${fileName}`;
      const raw = await readJsonFile<unknown>(path.join(appsDir, fileName));
      return validateAppShape(raw, source);
    }),
  );
  const controlPlane = validateControlPlaneShape(
    await readJsonFile<unknown>(path.join(catalogDir, 'control-plane.json')),
    'catalog/control-plane.json',
  );

  validateUniqueIds(apps);

  return {
    apps,
    controlPlane,
  };
}

function validateUniqueIds(apps: CatalogAppManifest[]): void {
  const seen = new Set<string>();
  for (const app of apps) {
    if (seen.has(app.id)) {
      throw new Error(`Duplicate catalog app id: ${app.id}`);
    }
    seen.add(app.id);
  }
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

    for (const route of app.routes) {
      if (!route.upstream.includes(':')) {
        errors.push(`${app.id}: route ${route.host} upstream should include service and port.`);
      }
      const upstreamService = route.upstream.split(':')[0] || '';
      if (!app.compose.services.includes(upstreamService)) {
        errors.push(`${app.id}: route ${route.host} upstream service ${upstreamService} is not part of the app.`);
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
