'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { createApiV1 } = require('../server/apiV1');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { createProcessingApi } = require('../server/processingApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');

test('admin review sessions expose only an exact review-ready derived version and renew in place', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-review-session-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const models = path.join(root, 'models');
  const oldModelsMount = config.modelsMount;
  config.modelsMount = models;
  const subject = 'ops:reviewer';
  const adminToken = 'review-admin-token-00000000000000000000';
  const readToken = 'review-read-token-000000000000000000000';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  processing.createAdminSession({ tokenHash: auth.hashToken(adminToken), subject, permissions: ['viewer.processing.publish'], displayUnits: 'imperial', expiresAt });
  processing.createAdminSession({ tokenHash: auth.hashToken(readToken), subject: 'ops:reader', permissions: ['viewer.processing.read'], displayUnits: 'metric', expiresAt });

  const project = processing.createProject({ displayName: 'Review project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Dataset', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const empty = crypto.createHash('sha256').digest('hex');
  processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 0, sha256: empty }], empty);
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Review task' });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: subject });
  const directory = path.join(models, task.id, attempt.id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'model.glb'), 'derived-mesh');
  fs.writeFileSync(path.join(directory, 'raw.laz'), 'administrative-source');
  const sha256 = crypto.createHash('sha256').update('derived-mesh').digest('hex');
  const rawSha256 = crypto.createHash('sha256').update('administrative-source').digest('hex');
  const model = repository.upsertModelVersion({
    provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id,
    displayName: task.displayName, status: 'ready', sourceLocator: { taskId: task.id, attemptId: attempt.id },
    assets: [
      { kind: 'glb', rootKey: 'models', relativePath: `${task.id}/${attempt.id}/model.glb`, byteSize: 12, sha256, published: false },
      { kind: 'pointCloud', rootKey: 'models', relativePath: `${task.id}/${attempt.id}/raw.laz`, byteSize: 21, sha256: rawSha256, published: false },
    ],
    makeActive: false,
  });
  const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id, model.id, versionId);
  processing.transitionAttempt(attempt.id, 'ready_for_review', { progress: 1 });
  processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: `${task.id}/${attempt.id}`, byteSize: 33, assetCount: 2 });

  assets.setRepository(repository);
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createProcessingApi({ repository, processing, storage: {} }));
  app.use(createApiV1(repository));
  app.use(assets);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    config.modelsMount = oldModelsMount;
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const issue = (key, token = adminToken) => fetch(`${base}/api/v1/attempts/${attempt.id}/review-sessions`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, body: '{}',
  });

  assert.equal((await issue('review-session-reader-0001', readToken)).status, 403);
  const issuedResponse = await issue('review-session-create-0001');
  assert.equal(issuedResponse.status, 201);
  assert.equal(issuedResponse.headers.get('cache-control'), 'no-store');
  const issued = await issuedResponse.json();
  assert.deepEqual(issued.assetKinds, ['glb']);
  assert.equal(issued.sessionMode, 'review');
  assert.equal(issued.attemptId, attempt.id);
  assert.equal(issued.modelVersionId, versionId);
  assert.equal(repository.getModel(model.id).activeVersion, null, 'review does not publish or activate the candidate');
  assert.equal(database.prepare('SELECT COUNT(*) count FROM public_shares').get().count, 0);

  const redeemResponse = await fetch(`${base}/api/v1/sessions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant: issued.grant }) });
  assert.equal(redeemResponse.status, 200);
  const session = await redeemResponse.json();
  assert.equal(session.sessionMode, 'review');
  assert.equal(session.reviewAttemptId, attempt.id);
  assert.equal(session.model.activeVersion.id, versionId);
  assert.ok(session.model.assets.glb);
  assert.equal(session.model.assets.pointCloud, null, 'raw point-cloud processing input is not review-shareable');
  const assetResponse = await fetch(`${base}${session.model.assets.glb}`, { headers: { range: 'bytes=0-6' } });
  assert.equal(assetResponse.status, 206);
  assert.equal(await assetResponse.text(), 'derived');
  const rawAssetUrl = `${base}/session-assets/${encodeURIComponent(session.accessToken)}/${encodeURIComponent(model.id)}/models/${task.id}/${attempt.id}/raw.laz`;
  assert.equal((await fetch(rawAssetUrl)).status, 404, 'a valid review capability cannot request administrative source assets directly');

  const renewalIssued = await (await issue('review-session-renew-0001')).json();
  const renewalResponse = await fetch(`${base}/api/v1/sessions/redeem`, { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ grant: renewalIssued.grant }) });
  assert.equal(renewalResponse.status, 200);
  const renewed = await renewalResponse.json();
  assert.equal(renewed.accessToken, session.accessToken);
  assert.equal(renewed.sessionId, session.sessionId);

  database.prepare("UPDATE processing_attempts SET status='published' WHERE id=?").run(attempt.id);
  assert.equal((await fetch(`${base}/api/v1/sessions/current`, { headers: { authorization: `Bearer ${session.accessToken}` } })).status, 401);
  assert.equal((await fetch(`${base}${session.model.assets.glb}`)).status, 403);
  database.prepare("UPDATE processing_attempts SET status='ready_for_review' WHERE id=?").run(attempt.id);

  const extra = await (await issue('review-session-revoke-target-0001')).json();
  const revoke = await fetch(`${base}/api/v1/attempts/${attempt.id}/review-sessions`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': 'review-session-revoke-0001' }, body: '{}' });
  assert.equal(revoke.status, 200);
  const revoked = await revoke.json();
  assert.equal(revoked.attemptId, attempt.id);
  assert.ok(revoked.revokedGrants >= 1);
  assert.ok(revoked.revokedSessions >= 1);
  assert.equal((await fetch(`${base}/api/v1/sessions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant: extra.grant }) })).status, 410);

  await t.test('attempt cancellation invalidates an existing review capability', async () => {
    const cancellationGrant = await (await issue('review-session-cancellation-0001')).json();
    const cancellationResponse = await fetch(`${base}/api/v1/sessions/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant: cancellationGrant.grant }),
    });
    assert.equal(cancellationResponse.status, 200);
    const cancellationSession = await cancellationResponse.json();

    database.prepare("UPDATE processing_attempts SET status='cancelled' WHERE id=?").run(attempt.id);
    assert.equal((await fetch(`${base}/api/v1/sessions/current`, { headers: { authorization: `Bearer ${cancellationSession.accessToken}` } })).status, 401);
    assert.equal((await fetch(`${base}${cancellationSession.model.assets.glb}`)).status, 403);
    database.prepare("UPDATE processing_attempts SET status='ready_for_review' WHERE id=?").run(attempt.id);
    database.prepare("UPDATE model_outputs SET status='ready' WHERE id=?").run(versionId);
    database.prepare("UPDATE model_versions SET status='ready' WHERE id=?").run(versionId);
    database.prepare("UPDATE models SET status='ready' WHERE id=?").run(model.id);
  });

  await t.test('result-version replacement invalidates a capability pinned to the prior version', async () => {
    const replacementGrant = await (await issue('review-session-replacement-0001')).json();
    const replacementResponse = await fetch(`${base}/api/v1/sessions/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant: replacementGrant.grant }),
    });
    assert.equal(replacementResponse.status, 200);
    const replacementSession = await replacementResponse.json();

    fs.writeFileSync(path.join(directory, 'model-v2.glb'), 'replacement-mesh');
    const replacementSha256 = crypto.createHash('sha256').update('replacement-mesh').digest('hex');
    const replacementModel = repository.upsertModelVersion({
      provider: 'ltds-processing', providerModelId: task.id, providerVersionId: `${attempt.id}-replacement`,
      displayName: task.displayName, status: 'ready', sourceLocator: { taskId: task.id, attemptId: attempt.id },
      assets: [{ kind: 'glb', rootKey: 'models', relativePath: `${task.id}/${attempt.id}/model-v2.glb`, byteSize: 16, sha256: replacementSha256, published: false }],
      makeActive: false,
    });
    const replacementVersionId = database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?')
      .get(replacementModel.id, `${attempt.id}-replacement`).id;
    database.prepare('DELETE FROM model_outputs WHERE id=?').run(versionId);
    processing.registerModelOutput({ versionId: replacementVersionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: `${task.id}/${attempt.id}-replacement`, byteSize: 16, assetCount: 1 });
    processing.setAttemptResult(attempt.id, model.id, replacementVersionId);

    assert.equal((await fetch(`${base}/api/v1/sessions/current`, { headers: { authorization: `Bearer ${replacementSession.accessToken}` } })).status, 401);
    assert.equal((await fetch(`${base}${replacementSession.model.assets.glb}`)).status, 403);
  });
});
