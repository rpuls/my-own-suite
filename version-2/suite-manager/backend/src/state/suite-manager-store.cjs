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
