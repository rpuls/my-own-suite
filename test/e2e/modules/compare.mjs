import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { e2eRoot } from '../support/env.mjs';

const resultsRoot = path.join(e2eRoot, 'results');

// The first and the last time each app screen was taken, when those came from
// different steps: the shape of "before the update" and "after it".
export function pairShots(shots) {
  const groups = new Map();
  for (const shot of shots) {
    const key = `${shot.app}/${shot.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(shot);
  }
  return [...groups.values()]
    .filter((list) => new Set(list.map((shot) => `${shot.runId}#${shot.stepIndex}`)).size > 1)
    .map((list) => ({ after: list.at(-1), app: list[0].app, before: list[0], name: list[0].name }));
}

// Runs in the page: a pixel counts as changed when any channel moved by more than
// the threshold, which ignores anti-aliasing but not a moved word.
async function diffInBrowser({ after, before, threshold }) {
  const load = (src) => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });
  const [left, right] = await Promise.all([load(before), load(after)]);
  const width = Math.max(left.width, right.width);
  const height = Math.max(left.height, right.height);
  const pixels = (image) => {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height).data;
  };
  const a = pixels(left);
  const b = pixels(right);
  const out = new OffscreenCanvas(width, height);
  const context = out.getContext('2d');
  const diff = context.createImageData(width, height);
  let changed = 0;
  for (let index = 0; index < a.length; index += 4) {
    const delta = Math.max(Math.abs(a[index] - b[index]), Math.abs(a[index + 1] - b[index + 1]), Math.abs(a[index + 2] - b[index + 2]));
    if (delta > threshold) {
      changed += 1;
      diff.data.set([230, 30, 60, 255], index);
    } else {
      const grey = 255 - (255 - (b[index] + b[index + 1] + b[index + 2]) / 3) * 0.25;
      diff.data.set([grey, grey, grey, 255], index);
    }
  }
  context.putImageData(diff, 0, 0);
  const blob = await out.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return { changedRatio: changed / (width * height), diffPng: btoa(binary), sizeChanged: left.width !== right.width || left.height !== right.height };
}

function dataUrl(file) {
  return `data:image/png;base64,${fs.readFileSync(path.join(resultsRoot, file)).toString('base64')}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/gu, (char) => ({ '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
}

function percent(ratio) {
  return ratio < 0.0005 ? 'unchanged' : `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}% changed`;
}

function renderReport(ctx, rows, dir) {
  const rel = (file) => path.relative(dir, path.join(resultsRoot, file)).replaceAll('\\', '/');
  const sections = rows.map((row) => `
  <section>
    <h2>${escapeHtml(row.app)} · ${escapeHtml(row.name)} <span class="${row.changedRatio < 0.0005 ? 'same' : 'changed'}">${percent(row.changedRatio)}${row.sizeChanged ? ', size changed' : ''}</span></h2>
    <div class="row">
      <figure><img src="${rel(row.before.file)}" alt=""><figcaption>Before · ${escapeHtml(row.before.step)}${row.before.runId !== ctx.runId ? ` (${escapeHtml(row.before.runId)})` : ''}</figcaption></figure>
      <figure><img src="${rel(row.after.file)}" alt=""><figcaption>After · ${escapeHtml(row.after.step)}</figcaption></figure>
      <figure><img src="${escapeHtml(row.diffFile)}" alt=""><figcaption>Changed pixels</figcaption></figure>
    </div>
  </section>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>MOS before and after</title>
<style>
  body { font: 14px/1.4 system-ui, sans-serif; margin: 24px; background: #f6f7f9; color: #17202a; }
  h1 { font-size: 20px; margin: 0 0 4px; } p { margin: 0 0 20px; color: #4a5562; }
  section { background: #fff; border: 1px solid #dfe3e8; border-radius: 10px; padding: 14px; margin-bottom: 16px; }
  h2 { font-size: 15px; margin: 0 0 10px; } h2 span { font-weight: 500; margin-left: 8px; }
  .changed { color: #b4233c; } .same { color: #2f7d4a; }
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  figure { margin: 0; } img { width: 100%; border: 1px solid #dfe3e8; border-radius: 6px; display: block; }
  figcaption { font-size: 12px; color: #4a5562; margin-top: 4px; }
</style></head>
<body><h1>Before and after</h1><p>${escapeHtml(ctx.plan.label || ctx.runId)} · ${rows.length} screen${rows.length === 1 ? '' : 's'} · ${rows.filter((row) => row.changedRatio >= 0.0005).length} changed</p>
${sections}
</body></html>
`;
}

// A report for a person to look at, not a gate: an update is allowed to change
// what an app looks like, so differences are shown, never failed.
export async function compare(ctx) {
  const pairs = pairShots(ctx.shots);
  if (!pairs.length) throw new Error('compare found no app screen taken in two different steps. Take the same shot(name) in an app journey and in its verify, or carry an earlier run in with --continue.');
  const dir = path.join(ctx.resultsDir, 'compare');
  fs.mkdirSync(dir, { recursive: true });
  const page = await ctx.page.context().newPage();
  try {
    await page.setContent('<!doctype html><title>diff</title>');
    const rows = [];
    for (const pair of pairs) {
      const result = await page.evaluate(diffInBrowser, { after: dataUrl(pair.after.file), before: dataUrl(pair.before.file), threshold: 40 });
      const diffFile = `${pair.app}-${pair.name}-diff.png`;
      fs.writeFileSync(path.join(dir, diffFile), Buffer.from(result.diffPng, 'base64'));
      rows.push({ ...pair, changedRatio: result.changedRatio, diffFile, sizeChanged: result.sizeChanged });
    }
    const htmlFile = path.join(dir, 'compare.html');
    fs.writeFileSync(htmlFile, renderReport(ctx, rows, dir));
    await page.setViewportSize({ height: 900, width: 1440 });
    await page.goto(pathToFileURL(htmlFile).href);
    await page.screenshot({ fullPage: true, path: path.join(dir, 'compare.png') });
    const summary = rows.map((row) => ({ after: row.after.file, app: row.app, before: row.before.file, changedRatio: Number(row.changedRatio.toFixed(5)), name: row.name, sizeChanged: row.sizeChanged }));
    fs.writeFileSync(path.join(dir, 'compare.json'), `${JSON.stringify(summary, null, 2)}\n`);
    for (const row of rows) console.log(`[compare] ${row.app}/${row.name}: ${percent(row.changedRatio)}`);
  } finally {
    await page.close();
  }
}
