// App package manifest reading, validation, and public projections.
//
// Validation is two passes over the locked generation-1 contract:
//   1. structure — apps/manifest.schema.json interpreted by manifest-schema.cjs
//   2. semantics — cross-references, template grammar, package files, and the
//      provisional areas, in manifest-semantics.cjs
// The open-world rule applies throughout: unknown manifest fields are ignored,
// never fatal, and projections copy known fields only, so an unknown field can
// never leak into a runtime projection either.
const fs = require('node:fs');
const path = require('node:path');

const { validateManifestStructure } = require('./manifest-schema.cjs');
const { APP_ID_PATTERN, validateManifestSemantics } = require('./manifest-semantics.cjs');

const MANIFEST_FILENAME = 'manifest.json';
const SUPPORTED_RESOURCE_LEVELS = new Set(['low', 'medium', 'high']);
const SUPPORTED_PACKAGE_ROLES = new Set(['standalone', 'capability-provider']);
const CATALOG_LINK_KEYS = new Set(['docs', 'repository', 'website']);

class AppPackageManifestError extends Error {
  constructor(message, details = []) {
    super(message);
    this.code = 'INVALID_APP_PACKAGE_MANIFEST';
    this.details = details;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => hasText(item));
}

function safeUrl(value) {
  if (!hasText(value)) return false;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function validateAppPackageManifest(manifest, { packageDir = null } = {}) {
  if (!isRecord(manifest)) {
    return ['Manifest must be a JSON object.'];
  }
  const errors = validateManifestStructure(manifest);
  errors.push(...validateManifestSemantics(manifest, { packageDir }));
  return errors;
}

function readAppPackageManifest(packageDir) {
  const manifestPath = path.join(packageDir, MANIFEST_FILENAME);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = validateAppPackageManifest(manifest, { packageDir });
  if (errors.length) {
    throw new AppPackageManifestError(`Invalid app package manifest at ${manifestPath}.`, errors);
  }
  return {
    manifest,
    manifestPath,
    packageDir,
  };
}

function publicOnboarding(manifest) {
  const onboarding = isRecord(manifest.onboarding) ? manifest.onboarding : {};
  const sections = Array.isArray(onboarding.sections) ? onboarding.sections : [];
  return {
    summary: typeof onboarding.summary === 'string' ? onboarding.summary : '',
    title: typeof onboarding.title === 'string' ? onboarding.title : '',
    sections: sections
      .filter((section) => isRecord(section))
      .map((section) => ({
        body: typeof section.body === 'string' ? section.body : '',
        choices: Array.isArray(section.choices) ? section.choices
          .filter((choice) => isRecord(choice))
          .map((choice) => ({
            id: typeof choice.id === 'string' ? choice.id : '',
            label: typeof choice.label === 'string' ? choice.label : '',
            steps: isStringArray(choice.steps) ? choice.steps : [],
          }))
          .filter((choice) => choice.id && choice.label) : [],
        id: typeof section.id === 'string' ? section.id : '',
        steps: isStringArray(section.steps) ? section.steps : [],
        title: typeof section.title === 'string' ? section.title : '',
        type: typeof section.type === 'string' ? section.type : 'steps',
        values: Array.isArray(section.values) ? section.values
          .filter((value) => isRecord(value))
          .map((value) => ({
            copy: value.copy === true,
            label: typeof value.label === 'string' ? value.label : '',
            value: typeof value.value === 'string' ? value.value : '',
          }))
          .filter((value) => value.label || value.value) : [],
        actionLabel: typeof section.actionLabel === 'string' ? section.actionLabel : '',
      }))
      .filter((section) => section.id && section.title),
  };
}

function publicCatalog(manifest) {
  const catalog = isRecord(manifest.catalog) ? manifest.catalog : {};
  const normalizeFeature = (feature) => ({
    body: hasText(feature?.body) ? feature.body : '',
    title: hasText(feature?.title) ? feature.title : '',
  });
  const resourceHint = isRecord(catalog.resourceHint) ? catalog.resourceHint : {};
  const privacy = isRecord(catalog.privacy) ? catalog.privacy : {};
  const links = isRecord(catalog.links) ? catalog.links : {};

  return {
    description: hasText(catalog.description) ? catalog.description : '',
    demoDeployTargets: Array.isArray(catalog.demoDeployTargets) ? catalog.demoDeployTargets
      .filter((target) => isRecord(target) && APP_ID_PATTERN.test(String(target.provider || '')) && hasText(target.label) && safeUrl(target.url))
      .map((target) => ({ label: target.label, provider: target.provider, url: target.url })) : [],
    features: Array.isArray(catalog.features) ? catalog.features.map(normalizeFeature).filter((item) => item.title) : [],
    links: Object.fromEntries(
      Object.entries(links).filter(([key, value]) => CATALOG_LINK_KEYS.has(key) && safeUrl(value)),
    ),
    privacy: {
      notes: isStringArray(privacy.notes) ? privacy.notes : [],
      summary: hasText(privacy.summary) ? privacy.summary : '',
    },
    related: Array.isArray(catalog.related) ? catalog.related.filter((id) => APP_ID_PATTERN.test(String(id))) : [],
    replaces: isStringArray(catalog.replaces) ? catalog.replaces : [],
    resourceHint: {
      description: hasText(resourceHint.description) ? resourceHint.description : '',
      label: hasText(resourceHint.label) ? resourceHint.label : '',
      level: SUPPORTED_RESOURCE_LEVELS.has(resourceHint.level) ? resourceHint.level : '',
    },
    // A relative src is a file inside the package, served through the same
    // authenticated endpoint family as the icon; the index addresses this
    // filtered projection, which screenshotPath() mirrors exactly.
    screenshots: Array.isArray(catalog.screenshots) ? catalog.screenshots
      .filter((screenshot) => isRecord(screenshot) && hasText(screenshot.src))
      .map((screenshot, index) => ({
        alt: hasText(screenshot.alt) ? screenshot.alt : '',
        caption: hasText(screenshot.caption) ? screenshot.caption : '',
        src: `/suite-manager/api/apps/packages/${encodeURIComponent(manifest.id || '')}/screenshots/${index}`,
      })) : [],
    tags: isStringArray(catalog.tags) ? catalog.tags : [],
  };
}

function publicPackageSummary(manifest, validationErrors = []) {
  const services = Object.entries(isRecord(manifest.resources?.services) ? manifest.resources.services : {})
    .map(([id, service]) => ({
      dockerfile: hasText(service?.dockerfile) ? service.dockerfile : null,
      id,
      internalPort: Number.isInteger(service?.internalPort) ? service.internalPort : null,
      volumes: Array.isArray(service?.volumes) ? service.volumes : [],
    }));
  return {
    category: hasText(manifest.category) ? manifest.category : 'unknown',
    health: isRecord(manifest.health) ? {
      type: manifest.health.type || null,
      url: manifest.health.url || null,
    } : null,
    catalog: publicCatalog(manifest),
    homepage: isRecord(manifest.homepage) ? {
      description: manifest.homepage.description || manifest.summary || '',
      group: manifest.homepage.group || '',
      icon: manifest.homepage.icon || '',
      name: manifest.homepage.name || manifest.name || manifest.id,
      ...(isRecord(manifest.homepage.widget) ? { widget: manifest.homepage.widget } : {}),
    } : null,
    capabilities: {
      exports: publicCapabilityExports(manifest.exports),
      integrations: publicIntegrationSlots(manifest.integrations),
      usefulness: publicUsefulness(manifest.usefulness),
    },
    icon: manifest.icon || manifest.homepage?.icon || '',
    iconUrl: hasText(manifest.icon) ? `/suite-manager/api/apps/packages/${encodeURIComponent(manifest.id || '')}/icon` : '',
    id: manifest.id || '',
    installStatus: 'not-installed',
    name: manifest.name || manifest.id || 'Unknown package',
    role: SUPPORTED_PACKAGE_ROLES.has(manifest.role) ? manifest.role : 'standalone',
    routes: Array.isArray(manifest.routes) ? manifest.routes.map((route) => ({
      host: route?.host || '',
      service: route?.service || '',
    })) : [],
    services,
    setup: {
      fieldCount: Array.isArray(manifest.setup?.fields) ? manifest.setup.fields.length : 0,
      fields: Array.isArray(manifest.setup?.fields)
        ? manifest.setup.fields.map((field) => ({
          id: field?.id || '',
          generated: isRecord(field?.generated),
          label: field?.label || '',
          required: field?.required === true,
          secret: field?.secret === true,
          type: field?.type || '',
          ...(field?.secret === true || field?.default === undefined ? {} : { default: field.default }),
        }))
        : [],
    },
    summary: manifest.summary || '',
    onboarding: publicOnboarding(manifest),
    validation: {
      errors: validationErrors,
      valid: validationErrors.length === 0,
    },
    version: manifest.version || '',
    minimumMosVersion: manifest.minimumMosVersion || '',
  };
}

function publicCapabilityExports(exports) {
  if (!isRecord(exports)) return [];
  return Object.entries(exports).map(([id, capability]) => ({
    id,
    interfaceVersion: Number.isInteger(capability.interfaceVersion) ? capability.interfaceVersion : null,
    protocol: typeof capability.protocol === 'string' ? capability.protocol : '',
    title: typeof capability.title === 'string' ? capability.title : '',
    type: typeof capability.type === 'string' ? capability.type : '',
  })).filter((item) => item.type);
}

function publicIntegrationSlots(integrations) {
  if (!isRecord(integrations)) return [];
  return Object.entries(integrations).map(([id, integration]) => ({
    accepts: Array.isArray(integration.accepts) ? integration.accepts.map((matcher) => ({
      interfaceVersion: Number.isInteger(matcher?.interfaceVersion) ? matcher.interfaceVersion : null,
      protocol: typeof matcher?.protocol === 'string' ? matcher.protocol : '',
      type: typeof matcher?.type === 'string' ? matcher.type : '',
    })).filter((matcher) => matcher.type) : [],
    id,
    title: typeof integration.title === 'string' ? integration.title : id,
  })).filter((item) => item.accepts.length);
}

function publicUsefulness(usefulness) {
  if (!isRecord(usefulness)) return { emptyState: '', requiresOneOf: [] };
  return {
    emptyState: typeof usefulness.emptyState === 'string' ? usefulness.emptyState : '',
    requiresOneOf: isStringArray(usefulness.requiresOneOf) ? usefulness.requiresOneOf : [],
  };
}

function inspectAppPackages(appsDir) {
  if (!fs.existsSync(appsDir)) return [];
  return fs.readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDir = path.join(appsDir, entry.name);
      const manifestPath = path.join(packageDir, MANIFEST_FILENAME);
      if (!fs.existsSync(manifestPath)) return null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const errors = validateAppPackageManifest(manifest, { packageDir });
        return publicPackageSummary(manifest, errors);
      } catch (error) {
        return publicPackageSummary({
          category: 'unknown',
          id: entry.name,
          name: entry.name,
          summary: 'Package manifest could not be read.',
          version: '0.0.0',
        }, [error instanceof Error ? error.message : 'Package manifest could not be read.']);
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function discoverAppPackages(appsDir) {
  if (!fs.existsSync(appsDir)) return [];
  return fs.readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appsDir, entry.name))
    .filter((packageDir) => fs.existsSync(path.join(packageDir, MANIFEST_FILENAME)))
    .map((packageDir) => readAppPackageManifest(packageDir))
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

module.exports = {
  AppPackageManifestError,
  MANIFEST_FILENAME,
  discoverAppPackages,
  inspectAppPackages,
  publicPackageSummary,
  readAppPackageManifest,
  validateAppPackageManifest,
};
