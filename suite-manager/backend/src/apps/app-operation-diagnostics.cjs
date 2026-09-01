'use strict';

// What an app operation leaves behind when it fails. The columns already carry
// the structured half — code, kind, timestamps — so this is only the free text
// that has nowhere else to live: the agent's own explanation and whatever detail
// it attached.
//
// Two rules shape it. It is bounded, because a diagnostics bundle that has to be
// readable — by a person or by an AI asked what went wrong — cannot afford one
// pathological failure filling it. And it is redacted here, on the way in, not
// on the way out: this text lands in SQLite, and SQLite lands in every backup
// bundle, so anything left in it is left in it permanently.

const { redactValues } = require('../redaction.cjs');

const MAX_DIAGNOSTICS_CHARS = 4_000;
const MAX_DETAIL_ENTRIES = 10;

function bound(text) {
  if (text.length <= MAX_DIAGNOSTICS_CHARS) return text;
  return `${text.slice(0, MAX_DIAGNOSTICS_CHARS)}\n…[truncated ${text.length - MAX_DIAGNOSTICS_CHARS} chars]`;
}

// `details` is whatever the agent chose to attach. It is stringified defensively
// rather than trusted to be text, because the shape differs per failure stage
// and a diagnostics writer that throws would lose the very failure it is
// recording.
function describeDetails(details) {
  if (!Array.isArray(details) || !details.length) return [];
  return details.slice(0, MAX_DETAIL_ENTRIES).map((entry) => {
    if (typeof entry === 'string') return entry;
    try { return JSON.stringify(entry); } catch { return String(entry); }
  });
}

function buildAppOperationDiagnostics(error, { secrets = [] } = {}) {
  const errorCode = error?.code || 'APP_RUNTIME_APPLY_FAILED';
  const lines = [];
  const message = error?.message ? String(error.message) : '';
  if (message) lines.push(message);
  const details = describeDetails(error?.details);
  if (details.length) {
    lines.push('', 'Details:');
    for (const detail of details) lines.push(`- ${detail}`);
  }
  const overflow = Array.isArray(error?.details) ? error.details.length - MAX_DETAIL_ENTRIES : 0;
  if (overflow > 0) lines.push(`- …and ${overflow} more`);
  const diagnostics = lines.join('\n').trim();
  return {
    diagnostics: diagnostics ? bound(redactValues(diagnostics, secrets)) : null,
    errorCode,
  };
}

module.exports = {
  MAX_DIAGNOSTICS_CHARS,
  buildAppOperationDiagnostics,
};
