'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const MIGRATIONS = [
  {
    version: 1,
    name: 'viewer_registry',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE models (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        provider_model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed','unregistered')),
        active_version_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        unregistered_at TEXT,
        UNIQUE(provider, provider_model_id)
      );

      CREATE TABLE model_versions (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        provider_version_id TEXT NOT NULL,
        source_locator_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed')),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        georef_json TEXT NOT NULL DEFAULT '{}',
        point_count INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(model_id, provider_version_id)
      );

      CREATE INDEX model_versions_model_idx ON model_versions(model_id, created_at DESC);

      CREATE TABLE model_assets (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        root_key TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        format TEXT,
        content_type TEXT,
        byte_size INTEGER,
        created_at TEXT NOT NULL,
        UNIQUE(version_id, kind)
      );

      CREATE TABLE model_aliases (
        alias_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE import_jobs (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        identifier TEXT NOT NULL,
        request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','importing','ready','failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        model_id TEXT REFERENCES models(id) ON DELETE SET NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT
      );

      CREATE INDEX import_jobs_status_idx ON import_jobs(status, created_at);

      CREATE TABLE public_shares (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        version_policy TEXT NOT NULL CHECK (version_policy IN ('latest','pinned')),
        model_version_id TEXT REFERENCES model_versions(id) ON DELETE RESTRICT,
        public_id_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        permissions_json TEXT NOT NULL,
        label TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT,
        revoked_by TEXT,
        revoke_reason TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TEXT
      );

      CREATE INDEX public_shares_model_idx ON public_shares(model_id, created_at DESC);

      CREATE TABLE session_grants (
        id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        subject TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('ops','client')),
        permissions_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        redeemed_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX session_grants_expiry_idx ON session_grants(expires_at);

      CREATE TABLE service_nonces (
        key_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(key_id, nonce)
      );

      CREATE INDEX service_nonces_created_idx ON service_nonces(created_at);

      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX audit_events_created_idx ON audit_events(created_at DESC);
      CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'application_state',
    sql: `
      CREATE TABLE app_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    name: 'viewer_sessions',
    sql: `
      CREATE TABLE viewer_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE RESTRICT,
        model_version_id TEXT NOT NULL REFERENCES model_versions(id) ON DELETE RESTRICT,
        subject TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('ops','client')),
        permissions_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX viewer_sessions_expiry_idx ON viewer_sessions(expires_at);
      CREATE INDEX viewer_sessions_model_idx ON viewer_sessions(model_id, expires_at);
    `,
  },
  {
    version: 4,
    name: 'service_idempotency',
    sql: `
      CREATE TABLE service_idempotency (
        key_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_status INTEGER,
        response_ciphertext TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(key_id, idempotency_key)
      );
      CREATE INDEX service_idempotency_expiry_idx ON service_idempotency(expires_at);
    `,
  },
];

function applyMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const applied = new Set(
    database.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare(
        'INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)',
      ).run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function openDatabase(databasePath) {
  if (!databasePath) throw new Error('databasePath is required');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON');
  database.exec('PRAGMA journal_mode=WAL');
  database.exec('PRAGMA synchronous=NORMAL');
  database.exec('PRAGMA busy_timeout=5000');
  applyMigrations(database);
  return database;
}

module.exports = { MIGRATIONS, applyMigrations, openDatabase };
