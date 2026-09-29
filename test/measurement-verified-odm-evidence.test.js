'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {MeasurementSourceUnitEvidence,sourceUnitDisplayEvidence}=require('../server/measurementSourceUnitEvidence');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t,kind='dsm'){
  const db=new DatabaseSync(':memory:');applyMigrations(db);t.after(()=>db.close());
  const inputFiles=[{relativePath:'photo.jpg',byteSize:4,sha256:sha('jpeg')}],archiveFiles=[];
  const artifact=(relativePath,text)=>{const bytes=Buffer.from(text);archiveFiles.push({relativePath,byteSize:bytes.length,sha256:sha(bytes)});return{relativePath,bytes};};
  const log={odmVersion:'3.5.6',images:1,success:true,startTime:'2026-01-01T00:00:00Z',endTime:'2026-01-01T00:01:00Z',totalTime:60,
    options:{gcp:null,geo:null,align:null,sm_cluster:null,split_image_groups:null,rerun:null,rerun_from:null,rerun_all:false,split:999999,end_with:'odm_postprocess',gps_z_offset:0,dsm:true,dtm:true},
    stages:['dataset','opensfm','odm_georeferencing','odm_dem','odm_postprocess'].map(name=>({name,messages:[]})),processes:[{exitCode:0,command:'/private?token=secret'}]};
  const source={relativePath:`odm_dem/${kind}.tif`,kind,sha256:sha('source'),byteSize:12,horizontalEpsg:32616,verticalUnit:null};
  const producer={inputFiles,archiveFiles,source,
    receipt:{operation:'create',status:'completed',providerTaskId:'task',completedTaskId:'task',archiveSha256:sha('archive'),inputManifestSha256:sha(JSON.stringify(inputFiles))},
    log:artifact('log.json',JSON.stringify(log)),photos:artifact('images.json',JSON.stringify([{filename:'photo.jpg',latitude:43,longitude:-88,altitude:200}])),
    coords:artifact('odm_georeferencing/coords.txt','WGS84 UTM 16N\n100 200\n1 2 200\n')};
  archiveFiles.push({...source});
  const request={modelId:'model',modelVersionId:'version',source:{id:'asset',kind,sha256:source.sha256,byteSize:source.byteSize},coordinateReference:{crs:'EPSG:32616'}};
  const register=()=>{
    db.prepare("INSERT INTO models(id,provider,provider_model_id,display_name,status,created_at,updated_at) VALUES('model','test','model','Model','importing','now','now')").run();
    db.prepare("INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at) VALUES('version','model','version','{}','importing','now','now')").run();
    db.prepare("INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,byte_size,sha256,created_at) VALUES('asset','version',?,'models',?,?,?,'now')").run(kind,source.relativePath,source.byteSize,source.sha256);
  };
  return{db,store:new MeasurementSourceUnitEvidence(db),producer,request,register};
}

for(const kind of ['dsm','dtm'])test(`verified ${kind} evidence persists only after exact output registration`,t=>{
  const f=fixture(t,kind);assert.equal(f.store.recordVerifiedOdm(f.request,f.producer),null);f.register();
  const evidence=f.store.recordVerifiedOdm(f.request,f.producer);
  assert.equal(evidence.basis,'verified-odm-source');assert.equal(evidence.verticalUnit,'m');assert.equal(evidence.verticalDatum,'unknown');
  assert.equal(evidence.producerProof.contract,'odm-3.5.6-native-gps-metres-v1');
  assert.equal(f.db.prepare('SELECT created_by FROM measurement_source_unit_evidence').get().created_by,'system:verified-odm-source');
  assert.deepEqual(f.store.recordVerifiedOdm(f.request,f.producer),evidence);
  assert.doesNotMatch(JSON.stringify(evidence),/private|secret|photo\.jpg|odm_dem/);
  assert.equal(sourceUnitDisplayEvidence(evidence).producerProof,undefined);
  assert.equal(f.store.summary('model','version',f.request.source).basis,'verified-odm-source');
});

test('producer inference cannot replace a staff review',t=>{
  const f=fixture(t);f.register();const staff=f.store.recordStaffReview({...f.request,sourceVerticalUnit:'m'},'employee');
  assert.deepEqual(f.store.recordVerifiedOdm(f.request,f.producer),staff);
});

test('caller resolved assertions, absent receipts, conflicts and modified producer artifacts remain unknown',t=>{
  const f=fixture(t);f.register();
  for(const producer of [null,{status:'resolved',verticalUnit:'metre'},{...f.producer,receipt:null},
    {...f.producer,source:{...f.producer.source,verticalUnit:'foot'}},
    {...f.producer,receipt:{...f.producer.receipt,operation:'restart'}},
    {...f.producer,log:{...f.producer.log,bytes:Buffer.from('changed')}}])assert.equal(f.store.recordVerifiedOdm(f.request,producer),null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM measurement_source_unit_evidence').get().n,0);
});

test('kind hash size CRS and immutable model/version/asset identity must match',t=>{
  const f=fixture(t);f.register();
  const changes=[{modelId:'other'},{modelVersionId:'other'},{coordinateReference:{crs:'EPSG:32617'}},
    ...[{id:'other'},{kind:'dtm'},{kind:'ept',manifestSha256:sha('tree')},{sha256:sha('other')},{byteSize:13},{manifestSha256:sha('tree')}].map(change=>({source:{...f.request.source,...change}}))];
  for(const change of changes)assert.equal(f.store.recordVerifiedOdm({...f.request,...change},f.producer),null);
  f.db.prepare("UPDATE model_assets SET sha256=? WHERE id='asset'").run(sha('modified'));
  assert.equal(f.store.recordVerifiedOdm(f.request,f.producer),null);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM measurement_source_unit_evidence').get().n,0);
});
