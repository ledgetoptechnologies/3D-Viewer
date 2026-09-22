import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { calculatePointSurface, pointSurfaceGrid, preflightPointSurface } from '../server/measurementPointSurface.mjs';
import {calculatePointSurfaceTransect} from '../server/measurementPointTransect.mjs';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-point-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'ept-hierarchy'));fs.mkdirSync(path.join(root,'ept-data'));
  const files=[],write=(relative,bytes)=>{bytes=Buffer.isBuffer(bytes)?bytes:Buffer.from(JSON.stringify(bytes));fs.writeFileSync(path.join(root,relative),bytes);const file={relativePath:relative,byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};files.push(file);return file;};
  const data=points=>{const bytes=Buffer.alloc(points.length*25);points.forEach(([x,y,z,classification],i)=>{bytes.writeDoubleLE(x,i*25);bytes.writeDoubleLE(y,i*25+8);bytes.writeDoubleLE(z,i*25+16);bytes[i*25+24]=classification;});return bytes;};
  const manifest=write('ept.json',{bounds:[0,0,0,4,4,4],dataType:'binary',srs:{horizontal:'32616'},schema:[{name:'X',type:'floating',size:8},{name:'Y',type:'floating',size:8},{name:'Z',type:'floating',size:8},{name:'Classification',type:'unsigned',size:1}]});
  write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':2,'1-0-0-0':-1});write('ept-hierarchy/1-0-0-0.json',{'1-0-0-0':2});
  write('ept-data/0-0-0-0.bin',data([[.5,.5,1,2],[1.5,.5,2,6]]));write('ept-data/1-0-0-0.bin',data([[.5,1.5,3,2],[1.5,1.5,4,2]]));
  const request={vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],reference:{type:'custom',elevationM:0},coordinateReference:{crs:'EPSG:32616'},sourceVerticalUnit:'m',cellSizeM:1,source:{id:'ept',byteSize:manifest.byteSize,sha256:manifest.sha256,manifestSha256:'b'.repeat(64)},modelVersionId:'v1'};
  return{root,files,request,write};
}
test('point surface reads every intersecting hierarchy level at full point count',async t=>{
  const f=fixture(t),result=await calculatePointSurface(path.join(f.root,'ept.json'),f.request,{sourceFiles:f.files});
  assert.equal(result.cutM3,10);assert.equal(result.coverage,1);assert.equal(result.source.pointsRead,4);assert.equal(result.source.nodesRead,2);assert.equal(result.source.allIntersectingHierarchyLevels,true);
  const ground=await calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,classFilter:'ground'},{sourceFiles:f.files});assert.equal(ground.cutM3,8);assert.equal(ground.coverage,.75);assert.equal(ground.status,'incomplete');
});
test('point result identifies its source and exact sampling policy without claiming verified height units',async t=>{
  const f=fixture(t),request={...f.request,method:'point-surface-cut-fill',source:{...f.request.source,kind:'ept'}};
  const result=await calculatePointSurface(path.join(f.root,'ept.json'),request,{sourceFiles:f.files});
  assert.equal(result.method,request.method);
  assert.equal(result.source.kind,'ept');
  assert.equal(result.source.manifestSha256,request.source.manifestSha256);
  assert.equal(result.source.verticalUnitBasis,'administrator-declared');
  assert.deepEqual(result.source.samplingGrid,{version:1,width:2,height:2,bounds:{minE:0,minN:0,maxE:2,maxN:2},cellSizeM:1,rowOrder:'north-to-south',reduction:'maximum-z',emptyCells:'missing'});
  assert.equal(result.preview.previewOnly,true);
  assert.equal(result.cutM3,10);
  await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),{...request,sourceVerticalUnit:undefined},{sourceFiles:f.files}),{code:'measurement_source_vertical_units_required'});
});
test('point surface missing or changed node fails instead of reporting partial full-resolution success',async t=>{
  const f=fixture(t);await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),f.request,{sourceFiles:f.files.filter(file=>!file.relativePath.endsWith('1-0-0-0.bin'))}),{code:'measurement_ept_file_unavailable'});
  fs.writeFileSync(path.join(f.root,'ept-data/1-0-0-0.bin'),Buffer.alloc(50));await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),f.request,{sourceFiles:f.files}),{code:'measurement_source_changed'});
});
test('point preflight verifies metadata before hierarchy or point reads',async t=>{
  const f=fixture(t);
  // Metadata preflight must not perform the expensive source-node traversal.
  fs.unlinkSync(path.join(f.root,'ept-data/0-0-0-0.bin'));
  const result=await preflightPointSurface(path.join(f.root,'ept.json'),f.request);
  assert.equal(result.expected,32616);
  await assert.rejects(preflightPointSurface(path.join(f.root,'ept.json'),{...f.request,sourceVerticalUnit:null}),{code:'measurement_source_vertical_units_required'});
  await assert.rejects(preflightPointSurface(path.join(f.root,'ept.json'),{...f.request,source:{...f.request.source,sha256:'0'.repeat(64)}}),{code:'measurement_source_changed'});
});
test('point section rebuilds the parent grid and frozen base, with missing cells remaining gaps',async t=>{
  const f=fixture(t),source={...f.request.source,kind:'ept'};
  const parent=await calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,source},{sourceFiles:f.files});
  const referencePatches=parent.preview.referencePatches;
  const request={...f.request,source,method:'surface-transect',parentCalculationId:'parent',samplingGrid:parent.source.samplingGrid,referencePatches,baseHash:crypto.createHash('sha256').update(JSON.stringify(referencePatches)).digest('hex'),line:{start:[0,.5],end:[2,.5]}};
  const result=await calculatePointSurfaceTransect(path.join(f.root,'ept.json'),request,{sourceFiles:f.files});
  assert.equal(result.sampling,'point-grid-step');
  assert.equal(result.calculationOrigin,'server-original-point-surface');
  assert.equal(result.source.manifestSha256,source.manifestSha256);
  assert.ok(result.segments.every(s=>s.status==='sample'&&s.baseStartM===0&&s.baseEndM===0));
  assert.equal(result.segments.reduce((sum,s)=>sum+(s.endM-s.startM)*s.surfaceM,0),3);
  const ground=await calculatePointSurfaceTransect(path.join(f.root,'ept.json'),{...request,classFilter:'ground'},{sourceFiles:f.files});
  assert.ok(ground.segments.some(s=>s.status==='nodata'&&!('surfaceM' in s)));
  await assert.rejects(calculatePointSurfaceTransect(path.join(f.root,'ept.json'),{...request,samplingGrid:{...request.samplingGrid,width:3}},{sourceFiles:f.files}),{code:'measurement_transect_source_mismatch'});
  await assert.rejects(calculatePointSurfaceTransect(path.join(f.root,'ept.json'),{...request,baseHash:'bad'},{sourceFiles:f.files}),{code:'measurement_transect_reference_invalid'});
});
test('point surface explicit sampling limits reject oversize; no automatic cell enlargement',()=>{
  assert.throws(()=>pointSurfaceGrid([[0,0,0],[1000,0,0],[1000,1000,0]],.001),{code:'measurement_limit'});
  assert.throws(()=>pointSurfaceGrid([[0,0,0],[1,0,0],[1,1,0]],NaN),{code:'measurement_point_cell_size_required'});
});

test('map reference samples the native point grid, not placeholder zero, and preview stays selected',async t=>{
 const f=fixture(t),request={...f.request,collection:'map',reference:{type:'boundary-triangulated'}};
 const result=await calculatePointSurface(path.join(f.root,'ept.json'),request,{sourceFiles:f.files});
 assert.ok(Math.abs(result.netM3)<1e-9);assert.ok(result.preview.samples.every(p=>p[3]>0));
 await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),{...request,classFilter:'ground'},{sourceFiles:f.files}),{code:'measurement_boundary_elevation_unavailable'});
 const selected=await calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,selection:{minElevationM:1.5,maxElevationM:3.5}},{sourceFiles:f.files,collectOnly:true});
 assert.deepEqual(selected.points,[[1.5,.5,2],[.5,1.5,3]]);
});

test('native LAZ source decodes all points using bundled offline WASM',async t=>{
 const f=fixture(t),bytes=fs.readFileSync(new URL('./fixtures/synthetic-ept-node.laz',import.meta.url));
 const manifest=f.write('ept.json',{bounds:[367000,4759000,99,367016,4759004,101],dataType:'laszip',srs:{horizontal:'32616'},schema:[{name:'X',type:'signed',size:4},{name:'Y',type:'signed',size:4},{name:'Z',type:'signed',size:4},{name:'Classification',type:'unsigned',size:1}]});
 f.write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':64});f.write('ept-data/0-0-0-0.laz',bytes);
 const request={...f.request,vertices:[[367000,4759000,0],[367016,4759000,0],[367016,4759004,0],[367000,4759004,0]],source:{...f.request.source,byteSize:manifest.byteSize,sha256:manifest.sha256}};
 const result=await calculatePointSurface(path.join(f.root,'ept.json'),request,{sourceFiles:f.files});assert.equal(result.source.pointsRead,64);assert.ok(result.cutM3>0);
});
