import { expect, test } from '@playwright/test';

import { inspectLogSurface } from './log-surface-rules.mjs';

// Playwright half of the log-surface inspection. The rules live in
// log-surface-rules.mjs so they can be unit tested without a browser or a host.
export async function assertLogSurface(bundle, env) {
  const { failures, inventory } = inspectLogSurface(bundle, env);

  // Attached rather than asserted. A committed baseline of third-party log
  // wording would go stale on every package bump, and a test everyone overrides
  // is worse than no test — so drift is reported for a human to compare between
  // runs, and only the hard rules fail the suite. Freezing this into a baseline
  // is worth doing once the real churn rate is known.
  await test.info().attach('log-surface-inventory.txt', { body: inventory, contentType: 'text/plain' });

  const detail = failures.map((failure) => `  - ${failure}`).join('\n');
  expect(failures, `The diagnostics bundle failed log-surface inspection:\n${detail}\n`).toEqual([]);
}
