import fs from 'node:fs';
import path from 'node:path';

import { chromium } from '@playwright/test';

let renderer = null;

// Its own headless browser: page.pdf() exists only headless, and a run started
// with --headed should still be able to make its files.
async function renderPage(html, viewport) {
  renderer ||= await chromium.launch();
  const page = await renderer.newPage({ viewport });
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

function target(ctx, appId, file) {
  const full = path.join(ctx.resultsDir, 'fixtures', appId, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  return full;
}

// Test files an app journey uploads, drawn at run time so nothing binary or
// licensed is committed, and different on every run so no app can deduplicate
// them against an earlier one.
export function fixtureMaker(ctx, appId) {
  return {
    async pdf(name, html) {
      const file = target(ctx, appId, `${name}.pdf`);
      const page = await renderPage(html, { height: 1123, width: 794 });
      await page.pdf({ format: 'A4', path: file, printBackground: true });
      await page.close();
      return file;
    },
    async png(name, html, { height = 800, width = 1200 } = {}) {
      const file = target(ctx, appId, `${name}.png`);
      const page = await renderPage(html, { height, width });
      await page.screenshot({ path: file });
      await page.close();
      return file;
    },
    text(name, content) {
      const file = target(ctx, appId, name);
      fs.writeFileSync(file, content);
      return file;
    },
  };
}

export async function closeFixtureRenderer() {
  await renderer?.close();
  renderer = null;
}
