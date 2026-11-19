'use strict';

// MOS's own tools, offered as the source "Suite Manager". They run in-process
// through the same service calls as Suite Manager's own screens, so every lock
// and check those take applies to an AI as well.

const RESTART_WAIT_MS = 45_000;

const APP_ARGUMENT = {
  properties: { app: { description: 'The app, by its name or id as mos_list_apps reports it.', type: 'string' } },
  required: ['app'],
  type: 'object',
};

// The Homepage dashboard as groups of tiles. The AI never sees or writes YAML:
// it reads this model and sends operations, and MOS writes the files.
const DASHBOARD_MODEL = [
  'The dashboard is a list of groups, top to bottom. A group holds tiles and at most one level of subgroups, in order.',
  'Name a group as "Group", or a subgroup as "Group > Subgroup". Positions count from 0; leave a position out to put something last.',
  'Every tile has a kind: "app" (placed by My Own Suite for an installed app), "link" (a plain link), or "home-service" (a link that also publishes an address on the suite).',
  'Every tile can be moved and given a new name, description or icon. Only links can be added, removed, or pointed at a new address.',
  'Icons are Homepage icon names such as jellyfin, nextcloud or mdi-folder (Material Design Icons with the mdi- prefix), or the address of an image.',
].join(' ');

const DASHBOARD_OPERATION = {
  properties: {
    columns: { description: 'set_layout: how many columns the group uses, 1 to 8.', type: 'integer' },
    description: { description: 'edit, add_link: the line under the tile name.', type: 'string' },
    from: { description: 'move, edit, remove_link: the group the tile is in, when its name is not unique.', type: 'string' },
    group: { description: 'rename_group, move_group, remove_group, set_layout: the group.', type: 'string' },
    icon: { description: 'edit, add_link: the tile icon.', type: 'string' },
    link: { description: 'edit (links only), add_link: an http or https address.', type: 'string' },
    name: { description: 'edit: the new tile name. add_link: the tile name. add_group, rename_group: the group name.', type: 'string' },
    op: { enum: ['move', 'edit', 'add_link', 'remove_link', 'add_group', 'rename_group', 'move_group', 'remove_group', 'set_layout', 'set_title'], type: 'string' },
    parent: { description: 'add_group: a top-level group to put the new group inside.', type: 'string' },
    position: { description: 'move, add_link, add_group, move_group: the place within the group or list, from 0.', type: 'integer' },
    style: { description: 'set_layout: "row" puts tiles side by side, "column" stacks them.', enum: ['row', 'column'], type: 'string' },
    tile: { description: 'move, edit, remove_link: the tile, by its name.', type: 'string' },
    title: { description: 'set_title: the dashboard title.', type: 'string' },
    to: { description: 'move, add_link: the group to put the tile in.', type: 'string' },
  },
  required: ['op'],
  type: 'object',
};

const DASHBOARD_TOOLS = [
  {
    annotations: { readOnlyHint: true },
    description: `Read the owner's Homepage dashboard: its title, and every group and tile in order. Read it before changing anything. ${DASHBOARD_MODEL}`,
    fixed: {},
    inputSchema: { properties: {}, type: 'object' },
    kind: 'read',
    name: 'dashboard_get',
    note: null,
    title: 'Look at the dashboard',
  },
  {
    annotations: { destructiveHint: false, idempotentHint: false, readOnlyHint: false },
    description: [
      'Change the Homepage dashboard with a list of operations, applied in order, all or nothing.',
      'Send everything one request needs in one call, so the owner can undo it as one step.',
      'Set preview to true to see what would change without changing anything, when the request is unclear.',
      'Operations: move {tile, to, position?, from?}; edit {tile, from?, name?, description?, icon?, link?}; add_link {to, name, link, description, icon?, position?}; remove_link {tile, from?};',
      'add_group {name, parent?, position?}; rename_group {group, name}; move_group {group, position}; remove_group {group} (only when empty); set_layout {group, style?, columns?} (top-level groups); set_title {title}.',
      DASHBOARD_MODEL,
    ].join(' '),
    fixed: {},
    inputSchema: {
      properties: {
        operations: { items: DASHBOARD_OPERATION, maxItems: 50, minItems: 1, type: 'array' },
        preview: { description: 'true to only describe the change.', type: 'boolean' },
      },
      required: ['operations'],
      type: 'object',
    },
    kind: 'change',
    name: 'dashboard_change',
    note: 'Every change can be undone under Customize → History.',
    title: 'Change the dashboard',
  },
  {
    annotations: { readOnlyHint: true },
    description: 'List the saved versions of the dashboard, newest first, each with who changed it and what. The one marked current is how it looks now.',
    fixed: {},
    inputSchema: { properties: {}, type: 'object' },
    kind: 'read',
    name: 'dashboard_history',
    note: null,
    title: 'Look at the dashboard history',
  },
  {
    annotations: { destructiveHint: false, idempotentHint: true, readOnlyHint: false },
    description: 'Put the dashboard back to a saved version from dashboard_history, for example to undo a change the owner did not like. Going back is saved as a version too, so it can be undone. Tiles of apps follow what is installed now.',
    fixed: {},
    inputSchema: { properties: { id: { description: 'The version id from dashboard_history.', type: 'integer' } }, required: ['id'], type: 'object' },
    kind: 'change',
    name: 'dashboard_restore',
    note: null,
    title: 'Restore the dashboard',
  },
];

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
  ...DASHBOARD_TOOLS,
];

function text(value, isError = false) {
  return { content: [{ text: value, type: 'text' }], isError };
}

function createMosTools({ appPackages, homepage, runtimeUrls, store }) {
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

  const failed = (error) => text(error?.message || 'The dashboard could not be changed.', true);
  Object.assign(handlers, {
    dashboard_get: async () => {
      try { return text(JSON.stringify(await homepage.dashboard(), null, 1)); } catch (error) { return failed(error); }
    },
    dashboard_change: async ({ operations, preview }, { client }) => {
      try {
        const result = await homepage.changeDashboard({ actor: client?.name || 'An AI', operations, preview: preview === true });
        const lines = result.summary.map((line) => `- ${line}`).join('\n');
        return text(result.applied
          ? `Done. The dashboard now shows the change:\n${lines}\nThe owner can undo it under Customize → History.`
          : `Preview only, nothing was changed:\n${lines}`);
      } catch (error) { return failed(error); }
    },
    dashboard_history: async () => {
      const { checkpoints } = homepage.history();
      return text(JSON.stringify(checkpoints.map(({ actor, at, current, id, summary }) => ({ at, by: actor, current, id, summary })), null, 1));
    },
    dashboard_restore: async ({ id }, { client }) => {
      try {
        const result = await homepage.restore(id, { actor: client?.name || 'An AI' });
        return text(result.changed === false ? 'The dashboard already looks like that version.' : 'Done. The dashboard is back to that version, and going back is itself undoable.');
      } catch (error) {
        if (error?.code === 'HOMEPAGE_RESTORE_OPENS_ADDRESSES') return text(`${error.message.replace(' Confirm to restore it.', '')} Only the owner can do that, under Customize → History.`, true);
        return failed(error);
      }
    },
  });

  return {
    call: async (name, args, context = {}) => handlers[name](args && typeof args === 'object' ? args : {}, context),
    name: 'Suite Manager',
    tools: TOOLS,
  };
}

module.exports = { createMosTools };
