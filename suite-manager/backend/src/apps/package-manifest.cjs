const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_FILENAME = 'manifest.json';
const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const FIELD_ID_PATTERN = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/u;
const SEMVERISH_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const SUPPORTED_FIELD_TYPES = new Set(['boolean', 'email', 'password', 'select', 'text', 'url']);
const SUPPORTED_GENERATORS = new Set(['random']);
const SUPPORTED_GENERATOR_ENCODINGS = new Set(['base64url', 'hex']);
const SUPPORTED_HEALTH_TYPES = new Set(['http']);
const SUPPORTED_COMPLEXITY_LEVELS = new Set(['easy', 'guided', 'advanced']);
const SUPPORTED_RESOURCE_LEVELS = new Set(['low', 'medium', 'high']);
const SUPPORTED_GUIDE_SECTION_TYPES = new Set(['choice-guide', 'manual-complete', 'note', 'steps', 'values', 'warning']);
const SUPPORTED_PACKAGE_ROLES = new Set(['standalone', 'companion', 'capability-provider', 'integration-helper']);
const SUPPORTED_SECRET_SCOPES = new Set(['consumer-instance', 'generated-client', 'provider-instance', 'relationship']);
const SUPPORTED_INTEGRATION_APPLY_KINDS = new Set(['service-env']);
const CATALOG_LINK_KEYS = new Set(['docs', 'repository', 'website']);
const RAW_CADDY_PATTERN = /(?:caddyfile|directive|handle|respond|reverse_proxy|route|snippet|tls\s|transport)/iu;
const SAFE_INTERNAL_PATH_PATTERN = /^\/__[A-Za-z0-9/_${}.-]{8,220}$/u;
const SAFE_TARGET_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?${}.-]{1,220}$/u;

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
    if (field.generated !== undefined) {
      if (!isRecord(field.generated)) {
        errors.push(`${prefix}.generated must be an object when present.`);
      } else {
        if (!SUPPORTED_GENERATORS.has(field.generated.kind)) {
          errors.push(`${prefix}.generated.kind must be one of: ${[...SUPPORTED_GENERATORS].join(', ')}.`);
        }
        if (!Number.isInteger(field.generated.bytes) || field.generated.bytes < 16 || field.generated.bytes > 128) {
          errors.push(`${prefix}.generated.bytes must be a whole number from 16 to 128.`);
        }
        if (!SUPPORTED_GENERATOR_ENCODINGS.has(field.generated.encoding)) {
          errors.push(`${prefix}.generated.encoding must be one of: ${[...SUPPORTED_GENERATOR_ENCODINGS].join(', ')}.`);
        }
      }
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
    if (route.internalIcalBridge !== undefined) {
      const bridge = route.internalIcalBridge;
      if (!isRecord(bridge)) {
        errors.push(`${prefix}.internalIcalBridge must be an object when present.`);
      } else {
        if (!SAFE_INTERNAL_PATH_PATTERN.test(String(bridge.path || ''))) {
          errors.push(`${prefix}.internalIcalBridge.path must be a safe internal path.`);
        }
        if (!SAFE_TARGET_PATH_PATTERN.test(String(bridge.targetPath || ''))) {
          errors.push(`${prefix}.internalIcalBridge.targetPath must be a safe target path.`);
        }
        if (!isRecord(bridge.basicAuth) || !hasText(bridge.basicAuth.username) || !hasText(bridge.basicAuth.password)) {
          errors.push(`${prefix}.internalIcalBridge.basicAuth must declare username and password templates.`);
        }
      }
    }
  }
}

function validateHomepage(manifest, errors) {
  if (manifest.homepage === undefined) return;
  if (!isRecord(manifest.homepage)) {
    errors.push('homepage must be an object.');
    return;
  }
  for (const field of ['description', 'group', 'icon', 'name']) {
    if (!hasText(manifest.homepage[field])) {
      errors.push(`homepage.${field} is required.`);
    }
  }
  if (manifest.homepage.widget !== undefined) validateHomepageWidget(manifest.homepage.widget, 'homepage.widget', errors);
}

function validatePackageRole(manifest, errors) {
  if (manifest.role === undefined) return;
  if (!SUPPORTED_PACKAGE_ROLES.has(manifest.role)) {
    errors.push(`role must be one of: ${[...SUPPORTED_PACKAGE_ROLES].join(', ')}.`);
  }
}

function validateHomepageWidget(widget, prefix, errors) {
  if (!isRecord(widget)) {
    errors.push(`${prefix} must be an object when present.`);
    return;
  }
  if (widget.type !== 'calendar' || widget.view !== 'monthly' || widget.showTime !== true) {
    errors.push(`${prefix} currently supports monthly calendar widgets only.`);
  }
  if (!Number.isInteger(widget.maxEvents) || widget.maxEvents < 1 || widget.maxEvents > 50) {
    errors.push(`${prefix}.maxEvents must be a whole number from 1 to 50.`);
  }
  if (!Array.isArray(widget.integrations) || widget.integrations.length < 1 || widget.integrations.length > 3) {
    errors.push(`${prefix}.integrations must contain one to three iCal integrations.`);
    return;
  }
  for (const [index, integration] of widget.integrations.entries()) {
    const itemPrefix = `${prefix}.integrations[${index}]`;
    if (!isRecord(integration)) {
      errors.push(`${itemPrefix} must be an object.`);
      continue;
    }
    if (integration.type !== 'ical') errors.push(`${itemPrefix}.type must be ical.`);
    for (const field of ['color', 'name', 'url']) {
      if (!hasText(integration[field])) errors.push(`${itemPrefix}.${field} is required.`);
    }
    if (hasText(integration.url) && !/^(?:https?:\/\/|\$\{app\.publicUrl\})/u.test(integration.url)) {
      errors.push(`${itemPrefix}.url must be an HTTP URL or app public URL template.`);
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

function validateCatalog(manifest, errors) {
  if (manifest.catalog === undefined) return;
  if (!isRecord(manifest.catalog)) {
    errors.push('catalog must be an object when present.');
    return;
  }
  const catalog = manifest.catalog;

  if (catalog.description !== undefined && !hasText(catalog.description)) {
    errors.push('catalog.description must be a non-empty string when present.');
  }
  if (catalog.tags !== undefined && !isStringArray(catalog.tags)) {
    errors.push('catalog.tags must be an array of non-empty strings when present.');
  }
  if (catalog.related !== undefined) {
    if (!Array.isArray(catalog.related) || !catalog.related.every((id) => APP_ID_PATTERN.test(String(id)))) {
      errors.push('catalog.related must be an array of DNS-safe app ids when present.');
    }
  }
  if (catalog.features !== undefined) {
    if (!Array.isArray(catalog.features)) {
      errors.push('catalog.features must be an array when present.');
    } else {
      for (const [index, feature] of catalog.features.entries()) {
        if (hasText(feature)) continue;
        if (isRecord(feature) && hasText(feature.title) && (feature.body === undefined || hasText(feature.body))) continue;
        errors.push(`catalog.features[${index}] must be a string or an object with title and optional body.`);
      }
    }
  }
  if (catalog.complexity !== undefined) {
    if (!isRecord(catalog.complexity)) {
      errors.push('catalog.complexity must be an object when present.');
    } else {
      if (!SUPPORTED_COMPLEXITY_LEVELS.has(catalog.complexity.level)) {
        errors.push(`catalog.complexity.level must be one of: ${[...SUPPORTED_COMPLEXITY_LEVELS].join(', ')}.`);
      }
      for (const field of ['label', 'description']) {
        if (catalog.complexity[field] !== undefined && !hasText(catalog.complexity[field])) {
          errors.push(`catalog.complexity.${field} must be a non-empty string when present.`);
        }
      }
    }
  }
  if (catalog.resourceHint !== undefined) {
    if (!isRecord(catalog.resourceHint)) {
      errors.push('catalog.resourceHint must be an object when present.');
    } else {
      if (!SUPPORTED_RESOURCE_LEVELS.has(catalog.resourceHint.level)) {
        errors.push(`catalog.resourceHint.level must be one of: ${[...SUPPORTED_RESOURCE_LEVELS].join(', ')}.`);
      }
      for (const field of ['label', 'description']) {
        if (catalog.resourceHint[field] !== undefined && !hasText(catalog.resourceHint[field])) {
          errors.push(`catalog.resourceHint.${field} must be a non-empty string when present.`);
        }
      }
    }
  }
  if (catalog.privacy !== undefined) {
    if (!isRecord(catalog.privacy)) {
      errors.push('catalog.privacy must be an object when present.');
    } else {
      if (catalog.privacy.summary !== undefined && !hasText(catalog.privacy.summary)) {
        errors.push('catalog.privacy.summary must be a non-empty string when present.');
      }
      if (catalog.privacy.notes !== undefined && !isStringArray(catalog.privacy.notes)) {
        errors.push('catalog.privacy.notes must be an array of non-empty strings when present.');
      }
    }
  }
  if (catalog.links !== undefined) {
    if (!isRecord(catalog.links)) {
      errors.push('catalog.links must be an object when present.');
    } else {
      for (const [key, value] of Object.entries(catalog.links)) {
        if (!CATALOG_LINK_KEYS.has(key)) {
          errors.push(`catalog.links.${key} is not supported.`);
        } else if (!safeUrl(value)) {
          errors.push(`catalog.links.${key} must be an HTTP or HTTPS URL.`);
        }
      }
    }
  }
  if (catalog.screenshots !== undefined) {
    if (!Array.isArray(catalog.screenshots)) {
      errors.push('catalog.screenshots must be an array when present.');
    } else {
      for (const [index, screenshot] of catalog.screenshots.entries()) {
        const prefix = `catalog.screenshots[${index}]`;
        if (!isRecord(screenshot)) {
          errors.push(`${prefix} must be an object.`);
          continue;
        }
        if (!hasText(screenshot.src)) {
          errors.push(`${prefix}.src is required.`);
        } else if (!safeUrl(screenshot.src)) {
          safeRelativePath(screenshot.src, `${prefix}.src`, errors);
        }
        for (const field of ['alt', 'caption']) {
          if (screenshot[field] !== undefined && !hasText(screenshot[field])) {
            errors.push(`${prefix}.${field} must be a non-empty string when present.`);
          }
        }
      }
    }
  }
}

function validateOnboarding(manifest, errors) {
  if (manifest.onboarding === undefined) return;
  if (!isRecord(manifest.onboarding)) {
    errors.push('onboarding must be an object when present.');
    return;
  }
  const onboarding = manifest.onboarding;
  if (onboarding.title !== undefined && !hasText(onboarding.title)) {
    errors.push('onboarding.title must be a non-empty string when present.');
  }
  if (onboarding.summary !== undefined && !hasText(onboarding.summary)) {
    errors.push('onboarding.summary must be a non-empty string when present.');
  }
  if (onboarding.steps !== undefined && !Array.isArray(onboarding.steps)) {
    errors.push('onboarding.steps must be an array when present.');
  }
  if (onboarding.sections !== undefined) {
    if (!Array.isArray(onboarding.sections)) {
      errors.push('onboarding.sections must be an array when present.');
      return;
    }
    for (const [index, section] of onboarding.sections.entries()) {
      const prefix = `onboarding.sections[${index}]`;
      if (!isRecord(section)) {
        errors.push(`${prefix} must be an object.`);
        continue;
      }
      if (!hasText(section.id)) errors.push(`${prefix}.id is required.`);
      if (!SUPPORTED_GUIDE_SECTION_TYPES.has(section.type)) {
        errors.push(`${prefix}.type must be one of: ${[...SUPPORTED_GUIDE_SECTION_TYPES].join(', ')}.`);
      }
      if (!hasText(section.title)) errors.push(`${prefix}.title is required.`);
      if (section.values !== undefined && !Array.isArray(section.values)) {
        errors.push(`${prefix}.values must be an array when present.`);
      } else if (Array.isArray(section.values)) {
        for (const [valueIndex, value] of section.values.entries()) {
          if (isRecord(value) && typeof value.value === 'string' && /\$\{secret\.[a-z][A-Za-z0-9]*\}/u.test(value.value)) {
            errors.push(`${prefix}.values[${valueIndex}].value must not reference secrets.`);
          }
        }
      }
      if (section.choices !== undefined && !Array.isArray(section.choices)) {
        errors.push(`${prefix}.choices must be an array when present.`);
      }
      if (section.steps !== undefined && !isStringArray(section.steps)) {
        errors.push(`${prefix}.steps must be an array of non-empty strings when present.`);
      }
    }
  }
}

function validateCapabilityMap(value, prefix, errors) {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${prefix} must be an object when present.`);
    return;
  }
  for (const [id, capability] of Object.entries(value)) {
    const itemPrefix = `${prefix}.${id}`;
    if (!FIELD_ID_PATTERN.test(id)) errors.push(`${itemPrefix} must use a camelCase capability id.`);
    if (!isRecord(capability)) {
      errors.push(`${itemPrefix} must be an object.`);
      continue;
    }
    if (!hasText(capability.type)) errors.push(`${itemPrefix}.type is required.`);
    if (capability.interfaceVersion !== undefined && !Number.isInteger(capability.interfaceVersion)) {
      errors.push(`${itemPrefix}.interfaceVersion must be a whole number when present.`);
    }
    if (capability.protocol !== undefined && !hasText(capability.protocol)) {
      errors.push(`${itemPrefix}.protocol must be a non-empty string when present.`);
    }
    if (capability.secrets !== undefined) {
      if (!isRecord(capability.secrets)) {
        errors.push(`${itemPrefix}.secrets must be an object when present.`);
      } else {
        for (const [secretId, secret] of Object.entries(capability.secrets)) {
          const secretPrefix = `${itemPrefix}.secrets.${secretId}`;
          if (!FIELD_ID_PATTERN.test(secretId)) errors.push(`${secretPrefix} must use a camelCase secret id.`);
          if (!isRecord(secret)) {
            errors.push(`${secretPrefix} must be an object.`);
            continue;
          }
          if (!SUPPORTED_SECRET_SCOPES.has(secret.scope)) {
            errors.push(`${secretPrefix}.scope must be one of: ${[...SUPPORTED_SECRET_SCOPES].join(', ')}.`);
          }
          if (!hasText(secret.ref) || !/^\$\{secret\.[a-z][A-Za-z0-9]*\}$/u.test(secret.ref)) {
            errors.push(`${secretPrefix}.ref must reference a declared setup secret.`);
          }
        }
      }
    }
  }
}

function validateConfigTargets(manifest, errors) {
  if (manifest.configTargets === undefined) return;
  if (!isRecord(manifest.configTargets)) {
    errors.push('configTargets must be an object when present.');
    return;
  }
  const serviceIds = new Set(Object.keys(isRecord(manifest.resources?.services) ? manifest.resources.services : {}));
  for (const [id, target] of Object.entries(manifest.configTargets)) {
    const prefix = `configTargets.${id}`;
    if (!FIELD_ID_PATTERN.test(id)) errors.push(`${prefix} must use a camelCase target id.`);
    if (!isRecord(target)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (target.kind !== 'service-env') errors.push(`${prefix}.kind must be service-env.`);
    if (!serviceIds.has(target.service)) errors.push(`${prefix}.service must reference a declared service.`);
    if (!isStringArray(target.allowedKeys) || target.allowedKeys.some((key) => !ENV_KEY_PATTERN.test(key))) {
      errors.push(`${prefix}.allowedKeys must contain uppercase environment keys.`);
    }
  }
}

function validateIntegrations(manifest, errors) {
  if (manifest.integrations === undefined) return;
  if (!isRecord(manifest.integrations)) {
    errors.push('integrations must be an object when present.');
    return;
  }
  const configTargets = isRecord(manifest.configTargets) ? manifest.configTargets : {};
  for (const [id, integration] of Object.entries(manifest.integrations)) {
    const prefix = `integrations.${id}`;
    if (!FIELD_ID_PATTERN.test(id)) errors.push(`${prefix} must use a camelCase integration id.`);
    if (!isRecord(integration)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (!Array.isArray(integration.accepts) || integration.accepts.length < 1) {
      errors.push(`${prefix}.accepts must contain at least one capability matcher.`);
    } else {
      for (const [index, matcher] of integration.accepts.entries()) {
        const matcherPrefix = `${prefix}.accepts[${index}]`;
        if (!isRecord(matcher)) {
          errors.push(`${matcherPrefix} must be an object.`);
          continue;
        }
        if (!hasText(matcher.type)) errors.push(`${matcherPrefix}.type is required.`);
        if (matcher.protocol !== undefined && !hasText(matcher.protocol)) errors.push(`${matcherPrefix}.protocol must be a non-empty string when present.`);
        if (matcher.interfaceVersion !== undefined && !Number.isInteger(matcher.interfaceVersion)) errors.push(`${matcherPrefix}.interfaceVersion must be a whole number when present.`);
      }
    }
    if (!isRecord(integration.apply)) {
      errors.push(`${prefix}.apply must be an object.`);
      continue;
    }
    const apply = integration.apply;
    if (!SUPPORTED_INTEGRATION_APPLY_KINDS.has(apply.kind)) errors.push(`${prefix}.apply.kind must be one of: ${[...SUPPORTED_INTEGRATION_APPLY_KINDS].join(', ')}.`);
    if (!hasText(apply.target) || !configTargets[apply.target]) errors.push(`${prefix}.apply.target must reference a declared config target.`);
    if (!isRecord(apply.values)) {
      errors.push(`${prefix}.apply.values must be an object.`);
    } else {
      const target = configTargets[apply.target];
      const allowed = new Set(Array.isArray(target?.allowedKeys) ? target.allowedKeys : []);
      for (const [key, value] of Object.entries(apply.values)) {
        if (!ENV_KEY_PATTERN.test(key)) errors.push(`${prefix}.apply.values.${key} must use an uppercase environment key.`);
        if (allowed.size && !allowed.has(key)) errors.push(`${prefix}.apply.values.${key} is not allowed by the config target.`);
        if (typeof value !== 'string') errors.push(`${prefix}.apply.values.${key} must be a string template.`);
      }
    }
  }
}

function validateUsefulness(manifest, errors) {
  if (manifest.usefulness === undefined) return;
  if (!isRecord(manifest.usefulness)) {
    errors.push('usefulness must be an object when present.');
    return;
  }
  if (manifest.usefulness.requiresOneOf !== undefined && !isStringArray(manifest.usefulness.requiresOneOf)) {
    errors.push('usefulness.requiresOneOf must be an array of capability types when present.');
  }
  if (manifest.usefulness.emptyState !== undefined && !hasText(manifest.usefulness.emptyState)) {
    errors.push('usefulness.emptyState must be a non-empty string when present.');
  }
}

function publicOnboarding(manifest) {
  const onboarding = isRecord(manifest.onboarding) ? manifest.onboarding : {};
  const steps = Array.isArray(onboarding.steps) ? onboarding.steps : [];
  const sections = Array.isArray(onboarding.sections) ? onboarding.sections : [];
  return {
    summary: typeof onboarding.summary === 'string' ? onboarding.summary : '',
    title: typeof onboarding.title === 'string' ? onboarding.title : '',
    steps: steps
      .filter((step) => isRecord(step))
      .map((step) => ({
        body: typeof step.body === 'string' ? step.body : '',
        title: typeof step.title === 'string' ? step.title : '',
        type: typeof step.type === 'string' ? step.type : 'manual',
      }))
      .filter((step) => step.title || step.body),
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
            qr: value.qr === true,
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
  const normalizeFeature = (feature) => {
    if (hasText(feature)) return { body: '', title: feature };
    return {
      body: hasText(feature?.body) ? feature.body : '',
      title: hasText(feature?.title) ? feature.title : '',
    };
  };
  const complexity = isRecord(catalog.complexity) ? catalog.complexity : {};
  const resourceHint = isRecord(catalog.resourceHint) ? catalog.resourceHint : {};
  const privacy = isRecord(catalog.privacy) ? catalog.privacy : {};
  const links = isRecord(catalog.links) ? catalog.links : {};

  return {
    complexity: {
      description: hasText(complexity.description) ? complexity.description : '',
      label: hasText(complexity.label) ? complexity.label : '',
      level: SUPPORTED_COMPLEXITY_LEVELS.has(complexity.level) ? complexity.level : '',
    },
    description: hasText(catalog.description) ? catalog.description : '',
    features: Array.isArray(catalog.features) ? catalog.features.map(normalizeFeature).filter((item) => item.title) : [],
    links: Object.fromEntries(
      Object.entries(links).filter(([key, value]) => CATALOG_LINK_KEYS.has(key) && safeUrl(value)),
    ),
    privacy: {
      notes: isStringArray(privacy.notes) ? privacy.notes : [],
      summary: hasText(privacy.summary) ? privacy.summary : '',
    },
    related: Array.isArray(catalog.related) ? catalog.related.filter((id) => APP_ID_PATTERN.test(String(id))) : [],
    resourceHint: {
      description: hasText(resourceHint.description) ? resourceHint.description : '',
      label: hasText(resourceHint.label) ? resourceHint.label : '',
      level: SUPPORTED_RESOURCE_LEVELS.has(resourceHint.level) ? resourceHint.level : '',
    },
    screenshots: Array.isArray(catalog.screenshots) ? catalog.screenshots
      .filter((screenshot) => isRecord(screenshot) && hasText(screenshot.src))
      .map((screenshot) => ({
        alt: hasText(screenshot.alt) ? screenshot.alt : '',
        caption: hasText(screenshot.caption) ? screenshot.caption : '',
        src: screenshot.src,
      })) : [],
    tags: isStringArray(catalog.tags) ? catalog.tags : [],
  };
}

function validateAppPackageManifest(manifest, { packageDir = null } = {}) {
  const errors = [];
  if (!isRecord(manifest)) {
    return ['Manifest must be a JSON object.'];
  }
  if (!APP_ID_PATTERN.test(String(manifest.id || ''))) errors.push('id must be a DNS-safe app id.');
  if (!hasText(manifest.name)) errors.push('name is required.');
  if (!SEMVERISH_PATTERN.test(String(manifest.version || ''))) errors.push('version must be semver-like.');
  if (!SEMVERISH_PATTERN.test(String(manifest.minimumMosVersion || ''))) errors.push('minimumMosVersion must be semver-like.');
  if (!SEMVERISH_PATTERN.test(String(manifest.minimumMosVersion || ''))) errors.push('minimumMosVersion must be semver-like.');
  if (!hasText(manifest.summary)) errors.push('summary is required.');
  if (!hasText(manifest.category)) errors.push('category is required.');
  if (manifest.packageFiles !== undefined) {
    if (!isStringArray(manifest.packageFiles)) {
      errors.push('packageFiles must be an array of non-empty relative paths when present.');
    } else {
      const seen = new Set();
      for (const [index, packageFile] of manifest.packageFiles.entries()) {
        const normalized = safeRelativePath(packageFile, `packageFiles[${index}]`, errors);
        if (normalized !== packageFile || packageFile.includes('\\')) {
          errors.push(`packageFiles[${index}] must use a canonical forward-slash path.`);
        }
        if (seen.has(packageFile)) errors.push(`packageFiles[${index}] duplicates another package file.`);
        seen.add(packageFile);
        if (packageDir && normalized && !fs.existsSync(path.join(packageDir, normalized))) {
          errors.push(`packageFiles[${index}] points to a missing package file.`);
        }
      }
    }
  }
  if (manifest.icon !== undefined) {
    const icon = safeRelativePath(manifest.icon, 'icon', errors);
    if (icon && packageDir && !fs.existsSync(path.join(packageDir, icon))) {
      errors.push('icon points to a missing package file.');
    }
  }

  validateSetup(manifest, errors);
  validatePackageRole(manifest, errors);
  const serviceIds = validateResources(manifest, packageDir, errors);
  validateRoutes(manifest, serviceIds, errors);
  validateHomepage(manifest, errors);
  validateHealth(manifest, errors);
  validateCatalog(manifest, errors);
  validateOnboarding(manifest, errors);
  validateCapabilityMap(manifest.exports, 'exports', errors);
  validateConfigTargets(manifest, errors);
  validateIntegrations(manifest, errors);
  validateUsefulness(manifest, errors);
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
    catalog: publicCatalog(manifest),
    homepage: isRecord(manifest.homepage) ? {
      description: manifest.homepage.description || '',
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
      port: Number.isInteger(route?.port) ? route.port : null,
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
    minimumMosVersion: manifest.minimumMosVersion || '',
  };
}

function publicCapabilityExports(exports) {
  if (!isRecord(exports)) return [];
  return Object.entries(exports).map(([id, capability]) => ({
    features: isRecord(capability.features) ? capability.features : {},
    id,
    implementation: typeof capability.implementation === 'string' ? capability.implementation : '',
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
    providerLabel: typeof integration.providerLabel === 'string' ? integration.providerLabel : '',
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
