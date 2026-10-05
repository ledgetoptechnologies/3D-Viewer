'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');
const {MeasurementSourceUnitEvidence}=require('../server/measurementSourceUnitEvidence');
const {processIngest}=require('../server/processingWorker');
const {makeZip}=require('./helpers/zipFixture');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

async function ingest(t,mode='fresh'){
  const {nativeTiffFixture}=await import('./helpers/native-tiff-fixture.mjs');
  const raster=nativeTiffFixture({verticalUnit:mode==='feet'?9002:null});
  const log={odmVersion:mode==='unknown-engine'?'3.5.7':'3.5.6',images:1,success:true,startTime:'2026-01-01T00:00:00Z',endTime:'2026-01-01T00:01:00Z',totalTime:60,
    options:{gcp:null,geo:null,align:null,sm_cluster:null,split_image_groups:null,rerun:null,rerun_from:null,rerun_all:false,split:999999,end_with:'odm_postprocess',gps_z_offset:0,dsm:true,dtm:true},
    stages:['dataset','opensfm','odm_georeferencing','odm_dem','odm_postprocess'].map(name=>({name,messages:[]})),processes:[{exitCode:0}]};
  const entries=[
    {path:'odm_texturing/odm_textured_model_geo.glb',data:'glb'},
    {path:'odm_texturing/odm_textured_model_geo.obj',data:'mtllib materials/model.mtl\nv 0 0 0\n'},
    {path:'odm_texturing/materials/model.mtl',data:'newmtl surface\nmap_Kd ../textures/model.jpg\n'},
    {path:'odm_texturing/textures/model.jpg',data:'texture'},
    {path:'entwine_pointcloud/ept.json',data:'{}'},
    {path:'3d_tiles/model/tileset.json',data:'{}'},
    {path:'odm_dem/dsm.tif',data:raster},{path:'odm_dem/dtm.tif',data:raster},
    {path:'log.json',data:JSON.stringify(log)},
    {path:'images.json',data:JSON.stringify([{filename:'a.jpg',latitude:43,longitude:-88,altitude:200}])},
    {path:'odm_georeferencing/coords.txt',data:'WGS84 UTM 16N\n100 200\n1 2 200\n'},
  ];
  if(mode==='local-cloud'||mode==='disabled-cloud'){
    entries.splice(entries.findIndex(entry=>entry.path==='entwine_pointcloud/ept.json'),1);
    entries.push({path:'odm_georeferencing/odm_georeferenced_model.laz',data:'registered-raw-source'});
  }
  const zip=makeZip(entries),requests=[];
  const server=http.createServer((req,res)=>{requests.push(req.url);res.writeHead(200,{'content-type':'application/zip','content-length':zip.length});res.end(zip);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ingest-unit-evidence-'));
  const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0,meshDerivativesEnabled:true,localDerivativesEnabled:mode==='local-cloud',processingProviderTransferTimeoutMs:5000,opsBaseUrl:'http://operations.test'};
  for(const directory of [config.datasetsMount,config.modelsMount,config.cacheMount,config.trashMount])fs.mkdirSync(directory,{recursive:true});
  const db=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(db),repository=new ViewerRepository(db),storage=new StorageManager(config);storage.initialize();
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Proof project'}),dataset=processing.createDataset({projectId:project.id,displayName:'Source',rootKey:'datasets',relativePath:'source'});
  const files=[{relativePath:'a.jpg',byteSize:4,sha256:sha('jpeg'),processingRole:'image'}];
  processing.finalizeDataset(dataset.id,files,sha(JSON.stringify(files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Local fixture',enabled:true,endpoint:`http://127.0.0.1:${server.address().port}`}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Proof task'});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id}),owner='ingest-unit-test',submit=processing.claimJob(owner);
  const snapshot=processing.getAttemptProvenance(attempt.id).submission;
  assert.equal(processing.validateAttemptInputInventory(submit.id,owner,processing.getDataset(dataset.id,true).files,snapshot.inputFiles),true);
  if(mode!=='missing-init'&&mode!=='missing-archive'){
    const init=processing.beginAttemptInitialization(submit.id,owner,{freshTaskMissing:true});
    assert.equal(init.ambiguous,false);
    assert.equal(processing.acknowledgeAttemptInitialization(submit.id,owner,init.generation,attempt.providerTaskId),true);
  }
  assert.equal(processing.setSubmissionStateForJob(submit.id,owner,'committed',1),true);
  assert.equal(processing.recordAttemptProviderResult(submit.id,owner,{uuid:attempt.providerTaskId,status:'completed'}),true);
  processing.transitionAttemptForJob(submit.id,owner,'ingesting');
  processing.completeJob(submit.id,owner);processing.enqueueJob(attempt.id,'ingest');
  const job=processing.claimJob(owner);assert.equal(job.job_type,'ingest');
  if(mode==='missing-archive'){
    // Historical extracted directory is still usable, but cannot invent a ZIP receipt.
    for(const entry of entries){const target=path.join(config.modelsMount,task.id,attempt.id,entry.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,entry.data);}
  }
  await processIngest(job,{processing,repository,storage,config,providerCredentials:{resolve:()=>''},signal:new AbortController().signal});
  assert.deepEqual(requests,mode==='missing-archive'?[]:[`/task/${attempt.providerTaskId}/download/all.zip`]);
  const completed=processing.getAttempt(attempt.id),model=repository.getModelVersion(completed.resultModelId,completed.resultModelVersionId),assets=model.activeVersion.assets;
  const transfer=processing.getAttemptTransferProvenance(attempt.id);
  if(mode!=='missing-archive'){assert.equal(transfer.archive.archiveSha256,sha(zip));assert.equal(transfer.archive.archiveFiles.length,entries.length);}
  const evidence=new MeasurementSourceUnitEvidence(db);
  return{db,processing,attempt,assets,completed,evidence,zip,snapshot};
}

test('processIngest persists exact native DSM/DTM metre evidence from real fresh receipts and returned ZIP', {skip:process.platform!=='linux'},async t=>{
  const f=await ingest(t),producer=f.processing.getVerifiedAttemptProducerReceipt(f.attempt.id);
  const ept=f.assets.find(asset=>asset.kind==='ept');
  assert.equal(ept.sha256,sha('{}'),'EPT header hash must be registered independently of its tree manifest');
  assert.match(ept.manifestSha256,/^[a-f0-9]{64}$/);
  assert.ok(producer);assert.equal(producer.receipt.inputManifestSha256,f.snapshot.inputManifestSha256);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM measurement_source_unit_evidence').get().count,2);
  for(const kind of ['dsm','dtm']){
    const source=f.assets.find(asset=>asset.kind===kind);assert.ok(source);
    const request={modelId:f.completed.resultModelId,modelVersionId:f.completed.resultModelVersionId,source,coordinateReference:{crs:'EPSG:32616'}};
    const proof=f.evidence.get(request);assert.equal(proof.basis,'verified-odm-source');assert.equal(proof.verticalUnit,'m');assert.equal(proof.verticalDatum,'unknown');
    assert.equal(proof.producerProof.archiveSha256,sha(f.zip));assert.equal(proof.sha256,source.sha256);assert.equal(proof.byteSize,source.byteSize);
    assert.equal(f.evidence.get({...request,source:{...source,sha256:'0'.repeat(64)}}),null);
  }
  for(const source of f.assets.filter(asset=>!['dsm','dtm'].includes(asset.kind)))assert.equal(f.evidence.summary(f.completed.resultModelId,f.completed.resultModelVersionId,source),null,'native raster proof must not authorize derived geometry');
});

test('node archive without EPT queues mandatory local indexing alongside existing mesh work',{skip:process.platform!=='linux'},async t=>{
  const f=await ingest(t,'local-cloud');assert.equal(f.completed.status,'derivatives');assert.equal(f.assets.some(asset=>asset.kind==='ept'),false);
  const jobs=f.db.prepare('SELECT id,derivative_type,request_json FROM derivative_jobs WHERE attempt_id=?').all(f.attempt.id),ept=jobs.find(job=>job.derivative_type==='ept');
  assert.ok(ept);assert.equal(JSON.parse(ept.request_json).optional,false);assert.ok(jobs.some(job=>job.derivative_type==='mesh_tiles'));
  const input=f.processing.derivativeInputSnapshot(ept.id);assert.equal(input.files.length,1);assert.equal(input.files[0].role,'point_cloud_source');assert.equal(input.files[0].sha256,sha('registered-raw-source'));
});
test('node archive without EPT refuses false readiness when local indexing policy is disabled',{skip:process.platform!=='linux'},async t=>{
  await assert.rejects(()=>ingest(t,'disabled-cloud'),{code:'missing_required_output'});
});
for(const mode of ['missing-init','missing-archive','unknown-engine'])test(`processIngest preserves output but never asserts metres for ${mode}`,{skip:process.platform!=='linux'},async t=>{
  const f=await ingest(t,mode);assert.ok(f.assets.some(asset=>asset.kind==='dsm'));assert.ok(f.assets.some(asset=>asset.kind==='dtm'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM measurement_source_unit_evidence').get().count,0);
  if(mode.startsWith('missing'))assert.equal(f.processing.getVerifiedAttemptProducerReceipt(f.attempt.id),null);
});

test('processIngest persists encoded feet independently of metre producer inference',{skip:process.platform!=='linux'},async t=>{
  const f=await ingest(t,'feet');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM measurement_source_unit_evidence').get().count,2);
  for(const source of f.assets.filter(asset=>['dsm','dtm'].includes(asset.kind))){
    const proof=f.evidence.summary(f.completed.resultModelId,f.completed.resultModelVersionId,source);
    assert.equal(proof.basis,'server-inspected-explicit-metadata');
    assert.equal(proof.verticalUnit,'ft');assert.equal(proof.verticalFactor,.3048);
  }
});
