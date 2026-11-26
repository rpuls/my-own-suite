'use strict';

// The calls MOS itself makes to an AI service: list its models, ask the chat
// model one question, and ask the search model for one embedding, to prove the
// address, key and models work together.

const { CodedError } = require('../../../../shared/coded-error.cjs');

const TIMEOUT_MS = 30_000;
const MAX_MODELS = 500;

class AiServiceError extends CodedError {
  constructor(code, message, statusCode = 400) {
    super(code, message, { statusCode });
  }
}

function hostOf(baseUrl) {
  try { return new URL(baseUrl).host; } catch { return 'that address'; }
}

async function providerMessage(response) {
  try {
    const body = await response.json();
    const message = body?.error?.message || body?.error || body?.message;
    return typeof message === 'string' ? message.slice(0, 300) : '';
  } catch {
    return '';
  }
}

async function request(baseUrl, path, { apiKey, body, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}${path}`, {
      body: body ? JSON.stringify(body) : undefined,
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      method: body ? 'POST' : 'GET',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new AiServiceError('AI_SERVICE_UNREACHABLE', error?.name === 'TimeoutError'
      ? `${hostOf(baseUrl)} did not answer in time.`
      : `MOS could not reach ${hostOf(baseUrl)}. Check the address, and that the computer running it is on.`, 502);
  }
  if (response.ok) return response;
  if (response.status === 401 || response.status === 403) {
    throw new AiServiceError('AI_SERVICE_KEY_REFUSED', apiKey ? 'The service refused this API key.' : 'The service asks for an API key.', 502);
  }
  if (response.status === 404 && !body) {
    throw new AiServiceError('AI_SERVICE_NOT_FOUND', `No AI service answered at this address. Most addresses end in /v1.`, 502);
  }
  const said = await providerMessage(response);
  throw new AiServiceError('AI_SERVICE_REFUSED', said ? `The service answered: ${said}` : `The service answered with an error (HTTP ${response.status}).`, 502);
}

async function jsonOf(response) {
  try { return await response.json(); } catch { return null; }
}

function wrongFormat() {
  return new AiServiceError('AI_SERVICE_REFUSED', 'The service answered, but not in the format apps expect.', 502);
}

async function listModels({ apiKey, baseUrl }, { fetchImpl = globalThis.fetch } = {}) {
  const body = await jsonOf(await request(baseUrl, '/models', { apiKey, fetchImpl }));
  const models = Array.isArray(body?.data) ? body.data.map((model) => model?.id).filter((id) => typeof id === 'string' && id) : [];
  return [...new Set(models)].sort().slice(0, MAX_MODELS);
}

async function ask({ apiKey, baseUrl, model }, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const started = now();
  const body = await jsonOf(await request(baseUrl, '/chat/completions', {
    apiKey,
    body: { messages: [{ content: 'Reply with the single word: ok', role: 'user' }], model },
    fetchImpl,
  }));
  if (!Array.isArray(body?.choices) || !body.choices.length) throw wrongFormat();
  return { ms: now() - started };
}

async function embed({ apiKey, baseUrl, model }, { fetchImpl = globalThis.fetch } = {}) {
  const body = await jsonOf(await request(baseUrl, '/embeddings', { apiKey, body: { input: 'ok', model }, fetchImpl }));
  if (!Array.isArray(body?.data) || !body.data.length) throw wrongFormat();
}

module.exports = { AiServiceError, ask, embed, listModels };
