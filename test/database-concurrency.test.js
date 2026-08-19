'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { MIGRATIONS, openDatabase } = require('../server/database');

const databaseModule = path.resolve(__dirname, '..', 'server', 'database.js');
const childSource = "const {openDatabase}=require(process.argv[1]);const db=openDatabase(process.argv[2]);db.close();";

function openInChild(databasePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childSource, databaseModule, databasePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`database child exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`)));
  });
}

function temporaryDatabase(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `viewer-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'viewer.sqlite');
}

function assertFullyMigrated(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
    assert.deepEqual(versions, MIGRATIONS.map((migration) => migration.version));
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { database.close(); }
}

test('two processes serialize migrations on a new shared volume', async (t) => {
  const databasePath = temporaryDatabase(t, 'migration-empty');
  await Promise.all([openInChild(databasePath), openInChild(databasePath)]);
  assertFullyMigrated(databasePath);
});

test('two processes serialize the same pending upgrade migration', async (t) => {
  const databasePath = temporaryDatabase(t, 'migration-upgrade');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, -1)) {
    database.exec('BEGIN IMMEDIATE');
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
    database.exec('COMMIT');
  }
  database.close();

  await Promise.all([openInChild(databasePath), openInChild(databasePath)]);
  assertFullyMigrated(databasePath);
});

test('v17 fails closed for legacy live unbound published authorization state', (t) => {
  const databasePath = temporaryDatabase(t, 'migration-v17-auth');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version < 17)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  database.exec('PRAGMA foreign_keys=OFF');
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const created = new Date().toISOString();
  const insertGrant = database.prepare(`INSERT INTO session_grants(
    id,model_id,subject,audience,permissions_json,expires_at,redeemed_at,created_at,session_mode
  ) VALUES (?,?,?,?,?,?,?,?,?)`);
  insertGrant.run('published-pending', 'model-one', 'ops:one', 'ops', '{}', future, null, created, 'published');
  insertGrant.run('published-redeemed', 'model-one', 'ops:one', 'ops', '{}', future, created, created, 'published');
  insertGrant.run('review-pending', 'model-one', 'ops:one', 'ops', '{}', future, null, created, 'review');
  const insertSession = database.prepare(`INSERT INTO viewer_sessions(
    id,token_hash,model_id,model_version_id,subject,audience,permissions_json,expires_at,revoked_at,created_at,updated_at,session_mode
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertSession.run('published-live', 'hash-live', 'model-one', 'version-one', 'ops:one', 'ops', '{}', future, null, created, created, 'published');
  insertSession.run('published-expired', 'hash-expired', 'model-one', 'version-one', 'ops:one', 'ops', '{}', past, null, created, created, 'published');
  insertSession.run('review-live', 'hash-review', 'model-one', 'version-one', 'ops:one', 'ops', '{}', future, null, created, created, 'review');
  database.close();

  const upgraded = openDatabase(databasePath);
  assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM session_grants WHERE id='published-pending'").get().count, 0);
  assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM session_grants WHERE id='published-redeemed'").get().count, 1);
  assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM session_grants WHERE id='review-pending'").get().count, 1);
  assert.ok(upgraded.prepare("SELECT revoked_at FROM viewer_sessions WHERE id='published-live'").get().revoked_at);
  assert.equal(upgraded.prepare("SELECT revoked_at FROM viewer_sessions WHERE id='published-expired'").get().revoked_at, null);
  assert.equal(upgraded.prepare("SELECT revoked_at FROM viewer_sessions WHERE id='review-live'").get().revoked_at, null);
  assert.equal(upgraded.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 20);
  upgraded.close();
});
