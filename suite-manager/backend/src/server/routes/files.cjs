const { jsonResponse } = require('../responses.cjs');

const VIEW = 'Sign in to see the files on your drives.';
const MANAGE = 'Sign in to change the files on your drives.';
const FILES = '/storage/drives/([^/]+)/files';

function route(method, suffix, signIn, handler, extra = {}) {
  return { handler, method, pattern: new RegExp(`^${FILES}${suffix}$`, 'u'), signIn, ...extra };
}

// A download is a navigation to a file, so it is refused when another site, or
// an app's page on a sibling subdomain, asks for it in the background.
function isForeignRead(request) {
  const site = request.headers['sec-fetch-site'];
  return Boolean(site) && site !== 'same-origin' && site !== 'none';
}

// An upload chunk answered early is still read to its end, so the browser hears
// the answer instead of a connection cut mid-body.
async function drained(request, work) {
  try {
    return await work();
  } finally {
    if (!request.readableEnded) request.resume();
  }
}

function filesRoutes({ files }) {
  return [
    route('GET', '', VIEW, async ({ params: [driveId], response, url }) => {
      jsonResponse(response, 200, await files.list(driveId, url.searchParams.get('path') || ''));
    }),
    route('GET', '/destinations', VIEW, async ({ params: [driveId], response }) => {
      jsonResponse(response, 200, await files.destinations(driveId));
    }),
    route('GET', '/download', VIEW, async ({ params: [driveId], request, response, url }) => {
      if (isForeignRead(request)) {
        jsonResponse(response, 403, { code: 'CROSS_ORIGIN_REJECTED', error: 'Files are downloaded from Suite Manager\'s own pages.' });
        return;
      }
      await files.streamDownload(driveId, url.searchParams.get('path') || '', request, response);
    }),
    route('POST', '/folder', MANAGE, async ({ body, params: [driveId], response }) => {
      jsonResponse(response, 200, await files.createFolder(driveId, await body()));
    }, { bodyLimit: 8 * 1024 }),
    route('POST', '/rename', MANAGE, async ({ body, params: [driveId], response }) => {
      jsonResponse(response, 200, await files.rename(driveId, await body()));
    }, { bodyLimit: 8 * 1024 }),
    route('POST', '/move', MANAGE, async ({ body, params: [driveId], response }) => {
      jsonResponse(response, 200, await files.move(driveId, await body()));
    }, { bodyLimit: 2 * 1024 * 1024 }),
    route('POST', '/delete', MANAGE, async ({ body, params: [driveId], response }) => {
      jsonResponse(response, 200, await files.remove(driveId, await body()));
    }, { bodyLimit: 2 * 1024 * 1024 }),
    route('POST', '/uploads', MANAGE, async ({ body, params: [driveId], response }) => {
      jsonResponse(response, 200, await files.beginUpload(driveId, await body()));
    }, { bodyLimit: 8 * 1024 }),
    route('PUT', '/uploads/([^/]+)', MANAGE, async ({ params: [driveId, uploadId], request, response, url }) => {
      const offset = Number(url.searchParams.get('offset'));
      jsonResponse(response, 200, await drained(request, () => files.appendChunk(driveId, uploadId, offset, request)));
    }),
    route('POST', '/uploads/([^/]+)/finish', MANAGE, async ({ params: [driveId, uploadId], response }) => {
      jsonResponse(response, 200, await files.finishUpload(driveId, uploadId));
    }),
    route('POST', '/uploads/([^/]+)/cancel', MANAGE, async ({ params: [driveId, uploadId], response }) => {
      jsonResponse(response, 200, await files.cancelUpload(driveId, uploadId));
    }),
  ];
}

module.exports = { filesRoutes };
