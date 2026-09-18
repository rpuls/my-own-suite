#!/usr/bin/env node
'use strict';

// The one MOS process that keeps running while the vault is locked.
//
// It listens twice. On a unix socket for Suite Manager, which asks what the
// vault is doing so the settings screen can say it in the owner's words. And on
// a loopback port for Caddy, which routes the locked page's form here — that
// side is reachable by anyone who can reach the server, and it is meant to be:
// the recovery key is the authentication, and a machine whose owner cannot
// reach the unlock form is a machine with no way back.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const { STATES, TPM_MODES, VaultAgentCore } = require('./agent-core.cjs');
const { SystemVaultAdapter } = require('./system-adapter.cjs');
const { renderLockedPage } = require('./page.cjs');
const { normalize } = require('../backup/recovery-key.cjs');
const { vaultAsksForPassword, vaultChipNeedsRepair } = require('../../shared/vault-contract.cjs');
const {
  UNAVAILABLE_PAGE_FILENAME,
  UNAVAILABLE_PAGE_ROOT,
  VAULT_AGENT_PORT,
  VAULT_UNLOCK_ROUTE,
  renderUnavailablePage,
} = require('../../infrastructure/control-plane-runtime.cjs');

const socketPath = process.env.MOS_VAULT_AGENT_SOCKET || '/run/mos-vault-agent/agent.sock';
const port = Number(process.env.MOS_VAULT_AGENT_PORT || VAULT_AGENT_PORT);
const statusPagePath = path.join(UNAVAILABLE_PAGE_ROOT, UNAVAILABLE_PAGE_FILENAME);

// Each attempt costs an Argon2 hash, which is deliberately expensive in both
// time and memory. Without a floor between them, the form an owner needs is also
// a way for anyone who can reach the machine to keep its memory busy.
const ATTEMPT_FLOOR_MS = 1_000;
// The floor is charged per source rather than to the machine, so somebody
// hammering the form from outside cannot make the owner wait a second for every
// one of their own tries. Attempts are still run one at a time — two
// `cryptsetup` processes must never open the same device at once — so a busy
// queue is still a slower answer; what this removes is a delay one source can
// impose on another. Sources are forgotten once they go quiet, which also keeps
// the map from growing with every address that has ever knocked.
const ATTEMPT_MEMORY_MS = 60_000;

const adapter = new SystemVaultAdapter();
const core = new VaultAgentCore(adapter);

let attemptChain = Promise.resolve();
const lastAttemptBySource = new Map();

function log(message) {
  process.stdout.write(`[mos-vault-agent] ${message}\n`);
}

/**
 * Keeps the page Caddy serves for every control-plane outage truthful.
 *
 * Caddy answers those errors from one file, and which page belongs in it depends
 * on why MOS is down: a locked vault needs the form, and everything else — an
 * update, a restore — needs the busy page that was always there. Writing the
 * file is how a locked machine gets its screen without the error handler having
 * to reach an upstream that may itself be starting.
 */
async function syncStatusPage(status) {
  const html = status.state === STATES.LOCKED
    ? renderLockedPage({ askPassword: pageAsksForPassword(status), sentence: null })
    : renderUnavailablePage();
  try {
    await fsp.mkdir(UNAVAILABLE_PAGE_ROOT, { recursive: true });
    await fsp.writeFile(statusPagePath, html, 'utf8');
  } catch (error) {
    log(`could not write the status page: ${error?.message || 'unknown error'}`);
  }
}

// Whether the form should offer the password field right now, which is a
// narrower question than the mode: a chip slot waiting for repair takes no
// password, and offering one would only spend the chip's tries on a secret it
// does not hold.
function pageAsksForPassword(status) {
  return vaultAsksForPassword(status) && !vaultChipNeedsRepair(status);
}

// The sentence the page shows above the form. Waiting for a password is the
// normal state of a mode-`password` machine and the page's own copy already
// says so, so that one is not repeated as a notice.
function pageSentence(status) {
  return status.reason === 'needs-password' ? null : status.sentence || null;
}

// Who is asking, as far as this process can tell. The page listener is bound to
// loopback and only Caddy can reach it; Caddy appends the address it saw as the
// last entry of X-Forwarded-For, so that entry is taken rather than the first,
// which a client can supply itself. It is a fairness key for the floor below
// and nothing else — no decision about opening the disk is made from it.
function sourceOf(request) {
  const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',').pop().trim();
  return forwarded || request?.socket?.remoteAddress || 'unknown';
}

// Serialised, and never faster than that source's floor. The chain matters as
// much as the delay: two browser tabs submitting at once must not have two
// `cryptsetup` processes opening the same device.
function attempt(work, source = 'local') {
  const next = attemptChain.then(async () => {
    const wait = Math.max(0, ATTEMPT_FLOOR_MS - (Date.now() - (lastAttemptBySource.get(source) || 0)));
    if (wait > 0) await new Promise((resolve) => { setTimeout(resolve, wait); });
    try {
      return await work();
    } finally {
      const now = Date.now();
      lastAttemptBySource.set(source, now);
      for (const [seen, at] of lastAttemptBySource) {
        if (now - at > ATTEMPT_MEMORY_MS) lastAttemptBySource.delete(seen);
      }
    }
  });
  attemptChain = next.then(() => undefined, () => undefined);
  return next;
}

/**
 * The whole of unlocking, from whichever of the two secrets someone typed.
 *
 * The suite is started here rather than left to systemd, because the units that
 * hold owner data require the vault and systemd does not start a unit again just
 * because something it required finally succeeded.
 */
async function unlock({ password = null, rawKey = null, source = 'local' }) {
  let key = null;
  if (rawKey !== null) {
    const normalized = normalize(rawKey);
    if (normalized.error) return { error: normalized.error, unlocked: false };
    key = normalized.key;
  }

  const result = await attempt(() => core.open({ key, pin: password }), source);
  if (!result.opened) return { error: result.sentence, unlocked: false };

  // The typed key is what authorises re-sealing the chip, so it happens now. A
  // re-seal that fails is a machine that asks for the key again next time,
  // never a machine that does not start.
  let resealed = {};
  if (key) {
    resealed = await attempt(() => core.reseal({ key }), source)
      .catch((error) => { log(`could not re-seal the chip after an unlock: ${error?.message || 'unknown error'}`); return {}; });
  }

  await syncStatusPage({ state: STATES.UNLOCKED });
  // Not awaited: starting dockerd and every app takes minutes, and the owner is
  // looking at a form that has to answer now.
  adapter.startDependents()
    .then((units) => log(`started after unlock: ${units.join(', ') || 'nothing'}`))
    .catch((startError) => log(`could not start the suite after unlock: ${startError?.message || 'unknown error'}`));
  return { repairPending: Boolean(resealed.repairPending), resealed: Boolean(resealed.resealed), unlocked: true };
}

async function readJsonBody(request, limit = 16 * 1024) {
  const raw = await readBody(request, limit);
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function readBody(request, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > limit) reject(new Error('BODY_TOO_LARGE'));
    });
    request.on('end', () => resolve(raw));
    request.on('error', reject);
  });
}

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function respondHtml(response, statusCode, html) {
  response.writeHead(statusCode, { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' });
  response.end(html);
}

// Suite Manager's side. It never unlocks anything — an owner who can sign in to
// Suite Manager is looking at an unlocked machine by definition — so this is
// status only.
const apiServer = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/v1/status') {
    try {
      // Suite Manager asks here right after the owner acknowledges the key, so
      // this is where the escrowed copy is discarded.
      await core.settleHandover();
      respondJson(response, 200, await core.status());
    } catch (error) {
      respondJson(response, 500, { code: error?.code || 'VAULT_STATUS_FAILED', message: error?.message || 'The vault could not be read.' });
    }
    return;
  }
  // Called by the backup agent at the end of a takeover restore, before it
  // writes the adopted key to its own key file. Only over the unix socket,
  // never from the page: the page is reachable by anyone who can reach the
  // server, and this is the one operation that changes what opens the disk.
  if (request.method === 'POST' && url.pathname === '/v1/vault/rekey') {
    try {
      const body = await readJsonBody(request);
      const { error, key } = normalize(body.nextKey);
      if (error) {
        respondJson(response, 400, { code: 'VAULT_REKEY_MISTYPED', message: error });
        return;
      }
      respondJson(response, 200, await attempt(() => core.rekey({ nextKey: key })));
    } catch (error) {
      respondJson(response, 500, {
        code: error?.code || 'VAULT_REKEY_FAILED',
        details: error?.details || [],
        message: error?.message || 'The vault key could not be changed.',
      });
    }
    return;
  }

  // The chip's side of three things Suite Manager owns: the startup-protection
  // switch, a password change the chip has to follow, and repairing a chip that
  // was left not knowing it. Over the unix socket only, like the rekey above,
  // because it changes what opens this disk — and with `mode: 'current'` for
  // the callers that are not choosing a mode and must not change one by
  // accident.
  if (request.method === 'POST' && url.pathname === '/v1/vault/tpm') {
    try {
      const body = await readJsonBody(request);
      const mode = body.mode === undefined ? 'current' : String(body.mode);
      if (!['current', TPM_MODES.AUTOMATIC, TPM_MODES.PASSWORD].includes(mode)) {
        respondJson(response, 400, { code: 'VAULT_TPM_MODE_UNKNOWN', message: 'That is not a way this machine can start.' });
        return;
      }
      const pin = body.pin === undefined || body.pin === null ? null : String(body.pin);
      respondJson(response, 200, await attempt(() => core.enrollChip({ mode, pin })));
    } catch (error) {
      respondJson(response, 500, {
        code: error?.code || 'VAULT_TPM_ENROLL_FAILED',
        details: error?.details || [],
        message: error?.message || 'This machine\'s security chip could not be taught what it needs to know.',
      });
    }
    return;
  }

  respondJson(response, 404, { code: 'NOT_FOUND', message: 'Unknown vault agent route.' });
});

const pageServer = http.createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const isUnlockPath = url.pathname === VAULT_UNLOCK_ROUTE || url.pathname === '/';

  const status = await core.status().catch(() => ({ state: STATES.LOCKED }));
  const askPassword = pageAsksForPassword(status);
  const sentence = pageSentence(status);

  if (!isUnlockPath) {
    respondHtml(response, 404, renderLockedPage({ askPassword, sentence: null }));
    return;
  }

  // A machine with no vault is not locked, it is merely down — an update, a
  // restore, a crash — and the busy page already explains that. Saying "locked"
  // here would send an owner looking for a key that opens nothing.
  if (status.state === STATES.ABSENT || status.state === STATES.UNSUPPORTED) {
    respondHtml(response, 200, renderUnavailablePage());
    return;
  }

  if (request.method !== 'POST') {
    if (status.state === STATES.UNLOCKED) {
      respondHtml(response, 200, renderLockedPage({ unlocked: true }));
      return;
    }
    respondHtml(response, 200, renderLockedPage({ askPassword, sentence }));
    return;
  }

  let raw = '';
  try {
    raw = await readBody(request);
  } catch {
    respondHtml(response, 413, renderLockedPage({ askPassword, error: 'That was longer than either of the two things this page accepts.', sentence }));
    return;
  }

  // An empty field never becomes an attempt: the chip's lockout is the
  // protection here, and a blank form must not spend one of its tries.
  const submitted = new URLSearchParams(raw);
  const password = submitted.get('password') || '';
  const rawKey = submitted.get('recoveryKey') || '';
  if (!password && !rawKey) {
    respondHtml(response, 200, renderLockedPage({
      askPassword,
      error: askPassword ? 'Enter your password, or your recovery key.' : 'Enter your recovery key.',
      sentence,
    }));
    return;
  }

  const source = sourceOf(request);
  const result = await unlock(rawKey ? { rawKey, source } : { password, source }).catch((error) => ({
    error: error?.message || 'The vault could not be opened.',
    unlocked: false,
  }));

  if (result.unlocked) {
    log(`unlocked with the ${rawKey ? 'recovery key' : 'owner password'}`);
    respondHtml(response, 200, renderLockedPage({
      repairPending: result.repairPending,
      resealed: result.resealed,
      unlocked: true,
    }));
    return;
  }
  log('an unlock attempt was refused');
  respondHtml(response, 200, renderLockedPage({ askPassword, error: result.error, sentence }));
});

async function main() {
  await fsp.mkdir(path.dirname(socketPath), { recursive: true });
  if (fs.existsSync(socketPath)) await fsp.rm(socketPath, { force: true });

  await core.settleHandover().catch((error) => log(`could not settle the key handover: ${error?.message || 'unknown error'}`));
  const status = await core.status().catch(() => ({ state: STATES.LOCKED }));
  await syncStatusPage(status);
  log(`vault is ${status.state}${status.reason ? ` (${status.reason})` : ''}${status.handover === 'pending' ? ', recovery key not yet handed over' : ''}`);

  apiServer.listen(socketPath, () => fs.chmodSync(socketPath, 0o660));
  pageServer.listen(port, '127.0.0.1', () => log(`listening for the unlock form on 127.0.0.1:${port}`));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    apiServer.close();
    pageServer.close();
    process.exit(0);
  });
}

main().catch((error) => {
  log(`failed to start: ${error?.message || 'unknown error'}`);
  process.exit(1);
});
