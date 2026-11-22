'use strict';

// The AI services an owner added, and which app uses which. Kept beside the
// Suite Manager store like the AI connection tables: same database, own rows.

const SERVICE_COLUMNS = `
  id, name, base_url AS baseUrl, key_ref AS keyRef, model, embedding_model AS embeddingModel,
  created_at AS createdAt, tested_at AS testedAt, test_error AS testError
`;

class AiServiceStore {
  constructor(store) {
    this.db = store.database;
  }

  list() {
    return this.db.prepare(`SELECT ${SERVICE_COLUMNS} FROM ai_services ORDER BY created_at, id`).all();
  }

  byId(id) {
    return this.db.prepare(`SELECT ${SERVICE_COLUMNS} FROM ai_services WHERE id = ?`).get(id) || null;
  }

  create({ at, baseUrl, embeddingModel, id, keyRef, model, name }) {
    this.db.prepare(`
      INSERT INTO ai_services (id, name, base_url, key_ref, model, embedding_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, baseUrl, keyRef, model, embeddingModel, at);
  }

  update(id, { baseUrl, embeddingModel, keyRef, model, name }) {
    this.db.prepare(`
      UPDATE ai_services SET name = ?, base_url = ?, key_ref = ?, model = ?, embedding_model = ? WHERE id = ?
    `).run(name, baseUrl, keyRef, model, embeddingModel, id);
  }

  recordTest(id, { at, error }) {
    this.db.prepare('UPDATE ai_services SET tested_at = ?, test_error = ? WHERE id = ?').run(at, error, id);
  }

  remove(id) {
    this.db.prepare('DELETE FROM ai_services WHERE id = ?').run(id);
  }

  appUses() {
    return this.db.prepare('SELECT package_id AS packageId, service_id AS serviceId FROM ai_service_apps ORDER BY package_id').all();
  }

  serviceOfApp(packageId) {
    return this.db.prepare(`
      SELECT ${SERVICE_COLUMNS} FROM ai_services WHERE id = (SELECT service_id FROM ai_service_apps WHERE package_id = ?)
    `).get(packageId) || null;
  }

  setAppService(packageId, serviceId) {
    if (!serviceId) {
      this.db.prepare('DELETE FROM ai_service_apps WHERE package_id = ?').run(packageId);
      return;
    }
    this.db.prepare(`
      INSERT INTO ai_service_apps (package_id, service_id) VALUES (?, ?)
      ON CONFLICT (package_id) DO UPDATE SET service_id = excluded.service_id
    `).run(packageId, serviceId);
  }
}

module.exports = { AiServiceStore };
