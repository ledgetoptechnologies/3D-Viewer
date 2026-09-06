'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const express = require('express');
const { applyMigrations } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { MeasurementRepository } = require('../server/measurementRepository');
const { MeasurementCalculationRepository } = require('../server/measurementCalculationRepository');
const { createMeasurementApi } = require('../server/measurementApi');
const { validateCalculationRequest } = require('../server/measurementCalculationApi');
const { authorizationLive, processOneMeasurementCalculation } = require('../server/measurementCalculationWorker');
const auth = require('../server/auth');
function fixture(t) {
  const database = new DatabaseSync(':memory:'); database.exec('PRAGMA foreign_keys=ON'); applyMigrations(database); t.after(() => database.close());
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database), measurements = new MeasurementRepository(database), jobs = new MeasurementCalculationRepository(database);
  const model = repository.upsertModelVersion({ provider: 'webodm', providerModelId: 'one', providerVersionId: 'v1', displayName: 'One', status: 'ready', assets: [{ kind: 'dsm', rootKey: 'models', relativePath: 'a.tif', format: 'tif', byteSize: 1, sha256: 'a'.repeat(64) }] });
  const principal = { modelId: model.id, modelVersionId: model.activeVersion.id, subject: 'admin-person', audience: 'ops' };
  const document = { id: crypto.randomUUID(), name: 'A', kind: 'polygon', collection: 'map', vertices: [[0,0,0],[1,0,0],[1,1,0],[0,1,0]], coordinateReference: { crs: 'EPSG:32616', verticalUnit: 'm' } };
  const measurement = measurements.create(principal, document).measurement;
  const viewerToken = crypto.randomBytes(32).toString('base64url'), adminToken = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  repository.createViewerSession({ ...principal, tokenHash: auth.hashToken(viewerToken), permissions: { view: true, measure: true }, expiresAt });
  processing.createAdminSession({ tokenHash: auth.hashToken(adminToken), subject: principal.subject, permissions: ['viewer.processing.write'], expiresAt });
  const body = { revision: 1, method: 'surface-cut-fill', sourceAssetId: model.activeVersion.assets[0].id, reference: { type: 'custom', elevationM: 0 }, sourceVerticalUnit: 'm' };
  const request = { ...validateCalculationRequest(body, measurement, model.activeVersion), authority: { viewerHash: auth.hashToken(viewerToken), adminHash: auth.hashToken(adminToken), subject: principal.subject } };
  return { database, repository, processing, measurements, jobs, model, principal, measurement, document, viewerToken, adminToken, body, request };
}
test('job queue snapshots revision, enforces singleton, cancels on edit, hides private request', t => {
  const f = fixture(t), queued = f.jobs.enqueue(f.measurement, f.request);
  assert.equal(queued.status, 'queued'); assert.equal(queued.request, undefined);
  assert.throws(() => f.jobs.enqueue(f.measurement, f.request), { code: 'measurement_calculation_already_active' });
  const job = f.jobs.claim('one'); assert.ok(job); assert.equal(f.jobs.claim('two'), null); assert.ok(f.jobs.live(job, 'one')); assert.equal(f.jobs.live(job, 'two'), false);
  assert.equal(f.processing.measurementCalculationActive(), true);
  f.measurements.update(f.principal, f.measurement.id, { ...f.document, name: 'Edit', revision: 1 });
  assert.equal(f.jobs.live(job, 'one'), false); assert.equal(f.jobs.finish(job, 'one', { cutM3: 5 }), false); assert.equal(f.jobs.get(f.measurement.id, job.id).status, 'cancelled');
});
test('expired calculation leases fail rather than silently rerunning', t => {
  const f = fixture(t), queued = f.jobs.enqueue(f.measurement, f.request), job = f.jobs.claim('one');
  assert.equal(f.jobs.claim('two', Date.now() + 91_000), null);
  assert.equal(f.jobs.get(f.measurement.id, queued.id).errorCode, 'worker_interrupted'); assert.equal(f.jobs.finish(job, 'one', {}), false);
});
test('worker rechecks both authorities and source identity, records only current results', async t => {
  const f = fixture(t), queued = f.jobs.enqueue(f.measurement, f.request);
  let calls = 0;
  const deps = { ...f, storage: { resolve: () => '/trusted/a.tif' }, config: {}, runCalculation: async (_path, _request, controls) => { assert.equal(controls.isLive(), true); calls++; return { cutM3: 1.23456789 }; } };
  assert.equal(await processOneMeasurementCalculation(deps, 'worker'), true); assert.equal(calls, 1); assert.equal(f.jobs.get(f.measurement.id, queued.id).result.cutM3, 1.23456789);
  const next = f.jobs.enqueue(f.measurement, f.request);
  f.database.prepare('UPDATE admin_sessions SET revoked_at=?').run(new Date().toISOString());
  assert.equal(authorizationLive(f.request, f.repository, f.processing), false);
  await processOneMeasurementCalculation(deps, 'worker'); assert.equal(calls, 1); assert.equal(f.jobs.get(f.measurement.id, next.id).errorCode, 'measurement_authorization_lost');
});
test('API rejects ordinary access, clients, wrong admin and client paths; owner lists results', async t => {
  const f = fixture(t), app = express(); let preflightCalls = 0, preflightError;
  app.use(express.json()); app.use('/measurements', createMeasurementApi(f.repository, { preflightRaster: async () => { preflightCalls++; if (preflightError) throw Object.assign(new Error(preflightError), { code: preflightError }); } }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); }); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/measurements/${f.measurement.id}/calculations`;
  const call = (extra = {}, body = f.body, method = 'POST') => fetch(url, { method, headers: { Authorization: `Bearer ${f.viewerToken}`, 'Content-Type': 'application/json', ...extra }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await call()).status, 403);
  assert.equal(preflightCalls, 0, 'ordinary viewer access cannot inspect native headers');
  const headers = { 'X-Viewer-Admin-Authorization': `Bearer ${f.adminToken}` };
  assert.equal((await call(headers, { ...f.body, absolutePath: '/etc/passwd' })).status, 400);
  preflightError = 'measurement_source_vertical_units_required';
  const missingUnits = await call(headers); assert.equal(missingUnits.status, 422);
  assert.equal((await missingUnits.json()).code, preflightError); assert.equal(f.jobs.list(f.measurement.id).length, 0);
  preflightError = 'measurement_raster_block_too_large';
  assert.equal((await call(headers)).status, 422); assert.equal(f.jobs.list(f.measurement.id).length, 0);
  preflightError = null;
  const response = await call(headers); assert.equal(response.status, 202); assert.equal((await response.json()).calculation.status, 'queued');
  const list = await (await call(headers, undefined, 'GET')).json(); assert.equal(list.calculations.length, 1); assert.ok(!JSON.stringify(list).includes('viewerHash'));
  f.database.prepare("UPDATE admin_sessions SET subject='another-person'").run(); assert.equal((await call(headers, undefined, 'GET')).status, 403);
  assert.throws(() => validateCalculationRequest({ ...f.body, method: 'reconstruct' }, f.measurement, f.model.activeVersion), { code: 'measurement_method_unavailable' });
});

test('revocation during calculation discards results',async t=>{
 const f=fixture(t),queued=f.jobs.enqueue(f.measurement,f.request);
 await processOneMeasurementCalculation({...f,config:{},storage:{resolve:()=>'/trusted/a.tif'},runCalculation:async(_p,_r,controls)=>{f.database.prepare('UPDATE admin_sessions SET revoked_at=?').run(new Date().toISOString());assert.equal(controls.isLive(),false);return{volumeM3:99};}},'worker');
 const job=f.jobs.get(f.measurement.id,queued.id);assert.equal(job.status,'failed');assert.equal(job.result,null);assert.equal(job.errorCode,'measurement_authorization_lost');
});

test('authority is rechecked after native source preflight before creating any job', async t => {
  const f=fixture(t),app=express();app.use(express.json());
  app.use('/measurements',createMeasurementApi(f.repository,{preflightRaster:async()=>{
    f.database.prepare('UPDATE admin_sessions SET revoked_at=?').run(new Date().toISOString());
  }}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/measurements/${f.measurement.id}/calculations`,{method:'POST',headers:{Authorization:`Bearer ${f.viewerToken}`,'X-Viewer-Admin-Authorization':`Bearer ${f.adminToken}`,'Content-Type':'application/json'},body:JSON.stringify(f.body)});
  assert.equal(response.status,403);assert.equal(f.jobs.list(f.measurement.id).length,0);
});

test('reconstruction requires explicit inferred geometry acknowledgement and immutable native source',t=>{
 const f=fixture(t),asset={id:'native-obj',kind:'obj',format:'obj',sha256:'b'.repeat(64),rootKey:'models',relativePath:'native.obj',byteSize:42};
 const version={...f.model.activeVersion,georef:{epsg:32616},assets:[asset]};
 const body={revision:1,method:'reconstructed-estimate',sourceAssetId:asset.id,sourceCoordinateFrame:'projected',selection:{seed:[.5,.5,0],minElevationM:-1,maxElevationM:10},reconstruction:{depth:6,normalRadiusM:.2,supportDistanceM:.1,acknowledgeInferredGeometry:true}};
 const request=validateCalculationRequest(body,f.measurement,version);assert.equal(request.collection,'map');assert.equal(request.source.sha256,asset.sha256);assert.equal(request.reconstruction.acknowledgeInferredGeometry,true);
 assert.throws(()=>validateCalculationRequest({...body,reconstruction:{...body.reconstruction,acknowledgeInferredGeometry:false}},f.measurement,version),{code:'measurement_reconstruction_settings_invalid'});
 assert.throws(()=>validateCalculationRequest({...body,reconstruction:{...body.reconstruction,depth:10}},f.measurement,version),{code:'measurement_reconstruction_settings_invalid'});
});
