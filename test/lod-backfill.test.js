'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database');
const {reconcileMissingLodDerivatives}=require('../server/lodBackfill');
const {createProcessingApi}=require('../server/processingApi');
const {processOneDerivative}=require('../server/derivativeWorker');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-lod-backfill-'));
  for(const name of['datasets','models','cache','trash','imports'])fs.mkdirSync(path.join(root,name));
  const db=openDatabase(path.join(root,'viewer.sqlite'));
  const processing=new ProcessingRepository(db);
  const repository=new ViewerRepository(db);
  const storage=new StorageManager({datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),datasetImportMount:path.join(root,'imports'),storageReserveBytes:0,storageReservePercent:0});
  storage.initialize();
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  return{root,db,processing,repository,storage};
}

function readyModel(c,{assets=['glb','obj']}={}){
  const project=c.processing.createProject({displayName:`LOD ${crypto.randomUUID()}`});
  const dataset=c.processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  c.processing.finalizeDataset(dataset.id,[],'a'.repeat(64));
  const task=c.processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Legacy model'});
  const attempt=c.processing.createImportedAttempt({id:crypto.randomUUID(),taskId:task.id,datasetId:dataset.id,providerTaskId:'legacy',createdBy:'ops:test'});
  const model=c.repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:task.displayName,status:'ready',assets:assets.map(kind=>({kind,rootKey:'datasets',relativePath:`legacy/model.${kind==='obj'?'obj':'glb'}`,sha256:'b'.repeat(64),published:false})),makeActive:false});
  const versionId=c.db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  c.processing.setAttemptResult(attempt.id,model.id,versionId);
  c.processing.registerModelOutput({versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:`${task.id}/${attempt.id}`,status:'ready',byteSize:1,assetCount:assets.length});
  return{project,task,attempt:c.processing.getAttempt(attempt.id),model,versionId};
}

test('legacy OBJ backfill queues once without taking the ready model offline',t=>{
  const c=fixture(t),item=readyModel(c);
  assert.deepEqual(reconcileMissingLodDerivatives(c.processing,c.storage,{meshDerivativesEnabled:true,limit:20}),{scanned:1,queued:1,conflict:false});
  const job=c.db.prepare('SELECT * FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id);
  assert.equal(job.derivative_type,'mesh_tiles');
  assert.equal(job.status,'pending');
  assert.equal(JSON.parse(job.request_json).optional,true);
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
  assert.equal(c.processing.getModelOutput(item.versionId).status,'ready');
  assert.equal(c.db.prepare('SELECT status FROM model_versions WHERE id=?').get(item.versionId).status,'ready');
  reconcileMissingLodDerivatives(c.processing,c.storage,{meshDerivativesEnabled:true,limit:20});
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id).n,1);
});

test('optional LOD failure is terminal until audited manual retry and preserves readiness',t=>{
  const c=fixture(t),item=readyModel(c);
  c.processing.enqueueOptionalDerivatives(item.attempt.id,[{type:'mesh_tiles',request:{optional:true}}]);
  const claimed=c.processing.claimDerivative('lod-worker');
  assert.equal(c.processing.failOptionalDerivative(claimed.id,'lod-worker','converter failed','derivative_failed'),true);
  assert.equal(c.processing.claimDerivative('automatic-retry'),null,'failed optional work is not automatically retried');
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
  assert.equal(c.processing.getModelOutput(item.versionId).status,'ready');
  assert.equal(c.db.prepare('SELECT status FROM model_versions WHERE id=?').get(item.versionId).status,'ready');
  const retried=c.processing.retryOptionalDerivative(claimed.id,'ops:test');
  assert.equal(retried.status,'pending');
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
  assert.equal(c.processing.getModelOutput(item.versionId).status,'ready');
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='derivative.retry' AND entity_id=?").get(claimed.id).n,1);
});

test('failed imported tile audit quarantines tiles while preserving the GLB fallback',t=>{
  const c=fixture(t),item=readyModel(c,{assets:['glb']});
  c.processing.addModelAsset({versionId:item.versionId,kind:'tiles',rootKey:'models',relativePath:'legacy/tiles/tileset.json',format:'3dtiles',contentType:'application/json',byteSize:2,attemptId:item.attempt.id,sha256:'c'.repeat(64)});
  c.processing.enqueueOptionalDerivatives(item.attempt.id,[{type:'lod_audit',request:{optional:true,tilesRootKey:'models',tilesRelativePath:'legacy/tiles'}}]);
  const claimed=c.processing.claimDerivative('lod-worker');
  assert.equal(c.processing.completeOptionalDerivative(claimed.id,'lod-worker',{verified:false,fallback:'glb'}),true);
  assert.deepEqual(c.processing.modelAssetsForVersion(item.versionId).map(asset=>asset.kind),['glb']);
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
  assert.equal(c.processing.getModelOutput(item.versionId).status,'ready');
  assert.equal(c.db.prepare('SELECT status FROM model_versions WHERE id=?').get(item.versionId).status,'ready');
  const audit=c.db.prepare("SELECT details_json FROM audit_events WHERE action='derivative.optional_complete' AND entity_id=?").get(claimed.id);
  assert.deepEqual(JSON.parse(audit.details_json).invalidatedAssetKinds,['tiles']);
});

test('the derivative worker executes a real external-GLB tile audit and registers verified tiles',async t=>{
  const c=fixture(t),item=readyModel(c,{assets:['glb']});
  const {writeAuditableFixture}=await import('./helpers/lod-fixture.mjs');
  const tilesRelativePath=`${item.task.id}/${item.attempt.id}/native-tiles`;
  const tilesDir=path.join(c.root,'models',...tilesRelativePath.split('/'));
  const fixtureSource=writeAuditableFixture(tilesDir);
  const glbPath=path.join(c.root,'datasets','legacy','model.glb');
  fs.mkdirSync(path.dirname(glbPath),{recursive:true});
  fs.copyFileSync(fixtureSource,glbPath);
  fs.rmSync(fixtureSource);
  c.processing.enqueueOptionalDerivatives(item.attempt.id,[{type:'lod_audit',request:{optional:true,tilesRootKey:'models',tilesRelativePath}}]);

  assert.equal(await processOneDerivative({processing:c.processing,storage:c.storage,config:{opsBaseUrl:'https://ops.example',meshDerivativesEnabled:true}},'lod-worker'),true);
  const job=c.db.prepare('SELECT status,result_json FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id);
  assert.equal(job.status,'complete');
  assert.deepEqual(JSON.parse(job.result_json),{verified:true,reused:true});
  const tiles=c.processing.modelAssetsForVersion(item.versionId).find(asset=>asset.kind==='tiles');
  assert.ok(tiles);
  assert.equal(tiles.relativePath,`${tilesRelativePath}/tileset.json`);
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
  assert.equal(c.processing.getModelOutput(item.versionId).status,'ready');
  assert.equal(c.db.prepare('SELECT status FROM model_versions WHERE id=?').get(item.versionId).status,'ready');
});

test('failed regeneration cannot leave proven-invalid imported tiles registered',async t=>{
  const c=fixture(t),item=readyModel(c),{writeAuditableFixture}=await import('./helpers/lod-fixture.mjs');
  const sourceFixture=path.join(c.root,'source-fixture'),source=writeAuditableFixture(sourceFixture);
  const glbPath=path.join(c.root,'datasets','legacy','model.glb'),objPath=path.join(c.root,'datasets','legacy','model.obj');
  fs.mkdirSync(path.dirname(glbPath),{recursive:true});
  fs.copyFileSync(source,glbPath);
  fs.writeFileSync(objPath,'invalid converter input is never reached by a real converter');
  const tilesRelativePath=`${item.task.id}/${item.attempt.id}/invalid-native`;
  const tilesDir=path.join(c.root,'models',...tilesRelativePath.split('/'));
  fs.mkdirSync(tilesDir,{recursive:true});
  fs.writeFileSync(path.join(tilesDir,'tileset.json'),'{"asset":{"version":"1.1"},"root":{"geometricError":0,"boundingVolume":{"sphere":[0,0,0,1]},"content":{"uri":"missing.b3dm"}}}');
  c.processing.addModelAsset({versionId:item.versionId,kind:'tiles',rootKey:'models',relativePath:`${tilesRelativePath}/tileset.json`,format:'3dtiles',contentType:'application/json',byteSize:1,attemptId:item.attempt.id,sha256:'c'.repeat(64)});
  c.processing.enqueueOptionalDerivatives(item.attempt.id,[{type:'lod_audit',request:{optional:true,tilesRootKey:'models',tilesRelativePath,generateFromObjOnFailure:true}}]);

  await processOneDerivative({processing:c.processing,storage:c.storage,config:{opsBaseUrl:'https://ops.example',meshDerivativesEnabled:true,obj2TilesBin:path.join(c.root,'missing-obj2tiles')}},'lod-worker');
  const job=c.db.prepare('SELECT status FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id);
  assert.equal(job.status,'failed');
  assert.deepEqual(c.processing.modelAssetsForVersion(item.versionId).map(asset=>asset.kind).sort(),['glb','obj']);
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
  assert.equal(c.processing.getModelOutput(item.versionId).status,'ready');
  assert.equal(c.db.prepare('SELECT status FROM model_versions WHERE id=?').get(item.versionId).status,'ready');
});

test('an ENOSPC audit-evidence failure preserves native tiles for manual retry',async t=>{
  const c=fixture(t),item=readyModel(c,{assets:['glb']}),tilesRelativePath=`${crypto.randomUUID()}/tiles`;
  const glbPath=path.join(c.root,'datasets','legacy','model.glb'),tilesDir=path.join(c.root,'models',...tilesRelativePath.split('/'));
  fs.mkdirSync(path.dirname(glbPath),{recursive:true});fs.writeFileSync(glbPath,'glb');
  fs.mkdirSync(tilesDir,{recursive:true});fs.writeFileSync(path.join(tilesDir,'tileset.json'),'{}');
  c.processing.addModelAsset({versionId:item.versionId,kind:'tiles',rootKey:'models',relativePath:`${tilesRelativePath}/tileset.json`,format:'3dtiles',contentType:'application/json',byteSize:2,attemptId:item.attempt.id,sha256:'c'.repeat(64)});
  c.processing.enqueueOptionalDerivatives(item.attempt.id,[{type:'lod_audit',request:{optional:true,tilesRootKey:'models',tilesRelativePath}}]);
  const auditScript=path.join(c.root,'operational-audit-failure.mjs');
  const classifierUrl=new URL('../scripts/lib/lod-equivalence.mjs',require('node:url').pathToFileURL(__filename)).href;
  fs.writeFileSync(auditScript,`import { auditFailureExitCode } from ${JSON.stringify(classifierUrl)}; const error=Object.assign(new Error('no space left while writing provenance'),{code:'ENOSPC'}); console.error(error.message); process.exit(auditFailureExitCode(error));\n`);

  await processOneDerivative({processing:c.processing,storage:c.storage,config:{opsBaseUrl:'https://ops.example',meshDerivativesEnabled:true},lodAuditScript:auditScript},'lod-worker');
  assert.equal(c.db.prepare('SELECT status FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id).status,'failed');
  assert.equal(c.processing.modelAssetsForVersion(item.versionId).some(asset=>asset.kind==='tiles'),true);
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
});

test('legacy backfill probes native tiles relative to the recorded output root',t=>{
  const c=fixture(t),item=readyModel(c),outputRelativePath=`legacy/${crypto.randomUUID()}`;
  c.db.prepare('UPDATE model_outputs SET relative_path=? WHERE id=?').run(outputRelativePath,item.versionId);
  const tilesDir=path.join(c.root,'models',...outputRelativePath.split('/'),'3d_tiles','model');
  fs.mkdirSync(tilesDir,{recursive:true});
  fs.writeFileSync(path.join(tilesDir,'tileset.json'),'{}');
  assert.equal(reconcileMissingLodDerivatives(c.processing,c.storage,{meshDerivativesEnabled:true}).queued,1);
  const job=c.db.prepare('SELECT derivative_type,request_json FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id);
  assert.equal(job.derivative_type,'lod_audit');
  assert.equal(JSON.parse(job.request_json).tilesRelativePath,`${outputRelativePath}/3d_tiles/model`);
});

test('GLB-only legacy models stay on explicit full-mesh fallback',t=>{
  const c=fixture(t),item=readyModel(c,{assets:['glb']});
  assert.equal(reconcileMissingLodDerivatives(c.processing,c.storage,{meshDerivativesEnabled:true}).queued,0);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id).n,0);
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
});

test('transient backfill conflict is retried instead of skipped',t=>{
  const c=fixture(t),item=readyModel(c),original=c.processing.enqueueOptionalDerivatives.bind(c.processing);
  c.processing.enqueueOptionalDerivatives=()=>null;
  assert.equal(reconcileMissingLodDerivatives(c.processing,c.storage,{meshDerivativesEnabled:true}).conflict,true);
  c.processing.enqueueOptionalDerivatives=original;
  assert.equal(reconcileMissingLodDerivatives(c.processing,c.storage,{meshDerivativesEnabled:true}).queued,1);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id).n,1);
});

test('derivative list and retry API enforce read/write permissions',async t=>{
  const c=fixture(t),item=readyModel(c),readToken='lod-read-token-000000000000000000000',writeToken='lod-write-token-00000000000000000000';
  c.processing.enqueueOptionalDerivatives(item.attempt.id,[{type:'mesh_tiles',request:{optional:true}}]);
  const claimed=c.processing.claimDerivative('lod-worker');
  c.processing.failOptionalDerivative(claimed.id,'lod-worker','failed');
  c.processing.createAdminSession({tokenHash:auth.hashToken(readToken),subject:'ops:read',permissions:['viewer.processing.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  c.processing.createAdminSession({tokenHash:auth.hashToken(writeToken),subject:'ops:write',permissions:['viewer.processing.read','viewer.processing.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json());app.use(createProcessingApi({repository:c.repository,processing:c.processing,storage:c.storage}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers=token=>({authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()});
  assert.equal((await fetch(`${base}/api/v1/processing/derivatives`,{headers:headers(readToken)})).status,200);
  assert.equal((await fetch(`${base}/api/v1/processing/derivatives/${claimed.id}/retry`,{method:'POST',headers:headers(readToken),body:'{}'})).status,403);
  const response=await fetch(`${base}/api/v1/processing/derivatives/${claimed.id}/retry`,{method:'POST',headers:headers(writeToken),body:'{}'});
  assert.equal(response.status,202);
  assert.equal((await response.json()).derivative.status,'pending');
});
