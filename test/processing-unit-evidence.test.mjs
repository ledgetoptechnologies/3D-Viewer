import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { nativeTiffFixture } from './helpers/native-tiff-fixture.mjs';
import { prepareProcessingUnitEvidence } from '../server/processingUnitEvidence.js';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t,{verticalUnit=null,engineVersion='3.5.6'}={}){
  const destination=fs.mkdtempSync(path.join(os.tmpdir(),'ingestion-unit-evidence-'));
  t.after(()=>fs.rmSync(destination,{recursive:true,force:true}));
  const archiveFiles=[],inputFiles=[{relativePath:'photo.jpg',byteSize:4,sha256:sha('jpeg')}];
  const put=(relativePath,data)=>{const bytes=Buffer.from(data),file=path.join(destination,relativePath);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);const row={relativePath,byteSize:bytes.length,sha256:sha(bytes)};archiveFiles.push(row);return row;};
  const log={odmVersion:engineVersion,images:1,success:true,startTime:'2026-01-01T00:00:00Z',endTime:'2026-01-01T00:01:00Z',totalTime:60,
    options:{gcp:null,geo:null,align:null,sm_cluster:null,split_image_groups:null,rerun:null,rerun_from:null,rerun_all:false,split:999999,end_with:'odm_postprocess',gps_z_offset:0,dsm:true,dtm:true},
    stages:['dataset','opensfm','odm_georeferencing','odm_dem','odm_postprocess'].map(name=>({name,messages:[]})),processes:[{exitCode:0}]};
  put('log.json',JSON.stringify(log));put('images.json',JSON.stringify([{filename:'photo.jpg',latitude:43,longitude:-88,altitude:200}]));put('odm_georeferencing/coords.txt','WGS84 UTM 16N\n100 200\n1 2 200\n');
  const assets=['dsm','dtm'].map(kind=>({id:kind,kind,...put(`odm_dem/${kind}.tif`,nativeTiffFixture({verticalUnit})),relativePath:`task/attempt/odm_dem/${kind}.tif`}));
  const producer={archiveFiles,inputFiles,receipt:{operation:'create',status:'completed',providerTaskId:'task',completedTaskId:'task',archiveSha256:sha('archive'),inputManifestSha256:sha(JSON.stringify(inputFiles))}};
  return{destination,assets,producer,sourcePrefix:'task/attempt',modelId:'model',modelVersionId:'version'};
}
test('ingestion prepares both registered native raster identities from real metadata and bound artifacts',async t=>{
  const f=fixture(t),candidates=await prepareProcessingUnitEvidence(f);
  assert.equal(candidates.length,2);
  for(const item of candidates){assert.equal(item.request.modelVersionId,'version');assert.equal(item.request.source.id,item.input.source.kind);assert.equal(item.input.source.verticalUnit,null);assert.equal(item.request.coordinateReference.crs,'EPSG:32616');}
});
test('feet, unsupported engines and missing receipts never auto-resolve',async t=>{
  for(const options of [{verticalUnit:9002},{engineVersion:'unknown'}])assert.deepEqual(await prepareProcessingUnitEvidence(fixture(t,options)),[]);
  const f=fixture(t);assert.deepEqual(await prepareProcessingUnitEvidence({...f,producer:null}),[]);
  f.producer.archiveFiles=f.producer.archiveFiles.filter(file=>file.relativePath!=='log.json');
  assert.deepEqual(await prepareProcessingUnitEvidence(f),[]);
});
test('changed companion artifact bytes fail integrity instead of authorizing a unit assumption',async t=>{
  const f=fixture(t),log=path.join(f.destination,'log.json'),bytes=fs.readFileSync(log);bytes[0]^=1;fs.writeFileSync(log,bytes);
  await assert.rejects(prepareProcessingUnitEvidence(f),{code:'source_changed'});
});
test('asset path or source identity mismatch cannot borrow producer evidence',async t=>{
  const f=fixture(t);f.assets[0].sha256=sha('wrong');f.assets[1].relativePath='other/odm_dem/dtm.tif';
  assert.deepEqual(await prepareProcessingUnitEvidence(f),[]);
});
