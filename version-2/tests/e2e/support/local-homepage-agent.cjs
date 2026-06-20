#!/usr/bin/env node

const fsp = require('node:fs/promises');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { HomepageConfigError } = require('../../../shared/homepage-contract.cjs');
const { HomepageAgentCore } = require('../../../system-agents/homepage/agent-core.cjs');

const socketPath = process.env.MOS_V2_HOMEPAGE_AGENT_SOCKET;
const configRoot = process.env.MOS_V2_HOMEPAGE_CONFIG_ROOT;

class LocalAdapter {
  readHomepageFile(file) { return fsp.readFile(path.join(configRoot, file), 'utf8'); }
  async applyTransaction({ files }) {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(configRoot, file);
      const temporary = `${target}.tmp-${process.pid}`;
      await fsp.writeFile(temporary, content);
      await fsp.rename(temporary, target);
    }
    return { steps: ['staged', 'validated', 'written', 'homepage-restarted'] };
  }
}

const core = new HomepageAgentCore(new LocalAdapter());
const routes = new Map([
  ['GET /v1/status', () => core.status()],
  ['POST /v1/homepage/read', (body) => core.read(body)],
  ['POST /v1/homepage/validate', (body) => core.validate(body)],
  ['POST /v1/homepage/apply', (body) => core.apply(body)],
  ['POST /v1/homepage/add-link', (body) => core.add(body, false)],
  ['POST /v1/homepage/add-home-service', (body) => core.add(body, true)],
]);

function body(request) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (error) { reject(error); } });
  });
}

const server = http.createServer(async (request, response) => {
  try {
    const handler = routes.get(`${request.method} ${new URL(request.url, 'http://localhost').pathname}`);
    if (!handler) { response.writeHead(404); response.end(); return; }
    const result = await handler(request.method === 'GET' ? {} : await body(request));
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(error instanceof HomepageConfigError ? error.statusCode : 500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: error.code, details: error.details, error: error.message }));
  }
});

if (!socketPath) throw new Error('MOS_V2_HOMEPAGE_AGENT_SOCKET is required.');
if (process.platform !== 'win32') { fs.mkdirSync(path.dirname(socketPath), { recursive: true }); fs.rmSync(socketPath, { force: true }); }
server.listen(socketPath, () => process.stdout.write('ready\n'));
function shutdown() { server.close(() => process.exit(0)); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
