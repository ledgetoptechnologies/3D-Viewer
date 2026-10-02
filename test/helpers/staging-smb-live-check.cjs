'use strict';
// Read-only admission check, run only in the staging API container with the
// candidate modules in volatile storage. Does not start jobs or alter config.
const assert=require('node:assert/strict');
const {StorageManager}=require('../../server/storageManager');
const {config}=require('/app/server/config');
assert.equal(process.platform,'linux');
assert.equal(config.modelsMount,'/app/storage/models');
assert.equal(config.cacheMount,'/app/storage/cache');
const original=new StorageManager({...config,stagingSmbAllowUnavailableInodes:false});
const space=original.space('models');
assert.equal(space.filesystemType,0xfe534d42);
assert.equal(space.files,0);assert.equal(space.ffree,0);
assert.throws(()=>original.requireDerivativeSpace('models',{sourceBytes:1024}),e=>e.code==='insufficient_storage'&&/inode headroom is unavailable/.test(e.message));
const candidate=new StorageManager({...config,deploymentId:'staging-192.168.50.90',expectedHost:'192.168.50.90',publicBaseUrl:'https://192.168.50.90:8088',stagingSmbAllowUnavailableInodes:true});
const admitted=candidate.requireDerivativeSpace('models',{sourceBytes:1024});
assert.equal(admitted.inodeReserve,null);
assert.equal(admitted.inodeAssessment,'unavailable-staging-smb-exception');
assert.ok(admitted.available-admitted.required>=admitted.reserve);
const production=new StorageManager({...candidate.config,expectedHost:'viewer.ledgetopdroneservices.com',publicBaseUrl:'https://viewer.ledgetopdroneservices.com'});
assert.throws(()=>production.requireDerivativeSpace('models',{sourceBytes:1024}),{code:'insufficient_storage'});
console.log(JSON.stringify({defaultRefuses:true,stagingCandidateAdmits:true,productionRefuses:true,nasBytesWritten:0,jobsStarted:0,filesystemType:space.filesystemType,files:space.files,ffree:space.ffree,available:admitted.available,required:admitted.required,reserve:admitted.reserve,inodeAssessment:admitted.inodeAssessment}));
