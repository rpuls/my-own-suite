const fs = require('node:fs');
const path = require('node:path');
const { getCatalogDir, getSelectedCatalogAppIds, loadCatalogApps } = require('./app-catalog-packages.cjs');

const CONTROL_PLANE_ROUTES = [
  { host: 'suite-manager', upstream: 'suite-manager:3000' },
  { host: 'homepage', upstream: 'homepage:3000' },
];

function getCatalogSelectionPath(repoRoot) {
  return path.join(repoRoot, 'deploy', 'vps', 'generated', 'app-catalog', 'compose-selection.json');
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

function selectedCatalogApps(repoRoot) {
  const appIds = getSelectedCatalogAppIds(readCatalogSelection(repoRoot));
  return loadCatalogApps(getCatalogDir(repoRoot))
    .filter((app) => appIds.has(app.id))
}

function catalogRouteSpecs(repoRoot) {
  return selectedCatalogApps(repoRoot)
    .flatMap((app) =>
      Array.isArray(app.routes.public)
        ? app.routes.public.map((route) => ({
            host: route.host,
            httpsInHttpMode: route.httpsInHttpMode === true,
            upstream: route.upstream,
          }))
        : [],
    )
    .filter((route) => route.host && route.upstream);
}

function catalogInternalRouteSnippets(repoRoot) {
  return selectedCatalogApps(repoRoot).flatMap((app) =>
    app.routes.internal.map((route) => {
      const assetPath = path.join(app.package.dir, route.asset);
      return {
        appId: app.id,
        content: fs.readFileSync(assetPath, 'utf8'),
        id: route.id,
        path: assetPath,
      };
    }),
  );
}

function catalogEnvProjections(repoRoot) {
  return selectedCatalogApps(repoRoot).flatMap((app) =>
    app.env.projections.map((projection) => ({
      ...projection,
      appId: app.id,
    })),
  );
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
  catalogEnvProjections,
  catalogInternalRouteSnippets,
  catalogRouteSpecs,
  readCatalogSelection,
};
