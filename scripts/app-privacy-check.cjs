#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const {
  digestAppPackage,
  validatePrivacyAssessment,
  validatePrivacyBinding,
} = require('../suite-manager/backend/src/apps/package-contracts.cjs');
const { discoverAppPackages } = require('../suite-manager/backend/src/apps/package-manifest.cjs');

const repoRoot = path.resolve(__dirname, '..');
const officialRepository = 'https://github.com/rpuls/my-own-suite';
const assessmentSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'schemas', 'app-privacy-assessment.schema.json'), 'utf8'),
);

// Minimal interpreter for the subset of JSON Schema the assessment schema
// uses (type, const, enum, pattern, required, properties,
// additionalProperties: false, items, minItems, $ref into $defs, and the
// date-time/uri formats). Interpreting the committed schema file keeps it the
// single source of truth without pulling a validator dependency into the repo;
// extend this subset if the schema ever grows past it.
function schemaErrors(schema, value, root, pointer) {
  if (schema.$ref !== undefined) {
    const resolved = schema.$ref.replace(/^#\//u, '').split('/')
      .reduce((node, segment) => node?.[segment], root);
    if (!resolved) return [`${pointer}: unresolvable $ref ${schema.$ref}.`];
    return schemaErrors(resolved, value, root, pointer);
  }
  const errors = [];
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer} must be ${JSON.stringify(schema.const)}.`);
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${pointer} must be one of ${schema.enum.join(', ')}.`);
  }
  if (schema.type !== undefined) {
    const actual = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
    if (actual !== schema.type) return [...errors, `${pointer} must be a ${schema.type}.`];
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${pointer} does not match ${schema.pattern}.`);
    }
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      errors.push(`${pointer} must be an ISO date-time.`);
    }
    if (schema.format === 'uri') {
      try { new URL(value); } catch { errors.push(`${pointer} must be a URI.`); }
    }
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer} must contain at least ${schema.minItems} item(s).`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => errors.push(...schemaErrors(schema.items, item, root, `${pointer}[${index}]`)));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const name of schema.required ?? []) {
      if (value[name] === undefined) errors.push(`${pointer}.${name} is required.`);
    }
    for (const [name, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (value[name] !== undefined) errors.push(...schemaErrors(propertySchema, value[name], root, `${pointer}.${name}`));
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!(name in (schema.properties ?? {}))) errors.push(`${pointer}.${name} is not a known property.`);
      }
    }
  }
  return errors;
}

const errors = [];
for (const entry of discoverAppPackages(path.join(repoRoot, 'apps'))) {
  const reviewPath = path.join(entry.packageDir, 'privacy-review.json');
  if (!fs.existsSync(reviewPath)) continue;
  try {
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    for (const error of schemaErrors(assessmentSchema, review, assessmentSchema, 'review')) {
      errors.push(`${entry.manifest.id}: ${error}`);
    }
    const expectedDigest = digestAppPackage(entry.packageDir, { manifest: entry.manifest });
    const source = {
      kind: 'official-git',
      path: `apps/${entry.manifest.id}`,
      repository: officialRepository,
      revision: review.scope?.source?.revision,
      trust: 'mos-reviewed',
    };
    for (const error of validatePrivacyBinding(review, { manifest: entry.manifest, packageDigest: expectedDigest, source })) {
      errors.push(`${entry.manifest.id}: ${error}`);
    }
    for (const error of validatePrivacyAssessment(review)) {
      errors.push(`${entry.manifest.id}: ${error}`);
    }
  } catch (error) {
    errors.push(`${entry.manifest.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
}
