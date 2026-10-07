'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const test = require('node:test');
const {openDatabase} = require('../server/database');
const {ProcessingRepository} = require('../server/processingRepository');

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }
async function fixture(t, phase) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-process-interruption-'));
  const databasePath = path.join(root, 'viewer.sqlite'), db = openDatabase(databasePath), processing = new ProcessingRepository(db);
  const paused = deferred(), remote = {initialize:0, upload:0, commit:0, remove:0, accepted:0, imagesCount:0}, initializedUuids = [];
  let heldResponse;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const send = value => { response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify(value)); };
    for await (const _chunk of request) { /* Consume actual adapter request bodies before acknowledging. */ }
    if (url.pathname.endsWith('/info') && url.pathname.startsWith('/task/')) {
      if (!remote.accepted) { response.writeHead(404, {'content-type':'application/json'}); response.end(JSON.stringify({error:'missing'})); }
      else send({uuid:attempt.providerTaskId, status:{code:10}, progress:0, imagesCount:remote.imagesCount});
    } else if (url.pathname === '/task/new/init') {
      remote.initialize++; initializedUuids.push(request.headers['set-uuid']);
      if (phase === 'initialize' && remote.initialize === 1) { heldResponse = response; paused.resolve(); }
      else send({uuid:request.headers['set-uuid']});
    }
    else if (url.pathname.startsWith('/task/new/upload/')) {
      remote.upload++; remote.imagesCount++;
      if (phase === 'upload') { heldResponse = response; paused.resolve(); } else send({success:true});
    } else if (url.pathname.startsWith('/task/new/commit/')) {
      remote.commit++; remote.accepted++;
      if (phase === 'commit') { heldResponse = response; paused.resolve(); } else send({});
    } else if (url.pathname === '/task/remove') { remote.remove++; send({}); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const project = processing.createProject({displayName:'Process interruption'}), dataset = processing.createDataset({projectId:project.id,displayName:'Synthetic image',storageMode:'managed',rootKey:'datasets',relativePath:'images'});
  fs.mkdirSync(path.join(root, 'images')); const bytes = Buffer.from('isolated synthetic image'); fs.writeFileSync(path.join(root,'images','one.jpg'), bytes);
  const files = [{relativePath:'one.jpg',byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}];
  processing.finalizeDataset(dataset.id,files,crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex'));
  const provider = processing.upsertProvider({displayName:'Local fake provider',type:'nodeodm',endpoint:`http://127.0.0.1:${server.address().port}`,enabled:true});
  const task = processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Owned synthetic task'}), attempt = processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
  const children = [];
  const run = owner => {
    const script = `const path=require('node:path');const {openDatabase}=require(${JSON.stringify(require.resolve('../server/database'))});const {ProcessingRepository}=require(${JSON.stringify(require.resolve('../server/processingRepository'))});const {processOne}=require(${JSON.stringify(require.resolve('../server/processingWorker'))});process.stdout.write('child-started\\n');const db=openDatabase(process.argv[1]);process.stdout.write('database-opened\\n');processOne({processing:new ProcessingRepository(db),config:{processingProviderTransferTimeoutMs:3000},providerCredentials:{resolve:()=>''},storage:{resolve:(_key,relative)=>path.join(process.argv[2],relative),requireProcessingHeadroom:()=>({})}},process.argv[3]).then(()=>{db.close();}).catch(error=>{process.stderr.write(error.stack);db.close();process.exitCode=1;});`;
    const child = spawn(process.execPath,['-e',script,databasePath,root,owner],{windowsHide:true}); children.push(child);
    let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const ended = new Promise(resolve => {
      child.once('error', error => resolve({error,stdout,stderr}));
      child.once('exit',(code,signal)=>resolve({code,signal,stdout,stderr}));
    });
    const waitUntilPaused = async () => {
      let timer;
      const outcome = await Promise.race([
        paused.promise.then(() => ({kind:'paused'})),
        ended.then(result => ({kind:'ended',result})),
        new Promise(resolve => { timer = setTimeout(() => resolve({kind:'timeout'}),5000); }),
      ]);
      clearTimeout(timer);
      if (outcome.kind === 'paused') return;
      if (outcome.kind === 'ended') throw new Error(`worker exited before provider request: ${JSON.stringify(outcome.result)}; submitJob=${JSON.stringify(job())}; dispatch=${JSON.stringify(db.prepare('SELECT * FROM processing_job_order WHERE job_id=?').get(job()?.id))}; remote=${JSON.stringify(remote)}`);
      throw new Error(`worker did not reach provider request within 5s; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}; submitJob=${JSON.stringify(job())}; remote=${JSON.stringify(remote)}`);
    };
    return {child,ended,waitUntilPaused};
  };
  t.after(async () => {
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      return new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(root,{recursive:true,force:true});
  });
  const job = () => db.prepare("SELECT * FROM processing_jobs WHERE attempt_id=? AND job_type='submit'").get(attempt.id);
  const expire = () => db.prepare("UPDATE processing_jobs SET lease_expires_at='2000-01-01T00:00:00Z' WHERE id=?").run(job().id);
  const release = () => { if (heldResponse && !heldResponse.destroyed) { heldResponse.writeHead(200,{'content-type':'application/json'}); heldResponse.end(JSON.stringify(phase === 'upload' ? {success:true} : {})); } };
  return {processing,db,attempt,remote,initializedUuids,paused:paused.promise,run,job,expire,release};
}

test('worker process death during initialization reclaims with the same UUID and one eventual accepted task', {timeout:8000}, async t => {
  const f = await fixture(t,'initialize'), first = f.run('first-process'); await first.waitUntilPaused();
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'initializing');
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).uploadedFileCount,0);
  first.child.kill(); await first.ended; f.expire();
  const restarted = await f.run('restarted-process').ended; assert.equal(restarted.code,0,restarted.stderr);
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'queued_upstream');
  assert.equal(f.processing.getAttempt(f.attempt.id).providerTaskId,f.attempt.providerTaskId);
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'committed');
  assert.deepEqual(f.initializedUuids,[f.attempt.providerTaskId,f.attempt.providerTaskId]);
  assert.deepEqual(f.remote,{initialize:2,upload:1,commit:1,remove:0,accepted:1,imagesCount:1});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(f.attempt.id).n,1);
});

test('worker process death after accepted commit preserves one queued remote task on restart', {timeout:8000}, async t => {
  const f = await fixture(t,'commit'), first = f.run('first-process'); await first.waitUntilPaused();
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'committing');
  first.child.kill(); await first.ended; f.expire();
  const restarted = await f.run('restarted-process').ended; assert.equal(restarted.code,0,restarted.stderr);
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'queued_upstream');
  assert.equal(f.processing.getAttempt(f.attempt.id).providerTaskId,f.attempt.providerTaskId);
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'committed');
  assert.deepEqual(f.remote,{initialize:1,upload:1,commit:1,remove:0,accepted:1,imagesCount:1});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(f.attempt.id).n,1);
});

test('worker process death after received temporary upload retains uncertainty without duplicate upload', {timeout:8000}, async t => {
  const f = await fixture(t,'upload'), first = f.run('first-process'); await first.waitUntilPaused();
  first.child.kill(); await first.ended; f.expire();
  const restarted = await f.run('restarted-process').ended; assert.equal(restarted.code,0,restarted.stderr);
  assert.equal(f.job().status,'pending'); assert.equal(f.job().error_code,'provider_submission_ambiguous');
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'uploading');
  assert.equal(f.processing.getAttempt(f.attempt.id).providerTaskId,f.attempt.providerTaskId);
  assert.equal(f.processing.getDataset(f.attempt.datasetId,true).files.length,1);
  assert.deepEqual(f.remote,{initialize:1,upload:1,commit:0,remove:0,accepted:0,imagesCount:1});
});

test('late commit response from expired process cannot overwrite successor recovery', {timeout:8000}, async t => {
  const f = await fixture(t,'commit'), first = f.run('old-process'); await first.waitUntilPaused(); f.expire();
  const replacement = await f.run('replacement-process').ended; assert.equal(replacement.code,0,replacement.stderr);
  f.release(); const stale = await first.ended; assert.equal(stale.code,0,stale.stderr);
  assert.equal(f.job().status,'complete');
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'committed');
  assert.deepEqual(f.remote,{initialize:1,upload:1,commit:1,remove:0,accepted:1,imagesCount:1});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(f.attempt.id).n,1);
});

test('late upload response from expired process cannot clear successor uncertainty or commit', {timeout:8000}, async t => {
  const f = await fixture(t,'upload'), first = f.run('old-process'); await first.waitUntilPaused(); f.expire();
  const replacement = await f.run('replacement-process').ended; assert.equal(replacement.code,0,replacement.stderr);
  f.release(); const stale = await first.ended; assert.equal(stale.code,0,stale.stderr);
  assert.equal(f.job().status,'pending'); assert.equal(f.job().error_code,'provider_submission_ambiguous');
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).submissionPhase,'uploading');
  assert.equal(f.processing.getAttemptSubmission(f.attempt.id).uploadedFileCount,0);
  assert.deepEqual(f.remote,{initialize:1,upload:1,commit:0,remove:0,accepted:0,imagesCount:1});
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(f.attempt.id).n,0);
});

for (const phase of ['upload','commit']) test(`cancelling while ${phase} response is suspended fences the process and never resubmits`, {timeout:8000}, async t => {
  const f = await fixture(t,phase), running = f.run('cancelled-process'); await running.waitUntilPaused();
  f.processing.cancelAttempt(f.attempt.id,'ops:isolated-test'); f.release();
  const exited = await running.ended; assert.equal(exited.code,0,exited.stderr);
  const next = await f.run('next-process').ended; assert.equal(next.code,0,next.stderr);
  assert.equal(f.processing.getAttempt(f.attempt.id).status,'cancelled'); assert.equal(f.job().status,'cancelled');
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile'").get(f.attempt.id).n,0);
  assert.deepEqual(f.remote,{initialize:1,upload:1,commit:phase==='commit'?1:0,remove:0,accepted:phase==='commit'?1:0,imagesCount:1});
});
