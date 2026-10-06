'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {providerDurationMs,attemptTiming}=require('../server/processingTiming');
const {NodeOdmProvider}=require('../server/nodeOdmProvider');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

test('provider runtime only accepts finite nonnegative numeric milliseconds',async()=>{
  for(const input of [-1,null,undefined,'76006',NaN,Infinity,false])assert.equal(providerDurationMs(input),null);
  for(const input of [0,76006,10.5])assert.equal(providerDurationMs(input),input);
  const uuid='00000000-0000-4000-8000-000000000001';
  for(const [value,expected] of [[-1,null],[null,null],['42',null],[0,0],[76006,76006]]){
    const provider=new NodeOdmProvider({endpoint:'https://provider.example.test',fetchImpl:async()=>new Response(JSON.stringify({uuid,status:{code:40},processingTime:value}),{headers:{'content-type':'application/json'}})});
    assert.equal((await provider.status(uuid)).processingDurationMs,expected);
  }
});

test('queued wall clock is separate from engine runtime and imports identify local ingestion',()=>{
  const row={provider_id:'node',provider_task_id:'uuid',created_at:'2026-10-05T12:00:00Z',started_at:'2026-10-05T12:01:00Z',updated_at:'2026-10-05T16:00:00Z'};
  assert.deepEqual(attemptTiming(row,null),{processingDurationMs:null,processingDurationSource:null,submissionElapsedMs:4*3600000,localIngestionElapsedMs:null});
  assert.equal(attemptTiming(row,{status:'running',providerTaskId:'uuid',processingDurationMs:123}).processingDurationMs,null);
  assert.equal(attemptTiming(row,{status:'completed',providerTaskId:'wrong',processingDurationMs:123}).processingDurationMs,null);
  assert.equal(attemptTiming(row,{status:'completed',providerTaskId:'uuid',processingDurationMs:76006}).processingDurationMs,76006);
  const imported=attemptTiming({...row,provider_id:null},null);
  assert.equal(imported.processingDurationMs,null);assert.equal(imported.submissionElapsedMs,null);assert.equal(imported.localIngestionElapsedMs,239*60000);
});

test('completed task-info engine duration persists without replacing immutable result evidence',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-duration-')),db=openDatabase(path.join(dir,'viewer.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Timing'}),dataset=processing.createDataset({projectId:project.id,displayName:'Data',storageMode:'managed',rootKey:'datasets',relativePath:'timing'});
  processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:0,sha256:'a'.repeat(64)}],'b'.repeat(64));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:'http://127.0.0.1:3000',enabled:true}),task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id}),job=processing.claimJob('owner');
  assert.equal(processing.getAttempt(attempt.id).processingDurationMs,null);
  const status={uuid:attempt.providerTaskId,status:'completed',statusCode:40,imagesCount:1,processingDurationMs:76006};
  assert.equal(processing.recordAttemptProviderResult(job.id,'wrong',status),false);
  assert.equal(processing.recordAttemptProviderResult(job.id,'owner',status),true);
  assert.equal(processing.getAttempt(attempt.id).processingDurationMs,76006);
  assert.equal(processing.getAttempt(attempt.id).processingDurationSource,'provider_task_info');
  processing.recordAttemptProviderResult(job.id,'owner',{...status,processingDurationMs:999});
  assert.equal(processing.getAttempt(attempt.id).processingDurationMs,76006);
});

test('workspace labels queued/import elapsed distinctly and never coerces unavailable runtime to zero',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8'),context=vm.createContext({});
  const durationLine=source.split('\n').find(line=>line.startsWith('function durationFromMs('));
  vm.runInContext(durationLine+'\n'+source.split('\n').filter(line=>line.startsWith('const duration=')||line.startsWith('const attemptDurationLabel=')).join('\n')+'\nthis.format=durationFromMs;this.elapsed=duration;this.label=attemptDurationLabel;',context);
  for(const value of [null,undefined,-1,'76006',Infinity])assert.equal(context.format(value),'Unavailable');
  assert.equal(context.format(76006),'1m 16s');assert.equal(context.format(0),'0m 0s');
  assert.equal(context.label({providerId:'node',status:'queued_upstream'}),'submission elapsed');
  assert.equal(context.elapsed({providerId:'node',submissionElapsedMs:3600000}),'1h 0m');
  assert.equal(context.label({providerId:null}),'local ingestion elapsed');
  assert.doesNotMatch(source,/<small>runtime<\/small>/);
  const api=fs.readFileSync(path.join(__dirname,'..','server','processingApi.js'),'utf8');
  assert.match(api,/processingDurationMs:attempt\?\.processingDurationMs\?\?null/);
  assert.doesNotMatch(api,/processingDurationMs:.*end-start/);
});
