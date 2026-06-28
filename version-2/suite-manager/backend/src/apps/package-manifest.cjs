const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_FILENAME = 'manifest.json';
const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const FIELD_ID_PATTERN = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/u;
const SEMVERISH_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SUPPORTED_FIELD_TYPES = new Set(['boolean', 'email', 'password', 'select', 'text', 'url']);
const SUPPORTED_HEALTH_TYPES = new Set(['http']);
const RAW_CADDY_PATTERN = /(?:caddyfile|directive|handle|respond|reverse_proxy|route|snippet|tls\s|transport)/iu;

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

function safeRelativePath(value, label, errors) {
  if (!hasText(value)) {
    errors.push(`${label} is required.`);
    return null;
  }
  const normalized = path.posix.normalize(value.replace(/\\/gu, '/'));
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    errors.push(`${label} must stay inside the app package folder.`);
    return null;
  }
  return normalized;
}

function assertNoRawCaddy(value, errors, trail = 'manifest') {
  if (typeof value === 'string' && RAW_CADDY_PATTERN.test(value)) {
    errors.push(`${trail} must not contain raw Caddy directives.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoRawCaddy(entry, errors, `${trail}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/caddy|caddyfile|directive|snippet|raw/iu.test(key)) {
      errors.push(`${trail}.${key} is not allowed; use structured route fields.`);
    }
    assertNoRawCaddy(child, errors, `${trail}.${key}`);
  }
}

function validateSetup(manifest, errors) {
  const setup = manifest.setup ?? { fields: [] };
  if (!isRecord(setup)) {
    errors.push('setup must be an object.');
    return;
  }
  const fields = setup.fields ?? [];
  if (!Array.isArray(fields)) {
    errors.push('setup.fields must be an array.');
    return;
  }
  const seen = new Set();
  for (const [index, field] of fields.entries()) {
    const prefix = `setup.fields[${index}]`;
    if (!isRecord(field)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (!FIELD_ID_PATTERN.test(String(field.id || ''))) {
      errors.push(`${prefix}.id must be a camelCase field id.`);
    } else if (seen.has(field.id)) {
      errors.push(`${prefix}.id duplicates another setup field.`);
    } else {
      seen.add(field.id);
    }
    if (!SUPPORTED_FIELD_TYPES.has(field.type)) {
      errors.push(`${prefix}.type must be one of: ${[...SUPPORTED_FIELD_TYPES].join(', ')}.`);
    }
    if (!hasText(field.label)) {
      errors.push(`${prefix}.label is required.`);
    }
    if (field.secret === true && field.default !== undefined) {
      errors.push(`${prefix} is secret and must not define a default value.`);
    }
  }
}

function validateResources(manifest, packageDir, errors) {
  if (!isRecord(manifest.resources)) {
    errors.push('resources must be an object.');
    return new Set();
  }
  if (!isRecord(manifest.resources.services)) {
    errors.push('resources.services must be an object.');
    return new Set();
  }
  const serviceIds = new Set();
  for (const [serviceId, service] of Object.entries(manifest.resources.services)) {
    const prefix = `resources.services.${serviceId}`;
    if (!APP_ID_PATTERN.test(serviceId)) {
      errors.push(`${prefix} must use a DNS-safe service id.`);
    }
    serviceIds.add(serviceId);
    if (!isRecord(service)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    const dockerfile = safeRelativePath(service.dockerfile, `${prefix}.dockerfile`, errors);
    if (dockerfile && packageDir && !fs.existsSync(path.join(packageDir, dockerfile))) {
      errors.push(`${prefix}.dockerfile points to a missing package file.`);
    }
    if (!Number.isInteger(service.internalPort) || service.internalPort < 1 || service.internalPort > 65535) {
      errors.push(`${prefix}.internalPort must be a TCP port between 1 and 65535.`);
    }
    if (service.env !== undefined) {
      if (!isRecord(service.env)) {
        errors.push(`${prefix}.env must be an object when present.`);
      } else {
        for (const [key, value] of Object.entries(service.env)) {
          if (!ENV_KEY_PATTERN.test(key) || typeof value !== 'string') {
            errors.push(`${prefix}.env must contain uppercase environment keys with string values.`);
            break;
          }
        }
      }
    }
    if (service.volumes !== undefined && !Array.isArray(service.volumes)) {
      errors.push(`${prefix}.volumes must be an array when present.`);
    }
  }
  return serviceIds;
}

function validateRoutes(manifest, serviceIds, errors) {
  const routes = manifest.routes ?? [];
  if (!Array.isArray(routes)) {
    errors.push('routes must be an array.');
    return;
  }
  const hosts = new Set();
  for (const [index, route] of routes.entries()) {
    const prefix = `routes[${index}]`;
    if (!isRecord(route)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (!APP_ID_PATTERN.test(String(route.host || ''))) {
      errors.push(`${prefix}.host must be a DNS-safe subdomain.`);
    } else if (hosts.has(route.host)) {
      errors.push(`${prefix}.host duplicates another route.`);
    } else {
      hosts.add(route.host);
    }
    if (!serviceIds.has(route.service)) {
      errors.push(`${prefix}.service must reference a declared service.`);
    }
    if (!Number.isInteger(route.port) || route.port < 1 || route.port > 65535) {
      errors.push(`${prefix}.port must be a TCP port between 1 and 65535.`);
    }
  }
}

function validateHomepage(manifest, errors) {
  if (!isRecord(manifest.homepage)) {
    errors.push('homepage must be an object.');
    return;
  }
  for (const field of ['description', 'group', 'icon', 'name']) {
    if (!hasText(manifest.homepage[field])) {
      errors.push(`homepage.${field} is required.`);
    }
  }
}

function validateHealth(manifest, errors) {
  if (!isRecord(manifest.health)) {
    errors.push('health must be an object.');
    return;
  }
  if (!SUPPORTED_HEALTH_TYPES.has(manifest.health.type)) {
    errors.push(`health.type must be one of: ${[...SUPPORTED_HEALTH_TYPES].join(', ')}.`);
  }
  if (!hasText(manifest.health.url)) {
    errors.push('health.url is required.');
  } else {
    try {
      const parsed = new URL(manifest.health.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errors.push('health.url must use HTTP or HTTPS.');
      }
    } catch {
      errors.push('health.url must be an absolute URL.');
    }
  }
}

function validateAppPackageManifest(manifest, { packageDir = null } = {}) {
  const errors = [];
  if (!isRecord(manifest)) {
    return ['Manifest must be a JSON object.'];
  }
  if (!APP_ID_PATTERN.test(String(manifest.id || ''))) errors.push('id must be a DNS-safe app id.');
  if (!hasText(manifest.name)) errors.push('name is required.');
  if (!SEMVERISH_PATTERN.test(String(manifest.version || ''))) errors.push('version must be semver-like.');
  if (!hasText(manifest.summary)) errors.push('summary is required.');
  if (!hasText(manifest.category)) errors.push('category is required.');

  validateSetup(manifest, errors);
  const serviceIds = validateResources(manifest, packageDir, errors);
  validateRoutes(manifest, serviceIds, errors);
  validateHomepage(manifest, errors);
  validateHealth(manifest, errors);
  assertNoRawCaddy(manifest, errors);
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
    homepage: isRecord(manifest.homepage) ? {
      description: manifest.homepage.description || '',
      group: manifest.homepage.group || '',
      icon: manifest.homepage.icon || '',
      name: manifest.homepage.name || manifest.name || manifest.id,
    } : null,
    icon: manifest.icon || manifest.homepage?.icon || '',
    id: manifest.id || '',
    installStatus: 'not-installed',
    name: manifest.name || manifest.id || 'Unknown package',
    routes: Array.isArray(manifest.routes) ? manifest.routes.map((route) => ({
      host: route?.host || '',
      port: Number.isInteger(route?.port) ? route.port : null,
      service: route?.service || '',
    })) : [],
    services,
    setup: {
      fieldCount: Array.isArray(manifest.setup?.fields) ? manifest.setup.fields.length : 0,
      fields: Array.isArray(manifest.setup?.fields)
        ? manifest.setup.fields.map((field) => ({
          id: field?.id || '',
          label: field?.label || '',
          required: field?.required === true,
          secret: field?.secret === true,
          type: field?.type || '',
        }))
        : [],
    },
    summary: manifest.summary || '',
    validation: {
      errors: validationErrors,
      valid: validationErrors.length === 0,
    },
    version: manifest.version || '',
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
