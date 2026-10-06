'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const test=require('node:test');
const {NodeOdmProvider,providerRetryDelay}=require('../server/nodeOdmProvider');
const {processOne}=require('../server/processingWorker');

test('TLS verification failures are classified separately from unreachable transport and rejected credentials',async()=>{
  for(const code of ['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_WRONG_VERSION_NUMBER']){
    for(const nested of [true,false]){
      const cause=Object.assign(new Error('private diagnostic detail'),nested?{cause:{code}}:{code});
      const provider=new NodeOdmProvider({endpoint:'https://private.example.test',token:'not-for-logs',fetchImpl:async()=>{throw cause;}});
      await assert.rejects(provider.request('/info'),error=>error.code==='provider_tls_failed'&&error.cause===cause&&error.message==='ODM TLS verification failed'&&!/not-for-logs|private diagnostic/.test(error.message));
    }
  }
  for(const code of ['ENETUNREACH','ECONNREFUSED','ECONNRESET']){
    const provider=new NodeOdmProvider({endpoint:'http://private.example.test',fetchImpl:async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code}});}});
    await assert.rejects(provider.request('/info'),error=>error.code==='provider_unreachable');
  }
  const provider=new NodeOdmProvider({endpoint:'https://private.example.test',fetchImpl:async()=>new Response(null,{status:401})});
  await assert.rejects(provider.request('/info'),error=>error.code==='provider_authentication_failed');
});

test('Retry-After parses seconds and HTTP dates with five-second floor and five-minute ceiling',()=>{
  const now=Date.parse('2026-10-05T12:00:00Z');
  for(const [header,expected] of [['0.1',5000],['1',5000],['5',5000],['12',12000],['300',300000],['301',300000],['999999',300000]])assert.equal(providerRetryDelay(header,now),expected,header);
  assert.equal(providerRetryDelay('Mon, 05 Oct 2026 12:00:02 GMT',now),5000);
  assert.equal(providerRetryDelay('Mon, 05 Oct 2026 12:00:30 GMT',now),30000);
  assert.equal(providerRetryDelay('Mon, 05 Oct 2026 12:10:00 GMT',now),300000);
  for(const header of [null,undefined,'',' ','invalid-date','NaN','Infinity','-1','0','Mon, 05 Oct 2026 11:59:59 GMT','Mon, 05 Oct 2026 12:00:00 GMT'])assert.equal(providerRetryDelay(header,now),null,String(header));
});

test('capacity and outage responses use bounded Retry-After and malformed values fall back to thirty seconds',async()=>{
  for(const status of [429,503])for(const [header,expected] of [['1',5000],['1000',300000],['bad-value',30000],['-1',30000],['0',30000],[null,30000],[new Date(Date.now()+3600000).toUTCString(),300000]]){
    const provider=new NodeOdmProvider({endpoint:'http://private.example.test',fetchImpl:async()=>new Response(null,{status,headers:header===null?{}:{'retry-after':header}})});
    await assert.rejects(provider.request('/info'),error=>error.code===(status===429?'provider_rate_limited':'provider_unavailable')&&error.retryAfterMs===expected,`${status}: ${header}`);
  }
});

test('worker durable outage exponential retry remains between five and three hundred seconds',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'provider-backoff-boundaries-')),body=Buffer.from('synthetic image');
  fs.writeFileSync(path.join(root,'one.jpg'),body);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const [count,expected] of [[0,5000],[1,10000],[5,160000],[6,300000],[20,300000]]){
    const recorded=[],job={id:'owned-job',attempt_id:'owned-attempt',job_type:'submit',lease_owner:'worker',attempt_count:count};
    const processing={claimJob:()=>job,getAttempt:()=>({id:job.attempt_id,taskId:'owned-task',datasetId:'owned-dataset',providerId:'owned-provider',providerTaskId:'same-uuid',options:{},status:'admitted'}),getAttemptSubmission:()=>({submissionPhase:'new',uploadedFileCount:0}),getTask:()=>({id:'owned-task',datasetId:'owned-dataset'}),getDataset:()=>({rootKey:'datasets',relativePath:'fixture',byteSize:body.length,files:[{relativePath:'one.jpg',byteSize:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}]}),getProvider:()=>({id:'owned-provider',capabilities:{}}),activeProcessingReservationBytes:()=>[],activeDerivativeReservationBytes:()=>[],appendLog:()=>{},failJob:(...args)=>recorded.push(args)};
    const before=Date.now();await processOne({processing,config:{},storage:{resolve:()=>path.join(root,'one.jpg'),requireProcessingHeadroom:()=>({})},adapterFactory:()=>({status:async()=>{throw Object.assign(new Error('temporary outage'),{code:'provider_unreachable'});}})},'worker');const after=Date.now();
    assert.equal(recorded.length,1);assert.equal(recorded[0][0],job.id);assert.equal(recorded[0][1],'worker');assert.equal(recorded[0][2],'provider_unreachable');
    const retryAt=Date.parse(recorded[0][4]);assert.ok(retryAt>=before+expected&&retryAt<=after+expected,`attempt ${count}: expected ${expected}ms bounded delay`);
  }
});

test('rendered ClusterODM detail suppresses placeholder queue and sentinel capacity while NodeODM retains real counts',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
  const start=source.indexOf('function providerHealthExplanation(provider){'),end=source.indexOf('\nfunction providerForm()',start);
  assert.ok(start>=0&&end>start,'execute the current rendering function, not a duplicate fixture implementation');
  const context={state:{presets:[]},can:()=>false,esc:String,providerName:String,providerCapabilityNotice:()=>'',available:String,badge:String,empty:String,dateTime:String};
  vm.createContext(context);vm.runInContext(`${source.slice(start,end)}; this.explain=providerHealthExplanation; this.render=providerDetail;`,context);
  const provider={id:'owned-node',displayName:'Node',endpoint:'http://private.example.test',type:'clusterodm',capabilities:{taskQueueCount:0,maxParallelTasks:99999999999}};
  const cluster=context.render(provider);assert.match(cluster,/Cluster-managed scheduling · live queue count unavailable/);assert.match(cluster,/Cluster-managed capacity/);assert.doesNotMatch(cluster,/0 queued|99999999999/);assert.match(cluster,/Provider-managed · no Viewer job limit/);
  const node=context.render({...provider,type:'nodeodm',capabilities:{taskQueueCount:7,maxParallelTasks:2}});assert.match(node,/7 queued · 2 upstream slots/);assert.doesNotMatch(node,/live queue count unavailable/);
  const reasons=[
    ['provider_authentication_failed','rejected its API token'],
    ['provider_credential_unavailable','could not read the configured API token'],
    ['provider_tls_failed','could not verify the provider’s TLS certificate'],
    ['provider_unreachable','could not reach the provider endpoint'],
    ['provider_busy','cannot accept work right now'],
    ['provider_rate_limited','does not confirm that its processing queue is full'],
    ['provider_unavailable','temporarily unavailable'],
    ['unrecognized','unclassified reason'],
  ];
  for(const [code,copy]of reasons){
    const unhealthy={...provider,runtimeHealth:'unhealthy',runtimeHealthErrorCode:code,runtimeHealthAt:'2026-10-05T12:00:00Z',runtimeHealthError:'secret or upstream detail must not render'};
    const detail=context.render(unhealthy),explanation=context.explain(unhealthy);
    assert.match(detail,/role="alert"/);assert.match(detail,new RegExp(copy));assert.doesNotMatch(detail,/secret or upstream detail/);assert.match(detail,/Last checked/);
  }
  assert.equal(context.explain({...provider,runtimeHealth:'healthy'}),'','healthy providers do not show a stale failure message');
});
