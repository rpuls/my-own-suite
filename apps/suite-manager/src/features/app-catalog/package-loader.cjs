const fs = require('node:fs');
const path = require('node:path');

const PROVISIONING_MODES = new Set(['automatic', 'assisted', 'manual', 'unsupported-alpha']);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function optionalString(value, label) {
  if (value === undefined || value === null) {
    return undefined;
  }
  return requireString(value, label);
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${label} must be an array of non-empty strings.`);
  }
  return value;
}

function optionalStringArray(value, label) {
  if (value === undefined || value === null) {
    return [];
  }
  return requireStringArray(value, label);
}

function normalizeAssetPath(packageDir, value, label) {
  const asset = requireString(value, label);
  const resolved = path.resolve(packageDir, asset);
  const root = path.resolve(packageDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must stay inside the app package.`);
  }
  return asset.replace(/\\/g, '/');
}

function normalizeRoute(route, label) {
  if (!isObject(route)) {
    throw new Error(`${label} must be an object.`);
  }
  return {
    host: requireString(route.host, `${label}.host`),
    httpsInHttpMode: route.httpsInHttpMode === true ? true : undefined,
    upstream: requireString(route.upstream, `${label}.upstream`),
  };
}

function normalizeHomepage(raw, source, packageDir) {
  if (raw === null) {
    return null;
  }
  if (!isObject(raw)) {
    throw new Error(`${source} homepage must be an object or null.`);
  }

  const contributions = isObject(raw.contributions) ? raw.contributions : {};
  const tile = isObject(raw.tile)
    ? raw.tile
    : raw.name
      ? raw
      : null;

  const normalizedContributions = {
    services: optionalStringArray(contributions.services, `${source} homepage.contributions.services`).map((asset, index) =>
      normalizeAssetPath(packageDir, asset, `${source} homepage.contributions.services[${index}]`),
    ),
    widgets: optionalStringArray(contributions.widgets, `${source} homepage.contributions.widgets`).map((asset, index) =>
      normalizeAssetPath(packageDir, asset, `${source} homepage.contributions.widgets[${index}]`),
    ),
  };

  return {
    contributions: normalizedContributions,
    tile:
      tile === null
        ? null
        : {
            description: requireString(tile.description, `${source} homepage.tile.description`),
            group: requireString(tile.group, `${source} homepage.tile.group`),
            hrefEnv: requireString(tile.hrefEnv, `${source} homepage.tile.hrefEnv`),
            icon: optionalString(tile.icon, `${source} homepage.tile.icon`),
            name: requireString(tile.name, `${source} homepage.tile.name`),
          },
  };
}

function normalizeEnv(raw, source) {
  const env = isObject(raw.env) ? raw.env : {};
  const projections = Array.isArray(env.projections) ? env.projections : [];
  return {
    projections: projections.map((projection, index) => {
      const label = `${source} env.projections[${index}]`;
      if (!isObject(projection)) {
        throw new Error(`${label} must be an object.`);
      }
      return {
        key: requireString(projection.key, `${label}.key`),
        serviceEnv: requireString(projection.serviceEnv, `${label}.serviceEnv`),
        value: requireString(projection.value, `${label}.value`),
      };
    }),
  };
}

function normalizeLifecycle(raw) {
  const lifecycle = isObject(raw.lifecycle) ? raw.lifecycle : {};
  return {
    installable: lifecycle.installable === true,
  };
}

function normalizeSetupHelper(value, source, packageDir) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return {
      backend: null,
      frontend: null,
      id: requireString(value, `${source} provisioning.setupHelper`),
    };
  }
  if (!isObject(value)) {
    throw new Error(`${source} provisioning.setupHelper must be a string, object, or null.`);
  }
  return {
    backend:
      value.backend === undefined || value.backend === null
        ? null
        : normalizeAssetPath(packageDir, value.backend, `${source} provisioning.setupHelper.backend`),
    frontend:
      value.frontend === undefined || value.frontend === null
        ? null
        : normalizeAssetPath(packageDir, value.frontend, `${source} provisioning.setupHelper.frontend`),
    id: requireString(value.id, `${source} provisioning.setupHelper.id`),
  };
}

function normalizeDoctor(raw, source) {
  if (raw.doctor === undefined || raw.doctor === null) {
    return null;
  }
  if (!isObject(raw.doctor)) {
    throw new Error(`${source} doctor must be an object or null.`);
  }
  const doctor = raw.doctor;
  const checks = Array.isArray(doctor.checks) ? doctor.checks : [];
  const homepageUrls = Array.isArray(doctor.homepageUrls) ? doctor.homepageUrls : [];
  return {
    checks: checks.map((check, index) => {
      const label = `${source} doctor.checks[${index}]`;
      if (!isObject(check)) {
        throw new Error(`${label} must be an object.`);
      }
      const type = requireString(check.type, `${label}.type`);
      if (type !== 'envIncludesEnv') {
        throw new Error(`${label}.type is not supported: ${type}`);
      }
      return {
        allowTemplate: optionalString(check.allowTemplate, `${label}.allowTemplate`),
        message: requireString(check.message, `${label}.message`),
        sourceKey: requireString(check.sourceKey, `${label}.sourceKey`),
        sourceServiceEnv: requireString(check.sourceServiceEnv, `${label}.sourceServiceEnv`),
        targetKey: requireString(check.targetKey, `${label}.targetKey`),
        targetServiceEnv: requireString(check.targetServiceEnv, `${label}.targetServiceEnv`),
        type,
      };
    }),
    homepageUrls: homepageUrls.map((homepageUrl, index) => {
      const label = `${source} doctor.homepageUrls[${index}]`;
      if (!isObject(homepageUrl)) {
        throw new Error(`${label} must be an object.`);
      }
      return {
        host: requireString(homepageUrl.host, `${label}.host`),
        key: requireString(homepageUrl.key, `${label}.key`),
      };
    }),
    requiredEnv: optionalStringArray(doctor.requiredEnv, `${source} doctor.requiredEnv`),
    serviceEnv: requireString(doctor.serviceEnv, `${source} doctor.serviceEnv`),
  };
}

function normalizeRoutes(raw, source, packageDir) {
  const routes = raw.routes;
  if (Array.isArray(routes)) {
    return {
      internal: [],
      public: routes.map((route, index) => normalizeRoute(route, `${source} routes[${index}]`)),
    };
  }
  if (!isObject(routes)) {
    return { internal: [], public: [] };
  }
  const publicRoutes = Array.isArray(routes.public) ? routes.public : [];
  const internalRoutes = Array.isArray(routes.internal) ? routes.internal : [];
  return {
    internal: internalRoutes.map((route, index) => {
      const label = `${source} routes.internal[${index}]`;
      if (!isObject(route)) {
        throw new Error(`${label} must be an object.`);
      }
      return {
        asset: normalizeAssetPath(packageDir, route.asset, `${label}.asset`),
        id: requireString(route.id, `${label}.id`),
      };
    }),
    public: publicRoutes.map((route, index) => normalizeRoute(route, `${source} routes.public[${index}]`)),
  };
}

function normalizeAppManifest(raw, source, packageDir) {
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
  if (!PROVISIONING_MODES.has(mode)) {
    throw new Error(`${source} provisioning.mode is not supported: ${mode}`);
  }

  const routes = normalizeRoutes(raw, source, packageDir);
  const homepage = normalizeHomepage(raw.homepage, source, packageDir);

  return {
    backup: {
      includeVolumes: requireStringArray(backup.includeVolumes, `${source} backup.includeVolumes`),
      restoreNotes: optionalString(backup.restoreNotes, `${source} backup.restoreNotes`),
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
    env: normalizeEnv(raw, source),
    doctor: normalizeDoctor(raw, source),
    homepage,
    id: requireString(raw.id, `${source} id`),
    lifecycle: normalizeLifecycle(raw),
    name: requireString(raw.name, `${source} name`),
    package: {
      dir: packageDir,
      source,
    },
    provisioning: {
      mode,
      postInstallActionLabel:
        provisioning.postInstallActionLabel === null
          ? null
          : optionalString(provisioning.postInstallActionLabel, `${source} provisioning.postInstallActionLabel`) || null,
      setupHelper: normalizeSetupHelper(provisioning.setupHelper, source, packageDir),
    },
    routes,
    summary: requireString(raw.summary, `${source} summary`),
  };
}

function getCatalogDir(repoRoot) {
  return path.join(repoRoot, 'apps', 'suite-manager', 'catalog');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadCatalogApps(catalogDir) {
  const appsDir = path.join(catalogDir, 'apps');
  if (!fs.existsSync(appsDir)) {
    return [];
  }

  const apps = [];
  for (const entry of fs.readdirSync(appsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) {
      const manifestPath = path.join(appsDir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        continue;
      }
      apps.push(
        normalizeAppManifest(
          readJson(manifestPath),
          `catalog/apps/${entry.name}/manifest.json`,
          path.join(appsDir, entry.name),
        ),
      );
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.json')) {
      const manifestPath = path.join(appsDir, entry.name);
      apps.push(
        normalizeAppManifest(
          readJson(manifestPath),
          `catalog/apps/${entry.name}`,
          appsDir,
        ),
      );
    }
  }

  const seen = new Set();
  for (const app of apps) {
    if (seen.has(app.id)) {
      throw new Error(`Duplicate catalog app id: ${app.id}`);
    }
    seen.add(app.id);
  }

  return apps.sort((left, right) => left.id.localeCompare(right.id));
}

function getSelectedCatalogAppIds(selection) {
  return new Set(
    (Array.isArray(selection.apps) ? selection.apps : [])
      .filter((app) => app && (app.status === 'installed' || app.status === 'pending-apply'))
      .map((app) => app.id)
      .filter((id) => typeof id === 'string' && id.trim()),
  );
}

module.exports = {
  getCatalogDir,
  getSelectedCatalogAppIds,
  loadCatalogApps,
};
