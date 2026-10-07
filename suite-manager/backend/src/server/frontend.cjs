const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { fileResponse, htmlResponse, textResponse } = require('./responses.cjs');

const SUITE_MANAGER_BASE_PATH = '/suite-manager/';
const FRONTEND_ASSET_PREFIX = `${SUITE_MANAGER_BASE_PATH}assets/`;

function resolveStaticPath(rootDir, requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const normalizedPath = path.normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const rootPath = path.resolve(rootDir);
  const filePath = path.resolve(rootDir, normalizedPath.replace(/^[/\\]+/, ''));
  const relativePath = path.relative(rootPath, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }

  return filePath;
}

function readFrontendHtml(frontendDistDir) {
  const indexPath = path.join(frontendDistDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  return fs.readFileSync(indexPath, 'utf8');
}

// A hash of the built index.html, so a browser holding another id knows it runs
// code this server no longer serves. Cached by mtime and size: it is polled.
let frontendBuildCache = null;
function frontendBuildId(frontendDistDir) {
  const indexPath = path.join(frontendDistDir, 'index.html');
  let stats = null;
  try { stats = fs.statSync(indexPath); } catch { return ''; }
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  if (frontendBuildCache?.stamp === stamp) return frontendBuildCache.id;
  const html = readFrontendHtml(frontendDistDir);
  if (html === null) return '';
  const id = crypto.createHash('sha256').update(html).digest('hex').slice(0, 16);
  frontendBuildCache = { id, stamp };
  return id;
}

// Bundles carry their content hash in the filename, so a year is safe; brand
// marks, favicons and fonts keep their names across a rebrand, so an hour.
function assetCacheControl(relativePath) {
  return relativePath.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600';
}

function serveFrontendAsset(response, frontendDistDir, pathname) {
  const relativePath = pathname.slice(FRONTEND_ASSET_PREFIX.length);
  const staticPath = resolveStaticPath(frontendDistDir, relativePath);
  if (!staticPath || !fs.existsSync(staticPath) || !fs.statSync(staticPath).isFile()) {
    return false;
  }

  fileResponse(response, staticPath, { 'Cache-Control': assetCacheControl(relativePath) });
  return true;
}

function serveFrontend(response, frontendDistDir) {
  const html = readFrontendHtml(frontendDistDir);
  if (html) {
    const buildId = frontendBuildId(frontendDistDir);
    // Never cached: it names the immutable bundles, so a stale copy pins a
    // browser to the previous build with no way to find out.
    htmlResponse(response, 200, buildId
      ? html.replace('</head>', `  <meta name="mos-build" content="${buildId}" />
  </head>`)
      : html, { 'Cache-Control': 'no-store' });
    return;
  }

  textResponse(response, 503, 'Suite Manager frontend is not built yet. Run npm run build:client.');
}

module.exports = {
  FRONTEND_ASSET_PREFIX,
  SUITE_MANAGER_BASE_PATH,
  frontendBuildId,
  serveFrontend,
  serveFrontendAsset,
};
