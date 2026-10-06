'use strict';
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const test=require('node:test');const {openDatabase}=require('../server/database');const {ProcessingRepository}=require('../server/processingRepository');const {NodeOdmProvider}=require('../server/nodeOdmProvider');const {providerHealthDiagnosticCode,refreshOneProviderHealth}=require('../server/providerHealth');

test('scheduled provider health is leased, fresh, sanitized and does not disable viewing or provider state on transient failure',async(t)=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-provider-health-')),database=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(database);t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});processing.updateProviderCapabilities(provider.id,{capabilities:{options:[]},fingerprint:'a'.repeat(64),health:'healthy'});const credentials={resolveWithRevision:()=>({token:'secret-provider-token',revision:0})},fetchImpl=async(url)=>new Response(String(url).includes('/info')?JSON.stringify({version:'2.2.3',engine:'odm',engineVersion:'3.5',taskQueueCount:0,maxImages:500}):JSON.stringify([]),{status:200,headers:{'content-type':'application/json'}});assert.equal(await refreshOneProviderHealth({processing,providerCredentials:credentials,owner:'health-a',fetchImpl}),true);let current=processing.getProvider(provider.id);assert.equal(current.runtimeHealth,'healthy');assert.equal(current.runtimeHealthError,null);assert.equal(current.enabled,true);assert.equal(current.lastHealth,'healthy');assert.equal(processing.claimProviderHealth('health-b'),null,'fresh checks are not immediately duplicated');database.prepare("UPDATE processing_providers SET runtime_health_at='2020-01-01T00:00:00.000Z'").run();assert.equal(await refreshOneProviderHealth({processing,providerCredentials:credentials,owner:'health-c',fetchImpl:async()=>{throw new Error('token=secret-provider-token at /mnt/private/provider');}}),true);current=processing.getProvider(provider.id);assert.equal(current.runtimeHealth,'unhealthy');assert.equal(current.enabled,true,'one transient scheduled failure must not disable the provider');assert.equal(current.lastHealth,'healthy','enablement probe state remains distinct from runtime freshness');assert.doesNotMatch(current.runtimeHealthError,/secret-provider-token|\/mnt\/private/);
  database.prepare("UPDATE processing_providers SET runtime_health_at='2020-01-01T00:00:00.000Z'").run();const claimed=processing.claimProviderHealth('health-stale');assert.equal(claimed.provider.id,provider.id);processing.updateProviderMetadata(provider.id,{endpoint:'http://127.0.0.1:3001'});assert.equal(processing.completeProviderHealth(provider.id,'health-stale',{status:'healthy',expectedCredentialRevision:claimed.credentialRevision,expectedEndpoint:claimed.endpoint}),null,'endpoint CAS rejects stale health results');
});

test('provider capability fingerprint excludes volatile queue and memory metrics',async()=>{let runtime={taskQueueCount:1,availableMemory:100,maxImages:500},options=[{name:'pc-ept',type:'bool',value:true}],fetchImpl=async(url)=>new Response(String(url).includes('/info')?JSON.stringify({version:'2.2.3',engine:'odm',engineVersion:'3.5',maxParallelTasks:2,totalMemory:1000,cpuCores:8,...runtime}):JSON.stringify(options),{status:200,headers:{'content-type':'application/json'}}),provider=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',fetchImpl});const first=await provider.capabilities();runtime={...runtime,taskQueueCount:9,availableMemory:5};const volatile=await provider.capabilities();assert.equal(volatile.fingerprint,first.fingerprint);runtime={...runtime,maxImages:501};const admissionChanged=await provider.capabilities();assert.notEqual(admissionChanged.fingerprint,first.fingerprint);runtime={...runtime,maxImages:500};options=[{name:'pc-ept',type:'bool',value:false}];const optionChanged=await provider.capabilities();assert.notEqual(optionChanged.fingerprint,first.fingerprint);});

test('scheduled health stores constrained diagnostic codes for auth, TLS, connectivity, capacity, outage and unknown failures',async t=>{
  const cases=[
    ['authentication',async()=>new Response(null,{status:401}),'provider_authentication_failed'],
    ['TLS',async()=>{throw Object.assign(new Error('private certificate path'),{cause:{code:'CERT_HAS_EXPIRED'}});},'provider_tls_failed'],
    ['unreachable',async()=>{throw Object.assign(new Error('fetch failed'),{cause:{code:'ECONNREFUSED'}});},'provider_unreachable'],
    ['rate limited',async()=>new Response(null,{status:429}),'provider_rate_limited'],
    ['service outage',async()=>new Response(null,{status:503}),'provider_unavailable'],
    ['unknown',async()=>new Response('token=do-not-store /private/path',{status:200,headers:{'content-type':'text/plain'}}),'provider_probe_failed'],
  ];
  for(const [label,fetchImpl,expectedCode]of cases){
    await t.test(label,async sub=>{
      const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-provider-health-code-')),database=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(database);
      sub.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
      const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
      const credentials={resolveWithRevision:()=>({token:'secret-provider-token',revision:0})};
      assert.equal(await refreshOneProviderHealth({processing,providerCredentials:credentials,owner:'health-code',fetchImpl}),true);
      const current=processing.getProvider(provider.id);
      assert.equal(current.runtimeHealthErrorCode,expectedCode);
      assert.equal(current.runtimeHealth,'unhealthy');
      assert.doesNotMatch(current.runtimeHealthError||'',/do-not-store|\/private\/path|secret-provider-token/);
      assert.equal(processing.listProviders()[0].runtimeHealthErrorCode,expectedCode,'provider DTO exposes the code used by the UI');
    });
  }
});

test('provider health calls only confirmed explicit provider_busy a capacity rejection',()=>{
  assert.equal(providerHealthDiagnosticCode(Object.assign(new Error('busy'),{code:'provider_busy',explicitCapacityRejection:true})),'provider_busy');
  assert.equal(providerHealthDiagnosticCode(Object.assign(new Error('busy'),{code:'provider_busy'})),'provider_rate_limited');
});

test('NodeODM 200 error envelopes map removed tasks to not-found without reflecting provider text',async()=>{const uuid='00000000-0000-4000-8000-000000000000',provider=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',fetchImpl:async()=>new Response(JSON.stringify({error:`${uuid} not found at /private/provider`}),{status:200,headers:{'content-type':'application/json'}})});await assert.rejects(provider.status(uuid),(error)=>{assert.equal(error.code,'provider_task_not_found');assert.doesNotMatch(error.message,/00000000|private/);return true;});});

test('ClusterODM 200 no-entry envelopes map removed tasks to not-found without reflecting provider text',async()=>{const uuid='00000000-0000-4000-8000-000000000001',provider=new NodeOdmProvider({endpoint:'http://127.0.0.1:3000',providerType:'clusterodm',fetchImpl:async()=>new Response(JSON.stringify({error:`Invalid route for taskId ${uuid}:info, no task table entry.`}),{status:200,headers:{'content-type':'application/json'}})});await assert.rejects(provider.status(uuid),(error)=>{assert.equal(error.code,'provider_task_not_found');assert.doesNotMatch(error.message,/00000000|task table/);return true;});});
