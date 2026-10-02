'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {StorageManager}=require('../server/storageManager');
const gib=1024**3;
const identified={deploymentId:'staging-192.168.50.90',expectedHost:'192.168.50.90',publicBaseUrl:'https://192.168.50.90:8088',stagingSmbAllowUnavailableInodes:true};
function fixture(t,{config={},stat={}}={}){
  t.mock.method(fs,'statSync',()=>({dev:1}));
  t.mock.method(fs,'statfsSync',()=>({type:0xfe534d42,bsize:4096,blocks:100*gib/4096,bavail:90*gib/4096,files:0,ffree:0,...stat}));
  return new StorageManager({modelsMount:'/app/storage/models',cacheMount:'/app/storage/cache',storageReserveBytes:20*gib,storageReservePercent:10,...config});
}
const admit=s=>s.requireDerivativeSpace('models',{sourceBytes:gib,expectedFiles:10000});
test('default refuses unavailable inode figures even on verified SMB staging',t=>{
  const s=fixture(t,{config:{...identified,stagingSmbAllowUnavailableInodes:false}});
  assert.throws(()=>admit(s),e=>e.code==='insufficient_storage'&&/unavailable/.test(e.message));
});
test('explicitly identified staging allows only SMB zero/zero, with honest diagnostics and intact reservations',t=>{
  const s=fixture(t,{config:{...identified,production:true}}),result=admit(s);
  assert.equal(result.files,0);assert.equal(result.ffree,0);assert.equal(result.inodeReserve,null);
  assert.equal(result.inodeAssessment,'unavailable-staging-smb-exception');assert.equal(result.required,5*gib);
  assert.equal(s.requireDerivativeSpace('models',{sourceBytes:gib,reservedBytes:8*gib,otherReservedBytes:2*gib,reservedDatasetBytes:[gib]}).required,14*gib);
});
for(const config of [{deploymentId:''},{deploymentId:'production'},{expectedHost:'viewer.ledgetopdroneservices.com'},{publicBaseUrl:'https://viewer.ledgetopdroneservices.com'}])
  test(`exception refuses non-staging identity ${JSON.stringify(config)}`,t=>assert.throws(()=>admit(fixture(t,{config:{...identified,...config}})),{code:'insufficient_storage'}));
for(const stat of [{type:0xef53},{type:0x01021994},{files:1000000,ffree:0},{files:1000000,ffree:20000},{files:0,ffree:10},{files:-1,ffree:-1},{files:NaN,ffree:NaN}])
  test(`exception does not bypass unknown filesystem, invalid figures, or known inode exhaustion ${JSON.stringify(stat)}`,t=>assert.throws(()=>admit(fixture(t,{config:identified,stat})),{code:'insufficient_storage'}));
test('low byte space still refuses staging exception',t=>assert.throws(()=>admit(fixture(t,{config:identified,stat:{bavail:24*gib/4096}})),e=>e.code==='insufficient_storage'&&/storage headroom/.test(e.message)));
test('missing mount/statfs errors are not swallowed by the exception',t=>{
  const s=fixture(t,{config:identified});
  fs.statfsSync.mock.mockImplementation(()=>{throw Object.assign(new Error('mount unavailable'),{code:'ENOENT'});});
  assert.throws(()=>admit(s),{code:'ENOENT'});
});
test('input limits and reservation validation remain enforced',t=>{
  const s=fixture(t,{config:identified});
  assert.throws(()=>s.requireDerivativeSpace('models',{sourceBytes:17*gib}),{code:'derivative_source_too_large'});
  assert.throws(()=>s.requireDerivativeSpace('models',{sourceBytes:1,reservedBytes:-1}),{code:'invalid_storage_estimate'});
  assert.throws(()=>s.requireDerivativeSpace('models',{sourceBytes:1,reservedDatasetBytes:[-1]}),{code:'insufficient_storage'});
});
test('known inode figures use the original reserve policy',t=>{
  const result=admit(fixture(t,{config:identified,stat:{files:1000000,ffree:500000}}));
  assert.equal(result.inodeReserve,50000);assert.equal(result.inodeAssessment,undefined);
});
test('environment defaults off; enabled non-staging configuration is rejected regardless of NODE_ENV',()=>{
  const script="const {config,validate}=require('./server/config');console.log(JSON.stringify({enabled:config.stagingSmbAllowUnavailableInodes,problems:validate().filter(x=>x.includes('STAGING_SMB'))}));";
  const run=env=>JSON.parse(execFileSync(process.execPath,['-e',script],{cwd:path.join(__dirname,'..'),env:{...process.env,VIEWER_DEPLOYMENT_ID:'',STAGING_SMB_ALLOW_UNAVAILABLE_INODES:'',...env},encoding:'utf8'}));
  assert.equal(run({NODE_ENV:'development'}).enabled,false);
  for(const NODE_ENV of ['development','production'])assert.equal(run({NODE_ENV,STAGING_SMB_ALLOW_UNAVAILABLE_INODES:'true'}).problems.length,1);
  assert.equal(run({NODE_ENV:'production',STAGING_SMB_ALLOW_UNAVAILABLE_INODES:'true',VIEWER_DEPLOYMENT_ID:identified.deploymentId,EXPECTED_HOST:identified.expectedHost,PUBLIC_BASE_URL:identified.publicBaseUrl}).problems.length,0);
});
