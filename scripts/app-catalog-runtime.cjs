const fs = require('node:fs');
const path = require('node:path');

const CONTROL_PLANE_ROUTES = [
  { host: 'suite-manager', upstream: 'suite-manager:3000' },
  { host: 'homepage', upstream: 'homepage:3000' },
];

function getCatalogDir(repoRoot) {
  return path.join(repoRoot, 'apps', 'suite-manager', 'catalog');
}

function getCatalogSelectionPath(repoRoot) {
  return path.join(repoRoot, 'deploy', 'vps', 'generated', 'app-catalog', 'compose-selection.json');
}

function loadCatalogApps(repoRoot) {
  const appsDir = path.join(getCatalogDir(repoRoot), 'apps');
  if (!fs.existsSync(appsDir)) {
    return [];
  }

  return fs
    .readdirSync(appsDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort()
    .map((fileName) => JSON.parse(fs.readFileSync(path.join(appsDir, fileName), 'utf8')));
}

function readCatalogSelection(repoRoot) {
  const selectionPath = getCatalogSelectionPath(repoRoot);
  if (!fs.existsSync(selectionPath)) {
    return {
      apps: [],
      profiles: [],
      version: 1,
    };
  }

  const parsed = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  return {
    apps: Array.isArray(parsed.apps) ? parsed.apps : [],
    profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
    version: 1,
  };
}

function selectedCatalogAppIds(selection) {
  return new Set(
    selection.apps
      .filter((app) => app && (app.status === 'installed' || app.status === 'pending-apply'))
      .map((app) => app.id)
      .filter((id) => typeof id === 'string' && id.trim()),
  );
}

function catalogRouteSpecs(repoRoot) {
  const appIds = selectedCatalogAppIds(readCatalogSelection(repoRoot));
  return loadCatalogApps(repoRoot)
    .filter((app) => appIds.has(app.id))
    .flatMap((app) =>
      Array.isArray(app.routes)
        ? app.routes.map((route) => ({
            host: route.host,
            httpsInHttpMode: route.httpsInHttpMode === true,
            upstream: route.upstream,
          }))
        : [],
    )
    .filter((route) => route.host && route.upstream);
}

function caddySiteBlock(siteAddress, upstream, extraLines = []) {
  return [
    `${siteAddress} {`,
    ...extraLines.map((line) => `\t${line}`),
    `\treverse_proxy ${upstream}`,
    '}',
    '',
  ];
}

function caddyServiceRoutesForMode(domain, tlsMode, appRoutes = []) {
  const routes = [...CONTROL_PLANE_ROUTES, ...appRoutes];

  if (tlsMode === 'cloudflare-dns01') {
    return [
      '# Generated MOS built-in HTTPS routes.',
      '# This file is managed by vps:init from DOMAIN, PUBLIC_URL_SCHEME, MOS_TLS_MODE, and installed catalog app state.',
      '',
      ...routes.flatMap((route) => caddySiteBlock(`${route.host}.${domain}`, route.upstream)),
    ].join('\n');
  }

  const httpRoutes = routes.filter((route) => route.httpsInHttpMode !== true);
  const httpsInternalRoutes = routes.filter((route) => route.httpsInHttpMode === true);
  const matcherBlocks = httpRoutes.flatMap((route) => [
    `\t@${route.host.replace(/-/g, '_')} host ${route.host}.${domain}`,
    `\thandle @${route.host.replace(/-/g, '_')} {`,
    `\t\treverse_proxy ${route.upstream}`,
    '\t}',
    '',
  ]);

  return [
    '# Generated MOS built-in HTTP routes.',
    '# This file is managed by vps:init from DOMAIN, PUBLIC_URL_SCHEME, MOS_TLS_MODE, and installed catalog app state.',
    '',
    ':80 {',
    ...matcherBlocks,
    '\trespond 404',
    '}',
    '',
    ...httpsInternalRoutes.flatMap((route) =>
      caddySiteBlock(`https://${route.host}.${domain}`, route.upstream, ['tls internal']),
    ),
  ].join('\n');
}

module.exports = {
  CONTROL_PLANE_ROUTES,
  caddyServiceRoutesForMode,
  catalogRouteSpecs,
  readCatalogSelection,
};
