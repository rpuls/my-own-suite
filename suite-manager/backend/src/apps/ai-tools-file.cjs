'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The tools a package offers an owner's AI, and the reviewed kind of each, live
// beside the manifest rather than in it: the manifest says how MOS reaches the
// app's MCP server, this file says what MOS may let an AI do there.
const AI_TOOLS_FILENAME = 'ai-tools.json';
const AI_TOOLS_SCHEMA_VERSION = 1;
const TOOL_KINDS = new Set(['read', 'add', 'change', 'serious', 'destructive']);
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/u;
const FIXED_PATH_PATTERN = /^[A-Za-z0-9_]{1,64}(?:\.[A-Za-z0-9_]{1,64}){0,7}$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Null when the package has no tools file. A file that is not JSON is reported
// as an error rather than read as no tools, so a broken file never offers fewer
// or other tools than its author meant.
function readAiToolsFile(packageDir) {
  const filePath = path.join(packageDir, AI_TOOLS_FILENAME);
  if (!fs.existsSync(filePath)) return { document: null, error: null };
  try {
    return { document: JSON.parse(fs.readFileSync(filePath, 'utf8')), error: null };
  } catch {
    return { document: null, error: `${AI_TOOLS_FILENAME} is not valid JSON.` };
  }
}

// A tool is its kind, or { kind, title, note, fixed }. `fixed` pins arguments
// by dotted path to the value the gateway always sends, whatever the AI asked.
function validateToolEntry(entry, prefix, errors) {
  const spec = typeof entry === 'string' ? { kind: entry } : entry;
  if (!isRecord(spec)) {
    errors.push(`${prefix} must be a kind or an object with a kind.`);
    return;
  }
  if (!TOOL_KINDS.has(spec.kind)) errors.push(`${prefix} kind must be one of: ${[...TOOL_KINDS].join(', ')}.`);
  if (spec.title !== undefined && (!hasText(spec.title) || spec.title.length > 60)) errors.push(`${prefix}.title must be a short label.`);
  if (spec.note !== undefined && (!hasText(spec.note) || spec.note.length > 160)) errors.push(`${prefix}.note must be one short sentence.`);
  if (spec.fixed === undefined) return;
  if (!isRecord(spec.fixed)) {
    errors.push(`${prefix}.fixed must be an object.`);
    return;
  }
  for (const [argumentPath, value] of Object.entries(spec.fixed)) {
    if (!FIXED_PATH_PATTERN.test(argumentPath)) errors.push(`${prefix}.fixed.${argumentPath} is not a dotted argument path.`);
    if (!['string', 'number', 'boolean'].includes(typeof value)) errors.push(`${prefix}.fixed.${argumentPath} must be a string, number or boolean.`);
  }
}

function validateAiTools(document) {
  const errors = [];
  if (!isRecord(document)) return [`${AI_TOOLS_FILENAME} must be an object.`];
  if (document.schemaVersion !== AI_TOOLS_SCHEMA_VERSION) errors.push(`${AI_TOOLS_FILENAME} schemaVersion must be ${AI_TOOLS_SCHEMA_VERSION}.`);
  const tools = isRecord(document.tools) ? Object.entries(document.tools) : [];
  if (!tools.length) errors.push(`${AI_TOOLS_FILENAME} tools must list at least one tool.`);
  for (const [name, entry] of tools) {
    if (!TOOL_NAME_PATTERN.test(name)) errors.push(`${AI_TOOLS_FILENAME} tools.${name} is not a valid tool name.`);
    validateToolEntry(entry, `${AI_TOOLS_FILENAME} tools.${name}`, errors);
  }
  return errors;
}

module.exports = { AI_TOOLS_FILENAME, TOOL_KINDS, TOOL_NAME_PATTERN, readAiToolsFile, validateAiTools };
