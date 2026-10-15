import fs from 'node:fs';
import path from 'node:path';

// An app screenshot, named by the app module so the same screen taken in a later
// step pairs up with this one in the compare report.
export async function takeShot(ctx, appId, page, name, { fullPage = false, mask = [] } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error(`Screenshot name "${name}" must be lowercase letters, digits and dashes.`);
  const stepDir = `${String(ctx.stepIndex + 1).padStart(2, '0')}-${ctx.step.token.replace(/[^a-z0-9-]+/giu, '-')}`;
  const file = path.join(ctx.resultsDir, 'shots', appId, stepDir, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
  // A hovered button would show up as a change between two otherwise identical screens.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(800);
  await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage, mask, path: file });
  ctx.shots.push({ app: appId, file: path.relative(path.dirname(ctx.resultsDir), file).replaceAll('\\', '/'), name, runId: ctx.runId, step: ctx.step.token, stepIndex: ctx.stepIndex });
  return file;
}
