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

const HOME_SUFFIXES = ['.local', '.lan', '.home', '.internal', '.home.arpa'];

function privateIpv4(host) {
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

// 'home' only when the address itself says so. A public-looking name that happens
// to resolve inside the network reads as 'internet', so MOS never claims that
// data stays at home when it cannot tell.
function addressLocality(baseUrl) {
  let host;
  try { host = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/gu, ''); } catch { return 'internet'; }
  if (net.isIPv4(host)) return privateIpv4(host) ? 'home' : 'internet';
  if (net.isIPv6(host)) return host === '::1' || /^f[cd]/u.test(host) || /^fe[89ab]/u.test(host) ? 'home' : 'internet';
  if (!host.includes('.') || HOME_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'home';
  return 'internet';
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

function manifestUsesAi(manifest) {
  return Object.values(manifest?.resources?.services || {}).some((service) => Object.values(service?.env || {}).some((value) => /\$\{ai\./u.test(String(value))));
}

module.exports = { AI_TEMPLATE_KEYS, addressLocality, aiTemplateValues, aiValuesForApp, manifestUsesAi };
