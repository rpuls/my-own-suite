#!/usr/bin/env node
'use strict';

// Did the suite come back after Ubuntu patched the host?
//
// This cannot stop a bad patch. It exists so that the failure is not silent and
// is not misattributed to an app: MOS has no telemetry, by promise, so it can
// never learn from the fleet that a patch is breaking servers. What it can do is
// make one owner's server able to say what happened, in a file the Updates
// screen and the diagnostics bundle both read.
//
// The checks are the ones MOS already has — the same units the diagnostics agent
// collects — rather than a second definition of healthy that could drift from
// the first.

const fs = require('node:fs');
const path = require('node:path');

const { MOS_UNITS } = require('../diagnostics/agent-core.cjs');
const { SystemDiagnosticsAdapter } = require('../diagnostics/system-adapter.cjs');
const { healthStatePath } = require('../../infrastructure/host-patching.cjs');

const stateRoot = process.env.MOS_STATE_ROOT || '/var/lib/mos';
// Runs at boot, so the first look is at a machine whose units are still coming
// up. A verdict taken then would report every restart as a failed patch.
const SETTLE_TIMEOUT_MS = Number(process.env.MOS_POST_PATCH_SETTLE_MS || 300_000);
const SETTLE_INTERVAL_MS = Number(process.env.MOS_POST_PATCH_INTERVAL_MS || 10_000);

// A unit systemd has no file for is not a failure: an install without the lab
// reset agent, or a component this machine never had, would otherwise be
// reported as the patch having broken something that was never there.
function isMissing(state) {
  return state.enabled === 'not-found' || (state.enabled === 'unknown' && state.active === 'inactive');
}

async function inspect(adapter) {
  const failures = [];
  for (const name of MOS_UNITS) {
    let state;
    try {
      state = await adapter.unitState(name);
    } catch (error) {
      failures.push({ active: 'unread', name, reason: error instanceof Error ? error.message : 'could not be read', sub: 'unread' });
      continue;
    }
    if (isMissing(state)) continue;
    if (state.active !== 'active') failures.push({ active: state.active, name, sub: state.sub });
  }
  return failures;
}

function write(state) {
  const file = healthStatePath(stateRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.chmodSync(file, 0o644);
}

async function main() {
  const adapter = new SystemDiagnosticsAdapter();
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let failures = await inspect(adapter);
  while (failures.length && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, SETTLE_INTERVAL_MS); });
    failures = await inspect(adapter);
  }
  write({ at: new Date().toISOString(), failures, ok: failures.length === 0 });
}

main().catch((error) => {
  // A check that could not run is recorded as exactly that. Reporting it as
  // healthy would be the one outcome that makes the file worse than not having
  // it, and reporting it as broken would send an owner looking for a fault in
  // their suite rather than in this.
  try {
    write({ at: new Date().toISOString(), failures: [], ok: null, reason: error instanceof Error ? error.message : 'The post-patch health check could not run.' });
  } catch {}
  process.exit(0);
});
