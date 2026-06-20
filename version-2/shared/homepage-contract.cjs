const crypto = require('node:crypto');
const YAML = require('yaml');

const HOMEPAGE_FILES = Object.freeze([
  'bookmarks.yaml',
  'services.template.yaml',
  'settings.yaml',
  'widgets.yaml',
]);
const HOMEPAGE_FILE_SET = new Set(HOMEPAGE_FILES);
const PROTOCOLS = new Set(['http', 'https']);
const HOST_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

class HomepageConfigError extends Error {
  constructor(code, message, statusCode = 400, details = []) {
    super(message);
    this.code = code;
    this.details = details;
    this.statusCode = statusCode;
  }
}

function assertAllowedFile(file) {
  if (!HOMEPAGE_FILE_SET.has(file)) {
    throw new HomepageConfigError('HOMEPAGE_FILE_NOT_ALLOWED', 'That Homepage file is not editable.', 404);
  }
  return file;
}

function revisionFor(content) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function parseDocument(content, file = 'services.template.yaml') {
  assertAllowedFile(file);
  if (typeof content !== 'string' || Buffer.byteLength(content) > 512 * 1024) {
    throw new HomepageConfigError('INVALID_HOMEPAGE_CONTENT', 'Homepage YAML must be text smaller than 512 KiB.');
  }
  const document = YAML.parseDocument(content, { prettyErrors: true, strict: true, uniqueKeys: true });
  if (document.errors.length) {
    throw new HomepageConfigError(
      'INVALID_HOMEPAGE_YAML',
      'Fix the YAML errors before saving.',
      400,
      document.errors.map((error) => error.message.split('\n')[0]),
    );
  }
  return document;
}

function validateYaml(content, file) {
  const document = parseDocument(content, file);
  if (file === 'services.template.yaml') validateServices(document.toJS());
  return { valid: true };
}

function entriesFromServices(value) {
  if (!Array.isArray(value)) {
    throw new HomepageConfigError('INVALID_SERVICES_TEMPLATE', 'Services must be a list of groups.');
  }
  const entries = [];
  for (const groupItem of value) {
    if (!groupItem || typeof groupItem !== 'object' || Array.isArray(groupItem)) {
      throw new HomepageConfigError('INVALID_SERVICES_TEMPLATE', 'Every service group must be a mapping.');
    }
    for (const [group, services] of Object.entries(groupItem)) {
      if (!group.trim() || !Array.isArray(services)) {
        throw new HomepageConfigError('INVALID_SERVICES_TEMPLATE', 'Every service group must have a name and service list.');
      }
      for (const serviceItem of services) {
        if (!serviceItem || typeof serviceItem !== 'object' || Array.isArray(serviceItem)) {
          throw new HomepageConfigError('INVALID_SERVICES_TEMPLATE', 'Every dashboard service must be a mapping.');
        }
        for (const [name, config] of Object.entries(serviceItem)) entries.push({ config, group, name });
      }
    }
  }
  return entries;
}

function validateProxy(proxy) {
  const keys = Object.keys(proxy && typeof proxy === 'object' && !Array.isArray(proxy) ? proxy : {}).sort();
  if (keys.join(',') !== 'subdomain,upstream') {
    throw new HomepageConfigError('INVALID_PROXY_METADATA', 'Home service proxy metadata has an unsupported field.');
  }
  let upstream;
  try { upstream = new URL(proxy.upstream); } catch {
    throw new HomepageConfigError('INVALID_PROXY_UPSTREAM', 'The upstream must be a valid HTTP or HTTPS URL.');
  }
  const protocol = upstream.protocol.replace(':', '');
  if (!PROTOCOLS.has(protocol) || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new HomepageConfigError('INVALID_PROXY_UPSTREAM', 'The upstream must contain only protocol, host, and port.');
  }
  if (!HOST_PATTERN.test(upstream.hostname.toLowerCase()) || !upstream.port) {
    throw new HomepageConfigError('INVALID_PROXY_UPSTREAM', 'The upstream host and explicit port are required.');
  }
  const port = Number(upstream.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HomepageConfigError('INVALID_PROXY_PORT', 'The upstream port must be between 1 and 65535.');
  }
  const subdomain = String(proxy.subdomain || '').trim().toLowerCase();
  if (!SUBDOMAIN_PATTERN.test(subdomain) || subdomain === 'home' || subdomain === 'www') {
    throw new HomepageConfigError('INVALID_PROXY_SUBDOMAIN', 'Enter a valid subdomain other than home or www.');
  }
  return { subdomain, upstream: `${protocol}://${upstream.hostname.toLowerCase()}:${port}` };
}

function validateServices(value) {
  const ids = new Set();
  const subdomains = new Set();
  for (const { config } of entriesFromServices(value)) {
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue;
    if (config.mos === undefined) continue;
    const mos = config.mos;
    const keys = Object.keys(mos && typeof mos === 'object' && !Array.isArray(mos) ? mos : {}).sort();
    if (!['id,managedBy', 'id,managedBy,proxy'].includes(keys.join(',')) || !ID_PATTERN.test(mos.id) || mos.managedBy !== 'user') {
      throw new HomepageConfigError('INVALID_MOS_METADATA', 'MOS dashboard metadata must contain a stable ID and user ownership only.');
    }
    if (ids.has(mos.id)) throw new HomepageConfigError('DUPLICATE_HOMEPAGE_ID', 'Dashboard entry IDs must be unique.');
    ids.add(mos.id);
    if (mos.proxy) {
      const proxy = validateProxy(mos.proxy);
      if (subdomains.has(proxy.subdomain)) throw new HomepageConfigError('DUPLICATE_PUBLIC_HOST', 'Public home service hosts must be unique.');
      subdomains.add(proxy.subdomain);
    }
  }
  return true;
}

function normalizeDashboardInput(input, homeService) {
  const allowed = homeService
    ? ['description', 'group', 'host', 'icon', 'name', 'port', 'protocol', 'subdomain']
    : ['description', 'group', 'icon', 'name', 'url'];
  const keys = Object.keys(input && typeof input === 'object' ? input : {}).sort();
  if (keys.join(',') !== allowed.sort().join(',')) {
    throw new HomepageConfigError('INVALID_GUIDED_REQUEST', 'Only the documented dashboard fields are accepted.');
  }
  const text = {};
  for (const key of ['name', 'description', 'icon', 'group']) {
    text[key] = String(input[key] || '').trim();
    if (!text[key] || text[key].length > 160 || /[\r\n]/u.test(text[key])) {
      throw new HomepageConfigError('INVALID_GUIDED_FIELD', `${key} is required and must be plain text.`);
    }
  }
  if (!homeService) {
    let url;
    try { url = new URL(String(input.url || '').trim()); } catch {
      throw new HomepageConfigError('INVALID_LINK_URL', 'Enter a valid HTTP or HTTPS link URL.');
    }
    if (!PROTOCOLS.has(url.protocol.replace(':', '')) || url.username || url.password) {
      throw new HomepageConfigError('INVALID_LINK_URL', 'Links must use HTTP or HTTPS and cannot contain credentials.');
    }
    return { ...text, url: url.href };
  }
  const proxy = validateProxy({
    subdomain: input.subdomain,
    upstream: `${String(input.protocol || '').trim().toLowerCase()}://${String(input.host || '').trim().toLowerCase()}:${input.port}`,
  });
  return { ...text, proxy };
}

function addEntry(content, rawInput, { homeService = false, id = crypto.randomUUID() } = {}) {
  const document = parseDocument(content);
  const current = document.toJS();
  validateServices(current);
  const input = normalizeDashboardInput(rawInput, homeService);
  const entries = entriesFromServices(current);
  const duplicate = entries.find(({ config }) => config?.mos?.id === id);
  if (duplicate) return { changed: false, content, id };
  if (homeService && entries.some(({ config }) => config?.mos?.proxy?.subdomain === input.proxy.subdomain)) {
    throw new HomepageConfigError('DUPLICATE_PUBLIC_HOST', 'That public subdomain is already used.');
  }
  let groupPair = document.contents.items
    .flatMap((item) => item?.items || [])
    .find((pair) => pair?.key?.value === input.group);
  if (!groupPair) {
    document.add(document.createNode({ [input.group]: [] }));
    groupPair = document.contents.items.at(-1)?.items?.[0];
  }
  const service = {
    [input.name]: {
      description: input.description,
      href: homeService ? '#' : input.url,
      icon: input.icon,
      mos: {
        id,
        managedBy: 'user',
        ...(homeService ? { proxy: input.proxy } : {}),
      },
    },
  };
  groupPair.value.add(document.createNode(service));
  const next = String(document);
  validateYaml(next, 'services.template.yaml');
  return { changed: true, content: next, id };
}

function publicUrlFor(proxy, domainState) {
  const baseDomain = String(domainState?.baseDomain || '').trim().toLowerCase();
  if (!HOST_PATTERN.test(baseDomain) || baseDomain === 'localhost') {
    throw new HomepageConfigError('PUBLIC_DOMAIN_REQUIRED', 'Configure a usable MOS domain before adding a home service.');
  }
  return `${domainState?.tlsMode === 'cloudflare-dns01' ? 'https' : 'http'}://${proxy.subdomain}.${baseDomain}/`;
}

function projectServices(content, domainState) {
  const document = parseDocument(content);
  const value = document.toJS();
  validateServices(value);
  for (const { config } of entriesFromServices(value)) {
    if (config?.mos?.proxy) config.href = publicUrlFor(validateProxy(config.mos.proxy), domainState);
    if (config?.mos) delete config.mos;
  }
  return `${YAML.stringify(value, { lineWidth: 0 })}`;
}

function renderCaddyRoutes(content, domainState) {
  const value = parseDocument(content).toJS();
  validateServices(value);
  const routes = entriesFromServices(value)
    .filter(({ config }) => config?.mos?.proxy)
    .map(({ config }) => {
      const proxy = validateProxy(config.mos.proxy);
      const publicUrl = new URL(publicUrlFor(proxy, domainState));
      return `${publicUrl.protocol}//${publicUrl.hostname} {\n  reverse_proxy ${proxy.upstream}\n}`;
    });
  return routes.length ? `${routes.join('\n\n')}\n` : '# No user-managed Homepage routes.\n';
}

module.exports = {
  HOMEPAGE_FILES,
  HomepageConfigError,
  addEntry,
  assertAllowedFile,
  entriesFromServices,
  projectServices,
  publicUrlFor,
  renderCaddyRoutes,
  revisionFor,
  validateProxy,
  validateServices,
  validateYaml,
};
