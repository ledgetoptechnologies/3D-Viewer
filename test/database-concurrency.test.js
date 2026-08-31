'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { MIGRATIONS, openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');

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

test('v27 reconciles legacy parallel LOD leases before enforcing database singleton uniqueness', (t) => {
  const databasePath = temporaryDatabase(t, 'migration-v27-lod-singleton');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=OFF');
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version < 27)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  const created = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const insert = database.prepare(`INSERT INTO derivative_jobs(
    id,attempt_id,derivative_type,status,request_json,result_json,lease_owner,lease_expires_at,heartbeat_at,created_at,updated_at
  ) VALUES (?,?,?,'leased','{}','{}',?,?,?,?,?)`);
  insert.run('legacy-lod-one', 'legacy-attempt-one', 'mesh_tiles', 'legacy-one', future, created, created, created);
  insert.run('legacy-lod-two', 'legacy-attempt-two', 'lod_audit', 'legacy-two', future, created, created, created);

  const migration = MIGRATIONS.find((item) => item.version === 27);
  database.exec('BEGIN IMMEDIATE');
  database.exec(migration.sql);
  database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
    .run(migration.version, migration.name, new Date().toISOString());
  database.exec('COMMIT');

  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM derivative_jobs WHERE derivative_type IN ('mesh_tiles','lod_audit') AND status='leased'").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM derivative_jobs WHERE derivative_type IN ('mesh_tiles','lod_audit') AND status='pending'").get().n, 1);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='derivative_jobs_single_lod_lease'").get());
  const pending = database.prepare("SELECT id FROM derivative_jobs WHERE status='pending'").get();
  assert.throws(
    () => database.prepare("UPDATE derivative_jobs SET status='leased',lease_owner='old-worker',lease_expires_at=? WHERE id=?").run(future, pending.id),
    /UNIQUE constraint failed/,
  );
  database.close();
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
  assert.equal(upgraded.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 27);
  upgraded.close();
});

test('v23 persists revision-zero recovery state for terminal pre-upgrade LOD jobs', (t) => {
  const databasePath = temporaryDatabase(t, 'migration-v23-lod-recovery');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version < 23)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  const created = new Date().toISOString();
  database.exec('PRAGMA foreign_keys=OFF');
  database.prepare("INSERT INTO derivative_jobs(id,attempt_id,derivative_type,status,request_json,result_json,created_at,updated_at,completed_at) VALUES (?,?,?,'failed',?,?,?, ?,?)")
    .run('legacy-lod-job', 'legacy-attempt', 'mesh_tiles', JSON.stringify({ optional: true, manualRetryCount: 1 }), JSON.stringify({ error: 'old validator rejected output' }), created, created, created);

  const migration=MIGRATIONS.find((item)=>item.version===23);
  database.exec('BEGIN IMMEDIATE');
  database.exec(migration.sql);
  database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
    .run(migration.version,migration.name,new Date().toISOString());
  database.exec('COMMIT');

  const row = database.prepare('SELECT recovery_revision,recovery_requeued_at FROM derivative_jobs WHERE id=?').get('legacy-lod-job');
  assert.equal(row.recovery_revision, 0);
  assert.equal(row.recovery_requeued_at, null);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='derivative_jobs_lod_recovery_idx'").get());
  assert.equal(database.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 23);
  database.close();
});

test('v25 preserves import history while replacing fingerprint uniqueness with a lookup index', (t) => {
  const databasePath=temporaryDatabase(t,'migration-v25-duplicate-imports'),database=new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON');
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const migration of MIGRATIONS.filter((item)=>item.version<25)){
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());
  }
  const processing=new ProcessingRepository(database),repository=new ViewerRepository(database),fingerprint='f'.repeat(64);
  const project=processing.createProject({id:'project-one',displayName:'Migration project'});
  const dataset=processing.createDataset({id:'dataset-one',projectId:project.id,displayName:'Migration dataset',sourceType:'webodm',storageMode:'adopted',rootKey:'datasets',relativePath:'dataset-one'});
  processing.finalizeDataset(dataset.id,[],crypto.createHash('sha256').digest('hex'));
  const task=processing.createTask({id:'task-one',projectId:project.id,datasetId:dataset.id,displayName:'Migration task'});
  const attempt=processing.createImportedAttempt({id:'attempt-one',taskId:task.id,datasetId:dataset.id,providerTaskId:'webodm:migration',createdBy:'ops:test'});
  const model=repository.upsertModelVersion({modelId:'model-one',versionId:'version-one',provider:'webodm',providerModelId:'task-import:import-one',providerVersionId:fingerprint,displayName:'Migration task',status:'ready',assets:[],makeActive:false});
  processing.setAttemptResult(attempt.id,model.id,'version-one');
  processing.recordWebodmTaskImport({id:'import-one',sourceFingerprint:fingerprint,sourceRelativePath:'backup.zip',projectId:project.id,taskId:task.id,datasetId:dataset.id,attemptId:attempt.id,modelId:model.id,modelVersionId:'version-one',assetKinds:[],createdBy:'ops:test'});
  const migration=MIGRATIONS.find((item)=>item.version===25);
  database.exec('BEGIN IMMEDIATE');database.exec(migration.sql);database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());database.exec('COMMIT');
  const preserved=database.prepare('SELECT * FROM webodm_task_imports WHERE id=?').get('import-one');
  assert.equal(preserved.source_fingerprint,fingerprint);
  assert.equal(preserved.project_id,project.id);
  assert.equal(preserved.task_id,task.id);
  assert.equal(preserved.dataset_id,dataset.id);
  assert.equal(preserved.attempt_id,attempt.id);
  assert.equal(preserved.model_id,model.id);
  assert.equal(preserved.model_version_id,'version-one');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(),[]);
  const indexes=database.prepare("PRAGMA index_list('webodm_task_imports')").all(),lookup=indexes.find((item)=>item.name==='webodm_task_imports_fingerprint_idx');
  assert.ok(lookup);
  assert.equal(lookup.unique,0);
  assert.deepEqual(database.prepare("PRAGMA index_info('webodm_task_imports_fingerprint_idx')").all().map((item)=>item.name),['source_fingerprint','created_at','id']);
  assert.doesNotMatch(database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='webodm_task_imports'").get().sql,/source_fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
  assert.equal(database.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,25);
  database.close();
});
