'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {pointCloudDerivativeSpecs}=require('../server/pointCloudImportPolicy');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');
const {processOneDatasetOperation}=require('../server/datasetOperationWorker');
const {inspectPointCloudRecoverySource}=require('../server/pointCloudRecovery');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const point=format=>({kind:'pointCloud',format,sha256:'a'.repeat(64)});

for(const format of ['laz','las'])test(`raw ${format} requires EPT; disabled policy refuses false readiness`,()=>{
  assert.deepEqual(pointCloudDerivativeSpecs([point(format)],{localDerivativesEnabled:true}),[{type:'ept',request:{optional:false}}]);
  assert.throws(()=>pointCloudDerivativeSpecs([point(format)]),{code:'point_cloud_indexing_unavailable'});
});
test('existing hashed EPT avoids redundant indexing, even with converter disabled',()=>{
  assert.deepEqual(pointCloudDerivativeSpecs([point('laz'),{kind:'ept',sha256:'b'.repeat(64),manifestSha256:'c'.repeat(64)}]),[]);
  assert.throws(()=>pointCloudDerivativeSpecs([point('laz'),{kind:'ept',sha256:'b'.repeat(64)}]),{code:'point_cloud_indexing_unavailable'});
});
test('unsupported or unhashed clouds cannot enter the converter',()=>{
  for(const asset of [point('txt'),point('ply'),{kind:'pointCloud',format:'laz'}])assert.throws(()=>pointCloudDerivativeSpecs([asset],{localDerivativesEnabled:true}),{code:'point_cloud_source_unsupported'});
  assert.deepEqual(pointCloudDerivativeSpecs([{kind:'dsm'}]),[]);
});

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-cloud-policy-'));
  const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),datasetImportMount:path.join(root,'imports'),storageReserveBytes:0,storageReservePercent:0,uploadMaxFiles:1000,localDerivativesEnabled:true};
  for(const key of ['datasetsMount','modelsMount','cacheMount','trashMount','datasetImportMount'])fs.mkdirSync(config[key],{recursive:true});
  const database=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(database),repository=new ViewerRepository(database),storage=new StorageManager(config);if(process.platform==='linux')storage.initialize();
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true})});return{root,config,database,processing,repository,storage};
}
function readyCloud(c){
  const project=c.processing.createProject({displayName:`Cloud policy ${crypto.randomUUID()}`}),dataset=c.processing.createDataset({projectId:project.id,displayName:'Retained source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  c.processing.finalizeDataset(dataset.id,[{relativePath:'original.jpg',byteSize:1,sha256:hash('p')}],hash('manifest'));
  const task=c.processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Cloud only'}),attempt=c.processing.createImportedAttempt({id:crypto.randomUUID(),taskId:task.id,datasetId:dataset.id,providerTaskId:`raw:${task.id}`,createdBy:'ops:test',staged:false});
  const relativePath=`${task.id}/${attempt.id}`,body=Buffer.alloc(247);body.write('LASF');body[24]=1;body[25]=2;body.writeUInt16LE(227,94);body.writeUInt32LE(227,96);body.writeUInt16LE(20,105);body.writeUInt32LE(1,107);for(const offset of [131,139,147])body.writeDoubleLE(0.001,offset);
  fs.mkdirSync(path.join(c.config.modelsMount,relativePath),{recursive:true});fs.writeFileSync(path.join(c.config.modelsMount,relativePath,'georeferenced_model.las'),body);
  const model=c.repository.upsertModelVersion({provider:'terra',providerModelId:task.id,providerVersionId:attempt.id,displayName:task.displayName,status:'ready',makeActive:false,georef:{crs:'EPSG:32616'},assets:[{kind:'pointCloud',format:'las',rootKey:'models',relativePath:`${relativePath}/georeferenced_model.las`,byteSize:body.length,sha256:hash(body),published:false}]});
  const versionId=c.database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;c.processing.setAttemptResult(attempt.id,model.id,versionId);
  c.processing.registerModelOutput({versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,rootKey:'models',relativePath,storageMode:'managed',status:'ready',byteSize:body.length,assetCount:1});
  const files=[{relativePath:'georeferenced_model.las',sourceRelativePath:'georeferenced_model.las',role:'point_cloud_source',byteSize:body.length,sha256:hash(body)}];
  return{project,dataset,task,attempt,model,versionId,relativePath,body,manifest:{files,manifestSha256:hash(JSON.stringify(files))}};
}
test('cloud recovery is durable, duplicate-safe and creates new identities without changing the original',t=>{
  const c=fixture(t),source=readyCloud(c),before=c.repository.getModelVersion(source.model.id,source.versionId);
  assert.equal(c.processing.pointCloudRecoveryCandidate(source.versionId),null);
  assert.equal(c.processing.pointCloudDerivativeState(source.versionId).disabledByPolicy,true);
  const value={outputId:source.versionId,subject:'ops:test',sessionId:'test',manifest:source.manifest,pointCloudRecovery:true};
  const first=c.processing.createLodRecoveryOperation(value),second=c.processing.createLodRecoveryOperation(value);
  assert.equal(first.id,second.id);
  const payload=JSON.parse(c.database.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(first.id).payload_json);
  assert.notEqual(payload.ids.versionId,source.versionId);assert.notEqual(payload.ids.attemptId,source.attempt.id);assert.equal(payload.pointCloudRecovery,true);
  assert.deepEqual(c.repository.getModelVersion(source.model.id,source.versionId),before);
  assert.throws(()=>c.processing.createLodRecoveryOperation({...value,subject:'ops:another'}),{code:'lod_recovery_in_progress'});
});
test('cloud recovery refuses changed registered source hashes and never treats LAZ as a public derivative',t=>{
  const c=fixture(t),source=readyCloud(c),bad={files:[{...source.manifest.files[0],sha256:'b'.repeat(64)}],manifestSha256:'c'.repeat(64)};
  assert.equal(c.processing.createLodRecoveryOperation({outputId:source.versionId,subject:'ops:test',manifest:bad,pointCloudRecovery:true}),null);
  assert.equal(require('../server/processingSecurity').publicDerivativeKind('pointCloud'),false);
});

test('queued cloud materializations reserve the physical copy once, not the authorization manifest twice',t=>{
  const c=fixture(t),sources=[readyCloud(c),readyCloud(c)];
  for(const source of sources)c.processing.createLodRecoveryOperation({outputId:source.versionId,subject:'ops:test',manifest:source.manifest,pointCloudRecovery:true});
  assert.equal(c.processing.activeRecoveryMaterializationBytes(),sources.reduce((sum,source)=>sum+source.body.length,0));
});

test('same owner with a newer generation fences old mutations, and nested registration rolls back atomically',t=>{
  const c=fixture(t),source=readyCloud(c),operation=c.processing.createLodRecoveryOperation({outputId:source.versionId,subject:'ops:test',manifest:source.manifest,pointCloudRecovery:true});
  const {withRecoveryMaterializationLease,recoveryScratchRelative}=require('../server/recoveryMaterializationLease'),old=c.processing.claimDatasetOperation('same-owner');
  c.database.prepare('UPDATE dataset_operations SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',operation.id);
  const current=c.processing.claimDatasetOperation('same-owner');assert.notEqual(recoveryScratchRelative(old,'target'),recoveryScratchRelative(current,'target'));
  assert.throws(()=>withRecoveryMaterializationLease(old,c.processing,()=>{throw new Error('must not execute')}),{code:'operation_lease_lost'});
  assert.throws(()=>withRecoveryMaterializationLease(current,c.processing,()=>{c.repository.transaction(()=>c.database.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('nested-regression','x','now')").run());c.processing.transaction(()=>{throw new Error('rollback all')});}),/rollback all/);
  assert.equal(c.database.prepare("SELECT * FROM app_state WHERE key='nested-regression'").get(),undefined);
  c.processing.transaction(()=>{c.database.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('outer-survives','x','now')").run();assert.throws(()=>c.repository.transaction(()=>{c.database.prepare("INSERT INTO app_state(key,value,updated_at) VALUES('inner-rolls-back','x','now')").run();throw new Error('inner only')}),/inner only/);});
  assert.ok(c.database.prepare("SELECT * FROM app_state WHERE key='outer-survives'").get());assert.equal(c.database.prepare("SELECT * FROM app_state WHERE key='inner-rolls-back'").get(),undefined);
});

test('actual cloud worker lease loss cannot promote or delete successor pre-registration files',{skip:process.platform!=='linux'},async t=>{
  const c=fixture(t),source=readyCloud(c),operation=c.processing.createLodRecoveryOperation({outputId:source.versionId,subject:'ops:test',manifest:source.manifest,pointCloudRecovery:true});
  const {recoveryScratchRelative}=require('../server/recoveryMaterializationLease'),{processPointCloudRecovery}=require('../server/pointCloudRecovery'),{cleanupLodRecoveryMaterialization}=require('../server/lodRecovery');
  const requireSpace=c.storage.requireSpace.bind(c.storage);let successor=null,destination=null,scratch=null,retainedPath=null;
  c.storage.requireSpace=(rootKey,bytes)=>{
    const result=requireSpace(rootKey,bytes);
    if(!successor&&rootKey==='models'){
      c.database.prepare('UPDATE dataset_operations SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',operation.id);
      successor=c.processing.claimDatasetOperation('successor-owner');const payload=JSON.parse(successor.payload_json);
      destination=c.storage.resolve('models',payload.targetRelativePath);retainedPath=path.join(destination,payload.companions.files[0].relativePath);fs.mkdirSync(path.dirname(retainedPath),{recursive:true});fs.writeFileSync(retainedPath,source.body);
      scratch=c.storage.resolve('models',recoveryScratchRelative(successor,payload.targetRelativePath));fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(path.join(scratch,'successor-marker'),'owned by successor');
    }
    return result;
  };
  await processOneDatasetOperation(c,'old-owner');assert.ok(successor);assert.equal(c.processing.getDatasetOperation(operation.id,'ops:test').status,'leased');
  assert.equal(fs.existsSync(retainedPath),true);assert.equal(fs.existsSync(path.join(scratch,'successor-marker')),true);
  const stale={...successor,lease_owner:'old-owner',attempt_count:successor.attempt_count-1};assert.throws(()=>cleanupLodRecoveryMaterialization(stale,c),{code:'operation_lease_lost'});
  const result=await processPointCloudRecovery(successor,c);assert.equal(result.attempt.status,'ingesting');assert.equal(c.processing.getModelOutput(result.model.activeVersion.id).status,'staged');
  assert.equal(c.processing.getModelOutput(source.versionId).status,'ready');
});

test('reclaim during asynchronous unit inspection fences old provisional rollback and final registry writes',{skip:process.platform!=='linux'},async t=>{
  const c=fixture(t),source=readyCloud(c),operation=c.processing.createLodRecoveryOperation({outputId:source.versionId,subject:'ops:test',manifest:source.manifest,pointCloudRecovery:true}),payload=JSON.parse(c.database.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(operation.id).payload_json);
  const resolve=c.storage.resolve.bind(c.storage);let successor=null;
  c.storage.resolve=(rootKey,relativePath,options)=>{
    const absolute=resolve(rootKey,relativePath,options);
    if(!successor&&options?.mustExist&&String(relativePath).startsWith(payload.targetRelativePath+'/')&&c.database.prepare('SELECT 1 FROM model_versions WHERE id=?').get(payload.ids.versionId)){
      c.database.prepare('UPDATE dataset_operations SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',operation.id);successor=c.processing.claimDatasetOperation('same-owner');
      c.database.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({successorOwns:true}),payload.ids.versionId);
    }
    return absolute;
  };
  await processOneDatasetOperation(c,'same-owner');assert.ok(successor);assert.equal(c.processing.getDatasetOperation(operation.id,'ops:test').status,'leased');
  assert.equal(c.processing.getModelOutput(payload.ids.versionId),null,'stale generation must not register or rollback successor provisional state');
  assert.equal(JSON.parse(c.database.prepare('SELECT metadata_json FROM model_versions WHERE id=?').get(payload.ids.versionId).metadata_json).successorOwns,true);
  const {processPointCloudRecovery}=require('../server/pointCloudRecovery');const result=await processPointCloudRecovery(successor,c);assert.equal(c.processing.getModelOutput(result.model.activeVersion.id).status,'staged');assert.equal(c.processing.getModelOutput(source.versionId).status,'ready');
});

test('reclaim after materialization return fences stale required-derivative activation',{skip:process.platform!=='linux'},async t=>{
  const c=fixture(t),source=readyCloud(c),operation=c.processing.createLodRecoveryOperation({outputId:source.versionId,subject:'ops:test',manifest:source.manifest,pointCloudRecovery:true}),audit=c.repository.audit.bind(c.repository);let successor=null;
  c.repository.audit=event=>{const value=audit(event);if(event.action==='point_cloud_recovery.materialized'&&!successor){c.database.prepare('UPDATE dataset_operations SET lease_expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z',operation.id);successor=c.processing.claimDatasetOperation('same-owner');}return value;};
  await processOneDatasetOperation(c,'same-owner');assert.ok(successor);assert.equal(c.processing.getDatasetOperation(operation.id,'ops:test').status,'leased');assert.equal(c.database.prepare('SELECT COUNT(*) n FROM derivative_jobs').get().n,0);
  const {processPointCloudRecovery}=require('../server/pointCloudRecovery'),{withRecoveryMaterializationLease}=require('../server/recoveryMaterializationLease'),result=await processPointCloudRecovery(successor,c);
  assert.ok(withRecoveryMaterializationLease(successor,c.processing,()=>c.processing.activateImportedDerivativesForOperation(operation.id,'same-owner',result.attempt.id,result.requiredDerivatives,result)));
  assert.equal(c.processing.getDatasetOperation(operation.id,'ops:test').status,'awaiting_derivatives');assert.equal(c.database.prepare('SELECT COUNT(*) n FROM derivative_jobs').get().n,1);assert.equal(c.processing.getModelOutput(source.versionId).status,'ready');
});
test('raw-only server import waits for required indexing with exact input reservations',{skip:process.platform!=='linux'},async t=>{
  const c=fixture(t),source=readyCloud(c),folder=path.join(c.config.datasetImportMount,'raw-cloud');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'georeferenced_model.las'),source.body);
  const operation=c.processing.createWebodmTaskImportOperation({request:{sourceRelativePath:'raw-cloud',projectId:source.project.id,taskDisplayName:'Imported cloud'},subject:'ops:test',sessionId:'test'});
  await processOneDatasetOperation(c,'cloud-import');
  const result=c.processing.getDatasetOperation(operation.id,'ops:test');assert.equal(result.status,'awaiting_derivatives',result.errorMessage);
  const job=c.database.prepare('SELECT id,request_json FROM derivative_jobs WHERE attempt_id=?').get(result.processingAttemptId);assert.equal(JSON.parse(job.request_json).optional,false);
  const input=c.processing.derivativeInputSnapshot(job.id);assert.equal(input.totalByteSize,source.body.length);assert.equal(input.files[0].sha256,hash(source.body));
  assert.equal(c.processing.getAttempt(result.processingAttemptId).status,'derivatives');assert.equal(c.processing.getModelOutput(result.result.model.activeVersion.id).status,'staged');
});
test('immutable cloud recovery materializes sealed source and queues EPT; reclaim keeps one version',{skip:process.platform!=='linux'},async t=>{
  const c=fixture(t),source=readyCloud(c),inspected=await inspectPointCloudRecoverySource(source.versionId,c);
  const operation=c.processing.createLodRecoveryOperation({outputId:source.versionId,subject:'ops:test',sessionId:'test',manifest:inspected.publicManifest,pointCloudRecovery:true});
  await processOneDatasetOperation(c,'cloud-recovery');
  const result=c.processing.getDatasetOperation(operation.id,'ops:test');assert.equal(result.status,'awaiting_derivatives',result.errorMessage);
  const version=result.result.model.activeVersion;assert.notEqual(version.id,source.versionId);assert.equal(version.georef.crs,'EPSG:32616');
  const copied=version.assets.find(asset=>asset.kind==='pointCloud');assert.equal(copied.sha256,hash(source.body));assert.equal(fs.statSync(c.storage.resolve(copied.rootKey,copied.relativePath)).mode&0o777,0o440);
  assert.equal(c.processing.getModelOutput(source.versionId).status,'ready');assert.equal(c.database.prepare('SELECT COUNT(*) n FROM derivative_jobs WHERE attempt_id=?').get(result.processingAttemptId).n,1);
  assert.equal(await processOneDatasetOperation(c,'cloud-reclaimed'),false);
});
test('disabled cloud import fails actionably, retains operator original and never announces ready',{skip:process.platform!=='linux'},async t=>{
  const c=fixture(t),source=readyCloud(c);c.config.localDerivativesEnabled=false;
  const folder=path.join(c.config.datasetImportMount,'raw-disabled');fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'georeferenced_model.las'),source.body);
  const operation=c.processing.createWebodmTaskImportOperation({request:{sourceRelativePath:'raw-disabled',projectId:source.project.id,taskDisplayName:'Disabled cloud'},subject:'ops:test'});
  await processOneDatasetOperation(c,'disabled-cloud');const result=c.processing.getDatasetOperation(operation.id,'ops:test');
  assert.equal(result.status,'failed');assert.equal(result.errorCode,'point_cloud_indexing_unavailable');assert.equal(fs.existsSync(path.join(folder,'georeferenced_model.las')),true);
  assert.equal(c.database.prepare("SELECT COUNT(*) n FROM processing_tasks WHERE display_name='Disabled cloud'").get().n,0);
  c.config.localDerivativesEnabled=true;assert.ok(c.processing.retryDatasetOperation(operation.id,'ops:test'));
  await processOneDatasetOperation(c,'enabled-cloud');const retried=c.processing.getDatasetOperation(operation.id,'ops:test');
  assert.equal(retried.status,'awaiting_derivatives',retried.errorMessage);assert.equal(c.database.prepare("SELECT COUNT(*) n FROM processing_tasks WHERE display_name='Disabled cloud'").get().n,1);
});

test('raw-cloud API is not viewer ready; recovery requires policy, live capability and write permission',{skip:process.platform!=='linux'},async t=>{
  const c=fixture(t),source=readyCloud(c),express=require('express'),auth=require('../server/auth'),{config}=require('../server/config'),{createProcessingApi}=require('../server/processingApi');
  const prior=config.localDerivativesEnabled;config.localDerivativesEnabled=false;t.after(()=>{config.localDerivativesEnabled=prior});
  const writer='cloud-api-writer-token-00000000000000',reader='cloud-api-reader-token-00000000000000';
  for(const [token,permissions] of [[writer,['viewer.processing.read','viewer.processing.write','viewer.processing.publish']],[reader,['viewer.processing.read']]])c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:`ops:${token}`,displayUnits:'imperial',permissions,expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer)}}));app.use(createProcessingApi({...c}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value))});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,endpoint=`/api/v1/processing/outputs/${source.versionId}/point-cloud-recovery-attempts`;
  const post=(token=writer,key=crypto.randomUUID())=>fetch(base+endpoint,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},body:'{}'});
  const outputs=await fetch(base+'/api/v1/processing/outputs',{headers:{authorization:`Bearer ${writer}`}});assert.equal(outputs.status,200);const output=(await outputs.json()).outputs.find(item=>item.id===source.versionId);assert.equal(output.viewerReady,false);assert.equal(output.pointCloudIndex.disabledByPolicy,true);
  const launch=await fetch(base+`/api/v1/attempts/${source.attempt.id}/review-sessions`,{method:'POST',headers:{authorization:`Bearer ${writer}`,'content-type':'application/json','idempotency-key':'cloud-review-not-ready'},body:'{}'});assert.equal(launch.status,409);assert.equal((await launch.json()).code,'asset_integrity_not_ready');
  assert.equal((await post(reader)).status,403);const disabled=await post();assert.equal(disabled.status,409);assert.equal((await disabled.json()).code,'point_cloud_indexing_unavailable');
  config.localDerivativesEnabled=true;assert.equal((await post()).status,409,'configuration alone cannot prove runtime capability');
  c.processing.recordWorkerHeartbeat('cloud-capability-test',{localDerivatives:true});
  const response=await post(writer,'cloud-recovery-durable-key');assert.equal(response.status,202);const first=(await response.json()).operation;
  const duplicate=await post(writer,'cloud-recovery-durable-key');assert.equal(duplicate.status,202);assert.equal((await duplicate.json()).operation.id,first.id);
  const renewed='cloud-api-renewed-token-0000000000000',other='cloud-api-other-writer-token-00000000';
  for(const [token,subject] of [[renewed,`ops:${writer}`],[other,'ops:another-writer']])c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject,displayUnits:'imperial',permissions:['viewer.processing.read','viewer.processing.write'],expiresAt:new Date(Date.now()+60000).toISOString()});
  const replay=await post(renewed,'cloud-recovery-durable-key');assert.equal(replay.status,202);assert.equal((await replay.json()).operation.id,first.id,'subject receipt survives session renewal');
  const denied=await post(other);assert.equal(denied.status,409);const deniedBody=await denied.json();assert.equal(deniedBody.code,'lod_recovery_in_progress');assert.equal(deniedBody.operation,undefined);
  assert.equal(c.processing.getModelOutput(source.versionId).status,'ready');assert.equal(c.database.prepare('SELECT COUNT(*) n FROM dataset_operations').get().n,1);
});
