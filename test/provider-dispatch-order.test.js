'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const test=require('node:test');
const {openDatabase,applyMigrations}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-dispatch-')),databasePath=path.join(root,'viewer.sqlite'),db=openDatabase(databasePath),repository=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=repository.createProject({displayName:'Ordered dispatch'}),dataset=repository.createDataset({projectId:project.id,displayName:'One image',storageMode:'managed',rootKey:'datasets',relativePath:'fixture'}),hash=crypto.createHash('sha256').digest('hex');
  repository.finalizeDataset(dataset.id,[{relativePath:'one.jpg',byteSize:0,sha256:hash}],hash);
  const provider=(type='clusterodm')=>repository.upsertProvider({type,displayName:type,endpoint:'http://127.0.0.1:3000',enabled:true,admissionLimit:1});
  const attempt=(providerId)=>{const task=repository.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Job'});return repository.createAttempt({taskId:task.id,providerId,options:{}});};
  const job=(attemptId)=>db.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(attemptId);
  return{db,repository,databasePath,provider,attempt,job};
}

test('equal timestamps use durable creation order even when IDs sort backwards',t=>{
  const c=fixture(t),p=c.provider(),first=c.attempt(p.id),second=c.attempt(p.id);
  c.db.prepare('DELETE FROM processing_jobs WHERE attempt_id IN (?,?)').run(first.id,second.id);
  const insert=c.db.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES (?,?,'submit','pending','2000-01-01T00:00:00Z','2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')");
  insert.run('z-first',first.id);insert.run('a-second',second.id);
  const a=c.job(first.id),b=c.job(second.id);
  const otherDb=openDatabase(c.databasePath),other=new ProcessingRepository(otherDb);
  try{const claimed=other.claimJob('first');assert.equal(claimed.id,a.id);assert.equal(c.repository.claimJob('second'),null);assert.equal(other.completeAndEnqueueJob(claimed.id,'first',first.id,'reconcile','2999-01-01T00:00:00Z'),true);assert.equal(c.repository.claimJob('next').id,b.id);}finally{otherDb.close();}
});

test('migration backfills existing jobs deterministically and allocates new sequence after deletion',t=>{
  const c=fixture(t),p=c.provider(),attempts=[c.attempt(p.id),c.attempt(p.id),c.attempt(p.id)],jobs=attempts.map(a=>c.job(a.id));
  c.db.exec('DROP TRIGGER processing_jobs_assign_dispatch_order; DROP TABLE processing_job_order; DELETE FROM schema_migrations WHERE version=40');
  c.db.prepare("UPDATE processing_jobs SET created_at='2020-01-01T00:00:00Z'").run();
  applyMigrations(c.db);
  const backfilled=c.db.prepare('SELECT job_id,sequence FROM processing_job_order ORDER BY sequence').all();
  assert.deepEqual(backfilled.map(row=>row.job_id),jobs.map(row=>row.id).sort());
  const previousMax=backfilled.at(-1).sequence;
  c.db.prepare('DELETE FROM processing_jobs WHERE id=?').run(backfilled.at(-1).job_id);
  const next=c.attempt(p.id),sequence=c.db.prepare('SELECT sequence FROM processing_job_order WHERE job_id=?').get(c.job(next.id).id).sequence;
  assert.ok(sequence>previousMax,'AUTOINCREMENT prevents reusing a deleted order');
});

test('deferred head blocks its provider while another provider and reconciliation remain eligible',t=>{
  const c=fixture(t),p=c.provider(),q=c.provider('nodeodm'),first=c.attempt(p.id),second=c.attempt(p.id),independent=c.attempt(q.id),job=c.repository.claimJob('one');
  assert.equal(job.attempt_id,first.id);assert.equal(c.repository.deferSubmitAdmission(job.id,'one',60_000,{errorCode:'provider_busy'}),true);
  assert.equal(c.repository.claimJob('other-provider').attempt_id,independent.id);
  assert.equal(c.repository.claimJob('blocked'),null);
  c.repository.enqueueJob(second.id,'reconcile');
  assert.equal(c.repository.claimJob('reconcile').job_type,'reconcile');
});

test('expired submit is reclaimed first and cancelled head releases next position',t=>{
  const c=fixture(t),p=c.provider(),first=c.attempt(p.id),second=c.attempt(p.id),leased=c.repository.claimJob('old');
  c.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(leased.id);
  assert.equal(c.repository.claimJob('new').id,leased.id);
  c.repository.cancelAttempt(first.id);
  assert.equal(c.repository.claimJob('next').attempt_id,second.id);
});

test('terminal attempts with leftover submit rows cannot block later submissions',t=>{
  const c=fixture(t),p=c.provider(),first=c.attempt(p.id),second=c.attempt(p.id);
  c.repository.transitionAttempt(first.id,'failed',{errorCode:'fixture'});
  assert.equal(c.job(first.id).status,'pending');
  assert.equal(c.repository.claimJob('next').attempt_id,second.id);
});

test('ready-for-review attempts with orphaned submit rows cannot block the provider FIFO',t=>{
  const c=fixture(t),p=c.provider(),first=c.attempt(p.id),second=c.attempt(p.id);
  c.db.prepare("UPDATE processing_attempts SET status='ready_for_review' WHERE id=?").run(first.id);
  assert.equal(c.job(first.id).status,'pending');
  assert.equal(c.repository.getProvider(p.id).activeAttempts,1);
  assert.equal(c.repository.claimJob('next').attempt_id,second.id);
});

test('many accepted queued/running jobs never consume a Viewer outstanding-job cap',t=>{
  for(const type of ['clusterodm','nodeodm']){
    const c=fixture(t),p=c.provider(type);
    for(let index=0;index<12;index++){
      const attempt=c.attempt(p.id),job=c.repository.claimJob(`worker-${index}`);
      assert.equal(job.attempt_id,attempt.id);
      c.repository.transitionAttempt(attempt.id,index%2?'running':'queued_upstream');
      assert.equal(c.repository.completeAndEnqueueJob(job.id,`worker-${index}`,attempt.id,'reconcile','2999-01-01T00:00:00Z'),true);
    }
    assert.equal(c.repository.getProvider(p.id).activeAttempts,12);
    assert.equal(c.repository.getProvider(p.id).dispatchMode,'provider_managed');
    assert.equal('admissionLimit' in c.repository.getProvider(p.id),false);
    assert.equal(c.db.prepare('SELECT admission_limit FROM processing_providers WHERE id=?').get(p.id).admission_limit,1);
  }
});

test('concurrent processes claim only one same-provider submission',async t=>{
  const c=fixture(t),p=c.provider();c.attempt(p.id);c.attempt(p.id);
  const databaseModule=require.resolve('../server/database'),repositoryModule=require.resolve('../server/processingRepository');
  const script=`const {openDatabase}=require(${JSON.stringify(databaseModule)});const {ProcessingRepository}=require(${JSON.stringify(repositoryModule)});const db=openDatabase(process.argv[1]);const r=new ProcessingRepository(db);process.stdout.write(JSON.stringify(r.claimJob(process.argv[2])));db.close();`;
  const run=(owner)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',script,c.databasePath,owner],{windowsHide:true});let output='',error='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);child.on('exit',code=>code===0?resolve(JSON.parse(output)):reject(new Error(error)));});
  const claims=await Promise.all([run('process-a'),run('process-b')]);assert.equal(claims.filter(Boolean).length,1);assert.equal(c.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE status='leased' AND job_type='submit'").get().n,1);
});

test('authentication hold survives replacement until verified probe and retains upload progress',t=>{
  const c=fixture(t),p=c.provider(),first=c.attempt(p.id),second=c.attempt(p.id),job=c.repository.claimJob('upload');
  c.repository.setSubmissionStateForJob(job.id,'upload','uploading',1);
  assert.equal(c.repository.deferProviderAuthentication(job.id,'upload','Credentials rejected'),true);
  assert.equal(c.repository.claimJob('held'),null);
  assert.equal(c.repository.getAttempt(first.id).uploadedFileCount,1);
  assert.equal(c.repository.getAttempt(first.id).submissionPhase,'uploading');
  const replacement=c.repository.setProviderCredential(p.id,{ciphertext:'encrypted',keyId:'fixture'});
  assert.equal(replacement.lastHealth,'authentication_failed');assert.equal(c.repository.claimJob('still-held'),null);
  c.repository.updateProviderCapabilities(p.id,{health:'healthy',capabilities:{},fingerprint:'fixture',expectedCredentialRevision:1,expectedEndpoint:p.endpoint});
  c.repository.updateProviderMetadata(p.id,{enabled:true});
  assert.equal(c.repository.claimJob('resumed').attempt_id,first.id);assert.equal(c.repository.claimJob('next-waits'),null);
  assert.equal(c.db.prepare('SELECT attempt_count FROM processing_jobs WHERE id=?').get(job.id).attempt_count,1);
  assert.ok(second.id);
});

test('remote cancellation terminalizes the leased attempt and releases the FIFO head',t=>{
  const c=fixture(t),p=c.provider(),first=c.attempt(p.id),second=c.attempt(p.id),job=c.repository.claimJob('remote');
  const cancelled=c.repository.cancelJobFromProvider(job.id,'remote','Node stopped',{eventId:crypto.randomUUID(),attemptId:first.id});
  assert.equal(cancelled.status,'cancelled');assert.equal(c.repository.getTask(first.taskId).status,'cancelled');assert.equal(c.job(first.id).status,'cancelled');
  assert.equal(c.repository.claimJob('next').attempt_id,second.id);
  assert.equal(c.db.prepare("SELECT actor_type FROM audit_events WHERE action='processing_attempt.provider_cancelled'").get().actor_type,'system');
});

test('stale probe and expired owner cannot clear or create authentication hold',t=>{
  const c=fixture(t),p=c.provider(),attempt=c.attempt(p.id),job=c.repository.claimJob('auth');
  const health=c.repository.claimProviderHealth('health',{at:Date.now()+10});
  assert.equal(health.provider.id,p.id);
  assert.equal(c.repository.deferProviderAuthentication(job.id,'auth','Rejected'),true);
  c.repository.setProviderCredential(p.id,{ciphertext:'new-encrypted',keyId:'fixture'});
  assert.equal(c.repository.completeProviderHealth(p.id,'health',{status:'healthy',expectedCredentialRevision:health.credentialRevision,expectedEndpoint:health.endpoint}),null);
  assert.equal(c.repository.updateProviderCapabilities(p.id,{health:'healthy',capabilities:{},fingerprint:'old',expectedCredentialRevision:0,expectedEndpoint:p.endpoint}),null);
  assert.equal(c.repository.getProvider(p.id).lastHealth,'authentication_failed');
  assert.equal(c.repository.claimJob('still-held'),null);
  c.repository.updateProviderCapabilities(p.id,{health:'healthy',capabilities:{},fingerprint:'new',expectedCredentialRevision:1,expectedEndpoint:p.endpoint});
  c.repository.updateProviderMetadata(p.id,{enabled:true});
  const retry=c.repository.claimJob('current');
  c.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(retry.id);
  assert.equal(c.repository.deferProviderAuthentication(retry.id,'current','Too late'),false);
  assert.equal(c.repository.getProvider(p.id).lastHealth,'healthy');assert.ok(attempt.id);
});

test('updating provider metadata preserves legacy admission column without exposing a cap',t=>{
  const c=fixture(t),p=c.repository.upsertProvider({type:'nodeodm',displayName:'Old provider',endpoint:'http://127.0.0.1:3000',enabled:false,admissionLimit:4});
  c.repository.updateProviderMetadata(p.id,{displayName:'Updated'});
  c.repository.upsertProvider({id:p.id,type:'nodeodm',displayName:'Updated again',endpoint:p.endpoint,enabled:false});
  assert.equal(c.db.prepare('SELECT admission_limit FROM processing_providers WHERE id=?').get(p.id).admission_limit,4);
  assert.equal('admissionLimit' in c.repository.getProvider(p.id),false);
});
