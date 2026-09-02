'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { createProcessingApi } = require('../server/processingApi');
const { processOneDerivative, structuredCommandFailure } = require('../server/derivativeWorker');
const { processLodRecovery } = require('../server/lodRecovery');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-recovery-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const repository = new ViewerRepository(database);
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, database, processing, repository };
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

test('surface-audit stderr preserves structured v4 failure evidence', () => {
  assert.deepEqual(structuredCommandFailure(JSON.stringify({
    valid: false,
    code: 'lod_surface_equivalence_failed',
    error: 'controlled surface area differs',
    details: { metric: 'areaRelativeDelta', observed: 0.000013, limit: 0.00001, grayZoneLimit: 0.000012 },
  })), {
    code: 'lod_surface_equivalence_failed',
    error: 'controlled surface area differs',
    details: { metric: 'areaRelativeDelta', observed: 0.000013, limit: 0.00001, grayZoneLimit: 0.000012 },
  });
  assert.equal(structuredCommandFailure('plain converter output'), null);
});

function readyMeshSource(context, label = 'Recovery source', { provider = 'ltds-processing', providerModelId = null, modelMetadata = {} } = {}) {
  const { processing, repository, database } = context;
  const project = processing.createProject({ displayName: `${label} project` });
  const dataset = processing.createDataset({
    projectId: project.id, displayName: `${label} dataset`, storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID(),
  });
  processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: digest('p') }], digest('dataset'));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: `${label} task` });
  const attempt = processing.createImportedAttempt({
    id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: `source:${task.id}`, createdBy: 'ops:recovery', staged: false,
  });
  const relativePath = `${task.id}/${attempt.id}`;
  const obj = Buffer.from('obj-source');
  const glb = Buffer.from('glb-source');
  const model = repository.upsertModelVersion({
    provider, providerModelId: providerModelId || task.id, providerVersionId: attempt.id,
    displayName: task.displayName, status: 'ready', metadata: modelMetadata, makeActive: false,
    assets: [
      { kind: 'obj', rootKey: 'models', relativePath: `${relativePath}/model.obj`, byteSize: obj.length, sha256: digest(obj), published: false },
      { kind: 'glb', rootKey: 'models', relativePath: `${relativePath}/model.glb`, byteSize: glb.length, sha256: digest(glb), published: false },
    ],
  });
  const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id, model.id, versionId);
  processing.registerModelOutput({
    versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id,
    rootKey: 'models', relativePath, storageMode: 'managed', status: 'ready', byteSize: obj.length + glb.length, assetCount: 2,
  });
  return { project, dataset, task, attempt: processing.getAttempt(attempt.id), model, versionId, relativePath, obj, glb };
}

function modelStorage(context) {
  const roots = { models: path.join(context.root, 'models') };
  fs.mkdirSync(roots.models, { recursive: true });
  return {
    resolve(rootKey, relativePath, { mustExist = false } = {}) {
      const root = roots[rootKey];
      if (!root) throw new Error(`unsupported test storage root: ${rootKey}`);
      const target = path.resolve(root, ...String(relativePath || '').split('/'));
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('unsafe test storage path');
      if (mustExist && !fs.existsSync(target)) throw new Error('missing test storage path');
      return target;
    },
  };
}

function recoveryManifest(source) {
  const files = [
    { relativePath: 'model.glb', sourceRelativePath: 'model.glb', role: 'mesh_glb', byteSize: source.glb.length, sha256: digest(source.glb) },
    { relativePath: 'model.obj', sourceRelativePath: 'model.obj', role: 'mesh_obj', byteSize: source.obj.length, sha256: digest(source.obj) },
  ];
  return { files, manifestSha256: digest(JSON.stringify(files)) };
}

test('schema v30 processing events are append-only and diagnostics expose only allowlisted sanitized data', (t) => {
  const context = fixture(t);
  const source = readyMeshSource(context, 'Diagnostics');
  const eventId = context.processing.recordProcessingEvent({
    id: 'diagnostic-event', attemptId: source.attempt.id, eventType: 'derivative.failed', phase: 'failed', severity: 'error',
    errorCode: 'converter_failed', message: 'converter\u001b[31m failed\r\nsecret',
    details: {
      derivativeType: 'mesh_tiles', recoveryRevision: 4, resourcePressure: true, exitCode: 137,
      converterDiagnostics: [{ schemaVersion: 1, eventName: 'pipeline_failure', resourcePressure: true, exceptionTypes: ['System.OutOfMemoryException', 'C:\\private\\model.obj'], resources: { workingSetBytes: 1234, secretPath: 'C:\\private' } }],
      workerResources: { rssBytes: 4321, cgroupMemoryMax: 'max', arbitrary: 'must-not-leak' },
      secretToken: 'must-not-leak', nested: { unsafe: true },
    },
  });
  assert.equal(eventId, 'diagnostic-event');
  const createdAt = context.database.prepare('SELECT created_at FROM processing_events WHERE id=?').get(eventId).created_at;
  assert.equal(context.processing.recordProcessingEvent({
    id: eventId, attemptId: source.attempt.id, eventType: 'derivative.failed', phase: 'failed', severity: 'error',
    errorCode: 'converter_failed', message: 'converter\u001b[31m failed\r\nsecret',
    details: {
      derivativeType: 'mesh_tiles', recoveryRevision: 4, resourcePressure: true, exitCode: 137,
      converterDiagnostics: [{ schemaVersion: 1, eventName: 'pipeline_failure', resourcePressure: true, exceptionTypes: ['System.OutOfMemoryException'], resources: { workingSetBytes: 1234 } }],
      workerResources: { rssBytes: 4321, cgroupMemoryMax: 'max' },
    }, createdAt,
  }), eventId, 'an exact producer replay is idempotent');
  assert.throws(() => context.processing.recordProcessingEvent({
    id: eventId, attemptId: source.attempt.id, eventType: 'derivative.failed', phase: 'changed', severity: 'error', createdAt,
  }), { code: 'processing_event_conflict' });
  assert.throws(() => context.database.prepare('UPDATE processing_events SET phase=? WHERE id=?').run('changed', eventId), /append-only/);
  assert.throws(() => context.database.prepare('DELETE FROM processing_events WHERE id=?').run(eventId), /append-only/);
  const diagnostics = context.processing.attemptDiagnostics(source.attempt.id);
  assert.equal(diagnostics.events.length, 1);
  assert.equal(diagnostics.events[0].message.includes('\u001b'), false);
  assert.deepEqual(diagnostics.events[0].details, {
    derivativeType: 'mesh_tiles', recoveryRevision: 4, resourcePressure: true, exitCode: 137,
    converterDiagnostics: [{ schemaVersion: 1, eventName: 'pipeline_failure', resourcePressure: true, exceptionTypes: ['System.OutOfMemoryException'], resources: { workingSetBytes: 1234 } }],
    workerResources: { rssBytes: 4321, cgroupMemoryMax: 'max' },
  });
  assert.equal(JSON.stringify(diagnostics).includes('must-not-leak'), false);
});

test('terminal Obj2Tiles pressure preserves initial retry evidence in attempt diagnostics', async (t) => {
  const context = fixture(t);
  const source = readyMeshSource(context, 'Obj2Tiles pressure');
  const jobId = context.processing.enqueueDerivative(source.attempt.id, 'mesh_tiles', { optional: false });
  const storage = modelStorage(context), sourceDirectory = storage.resolve('models', source.relativePath);
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(sourceDirectory, 'model.obj'), source.obj);
  fs.writeFileSync(path.join(sourceDirectory, 'model.glb'), source.glb);
  context.processing.persistDerivativeInputSnapshot(jobId, 'mesh_tiles', [
    { role: 'mesh_obj', rootKey: 'models', relativePath: `${source.relativePath}/model.obj`, byteSize: source.obj.length, sha256: digest(source.obj) },
    { role: 'mesh_glb', rootKey: 'models', relativePath: `${source.relativePath}/model.glb`, byteSize: source.glb.length, sha256: digest(source.glb) },
  ]);
  const finalError = Object.assign(new Error('semantic retry failure at C:\\private\\model.obj?token=must-not-leak'), {
    code: 'derivative_failed',
    serialRetryAttempted: true,
    resourcePressureEvidence: {
      resourcePressure: true,
      exitCode: 137,
      converterDiagnostics: [{
        schemaVersion: 1,
        eventName: 'pipeline_failure',
        resourcePressure: true,
        exceptionTypes: ['System.Threading.Tasks.TaskSchedulerException', 'C:\\private\\model.obj'],
        resources: { processThreads: 240, cgroupPidsCurrent: '255', secretPath: 'must-not-leak' },
      }],
      workerResources: { rssBytes: 8_000_000_000, cgroupMemoryMax: '25769803776', arbitrary: 'must-not-leak' },
    },
  });
  await processOneDerivative({
    processing: context.processing,
    storage,
    config: {},
    generateMeshTilesImpl: async () => { throw finalError; },
  }, 'derivative-worker:pressure-test');

  const diagnostics = context.processing.attemptDiagnostics(source.attempt.id);
  const event = diagnostics.events.find((item) => item.type === 'obj2tiles.resource_pressure');
  assert.equal(event.derivativeJobId, jobId);
  assert.equal(event.message, 'Obj2Tiles encountered scheduler or memory pressure and its one serial retry did not complete.');
  assert.deepEqual(event.details, {
    derivativeType: 'mesh_tiles', resourcePressure: true, exitCode: 137,
    converterDiagnostics: [{
      schemaVersion: 1,
      eventName: 'pipeline_failure',
      resourcePressure: true,
      exceptionTypes: ['System.Threading.Tasks.TaskSchedulerException'],
      resources: { processThreads: 240, cgroupPidsCurrent: '255' },
    }],
    workerResources: { rssBytes: 8_000_000_000, cgroupMemoryMax: '25769803776' },
  });
  assert.equal(JSON.stringify(diagnostics).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(diagnostics).includes('private'), false);
});

test('diagnostic run pagination is deterministic and the cursor advances without duplicates', (t) => {
  const context = fixture(t);
  const first = readyMeshSource(context, 'Page A');
  const second = readyMeshSource(context, 'Page B');
  const created = '2026-09-01T12:00:00.000Z';
  context.database.prepare('UPDATE processing_attempts SET created_at=? WHERE id IN (?,?)').run(created, first.attempt.id, second.attempt.id);
  const pageOne = context.processing.listDiagnosticRunsPage({ limit: 1 });
  assert.equal(pageOne.items.length, 1);
  assert.ok(pageOne.nextCursor);
  const pageTwo = context.processing.listDiagnosticRunsPage({ limit: 1, cursor: pageOne.nextCursor });
  assert.equal(pageTwo.items.length, 1);
  assert.notEqual(pageTwo.items[0].attemptId, pageOne.items[0].attemptId);
  assert.equal(pageTwo.nextCursor, null);
});

test('LOD recovery is idempotent, creates stable replacement identities, preserves the old version, and retries the required derivative in place', (t) => {
  const context = fixture(t);
  const source = readyMeshSource(context);
  const failedSourceJobId = context.processing.enqueueDerivative(source.attempt.id, 'mesh_tiles', { optional: true });
  const failedSourceJob = context.processing.claimDerivative('legacy-derivative-worker:test');
  assert.equal(failedSourceJob.id, failedSourceJobId);
  assert.equal(context.processing.failOptionalDerivative(failedSourceJob.id, 'legacy-derivative-worker:test', 'legacy_lod_failed', 'old tile conversion failed', failedSourceJob.lease_token), true);
  assert.equal(context.processing.getAttempt(source.attempt.id).status, 'ready_for_review');
  assert.equal(context.processing.getModelOutput(source.versionId).status, 'ready');
  const manifest = recoveryManifest(source);
  const created = context.processing.createLodRecoveryOperation({
    outputId: source.versionId, subject: 'ops:recovery', sessionId: 'session-one', manifest, auditActorId: 'ops:recovery',
  });
  assert.equal(created.type, 'lod_recovery');
  const replay = context.processing.createLodRecoveryOperation({
    outputId: source.versionId, subject: 'ops:recovery', sessionId: 'session-one', manifest, auditActorId: 'ops:recovery',
  });
  assert.equal(replay.id, created.id);
  assert.throws(() => context.processing.createLodRecoveryOperation({
    outputId: source.versionId, subject: 'ops:different-operator', sessionId: 'session-two', manifest, auditActorId: 'ops:different-operator',
  }), (error) => error.code === 'lod_recovery_in_progress' && error.operationId === undefined,
  'an operation is never returned or reassigned across subjects');
  assert.equal(context.database.prepare("SELECT COUNT(*) n FROM dataset_operations WHERE json_extract(payload_json,'$.lodRecovery')=1").get().n, 1);

  const payload = JSON.parse(context.database.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(created.id).payload_json);
  assert.notEqual(payload.ids.attemptId, source.attempt.id);
  assert.notEqual(payload.ids.versionId, source.versionId);
  assert.equal(payload.ids.modelId, source.model.id);
  assert.equal(context.processing.getModelOutput(source.versionId).status, 'ready');
  assert.equal(context.database.prepare('SELECT status FROM model_versions WHERE id=?').get(source.versionId).status, 'ready');
  assert.equal(context.processing.getAttempt(source.attempt.id).status, 'ready_for_review');

  const owner = 'dataset-worker:test';
  const leased = context.processing.claimDatasetOperation(owner);
  assert.equal(leased.id, created.id);
  const replacementAttempt = context.processing.createImportedAttempt({
    id: payload.ids.attemptId, taskId: source.task.id, datasetId: source.dataset.id,
    providerTaskId: `lod-recovery:${created.id}`, createdBy: 'ops:recovery', staged: true,
  });
  context.repository.upsertModelVersion({
    modelId: source.model.id, versionId: payload.ids.versionId, provider: 'ltds-processing', providerModelId: source.task.id,
    providerVersionId: `lod-recovery:${created.id}`, displayName: source.task.displayName, status: 'importing', makeActive: false,
    assets: [
      { kind: 'obj', rootKey: 'models', relativePath: `${payload.targetRelativePath}/model.obj`, byteSize: source.obj.length, sha256: digest(source.obj), published: false },
      { kind: 'glb', rootKey: 'models', relativePath: `${payload.targetRelativePath}/model.glb`, byteSize: source.glb.length, sha256: digest(source.glb), published: false },
    ],
  });
  context.processing.setAttemptResult(replacementAttempt.id, source.model.id, payload.ids.versionId);
  context.processing.registerModelOutput({
    versionId: payload.ids.versionId, modelId: source.model.id, taskId: source.task.id, attemptId: replacementAttempt.id,
    projectId: source.project.id, rootKey: 'models', relativePath: payload.targetRelativePath, status: 'staged',
    byteSize: source.obj.length + source.glb.length, assetCount: 2,
  });
  const awaiting = context.processing.activateImportedDerivativesForOperation(created.id, owner, replacementAttempt.id,
    [{ type: 'mesh_tiles', request: { optional: false } }], { attempt: replacementAttempt, requiredDerivatives: [] });
  assert.equal(awaiting.status, 'awaiting_derivatives');
  assert.equal(awaiting.processingAttemptId, replacementAttempt.id);

  const job = context.processing.claimDerivative('derivative-worker:test');
  assert.equal(job.attempt_id, replacementAttempt.id);
  context.database.prepare("UPDATE derivative_jobs SET attempt_count=3,lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(job.id);
  assert.equal(context.processing.terminalizeExhaustedDerivatives(), 1);
  const failedDiagnostics = context.processing.attemptDiagnostics(replacementAttempt.id);
  assert.equal(failedDiagnostics.operation.id, created.id);
  assert.deepEqual(failedDiagnostics.derivatives.map(({ type, status, optional, errorCode, operationId }) => ({ type, status, optional, errorCode, operationId })), [{
    type: 'mesh_tiles', status: 'failed', optional: false, errorCode: 'derivative_retry_exhausted', operationId: created.id,
  }]);
  assert.equal(context.processing.getModelOutput(source.versionId).status, 'ready');
  assert.equal(context.database.prepare('SELECT status FROM model_versions WHERE id=?').get(source.versionId).status, 'ready');
  assert.equal(context.processing.getAttempt(source.attempt.id).status, 'ready_for_review');

  const retried = context.processing.retryDatasetOperation(created.id, 'ops:recovery', 'ops:recovery');
  assert.equal(retried.status, 'awaiting_derivatives');
  assert.equal(retried.processingAttemptId, replacementAttempt.id);
  const retryJob = context.database.prepare('SELECT status,request_json FROM derivative_jobs WHERE id=?').get(job.id);
  assert.equal(retryJob.status, 'pending');
  assert.equal(JSON.parse(retryJob.request_json).manualRetryCount, 1);
  assert.equal(context.processing.retryOptionalDerivative(job.id, 'ops:recovery', { meshDerivativesEnabled: true }), null,
    'required mesh recovery must be retried through its durable operation, never the optional derivative endpoint');
});

test('LOD recovery preserves imported provider identity and model metadata', { skip: process.platform === 'win32' }, async (t) => {
  const context = fixture(t);
  const source = readyMeshSource(context, 'Imported identity', {
    provider: 'webodm', providerModelId: 'task-import:legacy-source',
    modelMetadata: { projectName: 'Imported project', retainedMarker: 'preserve-me' },
  });
  const storage = modelStorage(context), sourceDirectory = storage.resolve('models', source.relativePath);
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(sourceDirectory, 'model.obj'), source.obj);
  fs.writeFileSync(path.join(sourceDirectory, 'model.glb'), source.glb);
  const operation = context.processing.createLodRecoveryOperation({
    outputId: source.versionId, subject: 'ops:recovery', sessionId: 'session-imported', manifest: recoveryManifest(source),
  });
  const leased = context.processing.claimDatasetOperation('dataset-worker:imported-identity');
  assert.equal(leased.id, operation.id);
  const result = await processLodRecovery(leased, {
    processing: context.processing, repository: context.repository, storage, config: { meshDerivativesEnabled: true },
  });
  assert.equal(result.model.id, source.model.id);
  assert.equal(result.model.provider, 'webodm');
  assert.equal(result.model.providerModelId, 'task-import:legacy-source');
  assert.deepEqual(result.model.metadata, { projectName: 'Imported project', retainedMarker: 'preserve-me' });
  assert.ok(context.repository.getModelVersion(source.model.id, source.versionId), 'the source version remains registered');
});

test('LOD recovery attempt registration fails closed when a newer attempt became active', (t) => {
  const context = fixture(t), source = readyMeshSource(context, 'Superseded recovery');
  const newerAttemptId = crypto.randomUUID();
  context.processing.createImportedAttempt({
    id: newerAttemptId, taskId: source.task.id, datasetId: source.dataset.id,
    providerTaskId: `newer:${newerAttemptId}`, createdBy: 'ops:newer', staged: true,
  });
  const recoveryAttemptId = crypto.randomUUID();
  assert.throws(() => context.processing.createImportedAttempt({
    id: recoveryAttemptId, taskId: source.task.id, datasetId: source.dataset.id,
    providerTaskId: `lod-recovery:${recoveryAttemptId}`, createdBy: 'ops:recovery', staged: true,
    expectedActiveAttemptId: source.attempt.id,
  }), { code: 'attempt_superseded' });
  assert.equal(context.processing.getTask(source.task.id).activeAttemptId, newerAttemptId);
  assert.equal(context.processing.getAttempt(recoveryAttemptId), null, 'the failed CAS rolls back the provisional attempt');
});

test('LOD recovery attempt registration replays after its own active-attempt promotion', (t) => {
  const context = fixture(t), source = readyMeshSource(context, 'Recovery registration replay'), recoveryAttemptId = crypto.randomUUID();
  const input = {
    id: recoveryAttemptId, taskId: source.task.id, datasetId: source.dataset.id,
    providerTaskId: `lod-recovery:${recoveryAttemptId}`, createdBy: 'ops:recovery', staged: true,
    expectedActiveAttemptId: source.attempt.id,
  };
  const created = context.processing.createImportedAttempt(input);
  const replayed = context.processing.createImportedAttempt(input);
  assert.equal(replayed.id, created.id);
  assert.equal(context.processing.getTask(source.task.id).activeAttemptId, recoveryAttemptId);
  assert.equal(context.database.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE id=?').get(recoveryAttemptId).n, 1);
});

test('ready output with a failed legacy mesh derivative starts an immutable recovery through the API', { skip: process.platform === 'win32' }, async (t) => {
  const context = fixture(t);
  const source = readyMeshSource(context, 'API recovery');
  const outputDirectory = path.join(context.root, 'models', ...source.relativePath.split('/'));
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(path.join(outputDirectory, 'model.obj'), source.obj);
  fs.writeFileSync(path.join(outputDirectory, 'model.glb'), source.glb);
  const failedJobId = context.processing.enqueueDerivative(source.attempt.id, 'mesh_tiles', { optional: true });
  const failedJob = context.processing.claimDerivative('legacy-api-worker:test');
  assert.equal(failedJob.id, failedJobId);
  context.processing.failOptionalDerivative(failedJob.id, 'legacy-api-worker:test', 'legacy_lod_failed', 'legacy conversion failed', failedJob.lease_token);

  const previous = config.meshDerivativesEnabled;
  config.meshDerivativesEnabled = true;
  t.after(() => { config.meshDerivativesEnabled = previous; });
  const token = 'lod-recovery-api-writer-token-0000000000000';
  context.processing.createAdminSession({
    tokenHash: auth.hashToken(token), subject: 'ops:api-recovery', displayUnits: 'imperial',
    permissions: ['viewer.processing.read', 'viewer.processing.write'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const storage = { resolve(rootKey, relativePath, { mustExist = false } = {}) {
    assert.equal(rootKey, 'models');
    const absolute = path.join(context.root, 'models', ...String(relativePath).split('/'));
    if (mustExist && !fs.existsSync(absolute)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return absolute;
  } };
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use(createProcessingApi({ repository: context.repository, processing: context.processing, storage }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/processing/outputs/${source.versionId}/lod-recovery-attempts`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'api-recovery-ready-failed-lod' }, body: '{}',
  });
  assert.equal(response.status, 202);
  const { operation } = await response.json();
  assert.equal(operation.type, 'lod_recovery');
  const payload = JSON.parse(context.database.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(operation.id).payload_json);
  assert.notEqual(payload.ids.attemptId, source.attempt.id);
  assert.notEqual(payload.ids.versionId, source.versionId);
  assert.equal(context.processing.getAttempt(source.attempt.id).status, 'ready_for_review');
  assert.equal(context.processing.getModelOutput(source.versionId).status, 'ready');
  assert.equal(context.database.prepare('SELECT status FROM model_versions WHERE id=?').get(source.versionId).status, 'ready');
});

test('LOD recovery and diagnostics routes enforce processing permissions before accessing source storage', async (t) => {
  const context = fixture(t);
  const source = readyMeshSource(context, 'Retry authorization');
  const recovery = context.processing.createLodRecoveryOperation({
    outputId: source.versionId, subject: 'ops:retry', sessionId: 'retry-session', manifest: recoveryManifest(source), auditActorId: 'ops:retry',
  });
  assert.equal(context.processing.claimDatasetOperation('retry-auth-worker').id, recovery.id);
  assert.equal(context.processing.failDatasetOperation(recovery.id, 'retry-auth-worker', 'test_failure', 'retry authorization fixture'), true);
  const previous = config.meshDerivativesEnabled;
  config.meshDerivativesEnabled = true;
  t.after(() => { config.meshDerivativesEnabled = previous; });
  const readOnlyToken = 'lod-recovery-read-only-token-000000000000';
  const retryWriterToken = 'lod-recovery-retry-writer-token-0000000000';
  const importOnlyToken = 'lod-recovery-import-only-token-00000000000';
  context.processing.createAdminSession({
    tokenHash: auth.hashToken(readOnlyToken), subject: 'ops:reader', displayUnits: 'imperial', permissions: ['viewer.processing.read'],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  context.processing.createAdminSession({ tokenHash: auth.hashToken(retryWriterToken), subject: 'ops:retry', displayUnits: 'imperial', permissions: ['viewer.processing.write'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  context.processing.createAdminSession({ tokenHash: auth.hashToken(importOnlyToken), subject: 'ops:retry', displayUnits: 'imperial', permissions: ['viewer.datasets.import'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use(createProcessingApi({ repository: context.repository, processing: context.processing, storage: { resolve() { throw new Error('storage must not be reached'); } } }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = '/api/v1/processing/outputs/unknown/lod-recovery-attempts';
  assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'recovery-auth-unauthenticated' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}${route}`, { method: 'POST', headers: { authorization: `Bearer ${readOnlyToken}`, 'content-type': 'application/json', 'idempotency-key': 'recovery-auth-read-only' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/diagnostics/runs?limit=10`, { headers: { authorization: `Bearer ${readOnlyToken}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/operations/${recovery.id}/retry`, { method: 'POST', headers: { authorization: `Bearer ${importOnlyToken}`, 'content-type': 'application/json', 'idempotency-key': 'recovery-retry-import-only' }, body: '{}' })).status, 403,
    'dataset import permission alone cannot mutate a processing recovery');
  const retryResponse = await fetch(`${base}/api/v1/operations/${recovery.id}/retry`, { method: 'POST', headers: { authorization: `Bearer ${retryWriterToken}`, 'content-type': 'application/json', 'idempotency-key': 'recovery-retry-processing-writer' }, body: '{}' });
  assert.equal(retryResponse.status, 202);
  assert.equal((await retryResponse.json()).operation.status, 'queued');
});
