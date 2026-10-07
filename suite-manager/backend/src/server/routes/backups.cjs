const { restoreGuaranteeFor } = require('../../backups/restore-guarantee.cjs');
const { jsonResponse } = require('../responses.cjs');

const MANAGE = 'Sign in to manage backups.';
const INVALID_PASSWORD = { code: 'INVALID_PASSWORD', error: 'Your current password is incorrect.' };

// Storage credentials go to the agent field by field, so it is never handed
// something the screen did not ask for; nothing here keeps or logs them.
function objectDestination(input) {
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

function recoveryKeyRoutes({ backupAgent, setup }) {
  return [
    // Its own route because saving the key is what the first-backup gate waits for.
    {
      method: 'POST',
      path: '/backups/recovery-key/acknowledge',
      signIn: MANAGE,
      handler: async ({ response }) => {
        jsonResponse(response, 200, await backupAgent.acknowledgeRecoveryKey());
      },
    },
    // Shown freely until saved, then only for the password, which a session left
    // open on a borrowed screen cannot supply.
    {
      method: 'POST',
      path: '/backups/recovery-key/reveal',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        const known = await backupAgent.recoveryKeyStatus();
        if (known.recoveryKey?.acknowledged && !await setup.verifyOwnerPassword(input.password)) {
          jsonResponse(response, 400, INVALID_PASSWORD);
          return;
        }
        jsonResponse(response, 200, await backupAgent.revealRecoveryKey());
      },
    },
    // Always asks for the password: it changes what opens the disk and the archives.
    {
      method: 'POST',
      path: '/backups/recovery-key/rotate',
      signIn: 'Sign in to change your recovery key.',
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        if (!await setup.verifyOwnerPassword(input.password)) {
          jsonResponse(response, 400, INVALID_PASSWORD);
          return;
        }
        jsonResponse(response, 200, await backupAgent.rotateRecoveryKey(), { 'Cache-Control': 'no-store' });
      },
    },
  ];
}

function destinationRoutes({ backupAgent }) {
  return [
    // Another server's key goes straight through to the agent and is never kept here.
    {
      method: 'POST',
      path: '/backups/destinations/unlock',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.unlockDestination({
          destinationId: String(input.destinationId || ''),
          recoveryKey: String(input.recoveryKey || ''),
        }));
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/keys',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.archiveKeys({
          destinationId: String(input.destinationId || ''),
          recoveryKey: String(input.recoveryKey || ''),
        }));
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/keys/remove',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.removeArchiveKey({
          destinationId: String(input.destinationId || ''),
          keyId: String(input.keyId || ''),
          recoveryKey: String(input.recoveryKey || ''),
        }));
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/forget-key',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.forgetDestinationKey(String(input.destinationId || '')));
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/forget-drive',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.forgetDrive(String(input.fsUuid || '')));
      },
    },
    {
      method: 'POST',
      path: '/backups/mount',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.mount(String(input.destinationId || '')));
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/object',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        jsonResponse(response, 200, await backupAgent.connectObjectDestination(objectDestination(await body())));
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/object/test',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        jsonResponse(response, 200, await backupAgent.testObjectDestination(objectDestination(await body())));
      },
    },
    {
      method: 'POST',
      path: '/backups/destinations/object/remove',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.disconnectObjectDestination({ destinationId: String(input.destinationId || '') }));
      },
    },
    // Where everything automatic writes: the schedule and the checkpoint before an update.
    {
      method: 'POST',
      path: '/backups/primary',
      signIn: MANAGE,
      bodyLimit: 4 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.setPrimaryDestination({
          destinationId: input.destinationId === null ? null : String(input.destinationId || ''),
        }));
      },
    },
  ];
}

function backupRoutes(services) {
  const { backupAgent, backupInventory, logger } = services;
  return [
    {
      method: 'GET',
      path: '/backups/status',
      signIn: MANAGE,
      handler: async ({ response }) => {
        try {
          const agentStatus = await backupAgent.status();
          jsonResponse(response, 200, {
            ...agentStatus,
            inventory: backupInventory.inventory(),
            ...restoreGuaranteeFor(agentStatus),
            serviceAvailable: true,
          });
        } catch (error) {
          // Answered 200 so the screen can say so; a genuine fault looks the same as a stopped agent.
          logger.warn('backup-agent-unavailable', { error });
          jsonResponse(response, 200, {
            backups: [],
            currentJob: null,
            destinations: [],
            error: error.message || 'Backup agent is unavailable.',
            interruptedRestore: null,
            inventory: backupInventory.inventory(),
            lastJob: null,
            recoveryKey: null,
            ...restoreGuaranteeFor(null),
            serviceAvailable: false,
          });
        }
      },
    },
    ...recoveryKeyRoutes(services),
    ...destinationRoutes(services),
    {
      method: 'POST',
      path: '/backups/start',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 202, await backupAgent.startBackup({ destinationId: String(input.destinationId || ''), note: String(input.note || '') }));
      },
    },
    {
      method: 'POST',
      path: '/backups/schedule',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.setSchedule({
          enabled: input.enabled === true,
          frequency: String(input.frequency || ''),
          hour: Number(input.hour),
          keepLast: Number(input.keepLast),
          minute: Number(input.minute),
          timeZone: String(input.timeZone || ''),
          weekday: Number(input.weekday),
        }));
      },
    },
    {
      method: 'POST',
      path: '/backups/validate',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 202, await backupAgent.validateBackup({ backupPath: String(input.backupPath || '') }));
      },
    },
    {
      method: 'POST',
      path: '/backups/restore',
      signIn: 'Sign in to restore backups.',
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 202, await backupAgent.startRestore({
          backupPath: String(input.backupPath || ''),
          confirmation: String(input.confirmation || ''),
        }));
      },
    },
    {
      method: 'POST',
      path: '/backups/restore/acknowledge',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.acknowledgeInterruptedRestore({
          confirmation: String(input.confirmation || ''),
        }));
      },
    },
    {
      method: 'POST',
      path: '/backups/note',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.setBackupNote({ backupPath: String(input.backupPath || ''), note: String(input.note || '') }));
      },
    },
    {
      method: 'POST',
      path: '/backups/delete',
      signIn: MANAGE,
      bodyLimit: 8 * 1024,
      handler: async ({ body, response }) => {
        const input = await body();
        jsonResponse(response, 200, await backupAgent.deleteBackup({ backupPath: String(input.backupPath || '') }));
      },
    },
  ];
}

module.exports = { backupRoutes };
