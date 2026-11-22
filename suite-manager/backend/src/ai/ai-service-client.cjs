'use strict';

// The two calls MOS itself makes to an AI service: list its models, and ask it
// one question to prove the address, key and model work together.

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

async function listModels({ apiKey, baseUrl }, { fetchImpl = globalThis.fetch } = {}) {
  const response = await request(baseUrl, '/models', { apiKey, fetchImpl });
  let body;
  try { body = await response.json(); } catch { body = null; }
  const models = Array.isArray(body?.data) ? body.data.map((model) => model?.id).filter((id) => typeof id === 'string' && id) : [];
  return [...new Set(models)].sort().slice(0, MAX_MODELS);
}

async function ask({ apiKey, baseUrl, model }, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const started = now();
  const response = await request(baseUrl, '/chat/completions', {
    apiKey,
    body: { messages: [{ content: 'Reply with the single word: ok', role: 'user' }], model },
    fetchImpl,
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!Array.isArray(body?.choices) || !body.choices.length) {
    throw new AiServiceError('AI_SERVICE_REFUSED', 'The service answered, but not in the format apps expect.', 502);
  }
  return { ms: now() - started };
}

module.exports = { AiServiceError, ask, listModels };
