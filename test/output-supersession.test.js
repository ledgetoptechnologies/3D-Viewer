'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');
const {purgeExpiredTrash,applyStorageMutation}=require('../server/storageLifecycle');
const {candidateState,contentSuperset,retireSupersededOutputs,purgeSupersededOutputs}=require('../server/outputSupersession');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const linux={skip:process.platform==='win32'};

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-supersession-'));
  const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0};
  const storage=new StorageManager(config);
  if(process.platform==='win32'){for(const location of Object.values(config).filter(value=>typeof value==='string'))fs.mkdirSync(location,{recursive:true});}
  else storage.initialize();
  const database=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Supersession'}),dataset=processing.createDataset({projectId:project.id,displayName:'Retained originals',storageMode:'managed',rootKey:'datasets',relativePath:'retained-originals'});
  processing.finalizeDataset(dataset.id,[],digest('empty'));
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'One task'});
  const create=(name,active)=>{
    const attempt=processing.createImportedAttempt({id:crypto.randomUUID(),taskId:task.id,datasetId:dataset.id,providerTaskId:name,createdBy:'test',staged:false});
    const relativePath=`${task.id}/${attempt.id}`,versionId=crypto.randomUUID();
    fs.mkdirSync(storage.resolve('models',relativePath),{recursive:true});fs.writeFileSync(storage.resolve('models',`${relativePath}/model.glb`),'same original');
    const model=repository.upsertModelVersion({versionId,provider:'webodm',providerModelId:task.id,providerVersionId:name,displayName:name,status:'ready',makeActive:active,assets:[{kind:'glb',rootKey:'models',relativePath:`${relativePath}/model.glb`,byteSize:13,sha256:digest('same original'),published:false}]});
    processing.setAttemptResult(attempt.id,model.id,versionId);
    processing.registerModelOutput({versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath,byteSize:13,assetCount:1});
    return processing.getModelOutput(versionId);
  };
  const source=create('old',false),target=create('replacement',true),id=crypto.randomUUID(),time=new Date().toISOString();
  const jobId=processing.enqueueDerivative(target.attemptId,'lod_audit',{});
  database.prepare("UPDATE derivative_jobs SET status='complete',result_json=? WHERE id=?").run(JSON.stringify({verified:true}),jobId);
  const payload={lodRecovery:true,sourceOutputId:source.id,sourceVersionId:source.id,ids:{versionId:target.id,attemptId:target.attemptId,taskId:task.id,modelId:target.modelId}};
  database.prepare("INSERT INTO dataset_operations(id,operation_type,subject,dataset_id,payload_json,status,processing_attempt_id,available_at,created_at,updated_at,completed_at) VALUES (?,'catalog_map','test',?,?,'succeeded',?,?,?,?,?)").run(id,dataset.id,JSON.stringify(payload),target.attemptId,time,time,time,time);
  return{root,storage,database,processing,repository,source,target,task,dataset,jobId,create,operation:()=>database.prepare('SELECT * FROM dataset_operations WHERE id=?').get(id)};
}

test('exact content proof rejects an original missing from replacement',()=>{
  const file={relativePath:'model.glb',byteSize:7,sha256:'a'.repeat(64)};
  assert.equal(contentSuperset({files:[file]},{files:[file]}),true);
  assert.equal(contentSuperset({files:[file]},{files:[{...file,sha256:'b'.repeat(64)}]}),false);
  assert.equal(contentSuperset({files:[]},{files:[file]}),false);
  const obj={relativePath:'a/model.obj',byteSize:7,sha256:'a'.repeat(64)},mtl={relativePath:'a/mat.mtl',byteSize:8,sha256:'b'.repeat(64)};
  assert.equal(contentSuperset({files:[obj,mtl]},{files:[{...obj,relativePath:'b/model.obj'},{...mtl,relativePath:'c/mat.mtl'}]}),false,'separate relocation breaks relative references');
  assert.equal(contentSuperset({files:[obj,mtl]},{files:[{...obj,relativePath:'copy/a/model.obj'},{...mtl,relativePath:'copy/a/mat.mtl'}]}),true,'one coherent prefix preserves the entire dependency tree');
});

test('candidate requires same-task explicit success, active replacement and completed verification',t=>{
  const c=fixture(t),state=()=>candidateState(c.processing,c.operation(),c.source.id);
  assert.equal(state().eligible,true);
  c.database.prepare('UPDATE models SET active_version_id=? WHERE id=?').run(c.source.id,c.source.modelId);
  assert.equal(state().reason,'replacement_not_active');
  c.database.prepare('UPDATE models SET active_version_id=? WHERE id=?').run(c.target.id,c.source.modelId);
  c.database.prepare("UPDATE derivative_jobs SET result_json='{}' WHERE id=?").run(c.jobId);
  assert.equal(state().reason,'replacement_not_verified');
  assert.equal(candidateState(c.processing,{...c.operation(),status:'failed'},c.source.id).eligible,false);
  assert.equal(candidateState(c.processing,{...c.operation(),payload_json:'{}'},c.source.id).eligible,false);
});

test('candidate protects sessions, published assets, shared paths, pending derivatives and adopted storage',t=>{
  const c=fixture(t),state=()=>candidateState(c.processing,c.operation(),c.source.id);
  c.repository.createViewerSession({tokenHash:digest('session'),modelId:c.source.modelId,modelVersionId:c.source.id,subject:'viewer',audience:'ops',permissions:{view:true},expiresAt:new Date(Date.now()+60000).toISOString()});
  assert.equal(state().reason,'source_in_use');
  c.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());
  c.database.prepare('UPDATE model_assets SET published=1 WHERE version_id=?').run(c.source.id);
  assert.equal(state().reason,'source_published');
  c.database.prepare('UPDATE model_assets SET published=0 WHERE version_id=?').run(c.source.id);
  c.database.prepare('UPDATE model_assets SET relative_path=? WHERE version_id=?').run(`${c.source.relativePath}/model.glb`,c.target.id);
  assert.equal(state().reason,'shared_asset_dependency');
  c.database.prepare('UPDATE model_assets SET relative_path=? WHERE version_id=?').run(`${c.target.relativePath}/model.glb`,c.target.id);
  c.processing.enqueueDerivative(c.source.attemptId,'ept',{optional:true});
  assert.equal(state().reason,'derivative_or_retry_dependency');
  c.database.prepare("UPDATE derivative_jobs SET status='complete' WHERE attempt_id=?").run(c.source.attemptId);
  c.database.prepare("UPDATE model_outputs SET storage_mode='adopted' WHERE id=?").run(c.source.id);
  assert.equal(state().reason,'storage_not_exclusively_managed');
});

test('atomic archive+trash intent rejects dependency changes without modifying output',t=>{
  const c=fixture(t);
  const blocked=c.processing.beginOutputTrashMutation(c.source.id,'test','ready',{archiveInactiveReady:true,validate:()=>false});
  assert.equal(blocked,null);assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  const mutation=c.processing.beginOutputTrashMutation(c.source.id,'test','ready',{archiveInactiveReady:true,validate:()=>candidateState(c.processing,c.operation(),c.source.id).eligible});
  assert.equal(mutation.status,'intent');assert.equal(c.processing.getModelOutput(c.source.id).status,'archived');
  assert.equal(c.processing.beginOutputTrashMutation(c.source.id,'test','ready',{validate:()=>false}),null,'existing durable intents still rerun caller validation');
  const complete=applyStorageMutation(c.processing,c.storage,mutation);
  assert.equal(complete.status,'complete');assert.equal(c.processing.getModelOutput(c.source.id).status,'trashed');
  assert.equal(c.database.prepare('SELECT active_version_id FROM models WHERE id=?').get(c.target.modelId).active_version_id,c.target.id);
});

test('verified supersession is recoverable for 14 days then purges only redundant old output',linux,async t=>{
  const c=fixture(t),result=await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(result[0]?.status,'retired');
  const trash=c.processing.getTrash(result[0].trashId);
  assert.ok(new Date(trash.purgeAfter)-Date.now()>13.9*86400_000);
  assert.equal(c.processing.getModelOutput(c.source.id).status,'trashed');
  assert.equal(fs.readFileSync(c.storage.resolve('models',`${c.target.relativePath}/model.glb`),'utf8'),'same original');
  assert.equal((await retireSupersededOutputs(c.processing,c.storage)).length,0);
  assert.equal(purgeExpiredTrash(c.processing,c.storage).length,0);
  c.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run('2000-01-01T00:00:00.000Z',trash.id);
  c.database.prepare("INSERT INTO model_camera_photos(version_id,filename,root_key,relative_path,content_type,byte_size,sha256,created_at) VALUES (?,'original.jpg','models',?,'image/jpeg',13,?,?)").run(c.source.id,`${c.source.relativePath}/model.glb`,digest('same original'),new Date().toISOString());
  assert.equal(purgeExpiredTrash(c.processing,c.storage)[0].status,'deferred','generic purge cannot bypass revalidation');
  assert.equal((await purgeSupersededOutputs(c.processing,c.storage))[0].status,'complete');
  assert.equal(c.processing.getModelOutput(c.source.id).byteSize,0);
  assert.ok(c.processing.getAttempt(c.source.attemptId),'attempt history survives');
  assert.ok(c.processing.getDataset(c.dataset.id),'original input dataset survives');
  assert.equal(c.database.prepare('SELECT count(*) n FROM model_camera_photos WHERE version_id=?').get(c.source.id).n,0);
  assert.ok(fs.existsSync(c.storage.resolve('models',`${c.target.relativePath}/model.glb`)));
});

test('legacy manifest descendants and physical root aliases prevent automatic retirement',t=>{
  const c=fixture(t),legacyId=crypto.randomUUID();
  c.repository.upsertModelVersion({versionId:legacyId,provider:'legacy',providerModelId:'separate-model',providerVersionId:'legacy',displayName:'Legacy',status:'ready',makeActive:false,assets:[{kind:'tiles',rootKey:'models',relativePath:'legacy-tileset.json',byteSize:2,sha256:digest('{}'),published:false,manifestFiles:[{relativePath:`${c.source.relativePath}/model.glb`,byteSize:13,sha256:digest('same original')}]}]});
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'shared_asset_dependency');
  c.database.prepare('DELETE FROM model_asset_files WHERE asset_id IN (SELECT id FROM model_assets WHERE version_id=?)').run(legacyId);
  c.database.prepare("UPDATE model_assets SET root_key='derivatives',relative_path='model.glb' WHERE version_id=?").run(legacyId);
  c.database.prepare('UPDATE model_versions SET source_locator_json=? WHERE id=?').run(JSON.stringify({legacyAssetRoots:{derivatives:c.storage.resolve('models',c.source.relativePath)}}),legacyId);
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'shared_asset_dependency');
});

test('replacement loss blocks expired-trash purge and durable intent replay',linux,async t=>{
  const c=fixture(t),retired=(await retireSupersededOutputs(c.processing,c.storage))[0],trash=c.processing.getTrash(retired.trashId);
  c.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run('2000-01-01T00:00:00.000Z',trash.id);
  const pending=c.processing.beginPurgeMutation(trash.id,'storage-maintenance');
  c.database.prepare("UPDATE model_outputs SET status='trashed' WHERE id=?").run(c.target.id);
  assert.throws(()=>applyStorageMutation(c.processing,c.storage,pending),{code:'supersession_reverification_required'});
  assert.equal((await purgeSupersededOutputs(c.processing,c.storage))[0].status,'deferred');
  assert.ok(fs.existsSync(c.storage.resolve('trash',trash.relativePath)),'last preserved copy survives');
  assert.equal(c.processing.getStorageMutation(pending.id).status,'intent');
});

test('legacy root symlink is canonicalized before dependency exclusion',linux,t=>{
  const c=fixture(t),legacyId=crypto.randomUUID(),alias=path.join(c.root,'legacy-alias');
  fs.symlinkSync(c.storage.resolve('models',c.source.relativePath),alias,'dir');
  c.repository.upsertModelVersion({versionId:legacyId,provider:'legacy',providerModelId:'alias-model',providerVersionId:'legacy',displayName:'Alias',status:'ready',makeActive:false,sourceLocator:{legacyAssetRoots:{derivatives:alias}},assets:[{kind:'glb',rootKey:'derivatives',relativePath:'model.glb',byteSize:13,sha256:digest('same original'),published:false}]});
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'shared_asset_dependency');
});

test('explicit restore is a durable opt-out from later automatic retirement',linux,async t=>{
  const c=fixture(t),retired=(await retireSupersededOutputs(c.processing,c.storage))[0];
  const restore=c.processing.beginRestoreMutation(retired.trashId,'operator');
  assert.ok(restore);applyStorageMutation(c.processing,c.storage,restore);
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'explicit_restore_preserved');
  await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  assert.ok(fs.existsSync(c.storage.resolve('models',c.source.relativePath)));
});

test('unknown original file blocks cleanup and immutable pair is not rehashed on every maintenance pass',linux,async t=>{
  const c=fixture(t);fs.writeFileSync(c.storage.resolve('models',`${c.source.relativePath}/original-photo.jpg`),'irreplaceable');
  c.database.prepare('UPDATE model_outputs SET byte_size=26 WHERE id=?').run(c.source.id);
  const first=await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(first[0].reason,'content_not_fully_preserved');
  assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  const events=c.database.prepare("SELECT count(*) n FROM audit_events WHERE action='output.supersession_evaluated'").get().n;
  assert.equal(events,1);
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[]);
  assert.equal(c.database.prepare("SELECT count(*) n FROM audit_events WHERE action='output.supersession_evaluated'").get().n,1);
});

test('session dependency is diagnosed once and retirement resumes after the session ends',linux,async t=>{
  const c=fixture(t);
  c.repository.createViewerSession({tokenHash:digest('wait-session'),modelId:c.source.modelId,modelVersionId:c.target.id,subject:'viewer',audience:'ops',permissions:{view:true},expiresAt:new Date(Date.now()+60000).toISOString()});
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0].reason,'source_in_use');
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[]);
  c.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0].status,'retired');
});

test('registered integrity mismatch blocks even when both output copies have the same altered bytes',linux,async t=>{
  const c=fixture(t);
  for(const output of [c.source,c.target])fs.writeFileSync(c.storage.resolve('models',`${output.relativePath}/model.glb`),'bad! original');
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0].reason,'registered_integrity_mismatch');
  assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
});

test('replacement corruption during grace retains the last good copy',linux,async t=>{
  const c=fixture(t),retired=(await retireSupersededOutputs(c.processing,c.storage))[0],trash=c.processing.getTrash(retired.trashId);
  c.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run('2000-01-01T00:00:00.000Z',trash.id);
  fs.writeFileSync(c.storage.resolve('models',`${c.target.relativePath}/model.glb`),'bad! original');
  const result=await purgeSupersededOutputs(c.processing,c.storage);
  assert.equal(result[0].reason,'supersession_content_changed');
  assert.equal(fs.readFileSync(c.storage.resolve('trash',`${trash.relativePath}/model.glb`),'utf8'),'same original');
  assert.ok(Date.parse(c.processing.getTrash(trash.id).purgeAfter)>Date.now(),'failed proof receives a bounded daily retry');
});

test('bounded scan reaches eligible history beyond the newest 100 recovery operations',linux,async t=>{
  const c=fixture(t),operation=c.operation();
  c.database.prepare("UPDATE dataset_operations SET completed_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(operation.id);
  const insert=c.database.prepare("INSERT INTO dataset_operations(id,operation_type,subject,dataset_id,payload_json,status,processing_attempt_id,available_at,created_at,updated_at,completed_at) VALUES (?,'catalog_map','test',?,?,'succeeded',?,?,?,?,?)");
  for(let index=0;index<100;index++)insert.run(crypto.randomUUID(),c.dataset.id,JSON.stringify({lodRecovery:true}),c.target.attemptId,operation.created_at,operation.created_at,operation.created_at,operation.created_at);
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[]);
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.status,'retired');
});

test('pair budget resumes at companion source instead of repeatedly checking its predecessor',linux,async t=>{
  const c=fixture(t),companion=c.create('companion',false),operation=c.operation(),payload=JSON.parse(operation.payload_json);
  c.database.prepare('UPDATE processing_tasks SET active_attempt_id=? WHERE id=?').run(c.target.attemptId,c.task.id);
  payload.companionSourceOutputId=companion.id;
  c.database.prepare('UPDATE dataset_operations SET payload_json=? WHERE id=?').run(JSON.stringify(payload),operation.id);
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.sourceOutputId,c.source.id);
  const cursor=JSON.parse(c.database.prepare("SELECT details_json FROM audit_events WHERE action='output.supersession_scan_cursor' ORDER BY created_at DESC,rowid DESC LIMIT 1").get().details_json);
  assert.equal(cursor.resumeSourceId,companion.id);
  const second=await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(second[0]?.sourceOutputId,companion.id);assert.equal(second[0]?.status,'retired');
});

test('shutdown cancellation stops content hashing before any retirement intent',linux,async t=>{
  const c=fixture(t),controller=new AbortController(),read=fs.read;let reads=0;
  t.mock.method(fs,'read',function(...args){const callback=args.pop();return read.call(this,...args,(...result)=>{reads++;controller.abort();callback(...result);});});
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage,{signal:controller.signal}),[]);
  assert.equal(reads,1,'abort stops after the current bounded read rather than hashing the whole replacement');
  assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  assert.equal(c.database.prepare('SELECT count(*) n FROM storage_mutations').get().n,0);
  assert.equal(c.database.prepare("SELECT count(*) n FROM audit_events WHERE action='output.supersession_evaluated'").get().n,0,'normal shutdown does not impose a one-day failure cooldown');
});

test('worker shutdown aborts both supersession passes and joins maintenance before closing database',()=>{
  const worker=fs.readFileSync(path.join(__dirname,'../server/worker.js'),'utf8');
  assert.match(worker,/process\.once\(signal,\(\)=>maintenanceAbort\.abort\(\)\)/);
  for(const method of ['retireSupersededOutputs','purgeSupersededOutputs'])assert.ok(worker.includes(`${method}(processing,storage,{limit:1,signal:maintenanceAbort.signal})`));
  assert.ok(worker.includes('await maintenancePending;db.close()'));
  assert.match(worker,/async function maintenanceStep\(name,run\)\{if\(stopped\)return null/);
});
