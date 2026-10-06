import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {resolveEptUtmCrs,resolveEptVerticalUnits} from '../server/measurementEptCrs.mjs';
import {calculatePointSurface,preflightPointSurface} from '../server/measurementPointSurface.mjs';
import {calculatePointSurfaceTransect} from '../server/measurementPointTransect.mjs';

// Exact SRS captured from the pinned real Entwine conversion of the unified
// LAS fixture. This is interoperability evidence, not strict WKT2 conformance
// or a certification of a vertical datum. Only the point data below is synthetic.
const actual=JSON.parse(fs.readFileSync(new URL('./fixtures/unified-entwine-unnamed-srs.json',import.meta.url),'utf8'));
const expected={verticalFactor:1,verticalUnitBasis:'ept-vertical-crs',verticalUnit:'m',verticalDatum:'unknown'};
const resolve=srs=>resolveEptVerticalUnits(srs,32616);
const reject=(srs,code='measurement_source_vertical_metadata_invalid')=>assert.throws(()=>resolve(srs),{code});
const changed=(key,from,to)=>({[key]:actual[key].replace(from,to)});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('exact Entwine unnamed upward metre SRS works as WKT1, WKT2 and agreeing pair without claiming datum',()=>{
  for(const srs of [{wkt:actual.wkt},{wkt2:actual.wkt2},actual]){
    assert.equal(resolveEptUtmCrs(srs,32616),32616);
    assert.deepEqual(resolve(srs),expected);
  }
});

test('unnamed compatibility does not allow missing, non-string or whitespace-only names',()=>{
  for(const [key,tag] of [['wkt','VERT_CS'],['wkt2','VERTCRS']]){
    for(const replacement of [`${tag}[`,`${tag}[0,`,`${tag}[null,`,`${tag}[" ",`,`${tag}["\t",`]){
      // Syntax errors can be classified by the general CRS parser before the
      // vertical validator. They must still fail closed rather than gain units.
      assert.throws(()=>resolve(changed(key,`${tag}["",`,replacement)));
    }
  }
});

test('empty name accepts neither a named datum nor vertical CRS/datum authority claims',()=>{
  reject(changed('wkt','VERT_DATUM["unknown",2005]','VERT_DATUM["NAVD88",2005]'));
  reject(changed('wkt2','VDATUM["unknown"]','VDATUM["NAVD88"]'));
  reject(changed('wkt','VERT_DATUM["unknown",2005]','VERT_DATUM["unknown",2005,AUTHORITY["EPSG","5103"]]'));
  reject(changed('wkt2','VDATUM["unknown"]','VDATUM["unknown",ID["EPSG",5103]]'));
  reject(changed('wkt','AXIS["Up",UP]]]','AXIS["Up",UP],AUTHORITY["EPSG","5703"]]]'));
  reject(changed('wkt2','ID["EPSG",9001]]]]]','ID["EPSG",9001]]],ID["EPSG",5703]]]'));
  reject(changed('wkt','VERT_DATUM["unknown",2005]','VERT_DATUM["",2005]'));
  reject(changed('wkt2','VDATUM["unknown"]','VDATUM[""]'));
});

test('unnamed frame still rejects downward, duplicate, transformed and missing-unit definitions',()=>{
  reject(changed('wkt','AXIS["Up",UP]','AXIS["Up",DOWN]'));
  reject(changed('wkt2','AXIS["up",up,','AXIS["up",down,'));
  reject(changed('wkt','AXIS["Up",UP]','AXIS["Other",UP],AXIS["Up",UP]'));
  reject(changed('wkt2','CS[vertical,1]','CS[vertical,1],CS[vertical,1]'));
  reject(changed('wkt2','CS[vertical,1]','CS[vertical,2]'));
  reject(changed('wkt','VERT_DATUM["unknown",2005]','VERT_DATUM["unknown",2005,TOWGS84[0,0,0]]'));
  reject(changed('wkt',',UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Up",UP]',',AXIS["Up",UP]'),'measurement_source_vertical_metadata_invalid');
  reject(changed('wkt2',',LENGTHUNIT["metre",1,ID["EPSG",9001]]',''),'measurement_source_vertical_units_required');
});

test('unnamed units preserve factor, authority, horizontal and numeric vertical fail-closed guards',()=>{
  reject(changed('wkt','VERT_CS["",VERT_DATUM["unknown",2005],UNIT["metre",1','VERT_CS["",VERT_DATUM["unknown",2005],UNIT["metre",0.3048'),'measurement_source_vertical_units_unsupported');
  reject(changed('wkt2','LENGTHUNIT["metre",1,ID["EPSG",9001]]','LENGTHUNIT["metre",1,ID["EPSG",9002]]'),'measurement_source_vertical_units_conflict');
  const feet=actual.wkt2.replace('LENGTHUNIT["metre",1,ID["EPSG",9001]]','LENGTHUNIT["foot",0.3048,ID["EPSG",9002]]');
  near(resolve({wkt2:feet}).verticalFactor,.3048);
  reject({...actual,wkt2:feet},'measurement_source_vertical_units_conflict');
  reject({...actual,horizontal:32617},'measurement_source_crs_mismatch');
  reject(changed('wkt','"central_meridian",-87','"central_meridian",-81'),'measurement_source_crs_mismatch');
  reject({...actual,vertical:5703},'measurement_source_vertical_units_unsupported');
  reject({...actual,vertical:null});
});

function pointFixture(t,srs){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'point-unnamed-units-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'ept-hierarchy'));fs.mkdirSync(path.join(root,'ept-data'));
  const files=[];
  const write=(relative,value)=>{
    const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));
    fs.writeFileSync(path.join(root,relative),bytes);
    const identity={relativePath:relative,byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
    files.push(identity);return identity;
  };
  const header=write('ept.json',{srs,bounds:[0,0,0,2,2,4],dataType:'binary',schema:['X','Y','Z'].map(name=>({name,type:'floating',size:8}))});
  write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':4});
  const data=Buffer.alloc(4*24);
  [[.5,.5,1],[1.5,.5,2],[.5,1.5,3],[1.5,1.5,4]].forEach((point,i)=>point.forEach((value,j)=>data.writeDoubleLE(value,i*24+j*8)));
  write('ept-data/0-0-0-0.bin',data);
  const request={method:'point-surface-cut-fill',requireEncodedVerticalUnits:true,vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],reference:{type:'custom',elevationM:0},coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},cellSizeM:1,modelVersionId:'fixture-v1',source:{id:'fixture-ept',kind:'ept',byteSize:header.byteSize,sha256:header.sha256,manifestSha256:'a'.repeat(64)}};
  return{file:path.join(root,'ept.json'),files,request};
}

test('captured unnamed units support numerical binary point volume and parent-grid transect',async t=>{
  const f=pointFixture(t,actual),options={sourceFiles:f.files};
  assert.deepEqual((await preflightPointSurface(f.file,f.request,{requireEncodedVerticalUnits:true})).vertical,expected);
  const result=await calculatePointSurface(f.file,f.request,options);
  near(result.cutM3,10);assert.equal(result.fillM3,0);assert.equal(result.coverage,1);
  assert.equal(result.source.verticalDatum,'unknown');assert.equal(result.source.verticalUnitBasis,'ept-vertical-crs');
  assert.ok(!result.warnings.some(w=>/administrator-declared|declared as metres/.test(w)));
  const referencePatches=result.preview.referencePatches,baseHash=crypto.createHash('sha256').update(JSON.stringify(referencePatches)).digest('hex');
  const section=await calculatePointSurfaceTransect(f.file,{...f.request,method:'surface-transect',parentCalculationId:'parent',samplingGrid:result.source.samplingGrid,referencePatches,baseHash,line:{start:[0,.5],end:[2,.5]}},options);
  assert.equal(section.source.verticalDatum,'unknown');assert.equal(section.source.verticalUnitBasis,'ept-vertical-crs');
  assert.ok(section.segments.every(s=>s.status==='sample'&&s.baseStartM===0&&s.baseEndM===0));
  for(const segment of section.segments)near(segment.surfaceM,segment.cell[0]+1);
  near(section.segments.reduce((sum,s)=>sum+(s.endM-s.startM)*s.surfaceM,0),3);
});

test('explicit staff metre declaration never bypasses malformed unnamed or numeric vertical metadata',async t=>{
  for(const [srs,code] of [[{...actual,vertical:5703},'measurement_source_vertical_units_unsupported'],[changed('wkt','AXIS["Up",UP]','AXIS["Up",DOWN]'),'measurement_source_vertical_metadata_invalid']]){
    const f=pointFixture(t,srs),request={...f.request,sourceVerticalUnit:'m'};
    await assert.rejects(preflightPointSurface(f.file,request,{requireEncodedVerticalUnits:true}),{code});
    await assert.rejects(calculatePointSurface(f.file,request,{sourceFiles:f.files}),{code});
  }
});
