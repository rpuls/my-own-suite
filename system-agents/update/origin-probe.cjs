'use strict';

// Why a fetch from the update origin failed, with the evidence.
//
// For months the only record of a failed update check was git's last line,
// `could not read Username for 'https://github.com'`, which names the symptom
// — an HTTP 401 that git tried to answer with a login prompt — and nothing of
// the cause. A 401 for a public repository has two possible origins: this
// server sent a login GitHub rejects, or GitHub declined the request itself.
// They are told apart by asking twice. Once with git's own request traced, so
// it shows whether an Authorization header went out and what came back; once
// with a plain request from Node that no git configuration, netrc file or
// credential helper can touch. GitHub's answer says which it was, in its own
// words, and its request id lets GitHub look the request up.
//
// Nothing here can carry a login out: git redacts the Authorization header in
// its trace, and every line is scrubbed again for tokens, URL logins and the
// user name curl names when it authenticates.

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const { CommandFailure, describeDuration, runCommand } = require('../lib/command-output.cjs');

const COMMAND_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_TRACE_LINES = 60;
const MAX_BODY_CHARS = 300;
const REDACTED = '<redacted>';

// Git configuration keys that can add a login, a proxy or a rewritten URL to
// a request without any of it being visible in the command that was run.
const LOGIN_CONFIG_PATTERN = String.raw`^(credential\.|http\.|https\.|url\.|core\.askpass|core\.gitproxy)`;
const PROXY_VARIABLES = ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
// Response headers that say nothing about why a request was refused.
const NOISE_HEADERS = new Set([
  'accept-ranges', 'cache-control', 'connection', 'content-encoding', 'content-length', 'content-security-policy',
  'cross-origin-opener-policy', 'cross-origin-resource-policy', 'etag', 'expires', 'keep-alive', 'last-modified',
  'permissions-policy', 'pragma', 'referrer-policy', 'set-cookie', 'strict-transport-security', 'transfer-encoding',
  'vary', 'x-content-type-options', 'x-frame-options', 'x-xss-protection',
]);
const KEPT_REQUEST_HEADERS = /^(authorization|git-protocol|host|proxy-authorization|user-agent):/iu;
const KEPT_INFO = /trying|connected to|established connection|resolved|ipv[46]:|could not|couldn't|failed|netrc|auth using|proxy|ssl certificate|certificate (problem|verif)|error|timed out|refused|reset|closing connection/iu;

function scrub(text) {
  return String(text)
    .replace(/((?:proxy-)?authorization:\s*)\S.*$/gimu, `$1${REDACTED}`)
    .replace(/:\/\/[^/@\s]+@/gu, `://${REDACTED}@`)
    .replace(/user '[^']*'/gu, `user '${REDACTED}'`)
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{8,}/gu, REDACTED);
}

function firstLine(text) {
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

// What git itself said: the `fatal:`/`error:` lines, which are the whole of
// its explanation on a failed fetch.
function gitWords(error) {
  if (!(error instanceof CommandFailure)) return [firstLine(error?.message)].filter(Boolean);
  const lines = String(error.output || '').split('\n').map((line) => line.trim()).filter((line) => /^(fatal|error|remote):/u.test(line));
  return lines.length ? lines : [firstLine(error.output)].filter(Boolean);
}

async function capture(file, args, { cwd, env } = {}) {
  try {
    const result = await runCommand(file, args, { cwd, env, timeoutMs: COMMAND_TIMEOUT_MS });
    return { error: null, output: result.output, stdout: result.stdout.trim() };
  } catch (error) {
    return { error, output: error instanceof CommandFailure ? error.output : '', stdout: '' };
  }
}

function describeRemote(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = REDACTED;
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return scrub(url);
  }
}

// `git config --show-origin` prints `file:/root/.gitconfig<TAB>key value`.
function loginSources(configOutput) {
  return configOutput.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [origin, rest = ''] = line.split('\t');
    const space = rest.indexOf(' ');
    const key = space < 0 ? rest : rest.slice(0, space);
    const value = space < 0 ? '' : rest.slice(space + 1);
    const shown = /extraheader$/iu.test(key) ? REDACTED : scrub(value);
    return `${scrub(key)} = ${shown} (${origin.replace(/^file:/u, '')})`;
  });
}

function loginFiles() {
  const homes = [...new Set([os.homedir(), process.env.HOME].filter(Boolean))];
  const names = ['.netrc', '.git-credentials', path.join('.config', 'gh', 'hosts.yml')];
  return homes.flatMap((home) => names.map((name) => {
    const file = path.join(home, name);
    try {
      const stat = fs.statSync(file);
      return `${file} present (modified ${stat.mtime.toISOString()})`;
    } catch {
      return `${file} absent`;
    }
  }));
}

function environmentFacts() {
  const home = process.env.HOME ? `HOME=${process.env.HOME}` : `HOME unset (home directory ${os.homedir()})`;
  const proxies = PROXY_VARIABLES.filter((name) => process.env[name]);
  const gitVariables = Object.keys(process.env).filter((name) => /^(GIT_|CURL_|SSL_CERT)/u.test(name));
  return [
    home,
    proxies.length ? `proxy variables set: ${proxies.join(', ')}` : 'no proxy variables set',
    gitVariables.length ? `git-related variables set: ${gitVariables.join(', ')}` : 'no git-related variables set',
  ].join(' · ');
}

// The exchange git had, from a curl trace, reduced to the lines that tell the
// story: where it connected, what it asked for, whether a login went with it,
// and what came back.
function filterCurlTrace(text) {
  const kept = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/u, '');
    const send = line.indexOf('=> Send header: ');
    const recv = line.indexOf('<= Recv header: ');
    const info = line.indexOf('== Info: ');
    let entry = null;
    if (send >= 0) {
      const header = line.slice(send + '=> Send header: '.length).trim();
      if (/^[A-Z]+ \S+ HTTP\//u.test(header) || KEPT_REQUEST_HEADERS.test(header)) entry = header;
    } else if (recv >= 0) {
      const header = line.slice(recv + '<= Recv header: '.length).trim();
      const name = header.slice(0, header.indexOf(':')).toLowerCase();
      if (header && (header.startsWith('HTTP/') || !NOISE_HEADERS.has(name))) entry = header;
    } else if (info >= 0) {
      const detail = line.slice(info + '== Info: '.length).trim();
      if (KEPT_INFO.test(detail)) entry = detail;
    }
    if (entry) kept.push(scrub(entry));
    if (kept.length >= MAX_TRACE_LINES) break;
  }
  return kept;
}

// git's own request, traced to a file so the whole exchange survives even
// though the command fails. `GIT_TRACE_CURL` set to an absolute path writes
// there instead of stderr.
async function traceGitRequest(paths, ref, env) {
  fs.mkdirSync(paths.updateStateDir, { recursive: true });
  const traceFile = path.join(paths.updateStateDir, 'origin-trace.log');
  try { fs.unlinkSync(traceFile); } catch {}
  const result = await capture('git', ['ls-remote', '--heads', 'origin', ref], {
    cwd: paths.repoRoot,
    env: { ...env, GIT_TRACE_CURL: traceFile, GIT_TRACE_CURL_NO_DATA: '1', GIT_TRACE_REDACT: '1' },
  });
  let trace = '';
  try { trace = fs.readFileSync(traceFile, 'utf8'); } catch {}
  try { fs.unlinkSync(traceFile); } catch {}
  return { lines: filterCurlTrace(trace), said: result.error ? gitWords(result.error) : [] };
}

function refsUrl(remote) {
  let parsed;
  try { parsed = new URL(remote); } catch { return null; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, '')}/info/refs`;
  parsed.searchParams.set('service', 'git-upload-pack');
  return parsed;
}

// The same URL git asked for, requested plainly: no git configuration, no
// credential helper, no netrc, nothing but this server's network. GitHub's
// answer to this request is the fact everything else is compared against.
function directRequest(url) {
  return new Promise((resolve) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, { headers: { Accept: '*/*', 'User-Agent': 'mos-update-agent' } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { if (body.length < MAX_BODY_CHARS * 4) body += chunk; });
      response.on('end', () => resolve({
        body: body.replace(/\s+/gu, ' ').trim().slice(0, MAX_BODY_CHARS),
        error: null,
        headers: Object.entries(response.headers)
          .filter(([name]) => !NOISE_HEADERS.has(name))
          .map(([name, value]) => `${name}: ${scrub(Array.isArray(value) ? value.join(', ') : value)}`),
        remoteAddress: response.socket?.remoteAddress || null,
        status: response.statusCode,
        statusMessage: response.statusMessage || '',
      }));
      response.on('error', (error) => resolve({ error: { code: error.code || null, message: error.message } }));
    });
    request.on('error', (error) => resolve({ error: { code: error.code || null, message: error.message } }));
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(Object.assign(new Error(`no answer within ${describeDuration(REQUEST_TIMEOUT_MS)}`), { code: 'ETIMEDOUT' })));
  });
}

function header(direct, name) {
  const prefix = `${name}: `;
  const found = (direct?.headers || []).find((line) => line.toLowerCase().startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

// The one sentence the Updates screen shows, drawn from what the two requests
// established. Everything it asserts is in the details under it.
function conclude({ direct, gitSaid, host, remote, sentLogin }) {
  const gitFatal = gitSaid.find((line) => line.startsWith('fatal:')) || gitSaid[0] || 'git gave no reason';
  if (!direct) return `Fetching from ${remote || 'the update origin'} failed: ${gitFatal}`;
  if (direct.error) return `This server could not reach ${host}: ${direct.error.message}.`;
  const requestId = header(direct, 'x-github-request-id');
  const lookup = requestId ? ` ${host} can look up request ${requestId}.` : '';
  const answer = direct.body ? ` "${direct.body}"` : '';
  if (direct.status === 200 && sentLogin) {
    return `${host} serves this repository to a plain request without a login, but git on this server sends a stored login with every request and ${host} rejects it. Remove or fix that login on the server; the details name where git found it.`;
  }
  if (direct.status === 200) {
    return `${host} serves this repository to a plain request from this server, yet git's own request failed: ${gitFatal}. The two requests are compared in the details.`;
  }
  if (direct.status === 429 || (direct.status === 403 && header(direct, 'x-ratelimit-remaining') === '0')) {
    const retry = header(direct, 'retry-after');
    return `${host} is limiting requests from this server's address (HTTP ${direct.status}${retry ? `, retry after ${retry} seconds` : ''}).${lookup}`;
  }
  if (direct.status >= 300 && direct.status < 400) {
    return `${host} redirects this repository to ${header(direct, 'location') || 'another address'}; the update origin URL is out of date.`;
  }
  if (direct.status === 401 || direct.status === 403 || direct.status === 404) {
    return `${host} answered a plain request from this server for this repository with HTTP ${direct.status}${answer}. No login was sent, so either the repository is not public or ${host} is declining this server.${lookup}`;
  }
  if (direct.status >= 500) {
    return `${host} answered with HTTP ${direct.status} ${direct.statusMessage}: it is having trouble on its side.${lookup}`;
  }
  return `${host} answered a plain request with HTTP ${direct.status}${answer}, and git's request failed: ${gitFatal}.${lookup}`;
}

// Runs after the fetch has failed and been retried. Returns the reason as one
// sentence and the evidence as a list of details, ready for an operation
// diagnostics record.
async function explainFetchFailure(paths, ref, error, { attempts = 1, elapsedMs = 0, env = process.env } = {}) {
  const origin = await capture('git', ['remote', 'get-url', 'origin'], { cwd: paths.repoRoot, env });
  const remoteUrl = origin.stdout || null;
  const remote = describeRemote(remoteUrl);
  const url = remoteUrl ? refsUrl(remoteUrl) : null;
  const version = await capture('git', ['--version'], { cwd: paths.repoRoot, env });
  const config = await capture('git', ['config', '--show-origin', '--get-regexp', LOGIN_CONFIG_PATTERN], { cwd: paths.repoRoot, env });
  const sources = loginSources(config.stdout);
  const trace = await traceGitRequest(paths, ref, env);
  const direct = url ? await directRequest(url) : null;
  const gitSaid = gitWords(error);
  const sentLogin = trace.lines.some((line) => /^authorization:|auth using/iu.test(line));

  const details = [
    `git fetch origin ${ref} failed ${attempts === 1 ? 'once' : `${attempts} times over ${describeDuration(elapsedMs)}`}; git said:\n${gitSaid.map((line) => `  ${scrub(line)}`).join('\n') || '  (nothing)'}`,
    `origin: ${remote || 'not configured'}`,
    `git: ${version.stdout || 'not available'}`,
    `login sources git could use: ${sources.length ? `\n${sources.map((line) => `  ${line}`).join('\n')}` : 'none configured'}`,
    `login files: ${loginFiles().join(' · ')}`,
    `environment: ${environmentFacts()}`,
  ];
  if (direct) {
    const head = `plain request from this server, no login: GET ${url.href}${direct.remoteAddress ? ` (${direct.remoteAddress})` : ''}`;
    details.push(direct.error
      ? `${head}\n  failed: ${direct.error.message}${direct.error.code ? ` (${direct.error.code})` : ''}`
      : `${head}\n  HTTP ${direct.status} ${direct.statusMessage}\n${direct.headers.map((line) => `  ${line}`).join('\n')}${direct.body ? `\n  body: ${direct.body}` : ''}`);
  }
  details.push(`git's own request${sentLogin ? ', which carried a login' : ', which carried no login'}:\n${trace.lines.length ? trace.lines.map((line) => `  ${line}`).join('\n') : `  (no HTTP trace; git said: ${trace.said.join(' / ') || 'nothing'})`}`);

  return {
    details,
    reason: conclude({ direct, gitSaid, host: url?.host || remote || 'the update origin', remote, sentLogin }),
  };
}

module.exports = {
  conclude,
  explainFetchFailure,
  filterCurlTrace,
  loginSources,
  scrub,
};
