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
  {
    name: 'security-event-buckets',
    sql: `
      CREATE TABLE security_events (
        bucket_start TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('login-throttled')),
        client_fingerprint TEXT NOT NULL,
        event_count INTEGER NOT NULL CHECK (event_count > 0),
        max_retry_seconds INTEGER NOT NULL CHECK (max_retry_seconds > 0),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (bucket_start, event_type, client_fingerprint)
      ) STRICT;

      CREATE INDEX security_events_last_seen_idx ON security_events(last_seen_at);
    `,
    version: 7,
  },
  {
    name: 'installed-app-package-identity',
    sql: `
      ALTER TABLE app_instances ADD COLUMN package_digest TEXT;
      ALTER TABLE app_instances ADD COLUMN source_kind TEXT CHECK (source_kind IS NULL OR source_kind IN ('official-git', 'external-git', 'local'));
      ALTER TABLE app_instances ADD COLUMN source_repository TEXT;
      ALTER TABLE app_instances ADD COLUMN source_path TEXT;
      ALTER TABLE app_instances ADD COLUMN source_revision TEXT;
      ALTER TABLE app_instances ADD COLUMN source_trust TEXT CHECK (source_trust IS NULL OR source_trust IN ('mos-reviewed', 'publisher-signed', 'unverified'));
      ALTER TABLE app_instances ADD COLUMN snapshot_path TEXT;
      ALTER TABLE app_instances ADD COLUMN snapshot_state TEXT NOT NULL DEFAULT 'legacy-unmigrated' CHECK (snapshot_state IN ('legacy-unmigrated', 'installed', 'needs-package-recovery'));
      ALTER TABLE app_instances ADD COLUMN privacy_status TEXT CHECK (privacy_status IS NULL OR privacy_status IN ('reviewed', 'review-required', 'invalidated', 'unverified'));
      ALTER TABLE app_instances ADD COLUMN privacy_posture TEXT;
      ALTER TABLE app_instances ADD COLUMN privacy_reviewed_at TEXT;
    `,
    version: 8,
  },
  {
    name: 'app-update-operation-stages',
    sql: `
      ALTER TABLE app_operations ADD COLUMN stage TEXT;
      ALTER TABLE app_operations ADD COLUMN expected_installed_digest TEXT;
      ALTER TABLE app_operations ADD COLUMN candidate_digest TEXT;
      CREATE INDEX app_operations_active_update_idx ON app_operations(instance_id, kind, status);
    `,
    version: 9,
  },
  {
    name: 'app-update-recovery-state',
    sql: `
      ALTER TABLE app_instances ADD COLUMN update_recovery_state TEXT NOT NULL DEFAULT 'none'
        CHECK (update_recovery_state IN ('none', 'retry-safe', 'rollback-required', 'commit-required'));
      ALTER TABLE app_instances ADD COLUMN update_recovery_error TEXT;
    `,
    version: 10,
  },
  {
    name: 'external-app-sources',
    sql: `
      CREATE TABLE app_sources (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('external-git', 'local')),
        repository TEXT NOT NULL,
        catalog_path TEXT NOT NULL DEFAULT 'apps',
        revision TEXT,
        publisher TEXT,
        signature TEXT,
        trust TEXT NOT NULL CHECK (trust IN ('publisher-signed', 'unverified')),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'unavailable', 'key-rotated', 'compromised', 'removed')),
        status_reason TEXT,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX app_sources_status_idx ON app_sources(status);
    `,
    version: 11,
  },
  {
    // The table was shaped around the only event that existed: a throttled
    // sign-in, which always has a client and always has a retry delay. A package
    // source serving something the gate refused has neither, so the columns are
    // generalised rather than bent — `subject` is whatever the event is about,
    // and a retry delay is now optional. SQLite cannot widen a CHECK in place,
    // so the enum can only grow by rebuilding the table around the existing rows.
    name: 'security-event-subjects',
    sql: `
      CREATE TABLE security_events_rebuilt (
        bucket_start TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN (
          'login-throttled',
          'app-source-candidate-rejected',
          'app-source-download-throttled',
          'app-catalog-refresh-failed',
          'app-catalog-signature-invalid'
        )),
        subject TEXT NOT NULL,
        event_count INTEGER NOT NULL CHECK (event_count > 0),
        max_retry_seconds INTEGER CHECK (max_retry_seconds IS NULL OR max_retry_seconds > 0),
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (bucket_start, event_type, subject)
      ) STRICT;

      INSERT INTO security_events_rebuilt (
        bucket_start, event_type, subject, event_count, max_retry_seconds, first_seen_at, last_seen_at
      )
      SELECT bucket_start, event_type, client_fingerprint, event_count, max_retry_seconds, first_seen_at, last_seen_at
      FROM security_events;

      DROP TABLE security_events;
      ALTER TABLE security_events_rebuilt RENAME TO security_events;

      CREATE INDEX security_events_last_seen_idx ON security_events(last_seen_at);
    `,
    version: 12,
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

  // Hour-bucketed counters, not a log: the question these answer is "is this
  // happening, and how often", and a row per occurrence would be an unbounded
  // record an attacker controls the size of. `subject` is whatever the event is
  // about and is always an opaque identifier — a client fingerprint, a package
  // source id — never a URL, so a credential or a query parameter has nowhere to
  // land here even if a caller has one in hand.
  recordSecurityEvent({
    at,
    eventType,
    maxRows = 5_000,
    retentionDays = 30,
    retryAfterSeconds = null,
    subject,
  }) {
    const occurredAt = new Date(at);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error('Security event timestamp must be valid.');
    }
    const bucketStart = new Date(occurredAt);
    bucketStart.setUTCMinutes(0, 0, 0);
    const cutoff = new Date(occurredAt.getTime() - (retentionDays * 24 * 60 * 60 * 1_000)).toISOString();

    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO security_events (
          bucket_start, event_type, subject, event_count,
          max_retry_seconds, first_seen_at, last_seen_at
        )
        VALUES (?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(bucket_start, event_type, subject) DO UPDATE SET
          event_count = security_events.event_count + 1,
          max_retry_seconds = MAX(security_events.max_retry_seconds, excluded.max_retry_seconds),
          last_seen_at = excluded.last_seen_at
      `).run(
        bucketStart.toISOString(),
        eventType,
        subject,
        retryAfterSeconds,
        occurredAt.toISOString(),
        occurredAt.toISOString(),
      );
      this.database.prepare('DELETE FROM security_events WHERE last_seen_at < ?').run(cutoff);
      const count = this.database.prepare('SELECT COUNT(*) AS count FROM security_events').get().count;
      const excess = Math.max(0, Number(count) - maxRows);
      if (excess > 0) {
        this.database.prepare(`
          DELETE FROM security_events
          WHERE rowid IN (
            SELECT rowid FROM security_events ORDER BY last_seen_at ASC, rowid ASC LIMIT ?
          )
        `).run(excess);
      }
    });
  }

  // Broken out by type, because these do not add up to anything: a throttled
  // sign-in and a source serving a package the gate refused are different facts
  // about different things, and a single total would report seven of one as
  // indistinguishable from seven of the other.
  getSecurityEventSummary({ since }) {
    const byType = this.database.prepare(`
      SELECT
        event_type AS eventType,
        COALESCE(SUM(event_count), 0) AS eventCount,
        COUNT(DISTINCT subject) AS subjectCount,
        MAX(last_seen_at) AS lastSeenAt
      FROM security_events
      WHERE last_seen_at >= ?
      GROUP BY event_type
      ORDER BY event_type
    `).all(since).map((row) => ({
      eventCount: Number(row.eventCount),
      eventType: row.eventType,
      lastSeenAt: row.lastSeenAt || null,
      subjectCount: Number(row.subjectCount),
    }));
    return {
      byType,
      eventCount: byType.reduce((total, row) => total + row.eventCount, 0),
      lastSeenAt: byType.reduce((latest, row) => (!latest || row.lastSeenAt > latest ? row.lastSeenAt : latest), null),
    };
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
        package_digest AS packageDigest,
        package_id AS packageId,
        package_version AS packageVersion,
        privacy_posture AS privacyPosture,
        privacy_reviewed_at AS privacyReviewedAt,
        privacy_status AS privacyStatus,
        snapshot_path AS snapshotPath,
        snapshot_state AS snapshotState,
        source_kind AS sourceKind,
        source_path AS sourcePath,
        source_repository AS sourceRepository,
        source_revision AS sourceRevision,
        source_trust AS sourceTrust,
        status,
        update_recovery_error AS updateRecoveryError,
        update_recovery_state AS updateRecoveryState,
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
        package_digest AS packageDigest,
        package_id AS packageId,
        package_version AS packageVersion,
        privacy_posture AS privacyPosture,
        privacy_reviewed_at AS privacyReviewedAt,
        privacy_status AS privacyStatus,
        snapshot_path AS snapshotPath,
        snapshot_state AS snapshotState,
        source_kind AS sourceKind,
        source_path AS sourcePath,
        source_repository AS sourceRepository,
        source_revision AS sourceRevision,
        source_trust AS sourceTrust,
        status,
        update_recovery_error AS updateRecoveryError,
        update_recovery_state AS updateRecoveryState,
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

  // Owner-added external package sources. This table is deliberately independent
  // of app_instances with no foreign key or cascade, so removing a source never
  // uninstalls an already-installed snapshot.
  listAppSources() {
    return this.database.prepare(`
      SELECT
        added_at AS addedAt,
        catalog_path AS catalogPath,
        id,
        kind,
        publisher,
        repository,
        revision,
        signature,
        status,
        status_reason AS statusReason,
        trust,
        updated_at AS updatedAt
      FROM app_sources
      ORDER BY added_at
    `).all();
  }

  getAppSource(id) {
    return this.database.prepare(`
      SELECT
        added_at AS addedAt,
        catalog_path AS catalogPath,
        id,
        kind,
        publisher,
        repository,
        revision,
        signature,
        status,
        status_reason AS statusReason,
        trust,
        updated_at AS updatedAt
      FROM app_sources
      WHERE id = ?
    `).get(id) || null;
  }

  insertAppSource(record) {
    this.database.prepare(`
      INSERT INTO app_sources (
        id, kind, repository, catalog_path, revision, publisher, signature, trust, status, status_reason, added_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.kind,
      record.repository,
      record.catalogPath,
      record.revision ?? null,
      record.publisher ?? null,
      record.signature ?? null,
      record.trust,
      record.status,
      record.statusReason ?? null,
      record.addedAt,
      record.updatedAt,
    );
    return this.getAppSource(record.id);
  }

  updateAppSourceRevision({ at, id, revision }) {
    this.database.prepare(`
      UPDATE app_sources SET revision = ?, updated_at = ? WHERE id = ?
    `).run(revision, at, id);
    return this.getAppSource(id);
  }

  updateAppSourceStatus({ at, id, status, statusReason = null }) {
    this.database.prepare(`
      UPDATE app_sources SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?
    `).run(status, statusReason, at, id);
    return this.getAppSource(id);
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

  beginAppUpdate({ at, candidateDigest, expectedInstalledDigest, instanceId, operationId, request = {} }) {
    this.transaction(() => {
      const active = this.database.prepare(`
        SELECT id FROM app_operations
        WHERE instance_id = ? AND kind = 'update' AND status IN ('queued', 'running')
      `).get(instanceId);
      if (active) throw new Error('APP_UPDATE_ALREADY_RUNNING');
      this.database.prepare(`
        INSERT INTO app_operations (
          id, instance_id, kind, status, stage, expected_installed_digest, candidate_digest,
          request_json, started_at
        ) VALUES (?, ?, 'update', 'running', 'candidate-verified', ?, ?, ?, ?)
      `).run(operationId, instanceId, expectedInstalledDigest, candidateDigest, JSON.stringify(request), at);
      this.database.prepare(`UPDATE app_instances SET update_recovery_state = 'none', update_recovery_error = NULL WHERE id = ?`).run(instanceId);
    });
  }

  advanceAppUpdate({ at, instanceId, operationId, stage }) {
    const result = this.database.prepare(`
      UPDATE app_operations SET stage = ?
      WHERE id = ? AND instance_id = ? AND kind = 'update' AND status = 'running'
    `).run(stage, operationId, instanceId);
    if (result.changes !== 1) throw new Error('APP_UPDATE_OPERATION_NOT_RUNNING');
    return this.getAppOperation(operationId);
  }

  failAppUpdate({ at, errorCode, instanceId, operationId, recoveryState = 'none', stage }) {
    this.transaction(() => {
      this.database.prepare(`
        UPDATE app_operations
        SET status = 'failed', stage = ?, error_code = ?, completed_at = ?
        WHERE id = ? AND instance_id = ? AND kind = 'update' AND status = 'running'
      `).run(stage, errorCode, at, operationId, instanceId);
      this.database.prepare(`
        UPDATE app_instances SET update_recovery_state = ?, update_recovery_error = ?, updated_at = ? WHERE id = ?
      `).run(recoveryState, recoveryState === 'none' ? null : errorCode, at, instanceId);
    });
    return this.getAppOperation(operationId);
  }

  recoverInterruptedAppUpdates({ at }) {
    const operations = this.database.prepare(`
      SELECT id, instance_id AS instanceId, stage FROM app_operations
      WHERE kind = 'update' AND status = 'running' ORDER BY started_at
    `).all();
    return operations.map((operation) => {
      const recoveryState = operation.stage === 'snapshot-promoted'
        ? 'commit-required'
        : ['candidate-healthy', 'integrations-reconciled', 'homepage-reconciled'].includes(operation.stage)
          ? 'rollback-required'
          : 'retry-safe';
      this.failAppUpdate({
        at,
        errorCode: 'APP_UPDATE_INTERRUPTED',
        instanceId: operation.instanceId,
        operationId: operation.id,
        recoveryState,
        stage: `${operation.stage || 'unknown'}-interrupted`,
      });
      return { ...operation, recoveryState, status: 'recovery-required' };
    });
  }

  // `config` carries only the setup values the candidate newly requires; values
  // the instance already holds are left alone, so committing an update never
  // rewrites or rotates them.
  completeAppUpdate({ at, config = [], homepageApplied = false, instanceId, operationId, instance, projections, snapshotPath }) {
    this.transaction(() => {
      const operation = this.database.prepare(`
        SELECT candidate_digest AS candidateDigest FROM app_operations
        WHERE id = ? AND instance_id = ? AND kind = 'update' AND status = 'running'
      `).get(operationId, instanceId);
      if (!operation || operation.candidateDigest !== instance.packageDigest) throw new Error('APP_UPDATE_OPERATION_NOT_RUNNING');
      this.database.prepare(`
        UPDATE app_instances SET
          package_version = ?, manifest_digest = ?, display_name_snapshot = ?, category_snapshot = ?,
          package_digest = ?, source_kind = ?, source_repository = ?, source_path = ?, source_revision = ?, source_trust = ?,
          snapshot_path = ?, snapshot_state = 'installed', privacy_status = ?, privacy_posture = ?, privacy_reviewed_at = ?,
          update_recovery_state = 'none', update_recovery_error = NULL, updated_at = ?
        WHERE id = ?
      `).run(
        instance.packageVersion, instance.manifestDigest, instance.displayNameSnapshot, instance.categorySnapshot,
        instance.packageDigest, instance.source.kind, instance.source.repository, instance.source.path, instance.source.revision, instance.source.trust,
        snapshotPath, instance.privacy.status, instance.privacy.posture, instance.privacy.reviewedAt, at, instanceId,
      );
      for (const item of config) {
        this.database.prepare(`
          INSERT INTO app_instance_config (
            instance_id, key, value_json, source, secret_ref, redacted_label, fingerprint, updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          instanceId,
          item.key,
          item.valueJson ?? null,
          item.source,
          item.secretRef ?? null,
          item.redactedLabel ?? null,
          item.fingerprint ?? null,
          at,
        );
      }
      this.database.prepare('DELETE FROM app_instance_projections WHERE instance_id = ?').run(instanceId);
      for (const projection of projections) {
        const applied = ['compose', 'caddy', 'health'].includes(projection.kind) || (homepageApplied && projection.kind === 'homepage');
        this.database.prepare(`
          INSERT INTO app_instance_projections (instance_id, kind, content_json, digest, applied_digest, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(instanceId, projection.kind, projection.contentJson, projection.digest, applied ? projection.digest : null, applied ? 'applied' : 'rendered', at);
      }
      this.database.prepare('DELETE FROM app_instance_guides WHERE instance_id = ?').run(instanceId);
      this.database.prepare(`
        UPDATE app_operations SET status = 'succeeded', stage = 'completed', completed_at = ?
        WHERE id = ? AND instance_id = ? AND kind = 'update' AND status = 'running'
      `).run(at, operationId, instanceId);
    });
    return this.getAppOperation(operationId);
  }

  getAppOperation(operationId) {
    const row = this.database.prepare(`
      SELECT id, instance_id AS instanceId, kind, status, stage,
             expected_installed_digest AS expectedInstalledDigest,
             candidate_digest AS candidateDigest, error_code AS errorCode,
             started_at AS startedAt, completed_at AS completedAt
      FROM app_operations WHERE id = ?
    `).get(operationId);
    return row || null;
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

  markAppPackageRecoveryRequired({ at, instanceId }) {
    this.database.prepare(`
      UPDATE app_instances
      SET snapshot_state = 'needs-package-recovery', updated_at = ?
      WHERE id = ? AND snapshot_state = 'legacy-unmigrated'
    `).run(at, instanceId);
  }

  migrateAppPackageIdentity({ at, instanceId, packageDigest, privacy, snapshotPath, source }) {
    this.database.prepare(`
      UPDATE app_instances
      SET package_digest = ?, source_kind = ?, source_repository = ?, source_path = ?,
          source_revision = ?, source_trust = ?, snapshot_path = ?, snapshot_state = 'installed',
          privacy_status = ?, privacy_posture = ?, privacy_reviewed_at = ?, updated_at = ?
      WHERE id = ? AND snapshot_state = 'legacy-unmigrated'
    `).run(
      packageDigest,
      source.kind,
      source.repository,
      source.path,
      source.revision,
      source.trust,
      snapshotPath,
      privacy.status,
      privacy.posture,
      privacy.reviewedAt,
      at,
      instanceId,
    );
  }

  deleteAppInstance({ instanceId }) {
    this.transaction(() => {
      this.database.prepare('DELETE FROM app_instances WHERE id = ?').run(instanceId);
    });
  }

  installAppInstance({ at, config = [], instance, operationId, projections, request = {} }) {
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO app_instances (
          id, package_id, package_version, manifest_digest, status, enabled,
          display_name_snapshot, category_snapshot, created_at, updated_at, installed_at,
          package_digest, source_kind, source_repository, source_path, source_revision, source_trust,
          snapshot_path, snapshot_state, privacy_status, privacy_posture, privacy_reviewed_at
        )
        VALUES (?, ?, ?, ?, 'installed', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        instance.packageDigest ?? null,
        instance.source?.kind ?? null,
        instance.source?.repository ?? null,
        instance.source?.path ?? null,
        instance.source?.revision ?? null,
        instance.source?.trust ?? null,
        instance.snapshotPath ?? null,
        instance.snapshotState ?? 'legacy-unmigrated',
        instance.privacy?.status ?? null,
        instance.privacy?.posture ?? null,
        instance.privacy?.reviewedAt ?? null,
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
