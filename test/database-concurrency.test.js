'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { MIGRATIONS } = require('../server/database');

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
