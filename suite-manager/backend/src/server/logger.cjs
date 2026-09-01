'use strict';

const crypto = require('node:crypto');

const { createRedactor } = require('../redaction.cjs');

// One JSON object per line on stdout. journald already captures a systemd
// service's stdout, so MOS owns no log files, no rotation, and no dependency in
// a backend that has none — `journalctl -u mos-suite-manager` is the reader.
//
// The shape is deliberately small and stable, because these lines are read
// three ways: by a person tailing the journal, by a diagnostics bundle that has
// to stay small enough to hand to someone, and by an AI asked to explain a
// failure. All three are served by the same thing — bounded fields, a flat
// record, and truncation that says it happened rather than silently cutting.

const LEVELS = ['debug', 'info', 'warn', 'error'];
const LEVEL_RANK = new Map(LEVELS.map((level, index) => [level, index]));

// A stack is the field that would otherwise dominate a bundle: ten frames of
// node internals per record, none of which locate a MOS bug. Everything else is
// bounded well below anything a reader would want to skim past.
const LIMITS = {
  field: 2_000,
  record: 16_000,
  stackFrames: 12,
};

function truncate(value, limit = LIMITS.field) {
  const text = typeof value === 'string' ? value : String(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]`;
}

function serializeError(error, redact) {
  if (!error || typeof error !== 'object') {
    return error === undefined ? undefined : { message: truncate(redact(String(error))) };
  }
  const stack = typeof error.stack === 'string'
    ? error.stack.split('\n').slice(0, LIMITS.stackFrames).join('\n')
    : undefined;
  return {
    ...(error.code ? { code: truncate(redact(String(error.code)), 200) } : {}),
    ...(error.name && error.name !== 'Error' ? { name: truncate(redact(String(error.name)), 200) } : {}),
    message: truncate(redact(String(error.message || error))),
    ...(stack ? { stack: truncate(redact(stack), LIMITS.field * 2) } : {}),
  };
}

// Values are flattened rather than deep-serialized: a record that can nest
// arbitrarily is a record whose size cannot be predicted, and the point of this
// format is that a thousand of them still fit somewhere useful.
//
// Redaction happens here, per value, and the order is the whole point. Before
// serialization, because JSON-escaping a secret that contains a quote or a
// backslash stops it matching the exact value being searched for — which would
// have silently under-redacted precisely the passwords most likely to carry
// punctuation. And before truncation, because a secret straddling the cut would
// otherwise survive as a readable fragment.
function normalizeValue(value, redact) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return truncate(redact(value));
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) return serializeError(value, redact);
  if (Array.isArray(value)) return truncate(redact(value.map((entry) => String(entry)).join(', ')));
  try { return truncate(redact(JSON.stringify(value))); } catch { return truncate(redact(String(value))); }
}

// The same record, formatted for a person. Chosen by whether stdout is a
// terminal, which is exactly the distinction that matters: journald is never a
// TTY, so an installed server always writes JSON, and `npm run dev` always
// writes something a developer can read at a glance. Redaction runs first
// either way, so this only decides shape.
function formatPretty(record) {
  const { ts, level, event, ...rest } = record;
  const time = typeof ts === 'string' && ts.length >= 19 ? ts.slice(11, 19) : ts;
  const parts = [time, level.toUpperCase().padEnd(5), event];
  const error = rest.error;
  delete rest.error;
  const fields = Object.entries(rest).map(([key, value]) => `${key}=${value}`).join(' ');
  if (fields) parts.push(fields);
  let line = parts.join(' ');
  if (error) {
    line += `\n  ${error.code ? `${error.code}: ` : ''}${error.message}`;
    if (error.stack) line += `\n${error.stack.split('\n').slice(1).map((frame) => `  ${frame.trim()}`).join('\n')}`;
  }
  return line;
}

function createLogger({
  level = process.env.MOS_LOG_LEVEL || 'info',
  now = () => new Date().toISOString(),
  pretty = undefined,
  secretProvider = null,
  stream = process.stdout,
} = {}) {
  const threshold = LEVEL_RANK.has(level) ? LEVEL_RANK.get(level) : LEVEL_RANK.get('info');
  const redact = createRedactor(secretProvider);
  const humanReadable = pretty === undefined ? stream.isTTY === true : pretty === true;

  function write(recordLevel, event, fields = {}) {
    if (LEVEL_RANK.get(recordLevel) < threshold) return;
    const record = { ts: now(), level: recordLevel, event: truncate(redact(String(event)), 200) };
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'ts' || key === 'level' || key === 'event') continue;
      const normalized = key === 'error' ? serializeError(value, redact) : normalizeValue(value, redact);
      if (normalized !== undefined) record[key] = normalized;
    }
    let line;
    try { line = JSON.stringify(record); } catch { line = JSON.stringify({ ts: record.ts, level: recordLevel, event: record.event, note: 'record was not serializable' }); }
    // A record over the cap is a bug in a call site rather than something to
    // drop: keep the identifying head so the event is still findable, and say
    // how much went.
    if (line.length > LIMITS.record) {
      line = JSON.stringify({
        ts: record.ts,
        level: recordLevel,
        event: record.event,
        note: `record exceeded ${LIMITS.record} chars and was dropped`,
        droppedChars: line.length,
      });
    }
    // Reparsed rather than formatted from `record` directly, so the human line
    // can only ever show what the machine line would have carried — including
    // the redaction, which has already run over the serialized text.
    if (humanReadable) {
      try {
        stream.write(`${formatPretty(JSON.parse(line))}\n`);
        return;
      } catch { /* fall through to the JSON line */ }
    }
    stream.write(`${line}\n`);
  }

  // Four levels and nothing else. Every call site here logs at the boundary
  // where it already holds the whole story, so there is no deep stack to thread
  // context down and no bound-field helper to justify yet.
  return {
    debug: (event, fields) => write('debug', event, fields),
    error: (event, fields) => write('error', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
  };
}

// Short rather than a UUID because its whole job is to be read back off a
// screen or pasted into a bug report, and it only has to be unique among the
// requests in one journal.
function requestId() {
  return crypto.randomBytes(4).toString('hex');
}

module.exports = {
  LIMITS,
  createLogger,
  requestId,
};
