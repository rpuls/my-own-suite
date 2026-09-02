'use strict';

// Runs a privileged command and keeps the reason it failed.
//
// Every MOS host agent used to run its commands with `stdio: 'ignore'`, which
// made a failed `docker build` indistinguishable from any other failed `docker
// build`: the agent reported the stage and threw the explanation away. This
// runner keeps a bounded rolling tail of what the command wrote and hands it
// back with the failure, so the reason can travel to Suite Manager, into the
// persisted operation record, and into the file an owner sends for help.
//
// What it never keeps is the command line. App containers are started with
// materialized secrets on their argv, so an error path that echoed what it
// tried to run would leak every secret of an app at once. Callers describe a
// failure with a label they chose (`docker build for service "web"`), and the
// arguments stay in the process table where they always were. Output is masked
// by exact value for anything the caller knows to be secret before it leaves
// the agent; Suite Manager masks it again, against the full secret set it
// holds, before the text reaches SQLite.

const { spawn } = require('node:child_process');

// The rolling window kept while a command runs. Well above what is attached, so
// a secret straddling the window's edge can never sit inside the attached tail.
const ROLLING_CAPTURE_CHARS = 64 * 1024;
// What travels with a failure. Enough to hold the last error a build or a
// container printed with its context, and small enough that a multi-service
// package's failure still fits in one readable operation record.
const OUTPUT_TAIL_LINES = 60;
const OUTPUT_TAIL_CHARS = 8_000;
// How long a command that overran its deadline gets to stop on SIGTERM before
// it is killed outright.
const KILL_GRACE_MS = 5_000;
const REDACTION_MARKER = '[redacted]';
// Same floor as Suite Manager's redaction: shorter values occur inside ordinary
// words and masking them shreds the text while protecting nothing.
const MIN_MASKABLE_CHARS = 6;

// eslint-disable-next-line no-control-regex
const TERMINAL_COLOUR = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;

class CommandFailure extends Error {
  constructor(reason, { exitCode = null, output = '', signal = null, timeoutMs = null } = {}) {
    super(reason);
    this.name = 'CommandFailure';
    this.exitCode = exitCode;
    this.output = output;
    this.signal = signal;
    this.timeoutMs = timeoutMs;
  }

  get timedOut() {
    return this.message === 'COMMAND_TIMEOUT';
  }
}

function maskValues(text, values = []) {
  let result = String(text ?? '');
  const candidates = [...new Set(values)]
    .filter((value) => typeof value === 'string' && value.length >= MIN_MASKABLE_CHARS)
    .sort((left, right) => right.length - left.length);
  for (const value of candidates) result = result.split(value).join(REDACTION_MARKER);
  return result;
}

// The newest lines of a command's output, with colour codes removed and each
// progress bar collapsed to its final rewrite, so what is left reads as the log
// it would have been in a file.
function tailOutput(text, { chars = OUTPUT_TAIL_CHARS, lines = OUTPUT_TAIL_LINES } = {}) {
  const cleaned = String(text ?? '').replace(TERMINAL_COLOUR, '').replace(/\r\n/gu, '\n');
  const kept = cleaned.split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1).trimEnd())
    .filter((line) => line.trim());
  const dropped = Math.max(0, kept.length - lines);
  let result = kept.slice(-lines).join('\n');
  if (result.length > chars) result = `…${result.slice(-chars)}`;
  return dropped ? `[${dropped} earlier ${dropped === 1 ? 'line' : 'lines'} omitted]\n${result}` : result;
}

// With echo set the output also streams to this process's own stdout and
// stderr, for a worker whose journal is still the full log. A timeoutMs of 0
// means none.
//
// The command runs in its own process group so that a deadline stops all of
// it: `npm run` and `docker build` do their work in children that inherit the
// output pipes, and signalling only the parent would leave them running and
// the pipes open, which is exactly the hang the deadline exists to end.
function runCommand(file, args, { cwd = undefined, echo = false, env = undefined, mask = [], timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ownGroup = process.platform !== 'win32';
    let child;
    try {
      child = spawn(file, args, { cwd, detached: ownGroup, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    let output = '';
    let stdout = '';
    let timedOut = false;
    let killer = null;
    const stop = (signal) => {
      try {
        if (ownGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      callback(value);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      stop('SIGTERM');
      killer = setTimeout(() => stop('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs) : null;
    const keep = (current, chunk) => {
      const next = current + chunk;
      return next.length > ROLLING_CAPTURE_CHARS ? next.slice(-ROLLING_CAPTURE_CHARS) : next;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output = keep(output, chunk);
      stdout = keep(stdout, chunk);
      if (echo) process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output = keep(output, chunk);
      if (echo) process.stderr.write(chunk);
    });
    child.on('error', (error) => finish(reject, error));
    // `close` rather than `exit`: the pipes can still hold the last lines the
    // command wrote — usually the ones that say why it failed — after `exit`.
    child.on('close', (code, signal) => {
      const tail = maskValues(tailOutput(output), mask);
      if (timedOut) {
        finish(reject, new CommandFailure('COMMAND_TIMEOUT', { exitCode: code, output: tail, signal, timeoutMs }));
        return;
      }
      if (code === 0) {
        finish(resolve, { exitCode: 0, output: maskValues(output, mask), stdout: maskValues(stdout, mask) });
        return;
      }
      finish(reject, new CommandFailure('COMMAND_FAILED', { exitCode: code, output: tail, signal }));
    });
  });
}

function indent(text) {
  return String(text).split('\n').map((line) => `  ${line}`).join('\n');
}

function describeDuration(ms) {
  const unit = (value, name) => `${value} ${name}${value === 1 ? '' : 's'}`;
  const pair = (major, minor) => [major, minor].filter(Boolean).join(' ');
  if (ms < 1_000) return `${ms} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return unit(seconds, 'second');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return pair(unit(minutes, 'minute'), seconds % 60 ? unit(seconds % 60, 'second') : '');
  const hours = Math.floor(minutes / 60);
  return pair(unit(hours, 'hour'), minutes % 60 ? unit(minutes % 60, 'minute') : '');
}

// Lines explaining why a command failed, for a failure response. `what` is the
// caller's own label for the command; the argv is never consulted.
function describeFailure(error, what) {
  if (error instanceof CommandFailure) {
    const lead = error.timedOut
      ? `${what} did not finish within ${describeDuration(error.timeoutMs || 0)} and was stopped.`
      : error.signal
        ? `${what} was stopped by signal ${error.signal}.`
        : `${what} exited with code ${error.exitCode ?? 'unknown'}.`;
    const output = String(error.output || '').trim();
    return [lead, output ? `Last output:\n${indent(output)}` : 'It wrote no output.'];
  }
  if (error?.code === 'ENOENT' && /^spawn /u.test(String(error?.message || ''))) {
    return [`${what} could not start: the program is not installed on this server.`];
  }
  if (error?.code === 'EACCES' && /^spawn /u.test(String(error?.message || ''))) {
    return [`${what} could not start: the agent is not allowed to run it.`];
  }
  return [String(error?.message || `${what} failed.`)];
}

module.exports = {
  CommandFailure,
  KILL_GRACE_MS,
  OUTPUT_TAIL_CHARS,
  OUTPUT_TAIL_LINES,
  REDACTION_MARKER,
  ROLLING_CAPTURE_CHARS,
  describeDuration,
  describeFailure,
  indent,
  maskValues,
  runCommand,
  tailOutput,
};
