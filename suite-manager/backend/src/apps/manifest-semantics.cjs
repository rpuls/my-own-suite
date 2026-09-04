// The semantic half of manifest validation — everything the JSON Schema
// cannot express: cross-references between fields, the template grammar,
// package-file existence, and the provisional capability/widget/bridge areas.
//
// Structural validation (apps/manifest.schema.json via manifest-schema.cjs)
// runs first; this pass may assume shapes it declares valid, but must never
// throw on shapes it declares invalid — always accumulate readable errors.
const fs = require('node:fs');
const path = require('node:path');

const { SMTP_TEMPLATE_KEYS } = require('../../../../shared/smtp-contract.cjs');

const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const FIELD_ID_PATTERN = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)*$/u;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;

// The template grammar. A reference is ${namespace.path} where namespace is a
// lowercase camelCase word. Anything not shaped like that — ${UPPER_CASE},
// ${no-dot}, $plain — is literal text and passes through untouched, so shell
// and app-native ${VAR} syntax in env values keeps working.
const TEMPLATE_REFERENCE = /\$\{([a-z][a-zA-Z0-9]*)\.([^}]*)\}/gu;
const KNOWN_NAMESPACES = new Set(['app', 'config', 'export', 'import', 'owner', 'secret', 'smtp']);
const APP_KEYS = new Set(['host', 'publicUrl', 'scheme']);
const OWNER_KEYS = new Set(['email', 'name']);
// The owner's shared outbound email relay, projected into a service's runtime
// environment for apps that send mail. Added in MOS 0.19.0; a package that
// references it must raise minimumMosVersion to 0.19.0. ${smtp.password} is
// secret-grade and resolves like ${secret.*}: real only at materialize time.
const SMTP_KEYS = new Set(SMTP_TEMPLATE_KEYS);

const SUPPORTED_SECRET_SCOPES = new Set(['consumer-instance', 'generated-client', 'provider-instance', 'relationship']);
const SUPPORTED_INTEGRATION_APPLY_KINDS = new Set(['service-env']);
const ROUTE_KEY_DENYLIST = /caddy|directive|snippet/iu;
const SAFE_INTERNAL_PATH_PATTERN = /^\/__[A-Za-z0-9/_${}.-]{8,220}$/u;
const SAFE_TARGET_PATH_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?${}.-]{1,220}$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => hasText(item));
}

function normalizedRelativePath(value) {
  if (!hasText(value) || value.includes('\\')) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function checkPackagePath(value, label, packageDir, errors) {
  const normalized = normalizedRelativePath(value);
  if (normalized === null) {
    errors.push(`${label} must be a canonical forward-slash path inside the app package folder.`);
    return;
  }
  if (packageDir && !fs.existsSync(path.join(packageDir, normalized))) {
    errors.push(`${label} points to a missing package file.`);
  }
}

function setupFieldsOf(manifest) {
  return Array.isArray(manifest.setup?.fields) ? manifest.setup.fields.filter(isRecord) : [];
}

function serviceIdsOf(manifest) {
  return new Set(Object.keys(isRecord(manifest.resources?.services) ? manifest.resources.services : {}));
}

function validatePackageFiles(manifest, packageDir, errors) {
  if (!isStringArray(manifest.packageFiles)) return;
  for (const [index, packageFile] of manifest.packageFiles.entries()) {
    checkPackagePath(packageFile, `packageFiles[${index}]`, packageDir, errors);
  }
}

function validateSetupSemantics(manifest, errors) {
  const seen = new Set();
  for (const [index, field] of setupFieldsOf(manifest).entries()) {
    const prefix = `setup.fields[${index}]`;
    if (typeof field.id === 'string' && FIELD_ID_PATTERN.test(field.id)) {
      if (seen.has(field.id)) errors.push(`${prefix}.id duplicates another setup field.`);
      seen.add(field.id);
    }
    if (field.secret === true && field.default !== undefined) {
      errors.push(`${prefix} is secret and must not declare a default value.`);
    }
    if (field.type === 'boolean' && field.default !== undefined && !['false', 'true'].includes(field.default)) {
      errors.push(`${prefix}.default must be "true" or "false" for a boolean field.`);
    }
  }
}

function validateResourceSemantics(manifest, packageDir, errors) {
  const services = isRecord(manifest.resources?.services) ? manifest.resources.services : {};
  const volumeNames = new Map();
  for (const [serviceId, service] of Object.entries(services)) {
    if (!isRecord(service)) continue;
    const prefix = `resources.services.${serviceId}`;
    if (hasText(service.dockerfile)) {
      checkPackagePath(service.dockerfile, `${prefix}.dockerfile`, packageDir, errors);
    }
    if (Array.isArray(service.volumes)) {
      for (const [index, volume] of service.volumes.entries()) {
        if (typeof volume !== 'string' || !volume.includes(':')) continue;
        const name = volume.slice(0, volume.indexOf(':'));
        const owner = volumeNames.get(name);
        if (owner && owner !== serviceId) {
          errors.push(`${prefix}.volumes[${index}] reuses volume name "${name}" already declared by service ${owner}. Volumes are service-owned; shared volumes are not supported.`);
        }
        volumeNames.set(name, serviceId);
      }
    }
    // A peak below the resting figure would make capacity advice contradict
    // itself, and reads as a transposed pair rather than a deliberate claim.
    if (isRecord(service.requires)) {
      for (const [peakKey, restKey] of [['cpuPeakCores', 'cpuCores'], ['memoryPeakMb', 'memoryMb']]) {
        const peak = service.requires[peakKey];
        const rest = service.requires[restKey];
        if (typeof peak === 'number' && typeof rest === 'number' && peak < rest) {
          errors.push(`${prefix}.requires.${peakKey} must be at least ${restKey} (${rest}), got ${peak}.`);
        }
      }
    }
  }
}

function validateRouteSemantics(manifest, errors) {
  const routes = Array.isArray(manifest.routes) ? manifest.routes : [];
  const serviceIds = serviceIdsOf(manifest);
  const hosts = new Set();
  for (const [index, route] of routes.entries()) {
    if (!isRecord(route)) continue;
    const prefix = `routes[${index}]`;
    if (hasText(route.host)) {
      if (hosts.has(route.host)) errors.push(`${prefix}.host duplicates another route.`);
      hosts.add(route.host);
    }
    if (route.service !== undefined && !serviceIds.has(route.service)) {
      errors.push(`${prefix}.service must reference a declared service.`);
    }
    for (const key of Object.keys(route)) {
      if (ROUTE_KEY_DENYLIST.test(key)) {
        errors.push(`${prefix}.${key} is not allowed; routes are structured fields, never raw proxy configuration.`);
      }
    }
    if (isRecord(route.internalIcalBridge)) {
      const bridge = route.internalIcalBridge;
      if (!SAFE_INTERNAL_PATH_PATTERN.test(String(bridge.path || ''))) {
        errors.push(`${prefix}.internalIcalBridge.path must be a safe internal path starting with /__.`);
      }
      if (!SAFE_TARGET_PATH_PATTERN.test(String(bridge.targetPath || ''))) {
        errors.push(`${prefix}.internalIcalBridge.targetPath must be a safe target path.`);
      }
    }
  }
}

function validateHealthSemantics(manifest, errors) {
  const url = manifest.health?.url;
  if (!hasText(url)) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    errors.push('health.url must be an absolute URL.');
    return;
  }
  if (!serviceIdsOf(manifest).has(parsed.hostname)) {
    errors.push(`health.url hostname must be a declared service id, got "${parsed.hostname}".`);
  }
}

function validateCatalogSemantics(manifest, packageDir, errors) {
  const catalog = isRecord(manifest.catalog) ? manifest.catalog : {};
  if (!Array.isArray(catalog.screenshots)) return;
  const declaredFiles = isStringArray(manifest.packageFiles) ? manifest.packageFiles : [];
  for (const [index, screenshot] of catalog.screenshots.entries()) {
    if (!isRecord(screenshot) || !hasText(screenshot.src)) continue;
    const prefix = `catalog.screenshots[${index}]`;
    checkPackagePath(screenshot.src, `${prefix}.src`, packageDir, errors);
    // Only declared files survive the package digest, so an undeclared one
    // would fail every install with an opaque digest error instead of this one.
    if (!declaredFiles.includes(screenshot.src)) {
      errors.push(`${prefix}.src must be listed in packageFiles so it ships with the package.`);
    }
  }
}

function validateIconSemantics(manifest, packageDir, errors) {
  if (manifest.icon !== undefined && hasText(manifest.icon)) {
    checkPackagePath(manifest.icon, 'icon', packageDir, errors);
  }
}

// ---------------------------------------------------------------------------
// Template grammar (the other half of the contract).
//
// Each manifest location allows a specific set of namespaces; a reference to
// an undeclared field or unknown namespace is an error rather than shipping
// verbatim into a container as literal text.
// ---------------------------------------------------------------------------

function templateRulesFor(manifest) {
  const fields = setupFieldsOf(manifest);
  const configIds = new Set(fields.filter((field) => field.secret !== true).map((field) => String(field.id)));
  const secretIds = new Set(fields.filter((field) => field.secret === true).map((field) => String(field.id)));
  const exportIds = new Set(Object.keys(isRecord(manifest.exports) ? manifest.exports : {}));
  return { configIds, exportIds, secretIds };
}

function checkTemplateString(value, location, rules, errors) {
  if (typeof value !== 'string') return;
  for (const match of value.matchAll(TEMPLATE_REFERENCE)) {
    const [reference, namespace, rest] = match;
    if (!KNOWN_NAMESPACES.has(namespace)) {
      errors.push(`${location.label} references unknown template namespace "${namespace}" in ${reference}. Known namespaces: ${[...KNOWN_NAMESPACES].sort().join(', ')}.`);
      continue;
    }
    if (!location.allowed.has(namespace)) {
      errors.push(`${location.label} must not reference \${${namespace}.*}${namespace === 'secret' ? ' — secrets never appear here' : ''}.`);
      continue;
    }
    if (namespace === 'config' && !rules.configIds.has(rest)) {
      errors.push(`${location.label} references \${config.${rest}}, which is not a declared non-secret setup field.`);
    } else if (namespace === 'secret' && !rules.secretIds.has(rest)) {
      errors.push(`${location.label} references \${secret.${rest}}, which is not a declared secret setup field.`);
    } else if (namespace === 'app' && !APP_KEYS.has(rest)) {
      errors.push(`${location.label} references \${app.${rest}}; supported app keys are ${[...APP_KEYS].sort().join(', ')}.`);
    } else if (namespace === 'owner' && !OWNER_KEYS.has(rest)) {
      errors.push(`${location.label} references \${owner.${rest}}; supported owner keys are ${[...OWNER_KEYS].sort().join(', ')}.`);
    } else if (namespace === 'smtp' && !SMTP_KEYS.has(rest)) {
      errors.push(`${location.label} references \${smtp.${rest}}; supported smtp keys are ${[...SMTP_KEYS].sort().join(', ')}.`);
    } else if (namespace === 'export' && !rules.exportIds.has(rest.split('.')[0])) {
      errors.push(`${location.label} references \${export.${rest}}, which is not a declared export.`);
    } else if (namespace === 'import' && location.importSlot && rest.split('.')[0] !== location.importSlot) {
      errors.push(`${location.label} references \${import.${rest}} but sits in integration slot "${location.importSlot}".`);
    }
  }
}

function forbidTemplates(value, label, errors) {
  checkTemplateString(value, { allowed: new Set(), label }, { configIds: new Set(), exportIds: new Set(), secretIds: new Set() }, errors);
}

function walkStrings(value, trail, visit) {
  if (typeof value === 'string') {
    visit(value, trail);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, `${trail}[${index}]`, visit));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) walkStrings(child, `${trail}.${key}`, visit);
  }
}

function validateTemplates(manifest, errors) {
  const rules = templateRulesFor(manifest);
  const runtime = new Set(['app', 'config', 'secret']);
  // ${smtp.*} resolves only where a service's environment is materialized, so it
  // is allowed there and nowhere else — validating it in a location that never
  // resolves it (a bridge, a widget, an export) would ship a broken reference.
  const serviceEnv = new Set([...runtime, 'smtp']);

  for (const [index, field] of setupFieldsOf(manifest).entries()) {
    if (typeof field.default === 'string') {
      checkTemplateString(field.default, { allowed: new Set(['owner']), label: `setup.fields[${index}].default` }, rules, errors);
    }
    for (const key of ['label', 'redactedLabel']) {
      if (typeof field[key] === 'string') forbidTemplates(field[key], `setup.fields[${index}].${key}`, errors);
    }
  }

  const services = isRecord(manifest.resources?.services) ? manifest.resources.services : {};
  for (const [serviceId, service] of Object.entries(services)) {
    if (!isRecord(service) || !isRecord(service.env)) continue;
    for (const [key, value] of Object.entries(service.env)) {
      checkTemplateString(value, { allowed: serviceEnv, label: `resources.services.${serviceId}.env.${key}` }, rules, errors);
    }
  }

  const routes = Array.isArray(manifest.routes) ? manifest.routes : [];
  for (const [index, route] of routes.entries()) {
    if (!isRecord(route) || !isRecord(route.internalIcalBridge)) continue;
    walkStrings(route.internalIcalBridge, `routes[${index}].internalIcalBridge`, (value, trail) => {
      checkTemplateString(value, { allowed: runtime, label: trail }, rules, errors);
    });
  }

  if (isRecord(manifest.homepage?.widget)) {
    walkStrings(manifest.homepage.widget, 'homepage.widget', (value, trail) => {
      checkTemplateString(value, { allowed: runtime, label: trail }, rules, errors);
    });
  }

  if (isRecord(manifest.onboarding)) {
    walkStrings(manifest.onboarding, 'onboarding', (value, trail) => {
      if (/\.values\[\d+\]\.value$/u.test(trail)) {
        checkTemplateString(value, { allowed: new Set(['app', 'config']), label: trail }, rules, errors);
      } else {
        forbidTemplates(value, trail, errors);
      }
    });
  }

  if (isRecord(manifest.exports)) {
    walkStrings(manifest.exports, 'exports', (value, trail) => {
      checkTemplateString(value, { allowed: runtime, label: trail }, rules, errors);
    });
  }

  if (isRecord(manifest.integrations)) {
    for (const [slotId, integration] of Object.entries(manifest.integrations)) {
      if (!isRecord(integration)) continue;
      walkStrings(integration, `integrations.${slotId}`, (value, trail) => {
        checkTemplateString(value, {
          allowed: new Set(['app', 'config', 'export', 'import', 'secret']),
          importSlot: slotId,
          label: trail,
        }, rules, errors);
      });
    }
  }

  for (const area of ['catalog', 'summary', 'name', 'category', 'health']) {
    if (manifest[area] === undefined) continue;
    walkStrings(manifest[area], area, (value, trail) => forbidTemplates(value, trail, errors));
  }
}

// ---------------------------------------------------------------------------
// Provisional areas: capability system, widget, bridge. Validated for today's
// official packages, but explicitly outside the locked generation-1 baseline.
// ---------------------------------------------------------------------------

function validateExportsSemantics(manifest, errors) {
  if (manifest.exports === undefined) return;
  if (!isRecord(manifest.exports)) {
    errors.push('exports must be an object when present.');
    return;
  }
  for (const [id, capability] of Object.entries(manifest.exports)) {
    const prefix = `exports.${id}`;
    if (!isRecord(capability)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (!hasText(capability.type)) errors.push(`${prefix}.type is required.`);
    if (capability.interfaceVersion !== undefined && !Number.isInteger(capability.interfaceVersion)) {
      errors.push(`${prefix}.interfaceVersion must be a whole number when present.`);
    }
    if (capability.protocol !== undefined && !hasText(capability.protocol)) {
      errors.push(`${prefix}.protocol must be a non-empty string when present.`);
    }
    if (capability.secrets === undefined) continue;
    if (!isRecord(capability.secrets)) {
      errors.push(`${prefix}.secrets must be an object when present.`);
      continue;
    }
    for (const [secretId, secret] of Object.entries(capability.secrets)) {
      const secretPrefix = `${prefix}.secrets.${secretId}`;
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

function validateConfigTargetsSemantics(manifest, errors) {
  if (manifest.configTargets === undefined) return;
  if (!isRecord(manifest.configTargets)) {
    errors.push('configTargets must be an object when present.');
    return;
  }
  const serviceIds = serviceIdsOf(manifest);
  for (const [id, target] of Object.entries(manifest.configTargets)) {
    const prefix = `configTargets.${id}`;
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

function validateIntegrationsSemantics(manifest, errors) {
  if (manifest.integrations === undefined) return;
  if (!isRecord(manifest.integrations)) {
    errors.push('integrations must be an object when present.');
    return;
  }
  const configTargets = isRecord(manifest.configTargets) ? manifest.configTargets : {};
  for (const [id, integration] of Object.entries(manifest.integrations)) {
    const prefix = `integrations.${id}`;
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
    if (!hasText(apply.target) || !configTargets[apply.target]) {
      errors.push(`${prefix}.apply.target must reference a declared config target.`);
    }
    if (!isRecord(apply.values)) {
      errors.push(`${prefix}.apply.values must be an object.`);
      continue;
    }
    const allowed = new Set(isStringArray(configTargets[apply.target]?.allowedKeys) ? configTargets[apply.target].allowedKeys : []);
    for (const [key, value] of Object.entries(apply.values)) {
      if (!ENV_KEY_PATTERN.test(key)) errors.push(`${prefix}.apply.values.${key} must use an uppercase environment key.`);
      if (allowed.size && !allowed.has(key)) errors.push(`${prefix}.apply.values.${key} is not allowed by the config target.`);
      if (typeof value !== 'string') errors.push(`${prefix}.apply.values.${key} must be a string template.`);
    }
  }
}

function validateUsefulnessSemantics(manifest, errors) {
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

function validateWidgetSemantics(manifest, errors) {
  const widget = manifest.homepage?.widget;
  if (widget === undefined) return;
  if (!isRecord(widget)) {
    errors.push('homepage.widget must be an object when present.');
    return;
  }
  if (widget.type !== 'calendar' || widget.view !== 'monthly' || widget.showTime !== true) {
    errors.push('homepage.widget currently supports monthly calendar widgets only.');
  }
  if (!Number.isInteger(widget.maxEvents) || widget.maxEvents < 1 || widget.maxEvents > 50) {
    errors.push('homepage.widget.maxEvents must be a whole number from 1 to 50.');
  }
  if (!Array.isArray(widget.integrations) || widget.integrations.length < 1 || widget.integrations.length > 3) {
    errors.push('homepage.widget.integrations must contain one to three iCal integrations.');
    return;
  }
  for (const [index, integration] of widget.integrations.entries()) {
    const prefix = `homepage.widget.integrations[${index}]`;
    if (!isRecord(integration)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (integration.type !== 'ical') errors.push(`${prefix}.type must be ical.`);
    for (const field of ['color', 'name', 'url']) {
      if (!hasText(integration[field])) errors.push(`${prefix}.${field} is required.`);
    }
    if (hasText(integration.url) && !/^(?:https?:\/\/|\$\{app\.publicUrl\})/u.test(integration.url)) {
      errors.push(`${prefix}.url must be an HTTP URL or app public URL template.`);
    }
  }
}

function validateManifestSemantics(manifest, { packageDir = null } = {}) {
  const errors = [];
  if (!isRecord(manifest)) return errors;
  validatePackageFiles(manifest, packageDir, errors);
  validateIconSemantics(manifest, packageDir, errors);
  validateSetupSemantics(manifest, errors);
  validateResourceSemantics(manifest, packageDir, errors);
  validateRouteSemantics(manifest, errors);
  validateHealthSemantics(manifest, errors);
  validateCatalogSemantics(manifest, packageDir, errors);
  validateTemplates(manifest, errors);
  validateExportsSemantics(manifest, errors);
  validateConfigTargetsSemantics(manifest, errors);
  validateIntegrationsSemantics(manifest, errors);
  validateUsefulnessSemantics(manifest, errors);
  validateWidgetSemantics(manifest, errors);
  return errors;
}

module.exports = {
  APP_ID_PATTERN,
  ENV_KEY_PATTERN,
  FIELD_ID_PATTERN,
  TEMPLATE_REFERENCE,
  validateManifestSemantics,
};
