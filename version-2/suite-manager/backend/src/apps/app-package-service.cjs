const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  inspectAppPackages,
  publicPackageSummary,
  readAppPackageManifest,
} = require('./package-manifest.cjs');

class AppPackageServiceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digestFor(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function renderDryRunProjections(manifest) {
  const services = Object.entries(manifest.resources.services).map(([id, service]) => ({
    build: { context: `version-2/apps/${manifest.id}`, dockerfile: service.dockerfile },
    environment: service.env || {},
    id,
    internalPort: service.internalPort,
    volumes: service.volumes || [],
  }));
  const volumes = [...new Set(services.flatMap((service) => service.volumes.map((volume) => volume.split(':')[0])))].sort();
  const projections = [
    {
      content: {
        services,
        volumes,
      },
      kind: 'compose',
    },
    {
      content: {
        routes: manifest.routes.map((route) => ({
          host: route.host,
          reverseProxy: `${route.service}:${route.port}`,
        })),
      },
      kind: 'caddy',
    },
    {
      content: manifest.homepage,
      kind: 'homepage',
    },
    {
      content: {
        target: manifest.health.url,
        type: manifest.health.type,
      },
      kind: 'health',
    },
  ];
  return projections.map((projection) => ({
    ...projection,
    contentJson: stableJson(projection.content),
    digest: digestFor(projection.content),
  }));
}

function publicInstance(instance, projections = []) {
  if (!instance) return null;
  return {
    enabled: instance.enabled,
    id: instance.id,
    installedAt: instance.installedAt,
    manifestDigest: instance.manifestDigest,
    packageId: instance.packageId,
    packageVersion: instance.packageVersion,
    projections: projections.map((projection) => ({
      appliedDigest: projection.appliedDigest,
      content: projection.content,
      digest: projection.digest,
      kind: projection.kind,
      status: projection.status,
      updatedAt: projection.updatedAt,
    })),
    status: instance.status,
    updatedAt: instance.updatedAt,
  };
}

class AppPackageService {
  constructor({ appsDir, now = () => new Date(), store }) {
    this.appsDir = appsDir;
    this.now = now;
    this.store = store;
  }

  listPackages() {
    const instancesByPackage = new Map(this.store.getAppInstances().map((instance) => [instance.packageId, instance]));
    return inspectAppPackages(this.appsDir).map((summary) => {
      const instance = instancesByPackage.get(summary.id);
      const projections = instance ? this.store.getAppProjections(instance.id) : [];
      return {
        ...summary,
        installStatus: instance?.status || 'not-installed',
        instance: publicInstance(instance, projections),
      };
    });
  }

  installPackage(packageId) {
    const current = this.store.getAppInstanceByPackageId(packageId);
    if (current) {
      return publicInstance(current, this.store.getAppProjections(current.id));
    }

    const packageDir = path.join(this.appsDir, packageId);
    if (!fs.existsSync(path.join(packageDir, 'manifest.json'))) {
      throw new AppPackageServiceError('APP_PACKAGE_NOT_FOUND', 'That app package is not available.', 404);
    }
    const { manifest } = readAppPackageManifest(packageDir);
    const at = this.now().toISOString();
    const manifestDigest = digestFor(manifest);
    const projections = renderDryRunProjections(manifest);
    const instance = {
      categorySnapshot: manifest.category,
      displayNameSnapshot: manifest.name,
      id: crypto.randomUUID(),
      manifestDigest,
      packageId: manifest.id,
      packageVersion: manifest.version,
    };
    this.store.installAppInstance({
      at,
      instance,
      operationId: crypto.randomUUID(),
      projections,
      request: {
        dryRunOnly: true,
        packageId: manifest.id,
        packageVersion: manifest.version,
      },
    });

    return publicInstance(this.store.getAppInstanceByPackageId(packageId), this.store.getAppProjections(instance.id));
  }

  packageSummaryFor(manifest, validationErrors = []) {
    return publicPackageSummary(manifest, validationErrors);
  }
}

module.exports = {
  AppPackageServiceError,
  AppPackageService,
  digestFor,
  renderDryRunProjections,
  stableJson,
};
