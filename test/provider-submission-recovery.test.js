'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {processOne}=require('../server/processingWorker');
const {NodeOdmProvider,boundedJson}=require('../server/nodeOdmProvider');

function fixture(t,{count=2}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-safe-recovery-')),db=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Recovery'}),dataset=processing.createDataset({projectId:project.id,displayName:'Images',storageMode:'managed',rootKey:'datasets',relativePath:'images'});
  fs.mkdirSync(path.join(root,'images'));const files=[];
  for(let i=0;i<count;i++){const body=Buffer.from(`synthetic image ${i}`),relativePath=`photo-${i}.jpg`;fs.writeFileSync(path.join(root,'images',relativePath),body);files.push({relativePath,byteSize:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')});}
  processing.finalizeDataset(dataset.id,files,crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'));
  const provider=processing.upsertProvider({displayName:'Cluster',type:'clusterodm',endpoint:'http://127.0.0.1:3000',enabled:true}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
  const remote={temp:false,accepted:false,status:'queued_upstream',imagesCount:0,initialize:0,upload:0,commit:0,remove:0};
  const adapter={async status(){if(!remote.accepted)throw Object.assign(new Error('No task table entry'),{code:'provider_task_not_found'});return{uuid:attempt.providerTaskId,status:remote.status,progress:0,imagesCount:remote.imagesCount};},async initialize(){remote.temp=true;remote.initialize++;return{uuid:attempt.providerTaskId};},async upload(_uuid,batch){remote.upload++;remote.imagesCount+=batch.length;},async commit(){remote.commit++;remote.accepted=true;},async remove(){remote.remove++;throw new Error('Recovery must never remove this task');},async output(){return{lines:[],nextLine:0};}};
  const deps={processing,config:{},storage:{resolve:(_key,relative)=>path.join(root,relative),requireProcessingHeadroom:()=>({})},adapterFactory:()=>adapter};
  const submitJob=()=>db.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(attempt.id);
  const retry=()=>db.prepare("UPDATE processing_jobs SET available_at='2000-01-01' WHERE attempt_id=? AND status='pending'").run(attempt.id);
  return{db,processing,provider,task,attempt,remote,adapter,deps,submitJob,retry};
}

test('lost commit response preserves accepted queued UUID without deletion or duplicate upload',async t=>{
  const c=fixture(t);c.adapter.commit=async()=>{c.remote.commit++;c.remote.accepted=true;throw Object.assign(new Error('connection lost'),{code:'provider_unreachable'});};
  await processOne(c.deps,'first');assert.equal(c.processing.getAttemptSubmission(c.attempt.id).submissionPhase,'committing');
  c.retry();await processOne(c.deps,'second');
  assert.equal(c.processing.getAttempt(c.attempt.id).status,'queued_upstream');
  assert.equal(c.processing.getAttemptSubmission(c.attempt.id).submissionPhase,'committed');
  assert.equal(c.remote.initialize,1);assert.equal(c.remote.upload,1);assert.equal(c.remote.commit,1);assert.equal(c.remote.remove,0);
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(c.attempt.id).n,1);
});

test('lost commit response preserves accepted running UUID without deletion or duplicate submission',async t=>{
  const c=fixture(t),uuid=c.attempt.providerTaskId;
  c.adapter.commit=async()=>{c.remote.commit++;c.remote.accepted=true;c.remote.status='running';throw Object.assign(new Error('running commit response lost'),{code:'provider_unreachable'});};
  await processOne(c.deps,'first');assert.equal(c.processing.getAttemptSubmission(c.attempt.id).submissionPhase,'committing');
  c.retry();await processOne(c.deps,'recovered');
  assert.equal(c.processing.getAttempt(c.attempt.id).status,'running');
  assert.equal(c.processing.getAttempt(c.attempt.id).providerTaskId,uuid);
  assert.equal(c.processing.getAttemptSubmission(c.attempt.id).submissionPhase,'committed');
  assert.equal(c.processing.getAttemptSubmission(c.attempt.id).uploadedFileCount,2);
  assert.equal(c.remote.initialize,1);assert.equal(c.remote.upload,1);assert.equal(c.remote.commit,1);assert.equal(c.remote.remove,0);assert.equal(c.remote.imagesCount,2);
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(c.attempt.id).n,1);
});

test('lost init response safely resumes temp initialization with the same UUID',async t=>{
  const c=fixture(t),initialize=c.adapter.initialize;let lost=true;
  c.adapter.initialize=async()=>{const result=await initialize();if(lost){lost=false;throw Object.assign(new Error('init response lost'),{code:'provider_unreachable'});}return result;};
  await processOne(c.deps,'first');c.retry();await processOne(c.deps,'second');
  assert.equal(c.processing.getAttempt(c.attempt.id).providerTaskId,c.attempt.providerTaskId);
  assert.equal(c.remote.initialize,2);assert.equal(c.remote.upload,1);assert.equal(c.remote.commit,1);assert.equal(c.remote.remove,0);
});

test('lost temporary upload stays in durable reconciliation without duplicate filenames past retry budget',async t=>{
  const c=fixture(t),upload=c.adapter.upload;c.adapter.upload=async(...args)=>{await upload(...args);throw Object.assign(new Error('upload response lost'),{code:'provider_unreachable'});};
  for(let i=0;i<8;i++){c.retry();await processOne(c.deps,`worker-${i}`);}
  assert.equal(c.submitJob().status,'pending');assert.equal(c.submitJob().error_code,'provider_submission_ambiguous');
  assert.equal(c.processing.getAttemptSubmission(c.attempt.id).submissionPhase,'uploading');
  assert.equal(c.remote.upload,1);assert.equal(c.remote.commit,0);assert.equal(c.remote.remove,0);assert.equal(c.remote.imagesCount,2);
  assert.equal(c.processing.getDataset(c.attempt.datasetId,true).files.length,2);
});

test('acknowledged upload checkpoint resumes without reinitializing temp directory',async t=>{
  const c=fixture(t,{count:25});const job=c.processing.claimJob('checkpoint');
  c.processing.transitionAttemptForJob(job.id,'checkpoint','uploading');c.processing.setSubmissionStateForJob(job.id,'checkpoint','initialized',20);
  c.processing.failJob(job.id,'checkpoint','provider_unreachable','restart',new Date().toISOString());c.remote.temp=true;c.remote.imagesCount=20;c.retry();
  await processOne(c.deps,'resumed');assert.equal(c.remote.initialize,0);assert.equal(c.remote.upload,1);assert.equal(c.remote.imagesCount,25);assert.equal(c.remote.commit,1);
});

test('missing task after uncertain commit waits rather than destroying or resubmitting it',async t=>{
  const c=fixture(t);c.adapter.commit=async()=>{c.remote.commit++;throw Object.assign(new Error('response lost'),{code:'provider_unreachable'});};
  await processOne(c.deps,'first');for(let i=0;i<7;i++){c.retry();await processOne(c.deps,`retry-${i}`);}
  assert.equal(c.submitJob().status,'pending');assert.equal(c.submitJob().error_code,'provider_submission_ambiguous');assert.equal(c.remote.commit,1);assert.equal(c.remote.upload,1);assert.equal(c.remote.remove,0);
});

test('accepted terminal statuses survive submit recovery and reconciliation',async t=>{
  for(const status of ['failed','cancelled','completed'])await t.test(status,async t=>{
    const c=fixture(t);c.remote.accepted=true;c.remote.status=status;c.remote.imagesCount=2;
    await processOne(c.deps,'submit');assert.equal(c.remote.remove,0);assert.equal(c.remote.initialize,0);
    c.retry();await processOne(c.deps,'reconcile');
    assert.equal(c.processing.getAttempt(c.attempt.id).status,status==='completed'?'ingesting':status);
    if(status==='completed')assert.equal(c.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE job_type='ingest'").get().n,1);
  });
});

test('temporary endpoint errors and auth rejection have distinct classifications',async()=>{
  for(const [status,code] of [[401,'provider_authentication_failed'],[403,'provider_authentication_failed'],[429,'provider_busy'],[503,'provider_unavailable'],[502,'provider_unavailable']]){
    const adapter=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',fetchImpl:async()=>new Response(null,{status})});await assert.rejects(adapter.request('/info'),error=>error.code===code);
  }
  const adapter=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',fetchImpl:async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ENETUNREACH'}});}});
  await assert.rejects(adapter.request('/info'),error=>error.code==='provider_unreachable');
});

test('provider outages retain pending jobs beyond the generic failure budget',async t=>{
  const c=fixture(t);c.adapter.status=async()=>{throw Object.assign(new Error('unavailable'),{code:'provider_unavailable'});};
  for(let i=0;i<8;i++){c.retry();await processOne(c.deps,`worker-${i}`);}
  assert.equal(c.submitJob().status,'pending');assert.notEqual(c.processing.getAttempt(c.attempt.id).status,'failed');assert.equal(c.remote.initialize,0);
});

test('worker authentication rejection holds files and resumes only after successful provider probe',async t=>{
  const c=fixture(t),status=c.adapter.status;c.adapter.status=async()=>{throw Object.assign(new Error('HTTP 401'),{code:'provider_authentication_failed'});};
  await processOne(c.deps,'auth-rejected');c.retry();
  assert.equal(c.submitJob().status,'pending');assert.equal(c.submitJob().attempt_count,0);assert.equal(c.processing.getProvider(c.provider.id).lastHealth,'authentication_failed');
  assert.equal(await processOne(c.deps,'must-wait'),false);assert.equal(c.remote.initialize,0);
  c.processing.updateProviderCapabilities(c.provider.id,{capabilities:{},fingerprint:'new-probe',health:'healthy'});c.adapter.status=status;
  assert.equal(await processOne(c.deps,'corrected'),true);assert.equal(c.remote.commit,1);assert.equal(c.remote.upload,1);
});

test('unknown provider task state retains the remote UUID during reconciliation',async t=>{
  const c=fixture(t);await processOne(c.deps,'submitted');c.remote.status='unknown';c.retry();
  await processOne(c.deps,'observe');
  const job=c.db.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(c.attempt.id);
  assert.equal(job.status,'pending');assert.equal(job.error_code,'provider_submission_ambiguous');assert.equal(c.remote.remove,0);assert.equal(c.remote.commit,1);
});

test('response body interruption remains a retryable transport failure after HTTP headers',async()=>{
  const response=new Response(new ReadableStream({start(controller){controller.error(new TypeError('terminated'));}}),{headers:{'content-type':'application/json'}});
  await assert.rejects(boundedJson(response),error=>error.code==='provider_unreachable');
});
