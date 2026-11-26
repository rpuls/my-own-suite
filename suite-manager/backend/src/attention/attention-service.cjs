'use strict';

// Everything MOS notices by itself that needs the owner, as one list of checks.
// The start page, the Settings sidebar and the diagnostics summary all read it,
// so a new part of MOS adds one entry here and shows up in each.

// A problem that can heal by itself (an app restarting, a drive being plugged
// back in) is reported only once it has lasted this long, so a passing blip
// never reaches the owner.
const GRACE_MS = 2 * 60_000;
// Often enough that the grace period runs while nobody has the start page open.
const WATCH_MS = 60_000;
const BACKUP_STALE_DAYS = 3;
const DAY_MS = 86_400_000;

const DRIVE_TROUBLE = {
  away: 'is not connected',
  failed: 'could not be opened',
  'read-only': 'needs a check',
  unreachable: 'cannot be reached',
};

// `inDiagnostics: false` marks a check the diagnostics summary already reports in
// its own, more technical words.
const CHECKS = [
  {
    id: 'app-stopped',
    tile: 'apps',
    grace: true,
    inDiagnostics: false,
    find: ({ apps }) => (apps || []).filter((app) => app.down).map((app) => ({
      app: app.id, detail: 'and did not start again.', key: app.id, text: `${app.name} stopped`,
    })),
  },
  {
    id: 'app-failed',
    tile: 'apps',
    inDiagnostics: false,
    find: ({ apps }) => (apps || []).filter((app) => app.status === 'failed').map((app) => ({
      app: app.id, detail: 'Its page under Apps says what happened.', key: app.id, text: `${app.name} did not finish installing`,
    })),
  },
  {
    id: 'app-needs-config',
    tile: 'apps',
    find: ({ apps }) => (apps || []).filter((app) => app.status === 'needs-config').map((app) => ({
      app: app.id, detail: 'before it can start.', key: app.id, text: `${app.name} needs to be set up`,
    })),
  },
  {
    id: 'app-drive',
    tile: 'apps',
    grace: true,
    inDiagnostics: false,
    find: ({ apps, storage }) => (storage || []).filter((entry) => DRIVE_TROUBLE[entry.state] && entry.apps?.length).flatMap((entry) => entry.apps
      .map((id) => (apps || []).find((app) => app.id === id))
      .filter(Boolean)
      .map((app) => ({ app: app.id, detail: `because ${entry.name} ${DRIVE_TROUBLE[entry.state]}.`, key: `${app.id}:${entry.id}`, text: `${app.name} cannot open its files` }))),
  },
  {
    id: 'storage',
    tile: 'storage',
    grace: true,
    find: ({ storage }) => (storage || []).filter((entry) => DRIVE_TROUBLE[entry.state] && entry.state !== 'away' && !entry.apps?.length && entry.backups?.ours).map((entry) => ({
      detail: 'so no backup can be written to it.', key: entry.id, text: `${entry.name} ${DRIVE_TROUBLE[entry.state]}`,
    })),
  },
  {
    id: 'ai-tunnel',
    tile: 'ai',
    grace: true,
    find: ({ tunnel }) => (tunnel?.state === 'refused' ? [{
      assistant: tunnel.name, detail: 'Remove it and add it again in Settings.', key: tunnel.clientId, text: `${tunnel.name} cannot reach your suite`,
    }] : []),
  },
  {
    id: 'ai-token',
    tile: 'ai',
    find: ({ ai }) => (ai?.tokenless || []).map((source) => ({
      app: source.id, detail: 'before your assistants can use it.', key: source.id, text: `${source.name} needs a token`,
    })),
  },
  {
    id: 'host-restart',
    tile: 'updates',
    inDiagnostics: false,
    find: ({ updates }) => (updates?.host?.rebootRequired ? [{
      detail: 'Ubuntu installed. Apps are offline for about two minutes.', key: 'host', text: 'A restart finishes a security update',
    }] : []),
  },
  {
    id: 'update-failed',
    tile: 'updates',
    inDiagnostics: false,
    find: ({ updates }) => (updates?.currentJob?.status === 'failed' ? [{
      detail: 'Updates says what happened.', key: updates.currentJob.id || 'last', text: 'The last update did not finish',
    }] : []),
  },
  {
    id: 'backup-failed',
    tile: 'backups',
    find: ({ backups }) => (backups?.schedule?.lastResult?.status === 'failed' ? [{
      detail: backups.schedule.lastResult.message || '', key: 'schedule', text: 'The last automatic backup did not finish',
    }] : []),
  },
  {
    id: 'backup-stale',
    tile: 'backups',
    find: ({ backups, now }) => {
      if (!backups || backups.schedule?.lastResult?.status === 'failed') return [];
      const newest = newestBackupAt(backups);
      if (!newest) return backups.places?.length ? [{ detail: 'Back up now under Backups.', key: 'none', text: 'No backups of this server yet' }] : [];
      const days = Math.floor((now - Date.parse(newest)) / DAY_MS);
      return days > BACKUP_STALE_DAYS ? [{ detail: 'Automatic backups have not run since.', key: 'stale', text: `The last backup was ${days} days ago` }] : [];
    },
  },
];

function newestBackupAt(backups) {
  return (backups?.backups || []).filter((backup) => backup.owner === 'this' && backup.createdAt)
    .map((backup) => backup.createdAt).sort().at(-1) || null;
}

const settle = (promise) => Promise.resolve().then(() => promise).catch(() => null);

class AttentionService {
  constructor({ aiConnections, appPackages, backupAgent, chatGptTunnel, installJobs, now = () => new Date(), storage, store, updateJobs, updates }) {
    Object.assign(this, { aiConnections, appPackages, backupAgent, chatGptTunnel, installJobs, now, storage, store, updateJobs, updates });
    this.firstSeen = new Map();
    this.timer = null;
  }

  // Each source answers on its own; one that cannot answer leaves its tile unknown
  // rather than taking the rest of the page with it.
  async facts() {
    const [down, storage, tunnel, updates, backups] = await Promise.all([
      settle(this.appPackages.containersDown()),
      settle(this.storage.inventory()),
      settle(this.chatGptTunnel.status()),
      settle(this.updates.status()),
      settle(this.backupAgent.status()),
    ]);
    const busy = (id) => Boolean(this.installJobs?.get?.(id)?.status === 'running' || this.updateJobs?.get?.(id)?.status === 'running');
    const apps = this.store.getAppInstances().filter((instance) => instance.status !== 'uninstalled').map((instance) => ({
      down: Boolean(down && instance.status === 'installed' && instance.enabled && !busy(instance.packageId) && down(instance.packageId)),
      enabled: instance.enabled === true,
      id: instance.packageId,
      name: instance.displayNameSnapshot || instance.packageId,
      status: instance.status,
    }));
    const clients = this.aiConnections.aiStore.listClients();
    const tunnelClient = tunnel ? clients.find((client) => client.id === tunnel.clientId && client.enabled) : null;
    return {
      ai: { clients, tokenless: this.tokenlessSources(clients) },
      apps,
      backups,
      now: this.now().getTime(),
      storage: Array.isArray(storage?.storage) ? storage.storage : null,
      tunnel: tunnel && tunnelClient ? { ...tunnel, name: tunnelClient.name } : null,
      updates,
    };
  }

  // An app an assistant may use that has no token yet: every call to it fails.
  tokenlessSources(clients) {
    const catalog = this.aiConnections.catalog;
    return catalog.sources().filter((source) => source.instance && !source.mcp.packageSecret && !catalog.tokenOf(source)
      && clients.some((client) => client.enabled && (client.levels[source.id] || 'off') !== 'off'));
  }

  // Every problem the checks find now, each with when it was first seen; a check
  // with a grace period holds its problem back until it has lasted.
  async issues(facts = null) {
    const known = facts || await this.facts();
    const now = this.now().getTime();
    const found = CHECKS.flatMap((check) => check.find(known).map((issue) => ({ ...issue, check, id: `${check.id}:${issue.key}` })));
    const current = new Set(found.map((issue) => issue.id));
    for (const id of this.firstSeen.keys()) if (!current.has(id)) this.firstSeen.delete(id);
    for (const issue of found) if (!this.firstSeen.has(issue.id)) this.firstSeen.set(issue.id, now);
    return found
      .filter((issue) => !issue.check.grace || now - this.firstSeen.get(issue.id) >= GRACE_MS)
      .map(({ check, key, ...issue }) => ({ ...issue, check: check.id, inDiagnostics: check.inDiagnostics !== false, since: new Date(this.firstSeen.get(issue.id)).toISOString(), tile: check.tile }));
  }

  // What the start page shows: each tile's numbers, and the problems that belong to it.
  async overview() {
    const facts = await this.facts();
    const issues = await this.issues(facts);
    const of = (tile) => issues.filter((issue) => issue.tile === tile);
    const installed = (facts.apps || []).filter((app) => ['installed', 'disabled'].includes(app.status));
    const lastUsed = facts.ai.clients.filter((client) => client.lastUsedAt).sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))[0] || null;
    const system = (facts.storage || []).find((entry) => entry.kind === 'system') || null;
    return {
      ai: {
        connected: facts.ai.clients.filter((client) => client.enabled).length,
        issues: of('ai'),
        lastUsed: lastUsed ? { at: lastUsed.lastUsedAt, by: lastUsed.name } : null,
      },
      apps: {
        issues: of('apps'),
        running: installed.filter((app) => app.status === 'installed' && app.enabled && !app.down).length,
        total: installed.length,
      },
      backups: facts.backups ? {
        issues: of('backups'),
        lastAt: newestBackupAt(facts.backups),
        nextAt: facts.backups.schedule?.enabled ? facts.backups.schedule.nextRunAt || null : null,
        timeZone: facts.backups.schedule?.timeZone || null,
      } : null,
      storage: facts.storage ? {
        issues: of('storage'),
        places: facts.storage.filter((entry) => entry.kind !== 'system' && entry.connected).length,
        systemFreeBytes: system?.availableBytes ?? null,
      } : null,
      updates: facts.updates?.serviceAvailable ? {
        available: facts.updates.updateAvailable === true ? facts.updates.latestRelease?.version || 'A new version' : null,
        checkedAt: facts.updates.checkedAt || null,
        issues: of('updates'),
      } : null,
    };
  }

  watch() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.issues().catch(() => {}); }, WATCH_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { AttentionService, CHECKS, GRACE_MS };
