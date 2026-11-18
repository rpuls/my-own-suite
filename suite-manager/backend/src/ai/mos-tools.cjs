'use strict';

// MOS's own tools, offered as the source "Suite health". They run in-process
// through the same service calls as Suite Manager's own screens, so every lock
// and check those take applies to an AI as well.

const RESTART_WAIT_MS = 45_000;

const APP_ARGUMENT = {
  properties: { app: { description: 'The app, by its name or id as mos_list_apps reports it.', type: 'string' } },
  required: ['app'],
  type: 'object',
};

const TOOLS = [
  {
    annotations: { readOnlyHint: true },
    description: 'List the apps installed on this My Own Suite server and whether each one is running.',
    fixed: {},
    inputSchema: { properties: {}, type: 'object' },
    kind: 'read',
    name: 'list_apps',
    note: null,
    title: 'List apps',
  },
  {
    annotations: { readOnlyHint: true },
    description: 'Check whether one app answers its health check right now.',
    fixed: {},
    inputSchema: APP_ARGUMENT,
    kind: 'read',
    name: 'check_app',
    note: null,
    title: 'Check an app',
  },
  {
    annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: false },
    description: 'Restart one app. Its data stays as it is. Takes up to a few minutes; use check_app afterwards.',
    fixed: {},
    inputSchema: APP_ARGUMENT,
    kind: 'change',
    name: 'restart_app',
    note: 'Its data stays as it is.',
    title: 'Restart an app',
  },
];

function text(value, isError = false) {
  return { content: [{ text: value, type: 'text' }], isError };
}

function createMosTools({ appPackages, runtimeUrls, store }) {
  const installed = () => store.getAppInstances().filter((instance) => instance.status === 'installed');
  const findApp = (wanted) => {
    const needle = String(wanted || '').trim().toLowerCase();
    return installed().find((instance) => instance.packageId === needle || String(instance.displayNameSnapshot || '').toLowerCase() === needle) || null;
  };

  const handlers = {
    list_apps: async () => text(JSON.stringify(installed().map((instance) => ({
      app: instance.packageId,
      name: instance.displayNameSnapshot || instance.packageId,
      running: instance.enabled === true,
    })), null, 2)),

    check_app: async ({ app }) => {
      const instance = findApp(app);
      if (!instance) return text(`No installed app is called "${String(app).slice(0, 80)}".`, true);
      if (!instance.enabled) return text(`${instance.displayNameSnapshot || instance.packageId} is turned off.`);
      try {
        await appPackages.refreshPackageRuntimeStatus(instance.packageId);
        return text(`${instance.displayNameSnapshot || instance.packageId} is running and answers its health check.`);
      } catch (error) {
        return text(`${instance.displayNameSnapshot || instance.packageId} does not answer its health check: ${error.message}`);
      }
    },

    // A restart can outlast an MCP request, so it is waited for only briefly
    // and keeps going after the answer.
    restart_app: async ({ app }) => {
      const instance = findApp(app);
      if (!instance) return text(`No installed app is called "${String(app).slice(0, 80)}".`, true);
      const name = instance.displayNameSnapshot || instance.packageId;
      const restart = appPackages.restartPackageRuntime(instance.packageId, runtimeUrls(instance.packageId));
      const outcome = await Promise.race([
        restart.then(() => 'done', (error) => error),
        new Promise((resolve) => { setTimeout(() => resolve('running'), RESTART_WAIT_MS).unref?.(); }),
      ]);
      restart.catch(() => {});
      if (outcome === 'done') return text(`${name} restarted.`);
      if (outcome === 'running') return text(`${name} is restarting. Check it with check_app in a minute.`);
      return text(`${name} could not be restarted: ${outcome.message}`, true);
    },
  };

  return {
    call: async (name, args) => handlers[name](args && typeof args === 'object' ? args : {}),
    name: 'Suite health',
    tools: TOOLS,
  };
}

module.exports = { createMosTools };
