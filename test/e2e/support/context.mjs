import fs from 'node:fs';
import path from 'node:path';

import { e2eRoot, loadEnv } from './env.mjs';

export function resultsDirFor(runId) {
  return path.join(e2eRoot, 'results', runId);
}

function readCarriedState(runId) {
  const file = path.join(resultsDirFor(runId), 'state.json');
  if (!fs.existsSync(file)) throw new Error(`--continue ${runId}: that run left no state.json.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// What one step leaves for the next: the address in use, each app's own data,
// the backups made, and the screenshots taken. Saved as state.json so a later
// run can carry on from it with --continue.
export function createContext({ browser, page, plan, runId }) {
  const env = loadEnv();
  const carried = plan.continueRun ? readCarriedState(plan.continueRun) : {};
  const resultsDir = resultsDirFor(runId);
  const ctx = {
    appState: carried.appState || {},
    backups: carried.backups || [],
    browser,
    env,
    homeUrl: carried.homeUrl || env.baseURL,
    homepageCheckpoint: carried.homepageCheckpoint || null,
    page,
    plan,
    recoveryKey: carried.recoveryKey || null,
    resultsDir,
    runId,
    shots: (carried.shots || []).map((shot) => ({ ...shot, carried: true })),
    step: null,
    stepIndex: -1,

    state(appId) {
      ctx.appState[appId] ||= {};
      return ctx.appState[appId];
    },

    url(pathname = '/') {
      return new URL(pathname, `${ctx.homeUrl}/`).toString();
    },

    save() {
      const { appState, backups, homeUrl, homepageCheckpoint, recoveryKey, shots } = ctx;
      fs.mkdirSync(resultsDir, { recursive: true });
      fs.writeFileSync(path.join(resultsDir, 'state.json'), `${JSON.stringify({ appState, backups, homeUrl, homepageCheckpoint, recoveryKey, shots }, null, 2)}\n`);
    },
  };
  return ctx;
}
