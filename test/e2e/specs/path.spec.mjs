import fs from 'node:fs';
import path from 'node:path';

import { test } from '@playwright/test';

import { MODULES } from '../modules/index.mjs';
import { STEPS } from '../steps.mjs';
import { createContext, resultsDirFor } from '../support/context.mjs';
import { closeFixtureRenderer } from '../support/fixtures.mjs';
import { finishNetworkCapture, startNetworkCapture, suiteBase } from '../support/network.mjs';

const runId = process.env.MOS_E2E_RUN_ID;
const planFile = runId ? path.join(resultsDirFor(runId), 'plan.json') : null;
const plan = planFile && fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : null;

test(plan?.label || 'MOS path', async ({ browser, page }) => {
  if (!plan) throw new Error('Start runs with `npm run e2e -- <path>`, which resolves the path this spec runs.');
  test.setTimeout((plan.budgetMinutes + 15) * 60 * 1000);
  const ctx = createContext({ browser, page, plan, runId });
  try {
    if (plan.steps.some((step) => step.name === 'network')) ctx.network = await startNetworkCapture(ctx);
    for (const [index, step] of plan.steps.entries()) {
      ctx.stepIndex = index;
      ctx.step = step;
      ctx.timeline[index] = { arg: step.arg, index, name: step.name, start: Date.now() / 1000, token: step.token };
      try {
        await test.step(step.token, () => MODULES[step.name](ctx, step.arg), { timeout: STEPS[step.name].budgetMinutes * 60 * 1000 });
      } finally {
        ctx.timeline[index].end = Date.now() / 1000;
        ctx.network?.suites.add(suiteBase(ctx.homeUrl));
      }
    }
  } finally {
    ctx.save();
    if (ctx.network) await finishNetworkCapture(ctx).catch((error) => console.log(`[network] the final report failed: ${error.message}`));
    await closeFixtureRenderer();
  }
});
