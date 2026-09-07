import test from 'node:test';
import assert from 'node:assert/strict';
import {fromArrayBuffer} from 'geotiff';
import {resolveMeasurementDisplayElevations,retainedDisplayBoundary} from '../measurement-display-elevations.mjs';
import {nativeTiffFixture} from './helpers/native-tiff-fixture.mjs';
const record=()=>({collection:'map',kind:'polygon',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},vertices:[[.25,.25,0],[1.75,.25,0],[1.75,1.75,0],[.25,1.75,0]],source:{kind:'ortho'},results:{status:'geometry-only',elevationBasis:'not-sampled'}});
function fixture(overrides={}){
  const counts={preflight:0,open:0,close:0,reads:[]};
  const image={getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9001}),getSamplesPerPixel:()=>1,getOrigin:()=>[0,2],getResolution:()=>[1,-1],getWidth:()=>2,getHeight:()=>2,fileDirectory:{BitsPerSample:[32],RowsPerStrip:1},getGDALNoData:()=>null,readRasters:async options=>{counts.reads.push(options);return new Float32Array([1,2,3,4]);},...overrides};
  const options={modelVersionId:'v1',expectedCrs:'EPSG:32616',source:{type:'dsm',url:'/source/dsm.tif'},preflight:async()=>{counts.preflight++;},openTiff:async(_url,options)=>{counts.open++;assert.equal(options.allowFullFile,false);return{getImage:async()=>image,close:async()=>{counts.close++;}};}};
  return{counts,image,options,run:(r=record(),extra={})=>resolveMeasurementDisplayElevations(r,{...options,...extra})};
}
test('display-only sampling preserves map geometry/results and uses one bounded native window',async()=>{
  const f=fixture(),r=record(),before=structuredClone(r),pool={bindParameters:()=>{}},result=await f.run(r,{pool});
  assert.deepEqual(result.vertices.map(p=>p[2]),[3,4,2,1]);assert.deepEqual(r,before);assert.equal(f.counts.close,1);assert.equal(f.counts.reads.length,1);assert.deepEqual(f.counts.reads[0].window,[0,0,2,2]);assert.match(result.basis,/DSM native-cell elevations.*display only/);
  assert.equal(f.counts.reads[0].pool,pool,'native decoding receives the shared worker pool');
});
test('real TIFF with explicit GDAL foot band units provides correct display XYZ without changing saved zero Z',async()=>{
  const bytes=nativeTiffFixture({verticalUnit:null,gdalMetadata:'<GDALMetadata><Item name="UNITTYPE" sample="0" role="unittype">ft</Item></GDALMetadata>'});
  const tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),image=await tiff.getImage(),f=fixture();f.options.openTiff=async()=>({getImage:async()=>image,close:async()=>{}});
  const r=record(),result=await f.run(r);assert.deepEqual(result.vertices.map(p=>p[2]),[3,4,2,1].map(v=>v*.3048));assert.ok(r.vertices.every(p=>p[2]===0));assert.equal(r.results.status,'geometry-only');assert.match(result.basis,/gdal-band-unit/);
});
test('same-version, same-XY saved boundary with explicit units can be reused without source reads',async()=>{
  const r=record();r.results={method:'surface-cut-fill',modelVersionId:'v1',sourceVerticalUnitBasis:'gdal-band-unit',boundaryVertices:r.vertices.map((p,i)=>[p[0],p[1],100+i])};
  const f=fixture(),result=await f.run(r);assert.deepEqual(result.vertices.map(p=>p[2]),[100,101,102,103]);assert.equal(f.counts.preflight,0);result.vertices[0][2]=900;assert.equal(r.results.boundaryVertices[0][2],100);
  assert.equal(retainedDisplayBoundary(r,'other'),null);r.results.boundaryVertices[0][0]++;assert.equal(retainedDisplayBoundary(r,'v1'),null);r.results.boundaryVertices[0][0]--;delete r.results.sourceVerticalUnitBasis;assert.equal(retainedDisplayBoundary(r,'v1'),null);
});

test('requester-declared saved boundaries retain honest provenance and legacy declarations remain readable',()=>{
  for(const basis of ['requester-declared','administrator-declared','user-declared']){
    const r=record();r.results={method:'surface-cut-fill',source:{modelVersionId:'v1',verticalUnitBasis:basis},boundaryVertices:r.vertices.map(p=>[p[0],p[1],100])};
    const before=structuredClone(r),retained=retainedDisplayBoundary(r,'v1');
    assert.deepEqual(retained.vertices,r.results.boundaryVertices);assert.ok(retained.basis.includes(basis));assert.deepEqual(r,before,'reading does not rewrite historical attribution');
    assert.equal(retainedDisplayBoundary(r,'other'),null);
  }
});
test('missing elevations or unverified units fail closed instead of fabricating zero or reusing stale preview',async()=>{
  for(const [overrides,pattern]of [
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616})},/does not encode elevation units/],
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,ProjLinearUnitsGeoKey:9002,VerticalUnitsGeoKey:9001})},/horizontal units/],
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32617,VerticalUnitsGeoKey:9001})},/projection/],
    [{getSamplesPerPixel:()=>3},/single-band/],
    [{getResolution:()=>[1,1]},/grid/],
    [{getGDALNoData:()=>3},/no source elevation/],
    [{readRasters:async()=>new Float32Array([1,2,NaN,4])},/no source elevation/],
    [{readRasters:async()=>new Float32Array(1)},/window is incomplete/],
  ]){const f=fixture(overrides);await assert.rejects(f.run(),pattern);assert.equal(f.counts.close,1);}
  const f=fixture();await assert.rejects(f.run(record(),{source:null}),/no existing DSM/);assert.equal(f.counts.open,0);
});
test('out-of-bounds, oversized native extent and oversized block are rejected before pixel reads',async()=>{
  const outside=record();outside.vertices[0][0]=-1;const f=fixture();await assert.rejects(f.run(outside),/outside/);assert.equal(f.counts.reads.length,0);
  const wide=record();wide.vertices=[[.25,.25,0],[1999.75,.25,0],[1999.75,1999.75,0],[.25,1999.75,0]];const large=fixture({getWidth:()=>2000,getHeight:()=>2000,getOrigin:()=>[0,2000]});await assert.rejects(large.run(wide),/sampling limit/);assert.equal(large.counts.reads.length,0);
  const block=fixture({fileDirectory:{BitsPerSample:[64],RowsPerStrip:2},getWidth:()=>20_000_000});await assert.rejects(block.run(),/decode blocks/);assert.equal(block.counts.reads.length,0);
});
test('cancellation before or during native sampling never returns display geometry and closes source',async()=>{
  const pre=new AbortController();pre.abort();const f=fixture();await assert.rejects(f.run(record(),{signal:pre.signal}),{name:'AbortError'});assert.equal(f.counts.preflight,0);
  const controller=new AbortController(),late=fixture({readRasters:async()=>{controller.abort();return new Float32Array([1,2,3,4]);}});await assert.rejects(late.run(record(),{signal:controller.signal}),{name:'AbortError'});assert.equal(late.counts.close,1);
});
