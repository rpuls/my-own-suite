// Marketing screenshot capture primitives.
//
// The E2E flows call these at moments the public site wants pictures of
// (see docs on the pipeline in scripts/README.md). Captures are strictly
// best-effort: a failed screenshot logs a warning and never fails the
// regression, because the suite's job is validation and the pictures are
// a by-product. Stable filenames are the contract — the harvest script
// (npm run screenshots:update) copies <name>.png into
// site/src/assets/screenshots/ and the site picks them up by name.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');

export function screenshotsDir() {
  return process.env.MOS_E2E_SCREENSHOTS_DIR || defaultDir;
}

async function persist(name, take) {
  const filePath = path.join(screenshotsDir(), `${name}.png`);
  try {
    fs.mkdirSync(screenshotsDir(), { recursive: true });
    await take(filePath);
    console.log(`[screenshots] captured ${name}.png`);
    return true;
  } catch (error) {
    console.warn(`[screenshots] skipped ${name}.png: ${error.message}`);
    return false;
  }
}

export async function capturePageShot(page, name, { fullPage = false } = {}) {
  return persist(name, async (filePath) => {
    // Let hover states, dialog transitions, and image loads settle so the
    // capture looks like a resting screen, not a mid-animation frame.
    await page.waitForTimeout(600);
    await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage, path: filePath });
  });
}

export async function captureElementShot(locator, name) {
  return persist(name, async (filePath) => {
    await locator.scrollIntoViewIfNeeded();
    await locator.page().waitForTimeout(600);
    await locator.screenshot({ animations: 'disabled', caret: 'hide', path: filePath });
  });
}
