'use strict';

const { CodedError } = require('../../../../shared/coded-error.cjs');

const UPSTREAM_PROTOCOL_VERSION = '2025-11-25';
const DEFAULT_TIMEOUT_MS = 50_000;
// A package that signs the owner in once gets the app's token back on every call in this header.
const APP_TOKEN_HEADER = 'X-MOS-App-Token';
// A tool result carrying this in _meta says the app refused that token.
const SIGN_IN_META = 'myownsuite.org/sign-in';

class McpUpstreamError extends CodedError {
  constructor(code, message) {
    super(code, message, { statusCode: 502 });
  }
}

// A Streamable HTTP server may answer one request as an event stream; the
// response is the `data:` message carrying our request id.
function messageFromEventStream(text, id) {
  for (const block of text.split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try {
      const message = JSON.parse(data);
      if (message?.id === id) return message;
    } catch { /* a non-JSON event is not our answer */ }
  }
  return null;
}

let nextId = 1;

async function callMcp({ appToken = null, fetchImpl = fetch, method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, token = null, url }) {
  const id = nextId++;
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': UPSTREAM_PROTOCOL_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (appToken) headers[APP_TOKEN_HEADER] = appToken;
  let response;
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify({ id, jsonrpc: '2.0', method, params }),
      headers,
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new McpUpstreamError('AI_APP_UNREACHABLE', 'The app did not answer.');
  }
  const text = await response.text();
  const isStream = String(response.headers.get('content-type') || '').includes('text/event-stream');
  let message = null;
  try {
    message = isStream ? messageFromEventStream(text, id) : JSON.parse(text);
  } catch { /* handled below */ }
  if (!message || message.jsonrpc !== '2.0') {
    throw new McpUpstreamError('AI_APP_BAD_ANSWER', `The app answered in a way MOS could not read (HTTP ${response.status}).`);
  }
  if (message.error) {
    throw new McpUpstreamError('AI_APP_REFUSED', String(message.error.message || 'The app refused the request.'));
  }
  return message.result;
}

// The package exchanges the owner's password for the app's token. Null when the app refused the password.
async function signInUpstream({ fetchImpl = fetch, key, password, url }) {
  let response;
  try {
    response = await fetchImpl(url, {
      body: JSON.stringify({ password }),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new McpUpstreamError('AI_APP_UNREACHABLE', 'The app did not answer.');
  }
  if (response.status === 401) return null;
  let answer = null;
  try { answer = await response.json(); } catch { /* handled below */ }
  if (!response.ok || typeof answer?.token !== 'string' || !answer.token.trim()) {
    throw new McpUpstreamError('AI_APP_BAD_ANSWER', String(answer?.error || `The app could not sign in (HTTP ${response.status}).`));
  }
  return answer.token.trim();
}

async function listAllTools(options) {
  const tools = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const result = await callMcp({ ...options, method: 'tools/list', params: cursor ? { cursor } : {} });
    tools.push(...(Array.isArray(result?.tools) ? result.tools : []));
    cursor = result?.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

module.exports = { APP_TOKEN_HEADER, McpUpstreamError, SIGN_IN_META, callMcp, listAllTools, messageFromEventStream, signInUpstream };
