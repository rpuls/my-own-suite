'use strict';

// Turns a table of tools, written to be read by people, into MCP tool definitions.
// Every detail that would otherwise repeat per tool lives here once: the JSON
// schema of the arguments, the hints a tool's kind implies, and the empty defaults.

const OPTIONAL = Symbol('optional');

const text = (description) => ({ description, type: 'string' });
const integer = (description) => ({ description, type: 'integer' });
const flag = (description) => ({ description, type: 'boolean' });
const choice = (values, description) => ({ description, enum: [...values], type: 'string' });
const list = (items, { max, min }) => ({ items, maxItems: max, minItems: min, type: 'array' });
const optional = (spec) => ({ ...spec, [OPTIONAL]: true });

function schemaOf(args = {}) {
  const required = Object.keys(args).filter((name) => !args[name][OPTIONAL]);
  return { properties: { ...args }, ...(required.length ? { required } : {}), type: 'object' };
}

function hintsOf({ idempotent = false, kind }) {
  if (kind === 'read') return { readOnlyHint: true };
  return { destructiveHint: false, idempotentHint: idempotent, readOnlyHint: false };
}

// `says` may be a function, for a description built from data that grows, such
// as the list of diagnostics topics.
function toolsFrom(table) {
  return Object.entries(table).map(([name, tool]) => ({
    annotations: hintsOf(tool),
    description: typeof tool.says === 'function' ? tool.says() : tool.says,
    fixed: tool.fixed ?? {},
    inputSchema: schemaOf(tool.args),
    kind: tool.kind,
    name,
    note: tool.note ?? null,
    title: tool.title,
  }));
}

module.exports = { choice, flag, integer, list, optional, text, toolsFrom };
