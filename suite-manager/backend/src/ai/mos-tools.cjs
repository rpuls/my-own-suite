'use strict';

// MOS's own tools, offered as the source "Suite Manager". They run in-process
// through the same service calls as Suite Manager's own screens, so every lock
// and check those take applies to an AI as well.

const { TOPICS } = require('../diagnostics/support-bundle.cjs');
const { choice, flag, integer, list, optional, text, toolsFrom } = require('./tool-table.cjs');

const RESTART_WAIT_MS = 45_000;
const ACTIVITY_DEFAULT = 30;
const ACTIVITY_MAX = 100;

const app = text('The app, by its name or id as mos_list_apps reports it.');

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

const TOOLS = {
  list_apps: {
    kind: 'read',
    title: 'List apps',
    says: 'List the apps installed on this My Own Suite server and whether each one is running.',
    run: ({ installed }) => reply(JSON.stringify(installed().map((instance) => ({
      app: instance.packageId,
      name: nameOf(instance),
      running: instance.enabled === true,
    })), null, 2)),
  },

  check_app: {
    kind: 'read',
    title: 'Check an app',
    says: 'Check whether one app answers its health check right now.',
    args: { app },
    run: async ({ appPackages, findApp }, { app: wanted }) => {
      const instance = findApp(wanted);
      if (!instance) return noSuchApp(wanted);
      if (!instance.enabled) return reply(`${nameOf(instance)} is turned off.`);
      try {
        await appPackages.refreshPackageRuntimeStatus(instance.packageId);
        return reply(`${nameOf(instance)} is running and answers its health check.`);
      } catch (error) {
        return reply(`${nameOf(instance)} does not answer its health check: ${error.message}`);
      }
    },
  },

  restart_app: {
    kind: 'change',
    idempotent: true,
    title: 'Restart an app',
    says: 'Restart one app. Its data stays as it is. Takes up to a few minutes; use check_app afterwards.',
    note: 'Its data stays as it is.',
    args: { app },
    // A restart can outlast an MCP request, so it is waited for only briefly
    // and keeps going after the answer.
    run: async ({ appPackages, findApp, runtimeUrls }, { app: wanted }) => {
      const instance = findApp(wanted);
      if (!instance) return noSuchApp(wanted);
      const restart = appPackages.restartPackageRuntime(instance.packageId, runtimeUrls(instance.packageId));
      const outcome = await Promise.race([
        restart.then(() => 'done', (error) => error),
        new Promise((resolve) => { setTimeout(() => resolve('running'), RESTART_WAIT_MS).unref?.(); }),
      ]);
      restart.catch(() => {});
      if (outcome === 'done') return reply(`${nameOf(instance)} restarted.`);
      if (outcome === 'running') return reply(`${nameOf(instance)} is restarting. Check it with check_app in a minute.`);
      return reply(`${nameOf(instance)} could not be restarted: ${outcome.message}`, true);
    },
  },

  diagnostics: {
    kind: 'read',
    title: 'Look into a problem',
    says: () => [
      'Look into a problem on this My Own Suite server. Start with the topic summary, which lists what looks wrong, then read only the topic that explains it.',
      `Topics: ${Object.entries(TOPICS).map(([id, topic]) => `${id}: ${topic.says}`).join(' ')}`,
      'Passwords, tokens and app secrets are masked. Logs are shortened, keeping the newest lines.',
    ].join('\n'),
    args: {
      topic: choice(Object.keys(TOPICS), 'What to look at. Start with summary.'),
      app: optional(text('Only this app, by its name or id as mos_list_apps reports it. Narrows the apps and containers topics.')),
    },
    run: async ({ diagnostics, findAnyApp }, { app: wanted, topic }) => {
      if (!Object.hasOwn(TOPICS, topic)) return reply(`There is no topic "${String(topic).slice(0, 40)}". Topics: ${Object.keys(TOPICS).join(', ')}.`, true);
      const instance = wanted ? findAnyApp(wanted) : null;
      if (wanted && !instance) return noSuchApp(wanted);
      return reply(await diagnostics.read(topic, { app: instance?.packageId ?? null }));
    },
  },

  ai_activity: {
    kind: 'read',
    title: 'See what AI assistants did',
    says: 'What AI assistants did in the apps on this server, newest first: when, which assistant, in which app, which action, and how it ended. It never holds what was read or written. Use it to find out what an assistant changed, or why an action was refused.',
    args: {
      assistant: optional(text('Only this assistant, by the name it has in My Own Suite.')),
      app: optional(text('Only actions in this app, by its name or id as mos_list_apps reports it, or "Suite Manager".')),
      limit: optional(integer(`How many actions, newest first. ${ACTIVITY_DEFAULT} when left out, at most ${ACTIVITY_MAX}.`)),
    },
    run: ({ ai }, { app: wantedApp, assistant, limit }) => {
      let clientId = null;
      if (assistant) {
        const client = ai.clients().find((candidate) => candidate.name.toLowerCase() === String(assistant).trim().toLowerCase());
        if (!client) return reply(`No assistant is called "${String(assistant).slice(0, 80)}". Assistants: ${ai.clients().map((candidate) => candidate.name).join(', ') || 'none'}.`, true);
        clientId = client.id;
      }
      const wanted = Math.min(Math.max(Number.parseInt(limit, 10) || ACTIVITY_DEFAULT, 1), ACTIVITY_MAX);
      const needle = String(wantedApp || '').trim().toLowerCase();
      const entries = ai.activity({ clientId, limit: needle ? 200 : wanted }).entries
        .filter((entry) => !needle || entry.sourceId === needle || String(entry.sourceName || '').toLowerCase() === needle)
        .slice(0, wanted);
      if (!entries.length) return reply('No AI activity matches.');
      return reply(entries.map(activityLine).join('\n'));
    },
  },

  dashboard_get: {
    kind: 'read',
    title: 'Look at the dashboard',
    says: `Read the owner's Homepage dashboard: its title, and every group and tile in order. Read it before changing anything. ${DASHBOARD_MODEL}`,
    run: async ({ homepage }) => {
      try { return reply(JSON.stringify(await homepage.dashboard(), null, 1)); } catch (error) { return dashboardFailed(error); }
    },
  },

  dashboard_change: {
    kind: 'change',
    title: 'Change the dashboard',
    note: 'Every change can be undone under Customize → History.',
    says: [
      'Change the Homepage dashboard with a list of operations, applied in order, all or nothing.',
      'Send everything one request needs in one call, so the owner can undo it as one step.',
      'Set preview to true to see what would change without changing anything, when the request is unclear.',
      'Operations: move {tile, to, position?, from?}; edit {tile, from?, name?, description?, icon?, link?}; add_link {to, name, link, description, icon?, position?}; remove_link {tile, from?};',
      'add_group {name, parent?, position?}; rename_group {group, name}; move_group {group, position}; remove_group {group} (only when empty); set_layout {group, style?, columns?} (top-level groups); set_title {title}.',
      DASHBOARD_MODEL,
    ].join(' '),
    args: {
      operations: list(DASHBOARD_OPERATION, { max: 50, min: 1 }),
      preview: optional(flag('true to only describe the change.')),
    },
    run: async ({ homepage }, { operations, preview }, { client }) => {
      try {
        const result = await homepage.changeDashboard({ actor: client?.name || 'An AI', operations, preview: preview === true });
        const lines = result.summary.map((line) => `- ${line}`).join('\n');
        return reply(result.applied
          ? `Done. The dashboard now shows the change:\n${lines}\nThe owner can undo it under Customize → History.`
          : `Preview only, nothing was changed:\n${lines}`);
      } catch (error) { return dashboardFailed(error); }
    },
  },

  dashboard_history: {
    kind: 'read',
    title: 'Look at the dashboard history',
    says: 'List the saved versions of the dashboard, newest first, each with who changed it and what. The one marked current is how it looks now.',
    run: ({ homepage }) => {
      const { checkpoints } = homepage.history();
      return reply(JSON.stringify(checkpoints.map(({ actor, at, current, id, summary }) => ({ at, by: actor, current, id, summary })), null, 1));
    },
  },

  dashboard_restore: {
    kind: 'change',
    idempotent: true,
    title: 'Restore the dashboard',
    says: 'Put the dashboard back to a saved version from dashboard_history, for example to undo a change the owner did not like. Going back is saved as a version too, so it can be undone. Tiles of apps follow what is installed now.',
    args: { id: integer('The version id from dashboard_history.') },
    run: async ({ homepage }, { id }, { client }) => {
      try {
        const result = await homepage.restore(id, { actor: client?.name || 'An AI' });
        return reply(result.changed === false ? 'The dashboard already looks like that version.' : 'Done. The dashboard is back to that version, and going back is itself undoable.');
      } catch (error) {
        if (error?.code === 'HOMEPAGE_RESTORE_OPENS_ADDRESSES') return reply(`${error.message.replace(' Confirm to restore it.', '')} Only the owner can do that, under Customize → History.`, true);
        return dashboardFailed(error);
      }
    },
  },
};

function reply(value, isError = false) {
  return { content: [{ text: value, type: 'text' }], isError };
}

function nameOf(instance) {
  return instance.displayNameSnapshot || instance.packageId;
}

function noSuchApp(wanted) {
  return reply(`No installed app is called "${String(wanted).slice(0, 80)}".`, true);
}

function dashboardFailed(error) {
  return reply(error?.message || 'The dashboard could not be changed.', true);
}

function activityLine(entry) {
  const repeats = entry.repeats > 1 ? ` · ${entry.repeats} times` : '';
  return `${String(entry.at).slice(0, 16)}Z · ${entry.clientName || 'a removed assistant'} · ${entry.sourceName || 'unknown app'} · ${entry.toolTitle || entry.tool} · ${entry.outcome}${repeats}`;
}

function createMosTools({ ai, appPackages, diagnostics, homepage, runtimeUrls, store }) {
  const installed = () => store.getAppInstances().filter((instance) => instance.status === 'installed');
  const matches = (wanted) => {
    const needle = String(wanted || '').trim().toLowerCase();
    return (instance) => instance.packageId === needle || nameOf(instance).toLowerCase() === needle;
  };
  const context = {
    ai,
    appPackages,
    diagnostics,
    findAnyApp: (wanted) => store.getAppInstances().find(matches(wanted)) || null,
    findApp: (wanted) => installed().find(matches(wanted)) || null,
    homepage,
    installed,
    runtimeUrls,
  };
  return {
    call: async (name, args, call = {}) => TOOLS[name].run(context, args && typeof args === 'object' ? args : {}, call),
    name: 'Suite Manager',
    tools: toolsFrom(TOOLS),
  };
}

module.exports = { TOOLS, createMosTools };
