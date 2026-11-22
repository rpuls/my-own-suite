'use strict';

// On a server, package files reach `docker build` as 0640 root, and COPY keeps
// that mode. A Dockerfile that then drops root must make what it copied readable,
// or the service cannot open its own files (Paperless-ngx's MCP service, 0.4.0).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appsDir = path.resolve(__dirname, '..', '..', 'apps');
const READABLE = /chmod\s+(?:-R\s+)?(?:0?[0-7]?[4-7][4-7]|[ugoa]*\+r|a\+r|o\+r)\b/u;

function unreadableCopies(dockerfile) {
  const lines = dockerfile.split(/\r?\n/u);
  const dropsRoot = lines.some((line) => /^USER\s+(?!0\b|root\b)\S+/u.test(line));
  if (!dropsRoot) return [];
  const copies = lines.map((line) => /^COPY\s+(?!--chmod)(?:--\S+\s+)*\S+\s+(\S+)/u.exec(line)?.[1]).filter(Boolean);
  const runs = lines.filter((line) => /^RUN\b|^\s*&&/u.test(line)).join('\n');
  return copies.filter((target) => !runs.split('\n').some((line) => line.includes(target) && READABLE.test(line)));
}

test('a Dockerfile that drops root makes every file it copies readable', () => {
  const offenders = [];
  for (const app of fs.readdirSync(appsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const dir = path.join(appsDir, app.name);
    for (const file of fs.readdirSync(dir).filter((name) => /^Dockerfile(?:\..+)?$/u.test(name))) {
      for (const target of unreadableCopies(fs.readFileSync(path.join(dir, file), 'utf8'))) offenders.push(`apps/${app.name}/${file}: ${target}`);
    }
  }
  assert.deepEqual(offenders, [], `chmod these readable after COPY, before USER:\n${offenders.join('\n')}`);
});

test('the check finds a copy left at its build-context mode', () => {
  assert.deepEqual(unreadableCopies('FROM x\nCOPY a.py /opt/a.py\nUSER 1000:1000\n'), ['/opt/a.py']);
  assert.deepEqual(unreadableCopies('FROM x\nCOPY a.py /opt/a.py\nRUN chmod 0644 /opt/a.py\nUSER 1000:1000\n'), []);
  assert.deepEqual(unreadableCopies('FROM x\nCOPY --chmod=0644 a.py /opt/a.py\nUSER app\n'), []);
  assert.deepEqual(unreadableCopies('FROM x\nCOPY a.sh /a.sh\nRUN chmod +x /a.sh\n'), []);
});
