'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const auth = require('../server/auth');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProcessingApi } = require('../server/processingApi');
const { taskImageInventory } = require('../server/taskImageInventory');

function fixture(t, files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-image-inventory-'));
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(db), processing = new ProcessingRepository(db);
  const project = processing.createProject({ displayName: 'Image inventory' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Imported archive', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const hash = 'a'.repeat(64);
  processing.finalizeDataset(dataset.id, files.map(file => ({ byteSize: 1, sha256: hash, ...file })), hash);
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Archive task' });
  const output = (names = []) => {
    const attempt = processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: crypto.randomUUID() });
    const versionId = crypto.randomUUID();
    const model = repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, versionId, displayName: 'Imported model', status: 'ready', makeActive: false,
      assets: [{ kind: 'ortho', rootKey: 'models', relativePath: `${versionId}/ortho.tif`, contentType: 'image/tiff', sha256: hash }],
      cameraPhotos: names.map(filename => ({ filename, rootKey: 'models', relativePath: `${versionId}/images/${filename}`, contentType: 'image/jpeg', byteSize: 1, sha256: hash })) });
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.transitionAttempt(attempt.id, 'ready_for_review');
    return { versionId, attempt };
  };
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, repository, processing, project, dataset, task, output };
}

test('dataset inputs take precedence, excluding explicitly non-input image files', t => {
  const f = fixture(t, [{ relativePath: 'a.jpg' }, { relativePath: 'b.dng' }, { relativePath: 'plan.png', processingRole: 'administrative' }]);
  const output = f.output(['a.jpg']);
  assert.deepEqual(taskImageInventory(f.db, f.task.id, output.versionId), { sourceImageCount: 2, sourceImageCountSource: 'dataset_inputs' });
});

test('archive imports use only the selected result original-photo inventory, not retained versions or raster assets', t => {
  const f = fixture(t, [{ relativePath: 'backup.zip' }]);
  const old = f.output(['old-a.jpg', 'old-b.jpg', 'old-c.jpg']);
  const current = f.output(['a.jpg', 'b.jpg']);
  assert.deepEqual(taskImageInventory(f.db, f.task.id, current.versionId), { sourceImageCount: 2, sourceImageCountSource: 'registered_camera_originals' });
  assert.equal(taskImageInventory(f.db, f.task.id, old.versionId).sourceImageCount, 3);
});

test('missing original inventory remains unknown and cannot count a different task output', t => {
  const f = fixture(t, [{ relativePath: 'backup.zip' }]);
  const empty = f.output();
  assert.deepEqual(taskImageInventory(f.db, f.task.id, empty.versionId), { sourceImageCount: null, sourceImageCountSource: null });
  const other = f.processing.createTask({ projectId: f.project.id, datasetId: f.dataset.id, displayName: 'Other task' });
  const output = f.output(['a.jpg']);
  assert.deepEqual(taskImageInventory(f.db, other.id, output.versionId), { sourceImageCount: null, sourceImageCountSource: null });
  assert.equal(taskImageInventory(f.db, f.task.id).sourceImageCount, null);
});

test('legacy auto-role input images remain countable without loading file records', t => {
  const f = fixture(t, [{ relativePath: 'legacy.jpg' }]);
  f.db.prepare("UPDATE dataset_files SET processing_role='auto' WHERE dataset_id=?").run(f.dataset.id);
  assert.equal(taskImageInventory(f.db, f.task.id).sourceImageCount, 1);
});

for (const role of ['image', 'auto']) test(`registered elevation products are not camera inputs even with legacy ${role} roles`, t => {
  const f = fixture(t, [{ relativePath: 'odm_dem/dsm.tif' }, { relativePath: 'odm_dem/dtm.tif' }, { relativePath: 'camera-original.tiff' }]);
  f.db.prepare('UPDATE dataset_files SET processing_role=? WHERE dataset_id=?').run(role, f.dataset.id);
  const output = f.output();
  for (const kind of ['dsm', 'dtm']) f.processing.addModelAsset({ versionId: output.versionId, kind, rootKey: 'datasets', relativePath: `${f.dataset.relativePath}/odm_dem/${kind}.tif`, contentType: 'image/tiff', byteSize: 1, sha256: 'a'.repeat(64), attemptId: output.attempt.id });
  assert.deepEqual(taskImageInventory(f.db, f.task.id, output.versionId), { sourceImageCount: 1, sourceImageCountSource: 'dataset_inputs' });
});

test('matching raster names in another task or with changed bytes do not exclude camera TIFFs', t => {
  const f = fixture(t, [{ relativePath: 'dsm.tif' }]);
  const output = f.output();
  f.processing.addModelAsset({ versionId: output.versionId, kind: 'dsm', rootKey: 'datasets', relativePath: `${f.dataset.relativePath}/dsm.tif`, contentType: 'image/tiff', byteSize: 1, sha256: 'b'.repeat(64), attemptId: output.attempt.id });
  assert.equal(taskImageInventory(f.db, f.task.id).sourceImageCount, 1);
  f.db.prepare("UPDATE model_assets SET sha256=? WHERE version_id=? AND kind='dsm'").run('a'.repeat(64), output.versionId);
  const other = f.processing.createTask({ projectId: f.project.id, datasetId: f.dataset.id, displayName: 'Other TIFF task' });
  assert.equal(taskImageInventory(f.db, other.id).sourceImageCount, 1);
  assert.equal(taskImageInventory(f.db, f.task.id).sourceImageCount, null);
});

test('same-name and same-hash raster assets in a different storage root do not exclude camera TIFFs', t => {
  const f = fixture(t, [{ relativePath: 'dsm.tif' }]), output = f.output();
  f.processing.addModelAsset({ versionId: output.versionId, kind: 'dsm', rootKey: 'models', relativePath: `${f.dataset.relativePath}/dsm.tif`, contentType: 'image/tiff', byteSize: 1, sha256: 'a'.repeat(64), attemptId: output.attempt.id });
  assert.equal(taskImageInventory(f.db, f.task.id).sourceImageCount, 1);
  f.db.prepare("UPDATE model_assets SET root_key='datasets' WHERE version_id=? AND kind='dsm'").run(output.versionId);
  assert.equal(taskImageInventory(f.db, f.task.id).sourceImageCount, null);
});

test('registered catalog raster products match their dataset-specific external-root alias', t => {
  const f = fixture(t, [{ relativePath: 'dsm.tif' }]), output = f.output();
  f.db.prepare("UPDATE datasets SET root_key=?,storage_mode='external_reference' WHERE id=?").run(`webodm@${f.dataset.id}`, f.dataset.id);
  f.processing.addModelAsset({ versionId: output.versionId, kind: 'dsm', rootKey: 'webodm', relativePath: `${f.dataset.relativePath}/dsm.tif`, contentType: 'image/tiff', byteSize: 1, sha256: 'a'.repeat(64), attemptId: output.attempt.id });
  assert.equal(taskImageInventory(f.db, f.task.id).sourceImageCount, null);
});

test('retained manifest product roles exclude legacy image rows without excluding source TIFFs', t => {
  const f = fixture(t, [{ relativePath: 'images/original.tiff' }, { relativePath: 'odm_dem/dsm.tif' }, { relativePath: 'odm_texturing/texture.png' }]);
  const operation = f.processing.createWebodmTaskImportOperation({ request: { sourceRelativePath: 'import-fixture', projectId: f.project.id, taskDisplayName: 'Retained role fixture' }, subject: 'ops:fixture', sessionId: 'session' });
  assert.equal(f.processing.claimDatasetOperation('role-worker').id, operation.id);
  const files = [['images/original.tiff', 'source_photo'], ['odm_dem/dsm.tif', 'dsm'], ['odm_texturing/texture.png', 'mesh_texture']].map(([relativePath, role]) => ({ relativePath, sourceRelativePath: relativePath, role, byteSize: 1, sha256: 'a'.repeat(64) }));
  assert.ok(f.processing.recordRetainedImportManifest(operation.id, 'role-worker', { attemptId: null, datasetId: f.dataset.id, sourceKind: 'server_folder', sourceRelativePath: 'import-fixture', stagingRelativePath: 'fixture', manifestSha256: 'a'.repeat(64), extractedTreeSha256: 'a'.repeat(64), files }));
  assert.deepEqual(taskImageInventory(f.db, f.task.id), { sourceImageCount: 1, sourceImageCountSource: 'dataset_inputs' });
  f.db.prepare("UPDATE retained_import_files SET sha256=? WHERE role='dsm'").run('b'.repeat(64));
  assert.equal(taskImageInventory(f.db, f.task.id).sourceImageCount, 2, 'only hash-matching manifest evidence overrides legacy inference');
});

test('task list and detail expose archive photo counts with inventory provenance', async t => {
  const f = fixture(t, [{ relativePath: 'backup.zip' }]);
  const selected = f.output(['a.jpg', 'b.jpg']);
  f.output(['new-a.jpg', 'new-b.jpg', 'new-c.jpg']);
  // A later retained output must not silently replace the task's selected result.
  f.db.prepare('UPDATE processing_tasks SET active_attempt_id=? WHERE id=?').run(selected.attempt.id, f.task.id);
  const token = crypto.randomBytes(32).toString('base64url');
  f.processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:fixture', permissions: ['viewer.processing.read'], displayUnits: 'imperial', expiresAt: new Date(Date.now() + 60000).toISOString() });
  const app = express(); app.use(createProcessingApi({ repository: f.repository, processing: f.processing, storage: {} }));
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    for (const suffix of ['', `/${f.task.id}`]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/tasks${suffix}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      const body = await response.json(), task = body.task || body.tasks[0];
      assert.equal(task.metrics.sourceImageCount, 2);
      assert.equal(task.metrics.sourceImageCountSource, 'registered_camera_originals');
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
