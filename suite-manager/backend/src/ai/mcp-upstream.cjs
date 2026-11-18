'use strict';

const { CodedError } = require('../../../../shared/coded-error.cjs');

const UPSTREAM_PROTOCOL_VERSION = '2025-11-25';
const DEFAULT_TIMEOUT_MS = 50_000;

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

async function callMcp({ fetchImpl = fetch, method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, token = null, url }) {
  const id = nextId++;
  const headers = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': UPSTREAM_PROTOCOL_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
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

module.exports = { McpUpstreamError, callMcp, listAllTools, messageFromEventStream };
