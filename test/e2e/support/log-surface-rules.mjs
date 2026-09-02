import { redact } from './hyperv-env.mjs';

// Intelligent inspection of the log surface a real run leaves behind.
//
// A byte-for-byte comparison is impossible — timestamps move, an OS or package
// update legitimately changes wording — so this asserts on the two things that
// survive that churn: what MUST be there, and what MUST NEVER be there. The
// interesting failures are the ones nobody was looking for: a package update
// that starts emitting an error into a log nobody reads, a credential that
// stops being masked, a logger that quietly stops producing records at all.
// Each of those is invisible in a passing UI and expensive to find late.
//
// It runs against the diagnostics bundle rather than the raw journal on purpose.
// The bundle is the artifact an owner actually sends to a stranger, so "no
// secret is in here" is the security property that matters, asserted on exactly
// the surface where it matters. The bundle is bounded, which makes this sampling
// rather than proof — an honest limit, and the alternative is SSH.

// Structured records whose presence is always a defect, whatever else is true.
const CRASH_EVENTS = new Set(['uncaught-exception', 'unhandled-rejection', 'start-failed', 'server-error', 'port-in-use']);

// Error-level records a lab run may legitimately produce. Deliberately empty:
// an error MOS logged during a clean end-to-end run is a finding until someone
// decides otherwise, and the failure message names the event so deciding takes
// seconds. Add entries with a comment saying why.
const ALLOWED_ERROR_EVENTS = new Set([]);

// Catastrophes in any log, structured or not. Kept narrow on purpose — a broad
// grep for "error" would go red on the first third-party version bump, and a
// suite that cries wolf gets disabled within a month.
const FORBIDDEN_PATTERNS = [
  { name: 'Go panic (Caddy or a Go-based app crashed)', pattern: /^\s*panic: |goroutine \d+ \[running\]:/mu },
  { name: 'Python traceback', pattern: /Traceback \(most recent call last\)/u },
  { name: 'Node fatal error', pattern: /FATAL ERROR: |JavaScript heap out of memory/u },
  { name: 'segfault or protection fault', pattern: /segfault at |general protection fault/u },
  { name: 'disk full', pattern: /No space left on device/iu },
  { name: 'kernel OOM killer', pattern: /Out of memory: Killed process|oom-kill:/u },
  { name: 'permission denied on a MOS-owned path', pattern: /(permission denied|EACCES)[^\n]*(\/var\/lib\/mos|\/etc\/mos|\/run\/mos-)/iu },
  { name: 'database corruption', pattern: /database disk image is malformed|SQLITE_CORRUPT/u },
  { name: 'a MOS unit failed to start', pattern: /Failed to start [^\n]*MOS/iu },
];

// An assignment to a secret-shaped name whose value was not masked. The name
// pattern is env-var shaped because that is how a secret reaches a log at all:
// through a container's environment, a compose projection, or a command line.
const UNREDACTED_ASSIGNMENT = /\b([A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)=(\S+)/gu;

// Looks like an assignment but carries nothing: a cleared variable, a template
// that was never substituted, an obvious placeholder.
const BENIGN_VALUES = /^(\[redacted\]|null|nil|none|true|false|undefined|changeme|example|placeholder|""|''|\*+|x+|-+|\$\{[^}]*\}|<[^>]*>)$/iu;

function normalizeShape(line) {
  return line
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,+-]+Z?/gu, '<ts>')
    .replace(/\b[0-9a-f]{7,}\b/giu, '<hex>')
    .replace(/\b\d+\b/gu, '<n>')
    .replace(/\s+/gu, ' ')
    .trim();
}

// Suite Manager's own records, parsed back out of the journal lines carrying
// them. Recovering these is only possible because the logger emits one JSON
// object per line — the same property that makes the format worth having.
function structuredRecords(bundle) {
  const records = [];
  for (const line of String(bundle).split('\n')) {
    const start = line.indexOf('{"ts"');
    if (start === -1) continue;
    try {
      const record = JSON.parse(line.slice(start));
      if (record && typeof record === 'object') records.push(record);
    } catch { /* a record clipped by the bundle's own bounding is not a record */ }
  }
  return records;
}

// A section title sits between two rules, so its content starts after the second
// one — stopping at the first finds nothing and every check over that section
// then passes by default, which is the failure mode these rules exist to avoid.
function sectionOf(bundle, title) {
  const marker = `\n${title}\n`;
  const at = bundle.indexOf(marker);
  if (at === -1) return '';
  const underline = bundle.indexOf('\n', at + marker.length);
  if (underline === -1) return '';
  const contentStart = underline + 1;
  const nextRule = bundle.indexOf('─'.repeat(20), contentStart);
  return bundle.slice(contentStart, nextRule === -1 ? undefined : nextRule);
}

// Secrets this suite typed into MOS or into an app. Worth more than any pattern
// match: MOS masks by exact value against secrets it holds, and it holds none of
// these. The owner password is a scrypt hash to MOS, an app's own master
// password never reaches MOS at all, and the Cloudflare token lives in a
// root-owned file unprivileged Suite Manager usually cannot read. So these probe
// the leaks redaction structurally cannot cover, rather than re-testing the
// redactor against itself.
function knownSecrets(env) {
  return [
    ['owner password', env.owner?.password],
    ['Cloudflare API token', env.cloudflareApiToken],
    ['Radicale password', env.radicale?.password],
    ['Vaultwarden master password', env.vaultwarden?.password],
    ['Seafile admin password', env.seafile?.adminPassword],
  ].filter(([, value]) => typeof value === 'string' && value.length >= 8);
}

// Evaluates every rule and returns what it found. Pure on purpose: a leak
// detector whose regex silently stops matching is worse than no detector, so the
// rules have to be testable without a browser or a host.
export function inspectLogSurface(input = '', env = {}) {
  const bundle = typeof input === 'string' ? input : String(input ?? '');
  const failures = [];

  for (const [name, value] of knownSecrets(env)) {
    // Never the value itself — this message goes into CI output.
    if (bundle.includes(value)) failures.push(`LEAK: the ${name} (${redact(value)}) appears in a file MOS offers owners to send to a stranger.`);
  }

  for (const { name, pattern } of FORBIDDEN_PATTERNS) {
    const found = new RegExp(pattern.source, pattern.flags).exec(bundle);
    if (found) failures.push(`${name}: ${normalizeShape(found[0]).slice(0, 200)}`);
  }

  for (const match of bundle.matchAll(UNREDACTED_ASSIGNMENT)) {
    const [, name, value] = match;
    if (BENIGN_VALUES.test(value)) continue;
    failures.push(`unmasked secret-shaped value: ${name}=${redact(value)}`);
  }

  const records = structuredRecords(bundle);
  for (const record of records) {
    if (CRASH_EVENTS.has(record.event)) failures.push(`crash-shaped record: ${record.event} — ${String(record.error || '').slice(0, 200)}`);
    else if (record.level === 'error' && !ALLOWED_ERROR_EVENTS.has(record.event)) {
      failures.push(`unexpected error record: ${record.event}. If this is expected lab noise, add it to ALLOWED_ERROR_EVENTS in test/e2e/support/log-surface-rules.mjs with a reason.`);
    }
    if (!record.ts || !record.level || !record.event) failures.push(`malformed record, missing the ts/level/event envelope: ${JSON.stringify(record).slice(0, 200)}`);
  }

  // If the logger ever fell back to human-readable output on an installed server
  // — journald is not a terminal, so it must not — there would be no parseable
  // records at all, and every downstream reader would silently degrade to grep.
  if (!records.length) failures.push('no structured log records were found: Suite Manager is not writing JSON to the journal.');

  // Counted per container rather than searched for as indented text: every
  // container block carries indented `image` and `package` lines whether or not
  // it has any log, so a text search always finds something and the check would
  // pass forever without ever being able to fail.
  const containers = sectionOf(bundle, 'CONTAINERS');
  if (containers && !containers.includes('No MOS containers are present')) {
    const present = containers.split('\n').filter((line) => /^\S.+ {2}·/u.test(line)).length;
    const silent = (containers.match(/^ {2}\(no log lines\)$/gmu) || []).length;
    if (present > 0 && silent === present) {
      failures.push(`all ${present} MOS containers reported no log lines, so container logging is not reaching the collector.`);
    }
  }

  // The inventory makes a later regression legible: an OS or package update that
  // starts emitting something new shows up as a shape nobody has seen before.
  const shapes = [...new Set(bundle.split('\n').filter((line) => line.startsWith('  ') && line.trim()).map(normalizeShape))].sort();
  const events = [...new Set(records.map((record) => `${record.level} ${record.event}`))].sort();

  return {
    failures,
    inventory: [
      `records parsed: ${records.length}`,
      `distinct events: ${events.length}`,
      ...events.map((event) => `  ${event}`),
      '',
      `distinct line shapes: ${shapes.length}`,
      ...shapes.map((shape) => `  ${shape}`),
    ].join('\n'),
    records,
  };
}

export { ALLOWED_ERROR_EVENTS, CRASH_EVENTS, FORBIDDEN_PATTERNS, normalizeShape, structuredRecords };
