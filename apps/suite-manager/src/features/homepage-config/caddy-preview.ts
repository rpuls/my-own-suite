import { parseDocument } from 'yaml';

export type CaddyProxyPreviewError = {
  message: string;
  path: string;
};

export type CaddyProxyPreviewRoute = {
  host: string;
  href: string;
  path: string;
  siteAddress: string;
  title: string;
  upstream: string;
  upstreamTlsInsecureSkipVerify: boolean;
};

export type CaddyProxyPreview = {
  caddyfile: string;
  errors: CaddyProxyPreviewError[];
  routes: CaddyProxyPreviewRoute[];
  valid: boolean;
};

export type CaddyProxyPreviewOptions = {
  domain?: string;
  urlScheme?: string;
};

type TileCandidate = {
  path: string[];
  title: string;
  value: Record<string, unknown>;
};

const RAW_CADDY_FIELD_PATTERN = /(?:caddy|caddyfile|directive|snippet|raw)/i;
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatPath(path: string[]): string {
  return path.length > 0 ? path.join(' > ') : '<root>';
}

function parseHttpUrl(value: unknown): URL | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (!SUPPORTED_PROTOCOLS.has(url.protocol) || !url.hostname || url.hostname.includes('*')) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

function isOriginOnlyUrl(url: URL): boolean {
  return url.pathname === '/' && !url.search && !url.hash;
}

function hasEnabledProxy(tile: Record<string, unknown>): boolean {
  const mos = tile.mos;
  if (!isRecord(mos)) {
    return false;
  }

  const proxy = mos.proxy;
  return isRecord(proxy) && proxy.enabled === true;
}

function collectTiles(node: unknown, path: string[] = []): TileCandidate[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => collectTiles(child, path));
  }

  if (!isRecord(node)) {
    return [];
  }

  const entries = Object.entries(node);
  if (entries.length !== 1) {
    return [];
  }

  const entry = entries[0];
  if (!entry) {
    return [];
  }

  const [title, value] = entry;
  const nextPath = [...path, title];

  if (Array.isArray(value)) {
    return collectTiles(value, nextPath);
  }

  if (isRecord(value)) {
    return [{ path: nextPath, title, value }];
  }

  return [];
}

function normalizeUpstream(url: URL): string {
  if (url.pathname === '/' && !url.search && !url.hash) {
    return url.origin;
  }

  return url.toString();
}

function getStackSubdomain(value: Record<string, unknown>): string {
  const mos = value.mos;
  if (!isRecord(mos)) {
    return '';
  }

  const publicConfig = mos.public;
  if (isRecord(publicConfig) && publicConfig.mode === 'app-subdomain') {
    const subdomain = publicConfig.subdomain;
    if (typeof subdomain === 'string' && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(subdomain)) {
      return subdomain;
    }
  }

  if (mos.kind !== 'external' || mos.managed !== true || !hasEnabledProxy(value)) {
    return '';
  }

  const hrefUrl = parseHttpUrl(value.href);
  if (!hrefUrl) {
    return '';
  }

  const hostname = hrefUrl.hostname.toLowerCase();
  const legacySuffixes = ['.mos.home', '.localhost'];
  const suffix = legacySuffixes.find((candidate) => hostname.endsWith(candidate));
  if (!suffix) {
    return '';
  }

  const subdomain = hostname.slice(0, -suffix.length);
  return subdomain && !subdomain.includes('.') && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(subdomain)
    ? subdomain
    : '';
}

function resolvePublicUrl(
  tile: Record<string, unknown>,
  hrefUrl: URL | null,
  options: CaddyProxyPreviewOptions,
): URL | null {
  const subdomain = getStackSubdomain(tile);
  const domain = options.domain?.trim().toLowerCase() || '';
  const scheme = options.urlScheme === 'https' ? 'https' : options.urlScheme === 'http' ? 'http' : '';
  if (subdomain && domain && scheme) {
    return new URL(`${scheme}://${subdomain}.${domain}`);
  }

  return hrefUrl;
}

function buildCaddyfile(routes: CaddyProxyPreviewRoute[]): string {
  if (routes.length === 0) {
    return '';
  }

  return `${routes
    .map((route) => {
      if (route.upstreamTlsInsecureSkipVerify) {
        return `${route.siteAddress} {\n\treverse_proxy ${route.upstream} {\n\t\ttransport http {\n\t\t\ttls_insecure_skip_verify\n\t\t}\n\t}\n}`;
      }

      return `${route.siteAddress} {\n\treverse_proxy ${route.upstream}\n}`;
    })
    .join('\n\n')}\n`;
}

function hasRawCaddyField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((child) => hasRawCaddyField(child));
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(
    ([key, child]) => RAW_CADDY_FIELD_PATTERN.test(key) || hasRawCaddyField(child),
  );
}

export function createCaddyProxyPreviewFromServicesTemplate(
  content: string,
  options: CaddyProxyPreviewOptions = {},
): CaddyProxyPreview {
  const document = parseDocument(content, { prettyErrors: true });
  const firstYamlError = document.errors[0];
  if (firstYamlError) {
    return {
      caddyfile: '',
      errors: [{ message: `Invalid YAML: ${firstYamlError.message}`, path: 'services.template.yaml' }],
      routes: [],
      valid: false,
    };
  }

  const parsed = document.toJS();
  const root = Array.isArray(parsed) ? parsed : [parsed];
  const errors: CaddyProxyPreviewError[] = [];
  const routes: CaddyProxyPreviewRoute[] = [];
  const seenHosts = new Map<string, string>();

  for (const tile of collectTiles(root).filter((candidate) => hasEnabledProxy(candidate.value))) {
    const path = formatPath(tile.path);
    const mos = tile.value.mos;
    const proxy = isRecord(mos) && isRecord(mos.proxy) ? mos.proxy : {};
    const hrefUrl = parseHttpUrl(tile.value.href);
    const publicUrl = resolvePublicUrl(tile.value, hrefUrl, options);
    const upstreamUrl = parseHttpUrl(proxy.upstream);
    const tls = isRecord(proxy.tls) ? proxy.tls : {};
    const skipVerify = tls.insecureSkipVerify === true;

    if (!hrefUrl) {
      errors.push({ message: '`href` must be an absolute http or https URL with a non-wildcard hostname.', path });
    }

    if (!upstreamUrl) {
      errors.push({
        message: '`mos.proxy.upstream` must be an absolute http or https URL with a non-wildcard hostname.',
        path,
      });
    }

    if (upstreamUrl && !isOriginOnlyUrl(upstreamUrl)) {
      errors.push({
        message: '`mos.proxy.upstream` must not include a path, query string, or fragment.',
        path,
      });
    }

    if (hasRawCaddyField(proxy)) {
      errors.push({ message: 'Raw Caddy fields are not supported in `mos.proxy` annotations.', path });
    }

    if (!publicUrl || !upstreamUrl) {
      continue;
    }

    const host = publicUrl.hostname.toLowerCase();
    const siteAddress = publicUrl.protocol === 'http:' ? `http://${host}` : host;
    const existingPath = seenHosts.get(host);
    if (existingPath) {
      errors.push({ message: `Duplicate proxy hostname also used by ${existingPath}.`, path });
      continue;
    }

    seenHosts.set(host, path);
    routes.push({
      host,
      href: publicUrl.toString(),
      path,
      siteAddress,
      title: tile.title,
      upstream: normalizeUpstream(upstreamUrl),
      upstreamTlsInsecureSkipVerify: skipVerify && upstreamUrl.protocol === 'https:',
    });
  }

  const valid = errors.length === 0;
  return {
    caddyfile: valid ? buildCaddyfile(routes) : '',
    errors,
    routes: valid ? routes : [],
    valid,
  };
}
