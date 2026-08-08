// Structural manifest validation against the published JSON Schema.
//
// apps/manifest.schema.json is the canonical, machine-readable half of the
// locked manifest contract: it is what external authors validate against with
// any standard JSON Schema tool, and what the authoring documentation is
// written from. MOS itself must enforce exactly that artifact rather than a
// hand-written twin that can drift — so this module interprets the schema file
// directly. It implements only the JSON Schema subset the schema actually
// uses, and fails loudly on any keyword outside that subset, which keeps the
// schema honest: nobody can add a keyword MOS silently ignores.
//
// Deliberately dependency-free, like the rest of the backend.
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_SCHEMA_PATH = path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'manifest.schema.json');

// Keywords that shape validation. Anything else present in a schema node that
// is not in IGNORED_KEYWORDS throws at load time.
const SUPPORTED_KEYWORDS = new Set([
  '$ref', 'additionalProperties', 'const', 'enum', 'items', 'maxItems', 'maximum',
  'minItems', 'minLength', 'minProperties', 'minimum', 'pattern', 'patternProperties',
  'properties', 'propertyNames', 'required', 'type', 'uniqueItems',
]);
const IGNORED_KEYWORDS = new Set(['$defs', '$id', '$schema', 'description', 'title']);

let cachedSchema = null;

function loadManifestSchema() {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(fs.readFileSync(MANIFEST_SCHEMA_PATH, 'utf8'));
    assertSupported(cachedSchema, cachedSchema, 'schema');
  }
  return cachedSchema;
}

function assertSupported(node, root, trail) {
  if (Array.isArray(node) || node === null || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    if (!SUPPORTED_KEYWORDS.has(key) && !IGNORED_KEYWORDS.has(key)) {
      throw new Error(`${trail}.${key} is not a JSON Schema keyword this validator implements.`);
    }
  }
  for (const child of ['items', 'propertyNames', 'additionalProperties']) {
    if (node[child] !== undefined && typeof node[child] === 'object') {
      assertSupported(node[child], root, `${trail}.${child}`);
    }
  }
  for (const map of ['properties', 'patternProperties', '$defs']) {
    if (node[map] && typeof node[map] === 'object') {
      for (const [key, child] of Object.entries(node[map])) assertSupported(child, root, `${trail}.${map}.${key}`);
    }
  }
}

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error(`Unsupported schema $ref: ${ref}`);
  }
  let node = root;
  for (const segment of ref.slice(2).split('/')) {
    node = node?.[segment];
    if (node === undefined) throw new Error(`Unresolvable schema $ref: ${ref}`);
  }
  return node;
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function describeValue(value) {
  const kind = typeOf(value);
  if (kind === 'string') return value.length > 60 ? 'a longer string' : JSON.stringify(value);
  if (kind === 'object' || kind === 'array') return `an ${kind}`;
  return String(value);
}

function label(trail) {
  return trail || 'manifest';
}

function validateNode(schema, root, value, trail, errors) {
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, root);
    // Merge sibling keywords (none are used alongside $ref today, but stay correct).
    validateNode(resolved, root, value, trail, errors);
    const { $ref, ...rest } = schema;
    if (Object.keys(rest).some((key) => SUPPORTED_KEYWORDS.has(key))) {
      validateNode(rest, root, value, trail, errors);
    }
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${label(trail)} must be ${JSON.stringify(schema.const)}, got ${describeValue(value)}.`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${label(trail)} must be one of: ${schema.enum.join(', ')}.`);
    return;
  }
  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = expected.some((type) => actual === type || (type === 'number' && actual === 'integer'));
    if (!matches) {
      errors.push(`${label(trail)} must be ${expected.join(' or ')}, got ${describeValue(value)}.`);
      return;
    }
  }

  if (typeOf(value) === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${label(trail)} must not be empty.`);
      return;
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${label(trail)} does not match the required format (${schema.pattern}).`);
    }
    return;
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${label(trail)} must be at least ${schema.minimum}.`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${label(trail)} must be at most ${schema.maximum}.`);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${label(trail)} must contain at least ${schema.minItems} item${schema.minItems === 1 ? '' : 's'}.`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${label(trail)} must contain at most ${schema.maxItems} items.`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const [index, item] of value.entries()) {
        const key = JSON.stringify(item);
        if (seen.has(key)) errors.push(`${trail}[${index}] duplicates another entry.`);
        seen.add(key);
      }
    }
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        validateNode(schema.items, root, item, `${trail}[${index}]`, errors);
      }
    }
    return;
  }

  if (typeOf(value) === 'object') {
    if (schema.required !== undefined) {
      for (const key of schema.required) {
        if (value[key] === undefined) errors.push(`${trail ? `${trail}.` : ''}${key} is required.`);
      }
    }
    if (schema.minProperties !== undefined && Object.keys(value).length < schema.minProperties) {
      errors.push(`${label(trail)} must declare at least ${schema.minProperties} ${schema.minProperties === 1 ? 'entry' : 'entries'}.`);
    }
    const properties = schema.properties || {};
    const patternProperties = Object.entries(schema.patternProperties || {})
      .map(([pattern, child]) => ({ child, regExp: new RegExp(pattern, 'u') }));
    for (const [key, child] of Object.entries(value)) {
      // JSON cannot express undefined; an in-memory manifest carrying one
      // means "absent", exactly like a missing key.
      if (child === undefined) continue;
      const childTrail = trail ? `${trail}.${key}` : key;
      if (schema.propertyNames?.pattern && !new RegExp(schema.propertyNames.pattern, 'u').test(key)) {
        errors.push(`${childTrail} is not an allowed key name.`);
        continue;
      }
      let matched = false;
      if (properties[key] !== undefined) {
        matched = true;
        validateNode(properties[key], root, child, childTrail, errors);
      }
      for (const { child: patternSchema, regExp } of patternProperties) {
        if (regExp.test(key)) {
          matched = true;
          validateNode(patternSchema, root, child, childTrail, errors);
        }
      }
      if (!matched && schema.additionalProperties === false) {
        // The one closed keyspace in the schema (service ids); every other
        // object ignores unknown keys by design — the open-world rule.
        errors.push(`${childTrail} is not an allowed key name.`);
      }
    }
  }
}

// Validates structure against apps/manifest.schema.json. Returns human-readable
// error strings with dotted paths, matching the historical validator style.
function validateManifestStructure(manifest) {
  const schema = loadManifestSchema();
  const errors = [];
  validateNode(schema, schema, manifest, '', errors);
  return errors;
}

module.exports = {
  MANIFEST_SCHEMA_PATH,
  loadManifestSchema,
  validateManifestStructure,
};
