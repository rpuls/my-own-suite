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
    audio(name, { seconds = 4 } = {}) {
      const rate = 22050;
      const samples = Math.round(rate * seconds);
      const wav = Buffer.alloc(44 + samples * 2);
      wav.write('RIFF');
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(rate, 24);
      wav.writeUInt32LE(rate * 2, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write('data', 36);
      wav.writeUInt32LE(samples * 2, 40);
      for (let i = 0; i < samples; i += 1) wav.writeInt16LE(Math.round(1000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
      const file = target(ctx, appId, `${name}.wav`);
      fs.writeFileSync(file, wav);
      return file;
    },
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
    // A short WebM film recorded from a canvas in the browser, so a media app has
    // something real to identify and play without a video file in the repository.
    async video(name, { label = name, seconds = 4 } = {}) {
      const file = target(ctx, appId, `${name}.webm`);
      const page = await renderPage('<canvas height="240" width="426"></canvas>', { height: 240, width: 426 });
      const base64 = await page.evaluate(async ({ label: text, seconds: duration }) => {
        const canvas = document.querySelector('canvas');
        const draw = canvas.getContext('2d');
        const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
        const chunks = [];
        recorder.ondataavailable = (event) => chunks.push(event.data);
        const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
        recorder.start();
        const started = performance.now();
        while (performance.now() - started < duration * 1000) {
          const elapsed = (performance.now() - started) / 1000;
          draw.fillStyle = `hsl(${Math.round(elapsed * 90) % 360} 60% 40%)`;
          draw.fillRect(0, 0, canvas.width, canvas.height);
          draw.fillStyle = '#fff';
          draw.font = '28px sans-serif';
          draw.fillText(`${text} ${elapsed.toFixed(1)}s`, 20, 130);
          await new Promise((resolve) => { requestAnimationFrame(resolve); });
        }
        recorder.stop();
        await stopped;
        const bytes = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
      }, { label, seconds });
      await page.close();
      fs.writeFileSync(file, Buffer.from(base64, 'base64'));
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
