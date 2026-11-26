'use strict';

// How the AI service an owner chose for an app becomes that app's ${ai.*}
// values, shared by the settings service and the app runtime so the key names
// an app sees cannot drift from what is stored.

const net = require('node:net');

const { AiServiceStore } = require('./ai-service-store.cjs');

// The keys an app may read as ${ai.<key>}. Added in MOS 0.24.0; a package that
// references one must raise minimumMosVersion to 0.24.0.
const AI_TEMPLATE_KEYS = Object.freeze(['apiKey', 'baseUrl', 'chatCompletionsUrl', 'embeddingModel', 'embeddingProtocol', 'enabled', 'model']);

// Every service MOS stores speaks the OpenAI wire format, so an app that has to
// name the format gets this word.
const PROTOCOL = 'openai';

const PRIVATE_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.home.arpa'];
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|completions|embeddings|models)$/u;
const AI_REFERENCE = /\$\{ai\.([^}]+)\}/gu;

function hostnameOf(baseUrl) {
  try { return new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/gu, ''); } catch { return ''; }
}

function privateIpv4(host) {
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function loopbackHost(host) {
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || (net.isIPv4(host) && host.startsWith('127.'));
}

// Only when the address itself says so. A public-looking name that happens to
// resolve inside the network does not count, so MOS never claims more than it can tell.
function privateAddress(baseUrl) {
  const host = hostnameOf(baseUrl);
  if (!host) return false;
  if (net.isIPv4(host)) return privateIpv4(host);
  if (net.isIPv6(host)) return host === '::1' || /^f[cd]/u.test(host) || /^fe[89ab]/u.test(host);
  return !host.includes('.') || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// Where the owner is told a service runs. 'home' needs both a private address and
// a suite on the owner's own hardware; an unknown track never earns it.
function addressPlace(baseUrl, hostingTrack) {
  if (!privateAddress(baseUrl)) return 'internet';
  return hostingTrack === 'home-server' ? 'home' : 'private';
}

// What the form warns about before an address is saved. Loopback is refused
// outright: inside an app's container it names that container, never the model.
function addressAdvice(baseUrl) {
  const host = hostnameOf(baseUrl);
  if (loopbackHost(host)) return { advice: 'loopback', trimmed: null };
  if (ENDPOINT_SUFFIX.test(baseUrl)) return { advice: 'endpoint', trimmed: baseUrl.replace(ENDPOINT_SUFFIX, '') };
  if (host.endsWith('.local')) return { advice: 'local-name', trimmed: null };
  return { advice: null, trimmed: null };
}

// The ${ai.*} values for one app, as a Map of strings. With no service every
// value is empty, which is what makes renderEnvironment leave the app's AI
// variables out altogether.
function aiTemplateValues(service) {
  const source = service ? {
    apiKey: service.apiKey || '',
    baseUrl: service.baseUrl,
    chatCompletionsUrl: `${service.baseUrl}/chat/completions`,
    embeddingModel: service.embeddingModel || '',
    embeddingProtocol: service.embeddingModel ? PROTOCOL : '',
    enabled: 'true',
    model: service.model,
  } : {};
  return new Map(AI_TEMPLATE_KEYS.map((key) => [key, source[key] || '']));
}

// Read at materialize time, like the email relay: the app gets the service the
// owner chose for it as it is now, or nothing.
function aiValuesForApp(store, packageId, readSecret) {
  const service = new AiServiceStore(store).serviceOfApp(packageId);
  return aiTemplateValues(service ? { ...service, apiKey: service.keyRef ? readSecret(service.keyRef) : '' } : null);
}

// The environment variables a package fills from ${ai.*}, each with the keys it reads.
function aiVariablesOf(manifest) {
  const variables = new Map();
  for (const service of Object.values(manifest?.resources?.services || {})) {
    for (const [name, value] of Object.entries(service?.env || {})) {
      const keys = [...String(value).matchAll(AI_REFERENCE)].map((match) => match[1]);
      if (keys.length) variables.set(name, [...new Set([...(variables.get(name) || []), ...keys])]);
    }
  }
  return [...variables].map(([name, keys]) => ({ keys, name }));
}

module.exports = { AI_TEMPLATE_KEYS, addressAdvice, addressPlace, aiTemplateValues, aiValuesForApp, aiVariablesOf };
