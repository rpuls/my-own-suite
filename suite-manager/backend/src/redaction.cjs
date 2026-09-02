'use strict';

// Redaction by exact value, and the only implementation of it.
//
// Suite Manager holds the plaintext of every secret it could leak, which is a
// far stronger position than a regex for anything that looks like a key: there
// is no shape to guess at and no novel credential format to miss. The cost is
// that every caller must hand over the values, which is why this is a function
// of (text, secrets) rather than something clever that inspects the text.
//
// It lives on its own because its callers must not drift apart — the logger,
// which redacts before a line reaches the journal; operation diagnostics, which
// redact before text reaches SQLite and therefore every backup bundle; and the
// support bundle, which redacts the finished file. A second copy of this that
// disagreed about the minimum length would leak on exactly the secrets the
// other one masked.

const REDACTION_MARKER = '[redacted]';

// Below this, masking costs more than it protects: a short secret occurs inside
// ordinary words, so replacing every occurrence would shred the surrounding text
// while telling an attacker nothing they could not already guess.
const MIN_REDACTABLE_SECRET_CHARS = 6;

function redactableSecrets(secrets = []) {
  if (!Array.isArray(secrets)) return [];
  return [...new Set(secrets)]
    .filter((value) => typeof value === 'string' && value.length >= MIN_REDACTABLE_SECRET_CHARS)
    // Longest first, so a secret that contains another is masked whole rather
    // than leaving a recognisable fragment around the inner match.
    .sort((left, right) => right.length - left.length);
}

function redactValues(text, secrets = []) {
  if (!text || !secrets?.length) return text;
  let result = text;
  for (const secret of redactableSecrets(secrets)) result = result.split(secret).join(REDACTION_MARKER);
  return result;
}

// Same masking, plus a count of what it replaced. The count exists so a
// diagnostics bundle can prove redaction ran rather than asking its reader to
// take it on trust — a bundle that masked nothing because the secret set arrived
// empty is indistinguishable from one that had nothing to mask, and those are
// very different situations. Counts only: reporting which values matched, or how
// long they were, would rebuild the secret from the report.
function redactValuesWithReport(text, secrets = []) {
  const candidates = redactableSecrets(secrets);
  let result = String(text || '');
  let maskedCount = 0;
  for (const secret of candidates) {
    const parts = result.split(secret);
    maskedCount += parts.length - 1;
    result = parts.join(REDACTION_MARKER);
  }
  return { candidateCount: candidates.length, maskedCount, text: result };
}

// The logger redacts every value it writes, so it reads the secrets lazily
// rather than at construction.
//
// A provider that throws fails open: the text goes out unmasked rather than the
// record being lost. That is the right trade only while what reaches a log line
// cannot contain a secret in the first place, which is true today — the host
// agents discard command output and argv entirely, so an error message carries
// none. Whoever wires a real provider (roadmap I7) owns this choice again, and
// should decide then whether an unmaskable record is better dropped than
// written, because at that point the premise it rests on is gone.
function createRedactor(secretProvider) {
  if (typeof secretProvider !== 'function') return (text) => text;
  return (text) => {
    try {
      return redactValues(text, secretProvider());
    } catch {
      return text;
    }
  };
}

module.exports = {
  MIN_REDACTABLE_SECRET_CHARS,
  REDACTION_MARKER,
  createRedactor,
  redactValues,
  redactValuesWithReport,
  redactableSecrets,
};
