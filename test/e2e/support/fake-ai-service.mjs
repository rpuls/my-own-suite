// The AI service the `ai-service` step adds in Settings: an OpenAI-compatible model server
// on this machine, which the lab's apps reach over the network as they would an owner's own.
// It answers model lists, chat and text completions (streamed or not) and embeddings, keeps
// every request it gets, and serves any page or file a journey needs beside it.
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import http from 'node:http';
import os from 'node:os';

export const AI_BASE_PATH = '/mos-e2e-ai/v1';
export const DEFAULT_AI_SERVICE_PORT = 47311;
const EMBEDDING_SIZE = 16;
const BODY_LIMIT = 16 * 1024 * 1024;

function isLoopback(address) {
  return address.startsWith('127.') || address === '::1';
}

// The address this machine sends from to reach the lab is the one the lab can answer to.
// A lab named by loopback is this machine, whose containers reach it on its network address.
export async function runnerAddress(labUrl) {
  const { address: lab } = await dns.lookup(new URL(labUrl).hostname, { family: 4 });
  const socket = dgram.createSocket('udp4');
  try {
    const source = await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.connect(9, lab, () => resolve(socket.address().address));
    });
    if (!isLoopback(source)) return source;
  } finally {
    socket.close();
  }
  const found = Object.values(os.networkInterfaces()).flat().find((item) => item.family === 'IPv4' && !item.internal);
  if (!found) throw new Error('This machine has no network address the lab could reach. Set MOS_E2E_RUNNER_ADDRESS.');
  return found.address;
}

// Arguments that satisfy a tool's JSON schema, so an app that insists on a tool call gets one
// it can parse: every listed property, empty lists, and the reply text for every string.
export function exampleOf(schema, defs, text) {
  if (!schema || typeof schema !== 'object') return text;
  if (schema.$ref) return exampleOf(defs[schema.$ref.split('/').pop()], defs, text);
  const variants = schema.anyOf || schema.oneOf;
  if (variants) return exampleOf(variants.find((item) => item.type !== 'null') || variants[0], defs, text);
  if (schema.allOf) return exampleOf(schema.allOf[0], defs, text);
  if (schema.enum) return schema.enum[0];
  if ('const' in schema) return schema.const;
  const type = [schema.type].flat().find((item) => item && item !== 'null') || (schema.properties ? 'object' : 'string');
  switch (type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties || {}).map(([key, value]) => [key, exampleOf(value, defs, text)]));
    case 'array': return [];
    case 'integer':
    case 'number': return schema.minimum ?? 0;
    case 'boolean': return false;
    default:
      if (schema.format === 'date') return '2026-01-01';
      if (schema.format === 'date-time') return '2026-01-01T00:00:00Z';
      return text.slice(0, schema.maxLength ?? text.length);
  }
}

function chosenTool(body) {
  if (!Array.isArray(body.tools) || body.tool_choice === 'none') return null;
  const named = body.tool_choice?.function?.name;
  return body.tools.map((tool) => tool.function).find((tool) => tool && (!named || tool.name === named)) || null;
}

function assistantMessage(body, reply) {
  const tool = chosenTool(body);
  if (!tool) return { finish: 'stop', message: { content: reply, role: 'assistant' } };
  const parameters = tool.parameters || {};
  const args = exampleOf(parameters, parameters.$defs || parameters.definitions || {}, reply);
  const call = { function: { arguments: JSON.stringify(args), name: tool.name }, id: 'call_mos_e2e', type: 'function' };
  return { finish: 'tool_calls', message: { content: null, role: 'assistant', tool_calls: [call] } };
}

function embeddingOf(text) {
  const digest = crypto.createHash('sha256').update(String(text)).digest();
  const vector = Array.from({ length: EMBEDDING_SIZE }, (_, index) => digest[index] / 255 - 0.5);
  const length = Math.hypot(...vector) || 1;
  return vector.map((value) => value / length);
}

const USAGE = { completion_tokens: 4, prompt_tokens: 8, total_tokens: 12 };

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function sendStream(response, chunks) {
  response.writeHead(200, { 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream' });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
}

function chatCompletion(response, body, reply, model) {
  const { finish, message } = assistantMessage(body, reply);
  const base = { created: Math.floor(Date.now() / 1000), id: 'chatcmpl-mos-e2e', model };
  if (!body.stream) return sendJson(response, 200, { ...base, choices: [{ finish_reason: finish, index: 0, message }], object: 'chat.completion', usage: USAGE });
  const delta = message.tool_calls ? { role: 'assistant', tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : { content: reply, role: 'assistant' };
  return sendStream(response, [
    { ...base, choices: [{ delta, finish_reason: null, index: 0 }], object: 'chat.completion.chunk' },
    { ...base, choices: [{ delta: {}, finish_reason: finish, index: 0 }], object: 'chat.completion.chunk', usage: USAGE },
  ]);
}

function textCompletion(response, body, reply, model) {
  const base = { created: Math.floor(Date.now() / 1000), id: 'cmpl-mos-e2e', model, object: 'text_completion' };
  if (!body.stream) return sendJson(response, 200, { ...base, choices: [{ finish_reason: 'stop', index: 0, text: reply }], usage: USAGE });
  return sendStream(response, [{ ...base, choices: [{ finish_reason: 'stop', index: 0, text: reply }] }]);
}

function embeddings(response, body, model) {
  const inputs = [body.input].flat();
  sendJson(response, 200, { data: inputs.map((input, index) => ({ embedding: embeddingOf(input), index, object: 'embedding' })), model, object: 'list', usage: { prompt_tokens: inputs.length, total_tokens: inputs.length } });
}

const ENDPOINTS = [
  ['models', /\/models$/u],
  ['chat', /\/chat\/completions$/u],
  ['completion', /\/completions$/u],
  ['embedding', /\/embeddings$/u],
];

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) reject(new Error('request body too large'));
      else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function parseJson(raw) {
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; } catch { return null; }
}

export async function startFakeAiService({ address, port = DEFAULT_AI_SERVICE_PORT }) {
  const apiKey = `mos-e2e-${crypto.randomBytes(12).toString('hex')}`;
  const models = { chat: 'mos-e2e-chat', embedding: 'mos-e2e-embedding' };
  const reply = `MOS E2E model answer ${crypto.randomBytes(4).toString('hex')}`;
  const files = new Map();
  const requests = [];

  async function handle(request, response) {
    const { pathname } = new URL(request.url, 'http://fake');
    const raw = await readBody(request);
    if (!pathname.startsWith(`${AI_BASE_PATH}/`)) {
      const file = files.get(pathname);
      if (!file) return sendJson(response, 404, { error: { message: `nothing is served at ${pathname}` } });
      response.writeHead(200, { 'Content-Type': file.type });
      return response.end(file.body);
    }
    const kind = ENDPOINTS.find(([, pattern]) => pattern.test(pathname))?.[0] || null;
    const body = parseJson(raw);
    const authorized = request.headers.authorization === `Bearer ${apiKey}`;
    requests.push({
      at: Date.now(),
      authorized,
      body,
      // Only a browser sends an Origin with a request like this; an app's server never does.
      fromBrowser: Boolean(request.headers.origin),
      kind,
      method: request.method,
      model: body?.model ?? null,
      path: pathname,
      stream: body?.stream === true,
    });
    if (!authorized) return sendJson(response, 401, { error: { code: 'invalid_api_key', message: 'Incorrect API key provided.', type: 'invalid_request_error' } });
    if (!kind) return sendJson(response, 404, { error: { message: `no endpoint at ${pathname}` } });
    if (kind === 'models') return sendJson(response, 200, { data: Object.values(models).map((id) => ({ created: 0, id, object: 'model', owned_by: 'mos-e2e' })), object: 'list' });
    if (!body) return sendJson(response, 400, { error: { message: 'the body is not JSON' } });
    const model = body.model || models.chat;
    if (kind === 'chat') return chatCompletion(response, body, reply, model);
    if (kind === 'completion') return textCompletion(response, body, reply, model);
    return embeddings(response, body, model);
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      if (!response.headersSent) sendJson(response, 500, { error: { message: error.message } });
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', (error) => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is taken on this machine, so the fake AI service cannot start. Set MOS_E2E_AI_SERVICE_PORT to a free one.`)
      : error));
    server.listen(port, '0.0.0.0', resolve);
  });
  const origin = `http://${address}:${server.address().port}`;

  return {
    apiKey,
    baseUrl: `${origin}${AI_BASE_PATH}`,
    host: address,
    models,
    origin,
    reply,
    requests,
    // A file at this machine's address, for a journey that needs the app to fetch one or a page to open.
    serve(pathname, { body, type = 'application/octet-stream' }) {
      files.set(pathname, { body, type });
      return `${origin}${pathname}`;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => { server.close(() => resolve()); });
    },
  };
}
