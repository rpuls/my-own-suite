#!/usr/bin/env node
'use strict';

// A literal NUL byte makes ripgrep, and every agent search built on it, treat the
// whole file as binary and silently skip it. Write `\u0000` where a string needs one.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BINARY_EXTENSIONS = new Set(['.gif', '.ico', '.jpeg', '.jpg', '.pdf', '.png', '.ttf', '.webp', '.woff', '.woff2']);

const repoRoot = path.resolve(__dirname, '..');

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function nulLineNumbers(file) {
  const fullPath = path.join(repoRoot, file);
  if (!fs.lstatSync(fullPath, { throwIfNoEntry: false })?.isFile()) return [];
  return fs.readFileSync(fullPath, 'utf8')
    .split('\n')
    .flatMap((line, index) => (line.includes('\0') ? [index + 1] : []));
}

const offenders = trackedFiles()
  .filter((file) => !BINARY_EXTENSIONS.has(path.extname(file).toLowerCase()))
  .flatMap((file) => nulLineNumbers(file).map((line) => `${file}:${line}`));

if (offenders.length) {
  for (const location of offenders) console.error(`${location}: literal NUL byte; write \\u0000 instead`);
  process.exit(1);
}
console.log('No literal NUL bytes in tracked text files.');
