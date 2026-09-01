'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-import-cleanup-'));
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, processing };
}

function insertCleanup(c, id, { state = 'ready', status = 'pending', availableAt = '2026-09-01T12:00:00.000Z', relativePath = `webodm-task-imports/${id}` } = {}) {
  const createdAt = '2026-09-01T11:00:00.000Z';
  c.db.prepare(`INSERT INTO retained_imports(
    id,source_kind,source_root_key,source_relative_path,staging_root_key,staging_relative_path,
    cleanup_jobs_inserted,state,created_at,updated_at
  ) VALUES (?,'server_folder','dataset_import',?,'cache',?,1,?,?,?)`).run(
    id, `sources/${id}`, relativePath, state, createdAt, createdAt,
  );
  c.db.prepare(`INSERT INTO import_cleanup_jobs(
    id,retained_import_id,cleanup_type,root_key,relative_path,status,available_at,created_at,updated_at
  ) VALUES (?,?,'staging_tree','cache',?,?,?,?,?)`).run(
    `${id}:cleanup`, id, relativePath, status, availableAt, createdAt, createdAt,
  );
  return `${id}:cleanup`;
}

function row(c, id) {
  return c.db.prepare('SELECT * FROM import_cleanup_jobs WHERE id=?').get(id);
}

const START = Date.parse('2026-09-01T12:00:00.000Z');

test('cleanup claims are ready-gated, single-item, bounded, and token fenced', (t) => {
  const c = fixture(t);
  insertCleanup(c, 'not-ready', { state: 'failed', availableAt: new Date(START - 1000).toISOString() });
  const firstId = insertCleanup(c, 'ready-one', { availableAt: new Date(START - 500).toISOString() });
  const secondId = insertCleanup(c, 'ready-two', { availableAt: new Date(START - 250).toISOString() });

  const first = c.processing.claimImportCleanup('cleanup-owner', { leaseSeconds: 1, at: START });
  assert.equal(first.id, firstId);
  assert.equal(first.status, 'leased');
  assert.equal(first.lease_owner, 'cleanup-owner');
  assert.match(first.lease_token, /^[a-f0-9]{32}$/);
  assert.equal(first.lease_generation, 1);
  assert.equal(first.attempt_count, 1);
  assert.equal(first.lease_expires_at, new Date(START + 30_000).toISOString());
  assert.equal(row(c, secondId).status, 'pending', 'one claim leases only one job');

  const second = c.processing.claimImportCleanup('cleanup-owner', { leaseSeconds: 86_400, at: START });
  assert.equal(second.id, secondId);
  assert.equal(second.lease_expires_at, new Date(START + 3_600_000).toISOString());
  assert.equal(c.processing.claimImportCleanup('cleanup-owner', { at: START }), null);
  assert.equal(row(c, 'not-ready:cleanup').status, 'pending');
});

test('an expired leased cleanup is reclaimed with a fresh token and generation', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'expired-leased');
  const first = c.processing.claimImportCleanup('first-owner', { leaseSeconds: 30, at: START });
  const successor = c.processing.claimImportCleanup('successor-owner', { leaseSeconds: 30, at: START + 30_000 });

  assert.equal(successor.id, id);
  assert.equal(successor.status, 'leased');
  assert.equal(successor.lease_owner, 'successor-owner');
  assert.notEqual(successor.lease_token, first.lease_token);
  assert.equal(successor.lease_generation, 2);
  assert.equal(successor.attempt_count, 2);
  assert.equal(c.processing.completeImportCleanup(id, 'first-owner', first.lease_token, first.lease_generation, { at: START + 30_001 }), false);
});

test('quarantine intent is repository-derived and the leased lifecycle is fully fenced', (t) => {
  const c = fixture(t), relativePath = 'webodm-task-imports/quarantine-me', id = insertCleanup(c, 'quarantine-me', { relativePath });
  const lease = c.processing.claimImportCleanup('worker-a', { leaseSeconds: 60, at: START });

  assert.equal(c.processing.heartbeatImportCleanup(id, 'worker-b', lease.lease_token, lease.lease_generation, { at: START + 1000 }), false);
  assert.equal(c.processing.heartbeatImportCleanup(id, 'worker-a', lease.lease_token, lease.lease_generation, { leaseSeconds: 120, at: START + 1000 }), true);
  const quarantinePath = c.processing.persistImportCleanupQuarantineIntent(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 2000 });
  assert.equal(quarantinePath, `${relativePath}.cleanup-${lease.lease_token}.quarantine`);
  assert.equal(c.processing.persistImportCleanupQuarantineIntent(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 2001 }), quarantinePath);
  assert.equal(c.processing.markImportCleanupQuarantined(id, 'worker-a', lease.lease_token, lease.lease_generation + 1, { at: START + 3000 }), false);
  assert.equal(c.processing.markImportCleanupQuarantined(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 3000 }), true);
  assert.equal(c.processing.heartbeatImportCleanup(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 4000 }), true);
  assert.equal(c.processing.completeImportCleanup(id, 'worker-a', lease.lease_token, lease.lease_generation, { at: START + 5000 }), true);

  const completed = row(c, id);
  assert.equal(completed.status, 'complete');
  assert.equal(completed.quarantine_relative_path, quarantinePath);
  assert.equal(completed.lease_owner, null);
  assert.equal(completed.lease_token, null);
  assert.ok(completed.completed_at);
});

test('invalid cleanup paths cannot become quarantine intents', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'unsafe-path', { relativePath: '../escape' });
  const lease = c.processing.claimImportCleanup('worker', { at: START });
  assert.throws(
    () => c.processing.persistImportCleanupQuarantineIntent(id, 'worker', lease.lease_token, lease.lease_generation, { at: START + 1 }),
    (error) => error?.code === 'invalid_cleanup_path',
  );
  assert.equal(row(c, id).quarantine_relative_path, null);
});

test('cleanup retry uses exponential backoff without changing retained or model readiness', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'retry-me');
  c.db.prepare("INSERT INTO models(id,provider,provider_model_id,display_name,status,metadata_json,created_at,updated_at) VALUES ('ready-model','webodm','ready-model','Ready model','ready','{}',?,?)").run(new Date(START).toISOString(), new Date(START).toISOString());
  const first = c.processing.claimImportCleanup('worker', { at: START });

  assert.equal(c.processing.retryImportCleanup(id, 'worker', first.lease_token, first.lease_generation, 'temporary delete failure', { at: START + 1000 }), true);
  let retried = row(c, id);
  assert.equal(retried.status, 'pending');
  assert.equal(retried.available_at, new Date(START + 6000).toISOString());
  assert.equal(retried.last_error, 'temporary delete failure');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get('retry-me').state, 'ready');
  assert.equal(c.db.prepare("SELECT status FROM models WHERE id='ready-model'").get().status, 'ready');
  assert.equal(c.processing.claimImportCleanup('too-early', { at: START + 5999 }), null);

  const second = c.processing.claimImportCleanup('worker-two', { at: START + 6000 });
  assert.equal(second.attempt_count, 2);
  assert.equal(second.lease_generation, 2);
  const quarantinePath = c.processing.persistImportCleanupQuarantineIntent(id, 'worker-two', second.lease_token, second.lease_generation, { at: START + 6001 });
  assert.equal(c.processing.markImportCleanupQuarantined(id, 'worker-two', second.lease_token, second.lease_generation, { at: START + 6002 }), true);
  assert.equal(c.processing.retryImportCleanup(id, 'worker-two', second.lease_token, second.lease_generation, 'still busy', { at: START + 7000 }), true);
  retried = row(c, id);
  assert.equal(retried.available_at, new Date(START + 17_000).toISOString());
  assert.equal(retried.quarantine_relative_path, quarantinePath, 'retry preserves durable quarantine intent');
  assert.equal(c.db.prepare('SELECT state FROM retained_imports WHERE id=?').get('retry-me').state, 'ready');
  assert.equal(c.db.prepare("SELECT status FROM models WHERE id='ready-model'").get().status, 'ready');
});

test('explicit no-delete outcomes are terminal and reject arbitrary statuses', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'hardlink-skip');
  const lease = c.processing.claimImportCleanup('worker', { at: START });

  assert.throws(
    () => c.processing.completeImportCleanupWithoutDelete(id, 'worker', lease.lease_token, lease.lease_generation, 'complete', 'not explicit', { at: START + 1 }),
    (error) => error?.code === 'invalid_cleanup_outcome',
  );
  assert.equal(c.processing.completeImportCleanupWithoutDelete(id, 'worker', lease.lease_token, lease.lease_generation, 'cleanup_skipped_hardlink', 'source has multiple links', { at: START + 2 }), true);
  const terminal = row(c, id);
  assert.equal(terminal.status, 'cleanup_skipped_hardlink');
  assert.equal(terminal.last_error, 'source has multiple links');
  assert.equal(terminal.quarantine_relative_path, null);
  assert.equal(terminal.lease_owner, null);
  assert.ok(terminal.completed_at);
});

test('expired quarantined cleanup preserves its path and rejects every stale mutation', (t) => {
  const c = fixture(t), id = insertCleanup(c, 'quarantined-reclaim');
  const stale = c.processing.claimImportCleanup('stale-owner', { leaseSeconds: 30, at: START });
  const quarantinePath = c.processing.persistImportCleanupQuarantineIntent(id, 'stale-owner', stale.lease_token, stale.lease_generation, { at: START + 1 });
  assert.equal(c.processing.markImportCleanupQuarantined(id, 'stale-owner', stale.lease_token, stale.lease_generation, { at: START + 2 }), true);

  const successor = c.processing.claimImportCleanup('successor', { leaseSeconds: 60, at: START + 30_000 });
  assert.equal(successor.status, 'quarantined');
  assert.equal(successor.quarantine_relative_path, quarantinePath);
  assert.equal(successor.lease_generation, stale.lease_generation + 1);
  assert.notEqual(successor.lease_token, stale.lease_token);
  const staleFence = [id, 'stale-owner', stale.lease_token, stale.lease_generation];
  assert.equal(c.processing.heartbeatImportCleanup(...staleFence, { at: START + 30_001 }), false);
  assert.equal(c.processing.persistImportCleanupQuarantineIntent(...staleFence, { at: START + 30_001 }), null);
  assert.equal(c.processing.markImportCleanupQuarantined(...staleFence, { at: START + 30_001 }), false);
  assert.equal(c.processing.retryImportCleanup(...staleFence, 'stale retry', { at: START + 30_001 }), false);
  assert.equal(c.processing.completeImportCleanupWithoutDelete(...staleFence, 'source_changed', 'stale terminal', { at: START + 30_001 }), false);
  assert.equal(c.processing.completeImportCleanup(...staleFence, { at: START + 30_001 }), false);

  assert.equal(c.processing.heartbeatImportCleanup(id, 'successor', successor.lease_token, successor.lease_generation, { at: START + 30_001 }), true);
  assert.equal(c.processing.completeImportCleanup(id, 'successor', successor.lease_token, successor.lease_generation, { at: START + 30_002 }), true);
  assert.equal(row(c, id).status, 'complete');
});
