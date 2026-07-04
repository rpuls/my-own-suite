const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATABASE_FILENAME = 'suite-manager.sqlite';
const LEGACY_STATE_FILENAME = 'platform-state.json';

const MIGRATIONS = [
  {
    name: 'owner-and-sessions',
    sql: `
      CREATE TABLE owners (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        owner_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX sessions_owner_id_idx ON sessions(owner_id);
    `,
    version: 1,
  },
  {
    name: 'https-settings',
    sql: `
      CREATE TABLE https_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        base_domain TEXT,
        tls_mode TEXT NOT NULL DEFAULT 'off' CHECK (tls_mode IN ('off', 'cloudflare-dns01')),
        acme_email TEXT,
        provider TEXT CHECK (provider IS NULL OR provider = 'cloudflare'),
        configured_at TEXT,
        updated_at TEXT NOT NULL,
        pending_base_domain TEXT,
        pending_acme_email TEXT,
        last_apply_status TEXT NOT NULL DEFAULT 'never' CHECK (last_apply_status IN ('never', 'applying', 'applied', 'failed')),
        last_apply_at TEXT,
        last_apply_error_code TEXT,
        last_apply_diagnostics TEXT
      ) STRICT;

      INSERT INTO https_settings (id, updated_at) VALUES (1, CURRENT_TIMESTAMP);
    `,
    version: 2,
  },
  {
    name: 'homepage-revisions-and-operations',
    sql: `
      CREATE TABLE homepage_revisions (
        file TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE homepage_operations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applying', 'applied', 'failed')),
        file TEXT,
        revision TEXT,
        error_code TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
    `,
    version: 3,
  },
  {
    name: 'app-package-instances',
    sql: `
      CREATE TABLE app_instances (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL UNIQUE,
        package_version TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('installing', 'installed', 'disabled', 'failed', 'uninstalling', 'uninstalled', 'needs-config')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        display_name_snapshot TEXT NOT NULL,
        category_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        installed_at TEXT
      ) STRICT;

      CREATE INDEX app_instances_package_id_idx ON app_instances(package_id);

      CREATE TABLE app_instance_config (
        instance_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT,
        source TEXT NOT NULL CHECK (source IN ('user', 'generated', 'default', 'system')),
        secret_ref TEXT,
        redacted_label TEXT,
        fingerprint TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, key),
        FOREIGN KEY (instance_id) REFERENCES app_instances(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE app_instance_projections (
        instance_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('compose', 'caddy', 'homepage', 'env', 'health', 'backup')),
        content_json TEXT NOT NULL,
        digest TEXT NOT NULL,
        applied_digest TEXT,
        status TEXT NOT NULL CHECK (status IN ('rendered', 'applied', 'failed')),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (instance_id, kind),
        FOREIGN KEY (instance_id) REFERENCES app_instances(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE app_operations (
        id TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('install', 'apply', 'disable', 'enable', 'uninstall', 'update', 'validate')),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        error_code TEXT,
        diagnostics TEXT,
        request_json TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (instance_id) REFERENCES app_instances(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX app_operations_instance_id_idx ON app_operations(instance_id);
    `,
    version: 4,
  },
  {
    name: 'app-instance-guides',
    sql: `
      CREATE TABLE app_instance_guides (
        instance_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('not-started', 'viewed', 'completed', 'skipped')),
        manifest_digest TEXT NOT NULL,
        first_viewed_at TEXT,
        completed_at TEXT,
        skipped_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (instance_id) REFERENCES app_instances(id) ON DELETE CASCADE
      ) STRICT;
    `,
    version: 5,
  },
  {
    name: 'app-integrations',
    sql: `
      CREATE TABLE app_integrations (
        id TEXT PRIMARY KEY,
        provider_instance_id TEXT NOT NULL,
        consumer_instance_id TEXT NOT NULL,
        provider_capability_id TEXT NOT NULL,
        consumer_integration_slot TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned', 'applying', 'active', 'degraded', 'disabled', 'removing', 'removed', 'failed')),
        desired_projection_digest TEXT,
        last_applied_projection_digest TEXT,
        consumed_export_digest TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider_instance_id, consumer_instance_id, provider_capability_id, consumer_integration_slot),
        FOREIGN KEY (provider_instance_id) REFERENCES app_instances(id) ON DELETE CASCADE,
        FOREIGN KEY (consumer_instance_id) REFERENCES app_instances(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX app_integrations_provider_idx ON app_integrations(provider_instance_id);
      CREATE INDEX app_integrations_consumer_idx ON app_integrations(consumer_instance_id);
    `,
    version: 6,
  },
];

class OwnerAlreadyExistsError extends Error {}

function readLegacyState(legacyStatePath) {
  const parsed = JSON.parse(fs.readFileSync(legacyStatePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Legacy Suite Manager state must be a JSON object.');
  }

  if (parsed.owner !== null && parsed.owner !== undefined) {
    const owner = parsed.owner;
    for (const field of ['createdAt', 'email', 'name', 'passwordHash']) {
      if (typeof owner[field] !== 'string' || !owner[field]) {
        throw new Error(`Legacy Suite Manager owner is missing ${field}.`);
      }
    }
  }

  const sessions = parsed.sessions === undefined ? [] : parsed.sessions;
  if (!Array.isArray(sessions)) {
    throw new Error('Legacy Suite Manager sessions must be an array.');
  }
  for (const session of sessions) {
    if (typeof session?.createdAt !== 'string' || typeof session?.tokenHash !== 'string') {
      throw new Error('Legacy Suite Manager session is invalid.');
    }
  }
  if (!parsed.owner && sessions.length > 0) {
    throw new Error('Legacy Suite Manager state cannot contain sessions without an owner.');
  }

  return { owner: parsed.owner || null, sessions };
}

class SuiteManagerStore {
  constructor(stateDir) {
    if (!stateDir) {
      throw new Error('stateDir is required.');
    }

    this.stateDir = stateDir;
    this.databasePath = path.join(stateDir, DATABASE_FILENAME);
    this.legacyStatePath = path.join(stateDir, LEGACY_STATE_FILENAME);
    this.legacyMigratedPath = `${this.legacyStatePath}.migrated`;
    const databaseExisted = fs.existsSync(this.databasePath);
    const legacyState = !databaseExisted && fs.existsSync(this.legacyStatePath)
      ? readLegacyState(this.legacyStatePath)
      : null;

    fs.mkdirSync(this.stateDir, { recursive: true });

    try {
      this.database = new DatabaseSync(this.databasePath);
      this.configure();
      this.migrate();
      if (legacyState) {
        this.importLegacyState(legacyState);
        fs.renameSync(this.legacyStatePath, this.legacyMigratedPath);
      }
    } catch (error) {
      this.database?.close();
      if (!databaseExisted) {
        for (const suffix of ['', '-shm', '-wal']) {
          fs.rmSync(`${this.databasePath}${suffix}`, { force: true });
        }
      }
      throw error;
    }
  }

  configure() {
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.database.exec('PRAGMA busy_timeout = 5000;');
    this.database.exec('PRAGMA journal_mode = WAL;');
  }

  migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);

    for (const migration of MIGRATIONS) {
      this.transaction(() => {
        const applied = this.database.prepare(
          'SELECT 1 FROM schema_migrations WHERE version = ?',
        ).get(migration.version);
        if (applied) {
          return;
        }
        this.database.exec(migration.sql);
        this.database.prepare(`
          INSERT INTO schema_migrations (version, name, applied_at)
          VALUES (?, ?, ?)
        `).run(migration.version, migration.name, new Date().toISOString());
      });
    }
  }

  transaction(operation) {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      this.database.exec('COMMIT;');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  getOwner() {
    return this.database.prepare(`
      SELECT created_at AS createdAt, email, id, name, password_hash AS passwordHash
      FROM owners
      WHERE id = 1
    `).get() || null;
  }

  hasSession(tokenHash) {
    return Boolean(this.database.prepare('SELECT 1 FROM sessions WHERE token_hash = ?').get(tokenHash));
  }

  getHttpsSettings() {
    return this.database.prepare(`
      SELECT
        acme_email AS acmeEmail,
        base_domain AS baseDomain,
        configured_at AS configuredAt,
        last_apply_at AS lastApplyAt,
        last_apply_diagnostics AS lastApplyDiagnostics,
        last_apply_error_code AS lastApplyErrorCode,
        last_apply_status AS lastApplyStatus,
        pending_acme_email AS pendingAcmeEmail,
        pending_base_domain AS pendingBaseDomain,
        provider,
        tls_mode AS tlsMode,
        updated_at AS updatedAt
      FROM https_settings
      WHERE id = 1
    `).get();
  }

  beginHttpsApply({ acmeEmail, baseDomain, at }) {
    this.database.prepare(`
      UPDATE https_settings
      SET pending_base_domain = ?, pending_acme_email = ?, last_apply_status = 'applying',
          last_apply_at = ?, last_apply_error_code = NULL, last_apply_diagnostics = NULL,
          updated_at = ?
      WHERE id = 1
    `).run(baseDomain, acmeEmail, at, at);
  }

  completeHttpsApply(at) {
    this.database.prepare(`
      UPDATE https_settings
      SET base_domain = pending_base_domain, acme_email = pending_acme_email,
          provider = 'cloudflare', tls_mode = 'cloudflare-dns01',
          configured_at = COALESCE(configured_at, ?), updated_at = ?,
          pending_base_domain = NULL, pending_acme_email = NULL,
          last_apply_status = 'applied', last_apply_at = ?,
          last_apply_error_code = NULL, last_apply_diagnostics = NULL
      WHERE id = 1
    `).run(at, at, at);
  }

  failHttpsApply({ at, diagnostics = null, errorCode }) {
    this.database.prepare(`
      UPDATE https_settings
      SET pending_base_domain = NULL, pending_acme_email = NULL,
          last_apply_status = 'failed', last_apply_at = ?,
          last_apply_error_code = ?, last_apply_diagnostics = ?, updated_at = ?
      WHERE id = 1
    `).run(at, errorCode, diagnostics, at);
  }

  recordHomepageRevision({ at, file, revision }) {
    this.database.prepare(`
      INSERT INTO homepage_revisions (file, revision, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(file) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at
    `).run(file, revision, at);
  }

  startHomepageOperation({ at, id, kind }) {
    this.database.prepare(`
      INSERT INTO homepage_operations (id, kind, status, started_at) VALUES (?, ?, 'applying', ?)
    `).run(id, kind, at);
  }

  completeHomepageOperation({ at, file, id, revision }) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE homepage_operations SET status = 'applied', file = ?, revision = ?, completed_at = ? WHERE id = ?
      `).run(file, revision, at, id);
      this.recordHomepageRevision({ at, file, revision });
    });
  }

  failHomepageOperation({ at, errorCode, id }) {
    this.database.prepare(`
      UPDATE homepage_operations SET status = 'failed', error_code = ?, completed_at = ? WHERE id = ?
    `).run(errorCode, at, id);
  }

  getAppInstances() {
    return this.database.prepare(`
      SELECT
        category_snapshot AS categorySnapshot,
        created_at AS createdAt,
        display_name_snapshot AS displayNameSnapshot,
        enabled,
        id,
        installed_at AS installedAt,
        manifest_digest AS manifestDigest,
        package_id AS packageId,
        package_version AS packageVersion,
        status,
        updated_at AS updatedAt
      FROM app_instances
      ORDER BY package_id
    `).all().map((row) => ({ ...row, enabled: row.enabled === 1 }));
  }

  getAppInstanceByPackageId(packageId) {
    const row = this.database.prepare(`
      SELECT
        category_snapshot AS categorySnapshot,
        created_at AS createdAt,
        display_name_snapshot AS displayNameSnapshot,
        enabled,
        id,
        installed_at AS installedAt,
        manifest_digest AS manifestDigest,
        package_id AS packageId,
        package_version AS packageVersion,
        status,
        updated_at AS updatedAt
      FROM app_instances
      WHERE package_id = ?
    `).get(packageId);
    return row ? { ...row, enabled: row.enabled === 1 } : null;
  }

  getAppProjections(instanceId) {
    return this.database.prepare(`
      SELECT
        applied_digest AS appliedDigest,
        content_json AS contentJson,
        digest,
        kind,
        status,
        updated_at AS updatedAt
      FROM app_instance_projections
      WHERE instance_id = ?
      ORDER BY kind
    `).all(instanceId).map((row) => ({
      ...row,
      content: JSON.parse(row.contentJson),
      contentJson: undefined,
    }));
  }

  getAppConfig(instanceId) {
    return this.database.prepare(`
      SELECT
        fingerprint,
        key,
        redacted_label AS redactedLabel,
        secret_ref AS secretRef,
        source,
        updated_at AS updatedAt,
        value_json AS valueJson
      FROM app_instance_config
      WHERE instance_id = ?
      ORDER BY key
    `).all(instanceId).map((row) => ({
      ...row,
      secret: Boolean(row.secretRef),
      value: row.valueJson === null || row.valueJson === undefined ? undefined : JSON.parse(row.valueJson),
      valueJson: undefined,
    }));
  }

  getAppGuideState(instanceId) {
    return this.database.prepare(`
      SELECT
        completed_at AS completedAt,
        first_viewed_at AS firstViewedAt,
        instance_id AS instanceId,
        manifest_digest AS manifestDigest,
        skipped_at AS skippedAt,
        status,
        updated_at AS updatedAt
      FROM app_instance_guides
      WHERE instance_id = ?
    `).get(instanceId) || null;
  }

  getAppIntegrations() {
    return this.database.prepare(`
      SELECT
        consumer_instance_id AS consumerInstanceId,
        consumer_integration_slot AS consumerIntegrationSlot,
        consumed_export_digest AS consumedExportDigest,
        created_at AS createdAt,
        desired_projection_digest AS desiredProjectionDigest,
        id,
        last_applied_projection_digest AS lastAppliedProjectionDigest,
        last_error_code AS lastErrorCode,
        provider_capability_id AS providerCapabilityId,
        provider_instance_id AS providerInstanceId,
        status,
        updated_at AS updatedAt
      FROM app_integrations
      ORDER BY created_at
    `).all();
  }

  upsertAppConfigRows({ at, rows }) {
    for (const row of rows) {
      this.database.prepare(`
        INSERT INTO app_instance_config (
          instance_id, key, value_json, source, secret_ref, redacted_label, fingerprint, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, key) DO UPDATE SET
          value_json = excluded.value_json,
          source = excluded.source,
          secret_ref = excluded.secret_ref,
          redacted_label = excluded.redacted_label,
          fingerprint = excluded.fingerprint,
          updated_at = excluded.updated_at
      `).run(
        row.instanceId,
        row.key,
        row.valueJson ?? null,
        row.source,
        row.secretRef ?? null,
        row.redactedLabel ?? null,
        row.fingerprint ?? null,
        at,
      );
    }
  }

  replaceAppProjections({ at, instanceId, projections }) {
    for (const projection of projections) {
      this.database.prepare(`
        INSERT INTO app_instance_projections (
          instance_id, kind, content_json, digest, applied_digest, status, updated_at
        )
        VALUES (?, ?, ?, ?, NULL, 'rendered', ?)
        ON CONFLICT(instance_id, kind) DO UPDATE SET
          content_json = excluded.content_json,
          digest = excluded.digest,
          applied_digest = CASE
            WHEN app_instance_projections.applied_digest = excluded.digest THEN app_instance_projections.applied_digest
            ELSE NULL
          END,
          status = CASE
            WHEN app_instance_projections.applied_digest = excluded.digest THEN app_instance_projections.status
            ELSE 'rendered'
          END,
          updated_at = excluded.updated_at
      `).run(instanceId, projection.kind, projection.contentJson, projection.digest, at);
    }
    this.database.prepare(`
      UPDATE app_instances
      SET updated_at = ?
      WHERE id = ?
    `).run(at, instanceId);
  }

  beginAppIntegration({ at, consumerInstanceId, consumerIntegrationSlot, consumedExportDigest, desiredProjectionDigest, id, providerCapabilityId, providerInstanceId }) {
    this.database.prepare(`
      INSERT INTO app_integrations (
        id, provider_instance_id, consumer_instance_id, provider_capability_id, consumer_integration_slot,
        status, desired_projection_digest, consumed_export_digest, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'applying', ?, ?, ?, ?)
      ON CONFLICT(provider_instance_id, consumer_instance_id, provider_capability_id, consumer_integration_slot) DO UPDATE SET
        status = 'applying',
        desired_projection_digest = excluded.desired_projection_digest,
        consumed_export_digest = excluded.consumed_export_digest,
        last_error_code = NULL,
        updated_at = excluded.updated_at
    `).run(
      id,
      providerInstanceId,
      consumerInstanceId,
      providerCapabilityId,
      consumerIntegrationSlot,
      desiredProjectionDigest,
      consumedExportDigest,
      at,
      at,
    );
  }

  completeAppIntegration({ at, consumerInstanceId, consumerIntegrationSlot, lastAppliedProjectionDigest, providerCapabilityId, providerInstanceId }) {
    this.database.prepare(`
      UPDATE app_integrations
      SET status = 'active',
          last_applied_projection_digest = ?,
          last_error_code = NULL,
          updated_at = ?
      WHERE provider_instance_id = ?
        AND consumer_instance_id = ?
        AND provider_capability_id = ?
        AND consumer_integration_slot = ?
    `).run(lastAppliedProjectionDigest, at, providerInstanceId, consumerInstanceId, providerCapabilityId, consumerIntegrationSlot);
  }

  failAppIntegration({ at, consumerInstanceId, consumerIntegrationSlot, errorCode, providerCapabilityId, providerInstanceId }) {
    this.database.prepare(`
      UPDATE app_integrations
      SET status = 'failed',
          last_error_code = ?,
          updated_at = ?
      WHERE provider_instance_id = ?
        AND consumer_instance_id = ?
        AND provider_capability_id = ?
        AND consumer_integration_slot = ?
    `).run(errorCode, at, providerInstanceId, consumerInstanceId, providerCapabilityId, consumerIntegrationSlot);
  }

  markAppIntegrationStatus({ at, errorCode = null, id, status }) {
    this.database.prepare(`
      UPDATE app_integrations
      SET status = ?,
          last_error_code = ?,
          updated_at = ?
      WHERE id = ?
    `).run(status, errorCode, at, id);
  }

  markAppIntegrationsForInstance({ at, errorCode = null, instanceId, status }) {
    this.database.prepare(`
      UPDATE app_integrations
      SET status = ?,
          last_error_code = ?,
          updated_at = ?
      WHERE provider_instance_id = ?
         OR consumer_instance_id = ?
    `).run(status, errorCode, at, instanceId, instanceId);
  }

  setAppGuideStatus({ at, instanceId, status }) {
    if (!['viewed', 'completed', 'skipped'].includes(status)) {
      throw new Error('Invalid app guide status.');
    }
    const instance = this.database.prepare(`
      SELECT manifest_digest AS manifestDigest
      FROM app_instances
      WHERE id = ?
    `).get(instanceId);
    if (!instance) {
      throw new Error('App instance was not found.');
    }
    this.database.prepare(`
      INSERT INTO app_instance_guides (
        instance_id, status, manifest_digest, first_viewed_at, completed_at, skipped_at, updated_at
      )
      VALUES (
        ?, ?, ?, CASE WHEN ? = 'viewed' THEN ? ELSE NULL END,
        CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
        CASE WHEN ? = 'skipped' THEN ? ELSE NULL END,
        ?
      )
      ON CONFLICT(instance_id) DO UPDATE SET
        status = excluded.status,
        manifest_digest = excluded.manifest_digest,
        first_viewed_at = COALESCE(app_instance_guides.first_viewed_at, excluded.first_viewed_at, excluded.updated_at),
        completed_at = CASE WHEN excluded.status = 'completed' THEN excluded.updated_at ELSE app_instance_guides.completed_at END,
        skipped_at = CASE WHEN excluded.status = 'skipped' THEN excluded.updated_at ELSE app_instance_guides.skipped_at END,
        updated_at = excluded.updated_at
    `).run(
      instanceId,
      status,
      instance.manifestDigest,
      status,
      at,
      status,
      at,
      status,
      at,
      at,
    );
    return this.getAppGuideState(instanceId);
  }

  applyAppProjection({ at, instanceId, kind, operationId, request = {} }) {
    this.transaction(() => {
      const projection = this.database.prepare(`
        SELECT digest
        FROM app_instance_projections
        WHERE instance_id = ? AND kind = ?
      `).get(instanceId, kind);
      if (!projection) {
        throw new Error(`App projection ${kind} was not found.`);
      }
      this.database.prepare(`
        UPDATE app_instance_projections
        SET applied_digest = digest, status = 'applied', updated_at = ?
        WHERE instance_id = ? AND kind = ?
      `).run(at, instanceId, kind);
      this.database.prepare(`
        INSERT INTO app_operations (
          id, instance_id, kind, status, request_json, started_at, completed_at
        )
        VALUES (?, ?, 'apply', 'succeeded', ?, ?, ?)
      `).run(operationId, instanceId, JSON.stringify(request), at, at);
      this.database.prepare(`
        UPDATE app_instances
        SET updated_at = ?
        WHERE id = ?
      `).run(at, instanceId);
    });
  }

  applyAppProjections({ at, instanceId, kinds, operationId, request = {} }) {
    this.transaction(() => {
      for (const kind of kinds) {
        const projection = this.database.prepare(`
          SELECT digest
          FROM app_instance_projections
          WHERE instance_id = ? AND kind = ?
        `).get(instanceId, kind);
        if (!projection) {
          throw new Error(`App projection ${kind} was not found.`);
        }
      }
      for (const kind of kinds) {
        this.database.prepare(`
          UPDATE app_instance_projections
          SET applied_digest = digest, status = 'applied', updated_at = ?
          WHERE instance_id = ? AND kind = ?
        `).run(at, instanceId, kind);
      }
      this.database.prepare(`
        INSERT INTO app_operations (
          id, instance_id, kind, status, request_json, started_at, completed_at
        )
        VALUES (?, ?, 'apply', 'succeeded', ?, ?, ?)
      `).run(operationId, instanceId, JSON.stringify(request), at, at);
      this.database.prepare(`
        UPDATE app_instances
        SET updated_at = ?
        WHERE id = ?
      `).run(at, instanceId);
    });
  }

  recordAppHealthCheck({ at, errorCode = null, healthy, instanceId, operationId, request = {} }) {
    this.transaction(() => {
      const projection = this.database.prepare(`
        SELECT digest
        FROM app_instance_projections
        WHERE instance_id = ? AND kind = 'health'
      `).get(instanceId);
      if (!projection) {
        throw new Error('App projection health was not found.');
      }
      this.database.prepare(`
        UPDATE app_instance_projections
        SET applied_digest = CASE WHEN ? THEN digest ELSE applied_digest END,
            status = ?,
            updated_at = ?
        WHERE instance_id = ? AND kind = 'health'
      `).run(healthy ? 1 : 0, healthy ? 'applied' : 'failed', at, instanceId);
      this.database.prepare(`
        INSERT INTO app_operations (
          id, instance_id, kind, status, error_code, request_json, started_at, completed_at
        )
        VALUES (?, ?, 'validate', ?, ?, ?, ?, ?)
      `).run(operationId, instanceId, healthy ? 'succeeded' : 'failed', errorCode, JSON.stringify(request), at, at);
      this.database.prepare(`
        UPDATE app_instances
        SET updated_at = ?
        WHERE id = ?
      `).run(at, instanceId);
    });
  }

  markAppDisabled({ at, instanceId, operationId, request = {} }) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE app_instance_projections
        SET applied_digest = NULL,
            status = CASE WHEN kind IN ('compose', 'health') THEN 'rendered' ELSE status END,
            updated_at = ?
        WHERE instance_id = ? AND kind IN ('compose', 'health')
      `).run(at, instanceId);
      this.database.prepare(`
        UPDATE app_instances
        SET enabled = 0, status = 'disabled', updated_at = ?
        WHERE id = ?
      `).run(at, instanceId);
      this.database.prepare(`
        INSERT INTO app_operations (
          id, instance_id, kind, status, request_json, started_at, completed_at
        )
        VALUES (?, ?, 'disable', 'succeeded', ?, ?, ?)
      `).run(operationId, instanceId, JSON.stringify(request), at, at);
    });
  }

  markAppEnabled({ at, instanceId, operationId, request = {} }) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE app_instances
        SET enabled = 1, status = 'installed', updated_at = ?
        WHERE id = ?
      `).run(at, instanceId);
      this.database.prepare(`
        INSERT INTO app_operations (
          id, instance_id, kind, status, request_json, started_at, completed_at
        )
        VALUES (?, ?, 'enable', 'succeeded', ?, ?, ?)
      `).run(operationId, instanceId, JSON.stringify(request), at, at);
    });
  }

  markAppUninstalled({ at, instanceId, operationId, request = {} }) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE app_instance_projections
        SET applied_digest = NULL,
            status = CASE WHEN kind IN ('compose', 'caddy', 'health', 'homepage') THEN 'rendered' ELSE status END,
            updated_at = ?
        WHERE instance_id = ? AND kind IN ('compose', 'caddy', 'health', 'homepage')
      `).run(at, instanceId);
      this.database.prepare(`
        UPDATE app_instances
        SET enabled = 0, status = 'uninstalled', updated_at = ?
        WHERE id = ?
      `).run(at, instanceId);
      this.database.prepare(`
        INSERT INTO app_operations (
          id, instance_id, kind, status, request_json, started_at, completed_at
        )
        VALUES (?, ?, 'uninstall', 'succeeded', ?, ?, ?)
      `).run(operationId, instanceId, JSON.stringify(request), at, at);
    });
  }

  installAppInstance({ at, config = [], instance, operationId, projections, request = {} }) {
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO app_instances (
          id, package_id, package_version, manifest_digest, status, enabled,
          display_name_snapshot, category_snapshot, created_at, updated_at, installed_at
        )
        VALUES (?, ?, ?, ?, 'installed', 1, ?, ?, ?, ?, ?)
      `).run(
        instance.id,
        instance.packageId,
        instance.packageVersion,
        instance.manifestDigest,
        instance.displayNameSnapshot,
        instance.categorySnapshot,
        at,
        at,
        at,
      );

      for (const item of config) {
        this.database.prepare(`
          INSERT INTO app_instance_config (
            instance_id, key, value_json, source, secret_ref, redacted_label, fingerprint, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          instance.id,
          item.key,
          item.valueJson ?? null,
          item.source,
          item.secretRef ?? null,
          item.redactedLabel ?? null,
          item.fingerprint ?? null,
          at,
        );
      }

      for (const projection of projections) {
        this.database.prepare(`
          INSERT INTO app_instance_projections (
            instance_id, kind, content_json, digest, applied_digest, status, updated_at
          )
          VALUES (?, ?, ?, ?, NULL, 'rendered', ?)
        `).run(instance.id, projection.kind, projection.contentJson, projection.digest, at);
      }

      this.database.prepare(`
        INSERT INTO app_operations (
          id, instance_id, kind, status, request_json, started_at, completed_at
        )
        VALUES (?, ?, 'install', 'succeeded', ?, ?, ?)
      `).run(operationId, instance.id, JSON.stringify(request), at, at);
    });
  }

  createOwnerAndSession(owner, session) {
    this.transaction(() => {
      this.insertOwner(owner);
      this.insertSession(session);
    });
  }

  createSession(session) {
    this.insertSession(session);
  }

  deleteSession(tokenHash) {
    this.database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  insertOwner(owner) {
    try {
      this.database.prepare(`
        INSERT INTO owners (id, name, email, password_hash, created_at)
        VALUES (1, ?, ?, ?, ?)
      `).run(owner.name, owner.email, owner.passwordHash, owner.createdAt);
    } catch (error) {
      if (error.code?.startsWith('ERR_SQLITE_CONSTRAINT')) {
        throw new OwnerAlreadyExistsError('The MOS owner account already exists.', { cause: error });
      }
      throw error;
    }
  }

  insertSession(session) {
    this.database.prepare(`
      INSERT INTO sessions (owner_id, token_hash, created_at)
      VALUES (1, ?, ?)
    `).run(session.tokenHash, session.createdAt);
  }

  importLegacyState(state) {
    this.transaction(() => {
      if (!state.owner) {
        return;
      }
      this.insertOwner(state.owner);
      for (const session of state.sessions) {
        this.insertSession(session);
      }
    });
  }

  close() {
    this.database.close();
  }
}

module.exports = {
  DATABASE_FILENAME,
  LEGACY_STATE_FILENAME,
  MIGRATIONS,
  OwnerAlreadyExistsError,
  SuiteManagerStore,
};
