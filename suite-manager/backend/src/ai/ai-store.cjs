'use strict';

// The AI connection tables, kept beside the Suite Manager store rather than in
// it: they share its database and transactions but none of its other rows.

const ACTIVITY_KEPT_DAYS = 90;
const LEVELS = ['off', 'see', 'act'];

const CLIENT_COLUMNS = `
  id, name, preset, route, default_level AS defaultLevel, enabled,
  created_at AS createdAt, last_used_at AS lastUsedAt
`;

function clientRow(row) {
  return row ? { ...row, enabled: row.enabled === 1 } : null;
}

class AiStore {
  constructor(store) {
    this.store = store;
    this.db = store.database;
  }

  transaction(operation) {
    return this.store.transaction(operation);
  }

  listClients() {
    const clients = this.db.prepare(`SELECT ${CLIENT_COLUMNS} FROM ai_clients ORDER BY created_at, id`).all().map(clientRow);
    const levels = this.db.prepare('SELECT client_id AS clientId, source, level FROM ai_app_levels').all();
    const exceptions = this.db.prepare('SELECT client_id AS clientId, tool, allowed FROM ai_tool_exceptions').all();
    return clients.map((client) => ({
      ...client,
      exceptions: Object.fromEntries(exceptions.filter((row) => row.clientId === client.id).map((row) => [row.tool, row.allowed === 1 ? 'allow' : 'block'])),
      levels: Object.fromEntries(levels.filter((row) => row.clientId === client.id).map((row) => [row.source, row.level])),
    }));
  }

  clientById(id) {
    return clientRow(this.db.prepare(`SELECT ${CLIENT_COLUMNS} FROM ai_clients WHERE id = ?`).get(id));
  }

  clientByTokenHash(tokenHash) {
    return clientRow(this.db.prepare(`SELECT ${CLIENT_COLUMNS} FROM ai_clients WHERE token_hash = ?`).get(tokenHash));
  }

  createClient({ at, id, name, preset, route, tokenHash }) {
    this.db.prepare(`
      INSERT INTO ai_clients (id, name, preset, route, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, preset, route, tokenHash, at);
  }

  updateClient(id, { defaultLevel, enabled, name }) {
    const client = this.clientById(id);
    if (!client) return false;
    this.db.prepare('UPDATE ai_clients SET name = ?, enabled = ?, default_level = ? WHERE id = ?').run(
      name ?? client.name,
      (enabled ?? client.enabled) ? 1 : 0,
      defaultLevel ?? client.defaultLevel,
      id,
    );
    return true;
  }

  replaceClientToken({ id, tokenHash }) {
    return this.db.prepare('UPDATE ai_clients SET token_hash = ? WHERE id = ?').run(tokenHash, id).changes === 1;
  }

  deleteClient(id) {
    return this.db.prepare('DELETE FROM ai_clients WHERE id = ?').run(id).changes === 1;
  }

  markClientUsed({ at, id }) {
    this.db.prepare('UPDATE ai_clients SET last_used_at = ? WHERE id = ?').run(at, id);
  }

  levelFor(client, source) {
    const row = this.db.prepare('SELECT level FROM ai_app_levels WHERE client_id = ? AND source = ?').get(client.id, source);
    return row?.level || client.defaultLevel;
  }

  setLevel({ at, clientId, level, source }) {
    this.db.prepare(`
      INSERT INTO ai_app_levels (client_id, source, level, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (client_id, source) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at
    `).run(clientId, source, level, at);
  }

  exceptionFor(clientId, tool) {
    const row = this.db.prepare('SELECT allowed FROM ai_tool_exceptions WHERE client_id = ? AND tool = ?').get(clientId, tool);
    if (!row) return null;
    return row.allowed === 1 ? 'allow' : 'block';
  }

  setException({ at, clientId, exception, tool }) {
    if (!exception) {
      this.db.prepare('DELETE FROM ai_tool_exceptions WHERE client_id = ? AND tool = ?').run(clientId, tool);
      return;
    }
    this.db.prepare(`
      INSERT INTO ai_tool_exceptions (client_id, tool, allowed, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (client_id, tool) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at
    `).run(clientId, tool, exception === 'allow' ? 1 : 0, at);
  }

  clearExceptions({ clientId, toolPrefix }) {
    this.db.prepare("DELETE FROM ai_tool_exceptions WHERE client_id = ? AND substr(tool, 1, length(?)) = ?").run(clientId, toolPrefix, toolPrefix);
  }

  pins() {
    return new Map(this.db.prepare('SELECT tool, hash FROM ai_tool_pins').all().map((row) => [row.tool, row.hash]));
  }

  pin({ at, hash, tool }) {
    this.db.prepare(`
      INSERT INTO ai_tool_pins (tool, hash, pinned_at) VALUES (?, ?, ?)
      ON CONFLICT (tool) DO UPDATE SET hash = excluded.hash, pinned_at = excluded.pinned_at
    `).run(tool, hash, at);
  }

  // Levels, exceptions and pins of apps that are gone, so a reinstall starts from nothing.
  forgetSourcesOtherThan(liveSources) {
    const sourceIds = liveSources.map((source) => source.id);
    const prefixes = liveSources.map((source) => source.prefix);
    const staleTool = (tool) => !prefixes.some((prefix) => tool.startsWith(prefix));
    this.transaction(() => {
      for (const { source } of this.db.prepare('SELECT DISTINCT source FROM ai_app_levels').all()) {
        if (!sourceIds.includes(source)) this.db.prepare('DELETE FROM ai_app_levels WHERE source = ?').run(source);
      }
      for (const { tool } of this.db.prepare('SELECT DISTINCT tool FROM ai_tool_exceptions').all()) {
        if (staleTool(tool)) this.db.prepare('DELETE FROM ai_tool_exceptions WHERE tool = ?').run(tool);
      }
      for (const { tool } of this.db.prepare('SELECT tool FROM ai_tool_pins').all()) {
        if (staleTool(tool)) this.db.prepare('DELETE FROM ai_tool_pins WHERE tool = ?').run(tool);
      }
    });
  }

  recordActivity({ at, client = null, durationMs, kind = null, method, outcome, sourceName = null, tool = null, toolTitle = null }) {
    this.db.prepare(`
      INSERT INTO ai_activity (at, client_id, client_name, method, tool, tool_title, source_name, kind, outcome, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(at, client?.id || null, client?.name || null, method, tool, toolTitle, sourceName, kind, outcome, Math.max(0, Math.round(durationMs)));
  }

  writesSince({ clientId, since }) {
    return this.db.prepare(`
      SELECT COUNT(*) AS count FROM ai_activity
      WHERE client_id = ? AND at >= ? AND method = 'tools/call' AND kind IN ('add', 'change') AND outcome = 'ok'
    `).get(clientId, since).count;
  }

  // Tool calls only, newest first; `before` is the id of the last row already shown.
  activity({ before = null, clientId = null, limit = 50 } = {}) {
    const rows = this.db.prepare(`
      SELECT a.id, a.at, a.client_id AS clientId, a.client_name AS clientName, (c.id IS NULL) AS clientRemoved,
        a.tool, a.tool_title AS toolTitle, a.source_name AS sourceName, a.kind, a.outcome, a.duration_ms AS durationMs
      FROM ai_activity a LEFT JOIN ai_clients c ON c.id = a.client_id
      WHERE a.method = 'tools/call' AND (? IS NULL OR a.client_id = ?) AND (? IS NULL OR a.id < ?)
      ORDER BY a.id DESC LIMIT ?
    `).all(clientId, clientId, before, before, limit + 1);
    const entries = rows.slice(0, limit).map((row) => ({ ...row, clientRemoved: row.clientRemoved === 1 }));
    return { entries, nextBefore: rows.length > limit ? entries.at(-1).id : null };
  }

  hasActivity() {
    return Boolean(this.db.prepare("SELECT 1 FROM ai_activity WHERE method = 'tools/call' LIMIT 1").get());
  }

  pruneActivity(now) {
    const cutoff = new Date(now.getTime() - ACTIVITY_KEPT_DAYS * 86_400_000).toISOString();
    this.db.prepare('DELETE FROM ai_activity WHERE at < ?').run(cutoff);
  }
}

module.exports = { ACTIVITY_KEPT_DAYS, AiStore, LEVELS };
