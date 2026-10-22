const { DRIVE_ACTIONS, STICK_ACTION, stickJobId } = require('../../apps/drive-jobs.cjs');
const { jsonResponse } = require('../responses.cjs');

const VIEW = 'Sign in to see your storage.';
const MANAGE = 'Sign in to manage your storage.';
const UNAVAILABLE = { code: 'APP_AGENT_UNAVAILABLE', error: 'MOS could not ask the server which storage it has.' };

// Storage credentials go to the agent field by field, so it is never handed
// something the screen did not ask for; nothing here keeps or logs them.
function bucketInput(input) {
  return {
    accessKeyId: String(input.accessKeyId || ''),
    bucket: String(input.bucket || ''),
    endpoint: String(input.endpoint || ''),
    folder: String(input.folder || ''),
    label: String(input.label || ''),
    region: String(input.region || ''),
    secretAccessKey: String(input.secretAccessKey || ''),
    ...(input.id ? { id: String(input.id) } : {}),
  };
}

function storageRoutes({ backupAgent, driveJobs, storage }) {
  return [
    {
      method: 'GET',
      path: '/storage',
      signIn: VIEW,
      handler: async ({ response }) => {
        const listed = await storage.inventory();
        jsonResponse(response, listed ? 200 : 503, listed || UNAVAILABLE);
      },
    },
    // Server-sent events: one `changed` per change, and a comment every 25 s so no
    // proxy on the way takes the quiet connection for a dead one.
    {
      method: 'GET',
      path: '/storage/events',
      signIn: VIEW,
      handler: async ({ request, response }) => {
        response.writeHead(200, { 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Content-Type': 'text/event-stream' });
        response.write(': open\n\n');
        const unsubscribe = storage.subscribe(() => response.write('event: changed\ndata: {}\n\n'));
        const heartbeat = setInterval(() => response.write(': still here\n\n'), 25_000);
        request.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      },
    },
    {
      method: 'GET',
      path: '/storage/usage',
      signIn: VIEW,
      handler: async ({ response }) => {
        const usage = await storage.usage();
        jsonResponse(response, usage ? 200 : 503, usage || UNAVAILABLE);
      },
    },
    {
      method: 'POST',
      pattern: /^\/storage\/([^/]+)\/rename$/u,
      signIn: MANAGE,
      bodyLimit: 4 * 1024,
      handler: async ({ body, params: [id], response }) => {
        jsonResponse(response, 200, await storage.rename(id, (await body()).name));
      },
    },
    ...DRIVE_ACTIONS.map((action) => ({
      method: 'POST',
      pattern: new RegExp(`^/storage/drives/([^/]+)/${action}$`, 'u'),
      signIn: MANAGE,
      handler: async ({ params: [driveId], response }) => {
        jsonResponse(response, 202, { job: driveJobs.begin(driveId, { action }) });
      },
    })),
    {
      method: 'POST',
      pattern: /^\/storage\/drives\/([^/]+)\/forget$/u,
      signIn: MANAGE,
      handler: async ({ params: [driveId], response }) => {
        jsonResponse(response, 200, await storage.forgetDrive(driveId));
      },
    },
    {
      method: 'POST',
      path: '/storage/buckets',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        jsonResponse(response, 200, await backupAgent.connectObjectDestination(bucketInput(await body())));
      },
    },
    {
      method: 'POST',
      path: '/storage/buckets/test',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        jsonResponse(response, 200, await backupAgent.testObjectDestination(bucketInput(await body())));
      },
    },
    {
      method: 'POST',
      path: '/storage/buckets/remove',
      signIn: MANAGE,
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        jsonResponse(response, 200, await backupAgent.disconnectObjectDestination({ destinationId: String((await body()).id || '') }));
      },
    },
    // Erases the stick into an ordinary drive, as a job the page reads back with the
    // storage list; the screen asked for a confirmation first.
    {
      method: 'POST',
      path: '/storage/installer-stick/format',
      signIn: MANAGE,
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        if (input.confirmed !== true) {
          jsonResponse(response, 400, { code: 'CONFIRMATION_REQUIRED', error: 'Confirm that the installer on the stick may be erased.' });
          return;
        }
        jsonResponse(response, 202, { job: driveJobs.begin(stickJobId(String(input.devicePath || '')), { action: STICK_ACTION }) });
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/add',
      signIn: 'Sign in to manage backups.',
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await storage.holdBackups(String(input.storageId || ''), { primary: input.primary === true }));
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/release',
      signIn: 'Sign in to manage backups.',
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        jsonResponse(response, 200, await storage.releaseBackups(String((await body()).storageId || '')));
      },
    },
  ];
}

module.exports = { storageRoutes };
