'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {NodeOdmProvider,checkedAction}=require('../server/nodeOdmProvider');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {processOne}=require('../server/processingWorker');

test('provider rate limits and temporary unavailability have separate retryable classifications',async()=>{
  for(const status of [429,503]){
    const provider=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',fetchImpl:async()=>new Response(null,{status,headers:status===429?{'retry-after':'12'}:{}})});
    await assert.rejects(provider.request('/task/new/init'),error=>error.code===(status===429?'provider_busy':'provider_unavailable')&&error.status===status&&error.retryAfterMs===(status===429?12_000:30_000));
  }
});

test('unrelated provider errors keep their existing classification',async()=>{
  const provider=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',fetchImpl:async()=>new Response(null,{status:400})});
  await assert.rejects(provider.request('/task/new/init'),error=>error.code==='provider_request_failed'&&error.status===400);
  assert.throws(()=>checkedAction({error:'Invalid options'},'initialize'),error=>error.code==='provider_request_failed');
});

test('ClusterODM concurrent-task limit returned in a successful JSON response is retryable',()=>{
  assert.throws(()=>checkedAction({error:'Reached maximum number of concurrent tasks: 4. Please wait until other tasks have finished, then restart the task.'},'initialize'),error=>error.code==='provider_busy'&&error.retryAfterMs===30_000);
  assert.throws(()=>checkedAction({error:'Reached maximum number of concurrent tasks, please wait until other tasks have finished, then restart the task.'},'commit'),error=>error.code==='provider_busy'&&error.retryAfterMs===30_000);
});

test('worker defers temporary provider capacity errors without consuming retry budget',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-backpressure-')),image=path.join(root,'one.jpg'),body=Buffer.from('synthetic image');fs.writeFileSync(image,body);
  const job={id:'submit-job',attempt_id:'attempt-1',job_type:'submit',lease_owner:'worker-1'},calls=[];
  const processing={claimJob:()=>job,heartbeatJob:()=>true,getAttempt:()=>({id:'attempt-1',taskId:'task-1',datasetId:'dataset-1',providerId:'provider-1',providerTaskId:'remote-1',options:{},status:'admitted'}),getAttemptSubmission:()=>({submissionPhase:'new',uploadedFileCount:0}),getTask:()=>({id:'task-1',datasetId:'dataset-1',displayName:'Synthetic'}),getDataset:()=>({id:'dataset-1',rootKey:'datasets',relativePath:'fixture',files:[{relativePath:'one.jpg',byteSize:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex'),processingRole:'image'}]}),getProvider:()=>({id:'provider-1',type:'clusterodm',capabilities:{}}),activeProcessingReservationBytes:()=>[],activeDerivativeReservationBytes:()=>[],validateAttemptInputInventory:()=>true,deferSubmitAdmission:(...args)=>{calls.push(args);return true;},appendLog:()=>{throw new Error('temporary capacity should not be logged as a terminal error');}};
  const storage={resolve:()=>image,requireProcessingHeadroom:()=>({})};
  const deps={processing,storage,config:{},adapterFactory:()=>({async status(){throw Object.assign(new Error('ODM request failed with HTTP 429'),{code:'provider_busy',status:429,retryAfterMs:15_000});}})};
  try{assert.equal(await processOne(deps,'worker-1'),true);assert.equal(calls.length,1);assert.equal(calls[0][0],job.id);assert.equal(calls[0][1],job.lease_owner);assert.equal(calls[0][2],15_000);assert.deepEqual(calls[0][3],{errorCode:'provider_busy',errorMessage:'waiting for upstream provider capacity'});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('provider submission queue retains per-provider FIFO when its oldest job is waiting for capacity',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-queue-order-')),db=openDatabase(path.join(root,'queue.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Queue fixture'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic images',storageMode:'managed',rootKey:'datasets',relativePath:'fixture'});
  processing.finalizeDataset(dataset.id,[{relativePath:'one.jpg',byteSize:0,sha256:crypto.createHash('sha256').digest('hex')}],crypto.createHash('sha256').digest('hex'));
  const provider=processing.upsertProvider({type:'clusterodm',displayName:'Cluster',endpoint:'http://127.0.0.1:3000',enabled:true,admissionLimit:4});
  const tasks=['First','Second'].map(displayName=>processing.createTask({projectId:project.id,datasetId:dataset.id,displayName}));
  const attempts=tasks.map(task=>processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}));
  const jobs=attempts.map(attempt=>db.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(attempt.id));
  db.prepare("UPDATE processing_jobs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(jobs[0].id);
  const first=processing.claimJob('first-worker');assert.equal(first.id,jobs[0].id);
  assert.equal(processing.deferSubmitAdmission(first.id,'first-worker',30_000,{errorCode:'provider_busy',errorMessage:'waiting for upstream provider capacity'}),true);
  assert.equal(processing.claimJob('must-wait'),null,'a newer same-provider task must not bypass the deferred FIFO head');
  db.prepare("UPDATE processing_jobs SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(jobs[0].id);
  const retried=processing.claimJob('retry-first');assert.equal(retried.id,jobs[0].id);
  assert.equal(processing.claimJob('must-wait-again'),null,'later work waits while the FIFO head is still being submitted upstream');
  assert.equal(processing.completeAndEnqueueJob(retried.id,'retry-first',attempts[0].id,'reconcile'),true);
  assert.equal(processing.claimJob('next-worker').attempt_id,attempts[1].id,'the next job becomes eligible after the oldest job has been accepted upstream');
});

test('provider submission FIFO prevents a later worker from overtaking a leased older upload',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-queue-lease-order-')),db=openDatabase(path.join(root,'queue.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Concurrent queue fixture'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic images',storageMode:'managed',rootKey:'datasets',relativePath:'fixture'});
  processing.finalizeDataset(dataset.id,[{relativePath:'one.jpg',byteSize:0,sha256:crypto.createHash('sha256').digest('hex')}],crypto.createHash('sha256').digest('hex'));
  const provider=processing.upsertProvider({type:'clusterodm',displayName:'Cluster',endpoint:'http://127.0.0.1:3000',enabled:true,admissionLimit:4});
  const tasks=['Older upload','Later upload'].map(displayName=>processing.createTask({projectId:project.id,datasetId:dataset.id,displayName}));
  const attempts=tasks.map(task=>processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}));
  const jobs=attempts.map(attempt=>db.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(attempt.id));
  db.prepare("UPDATE processing_jobs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(jobs[0].id);
  const first=processing.claimJob('slow-first-worker');assert.equal(first.id,jobs[0].id);
  assert.equal(processing.claimJob('fast-second-worker'),null,'a leased earlier submission must hold the FIFO position even when provider admission has spare capacity');
  assert.equal(processing.completeAndEnqueueJob(first.id,'slow-first-worker',attempts[0].id,'reconcile'),true,'once the upstream accepts the older submission, the lease can advance');
  assert.equal(processing.claimJob('next-worker').attempt_id,attempts[1].id,'the second submission becomes eligible after the older upstream task is accepted');
});

test('capacity deferral resets an in-progress attempt but preserves upload recovery state',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-capacity-recovery-')),db=openDatabase(path.join(root,'queue.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Recovery fixture'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic images',storageMode:'managed',rootKey:'datasets',relativePath:'fixture'});
  processing.finalizeDataset(dataset.id,[{relativePath:'one.jpg',byteSize:0,sha256:crypto.createHash('sha256').digest('hex')}],crypto.createHash('sha256').digest('hex'));
  const provider=processing.upsertProvider({type:'clusterodm',displayName:'Cluster',endpoint:'http://127.0.0.1:3000',enabled:true,admissionLimit:4}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Capacity retry'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
  const job=processing.claimJob('capacity-worker');
  assert.equal(job.attempt_id,attempt.id);
  assert.ok(processing.transitionAttemptForJob(job.id,'capacity-worker','initializing'));
  assert.ok(processing.transitionAttemptForJob(job.id,'capacity-worker','uploading'));
  assert.ok(processing.transitionAttemptForJob(job.id,'capacity-worker','committed'));
  assert.equal(processing.setSubmissionStateForJob(job.id,'capacity-worker','committing',7),true);
  assert.equal(processing.deferSubmitAdmission(job.id,'capacity-worker',30_000,{errorCode:'provider_busy',errorMessage:'waiting for upstream provider capacity'}),true);
  const deferred=processing.getAttempt(attempt.id),deferredTask=processing.getTask(task.id),deferredJob=db.prepare('SELECT attempt_count,status FROM processing_jobs WHERE id=?').get(job.id);
  assert.equal(deferred.status,'pending','capacity rejection at commit must not leave an attempt marked committed');
  assert.equal(deferredTask.status,'queued');
  assert.equal(deferred.submissionPhase,'committing','preserve phase so retry can reconcile or safely resume upload');
  assert.equal(deferred.uploadedFileCount,7,'preserve upload progress for idempotent retry');
  assert.equal(deferredJob.status,'pending');
  assert.equal(deferredJob.attempt_count,0,'temporary capacity must not consume the retry budget');
});

test('capacity rejection at init or commit retries the same FIFO attempt without consuming retry budget',async t=>{
  for(const rejectedPhase of ['initialize','commit'])await t.test(rejectedPhase,async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),`provider-${rejectedPhase}-retry-`));fs.mkdirSync(path.join(root,'datasets'));
    const db=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(db),storage={resolve:(rootKey,relativePath)=>path.join(root,rootKey,...relativePath.split('/')),requireProcessingHeadroom:()=>({})};
    t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
    const project=processing.createProject({displayName:'Provider backpressure'}),relativePath='fixture',dataset=processing.createDataset({projectId:project.id,displayName:'One image',storageMode:'managed',rootKey:'datasets',relativePath}),directory=path.join(root,'datasets',relativePath),body=Buffer.from('synthetic image'),image=path.join(directory,'one.jpg');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(image,body);
    const file={relativePath:'one.jpg',byteSize:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')};processing.finalizeDataset(dataset.id,[file],crypto.createHash('sha256').update(JSON.stringify([file])).digest('hex'));
    const provider=processing.upsertProvider({type:'clusterodm',displayName:'Cluster',endpoint:'http://127.0.0.1:3000',enabled:true,admissionLimit:4}),tasks=['Older capacity retry','Newer submission'].map(displayName=>processing.createTask({projectId:project.id,datasetId:dataset.id,displayName})),attempts=tasks.map(task=>processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}})),jobs=attempts.map(attempt=>db.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(attempt.id));
    db.prepare("UPDATE processing_jobs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(jobs[0].id);
    const remote={exists:false,accepted:false,status:'queued_upstream',imagesCount:0,initCalls:0,uploadCalls:0,commitCalls:0,removeCalls:0,activeTasks:0};let rejectCapacity=true;
    const adapter={async status(){if(!remote.accepted)throw Object.assign(new Error('task not found'),{code:'provider_task_not_found'});return{status:remote.status,progress:0,imagesCount:remote.imagesCount};},async initialize(){if(rejectCapacity&&rejectedPhase==='initialize'){rejectCapacity=false;throw Object.assign(new Error('provider is at capacity'),{code:'provider_busy',retryAfterMs:5_000,explicitCapacityRejection:true});}remote.exists=true;remote.status='queued_upstream';remote.imagesCount=0;remote.initCalls++;return{uuid:attempts[0].providerTaskId};},async upload(_uuid,files){remote.uploadCalls++;remote.imagesCount+=files.length;},async commit(){remote.commitCalls++;if(rejectCapacity&&rejectedPhase==='commit'){rejectCapacity=false;remote.exists=false;throw Object.assign(new Error('provider is at capacity'),{code:'provider_busy',retryAfterMs:5_000,explicitCapacityRejection:true});}remote.accepted=true;remote.activeTasks++;remote.status='running';},async remove(){remote.removeCalls++;throw new Error('Recovery must not remove task');}};
    const deps={processing,storage,config:{},adapterFactory:()=>adapter},stableProviderTaskId=attempts[0].providerTaskId;
    assert.equal(await processOne(deps,'first-worker'),true);
    const deferred=processing.getAttempt(attempts[0].id),submission=processing.getAttemptSubmission(attempts[0].id),jobState=db.prepare('SELECT status,attempt_count FROM processing_jobs WHERE id=?').get(jobs[0].id);
    assert.equal(deferred.status,'pending');assert.equal(jobState.status,'pending');assert.equal(jobState.attempt_count,0,'capacity must not consume the retry budget');
    assert.equal(deferred.providerTaskId,stableProviderTaskId,'retry retains the provider task UUID');
    if(rejectedPhase==='initialize'){assert.equal(submission.submissionPhase,'initializing');assert.equal(submission.uploadedFileCount,0);}
    else{assert.equal(submission.submissionPhase,'new');assert.equal(submission.uploadedFileCount,0);assert.equal(remote.uploadCalls,1);}
    assert.equal(processing.claimJob('later-worker'),null,'the newer task cannot overtake the capacity-deferred FIFO head');
    db.prepare("UPDATE processing_jobs SET available_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(jobs[0].id);
    assert.equal(await processOne(deps,'retry-worker'),true);
    assert.equal(processing.getAttemptSubmission(attempts[0].id).submissionPhase,'committed');
    assert.equal(processing.getAttempt(attempts[0].id).providerTaskId,stableProviderTaskId);
    assert.equal(remote.activeTasks,1,'only one accepted remote task remains after retry');
    if(rejectedPhase==='initialize'){assert.equal(remote.initCalls,1);assert.equal(remote.uploadCalls,1);assert.equal(remote.removeCalls,0);}
    else{assert.equal(remote.initCalls,2);assert.equal(remote.uploadCalls,2);assert.equal(remote.removeCalls,0,'explicit cluster capacity rejection already removed its temporary files; Viewer never removes a queued task');}
    assert.equal(processing.claimJob('next-worker').attempt_id,attempts[1].id,'the next FIFO submission advances only after the earlier task is accepted upstream');
  });
});
