import test from 'node:test';
import assert from 'node:assert/strict';
import { createReference, createSurfaceAccumulator, integrateSurfaceVolume, triangulatePolygon, polygonArea } from '../measurement-volume.mjs';
import {estimateMeasurementInventory} from '../measurement-density.mjs';
const square = [[0, 0, 10], [2, 0, 10], [2, 2, 10], [0, 2, 10]];
const grid = { width: 2, height: 2, bounds: { minE: 0, minN: 0, maxE: 2, maxN: 2 }, vertices: square };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
test('native surface cut/fill keeps precision and reports both signs', () => {
  const result = integrateSurfaceVolume({ ...grid, values: [12.1234567, 8, 11, 9] });
  near(result.cutM3, 3.1234567); near(result.fillM3, 3); near(result.netM3, .1234567); assert.equal(result.status, 'complete');
});
test('fractional boundary coverage integrates sloping base crossing a cell exactly', () => {
  const result = integrateSurfaceVolume({ values: [1], width: 1, height: 1, bounds: { minE: 0, minN: 0, maxE: 2, maxN: 1 }, vertices: [[0, 0, 0], [2, 0, 2], [2, 1, 2], [0, 1, 0]] });
  near(result.cutM3, .5); near(result.fillM3, .5); near(result.coverage, 1);
  const triangle = integrateSurfaceVolume({ values: [3], width: 1, height: 1, bounds: { minE: 0, minN: 0, maxE: 1, maxN: 1 }, vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] });
  near(triangle.footprintM2, .5); near(triangle.cutM3, 1.5);
});
test('concave polygon and large UTM coordinates keep actual area', () => {
  const vertices = [[0, 0, 0], [3, 0, 0], [3, 1, 0], [1, 1, 0], [1, 3, 0], [0, 3, 0]].map(([x, y, z]) => [x + 600000, y + 4500000, z]);
  near(triangulatePolygon(vertices).reduce((sum, p) => sum + polygonArea(p), 0), 5);
  const result = integrateSurfaceVolume({ values: Array(9).fill(2), width: 3, height: 3, bounds: { minE: 600000, minN: 4500000, maxE: 600003, maxN: 4500003 }, vertices });
  near(result.cutM3, 10); near(result.footprintM2, 5);
});
test('nodata and absent extent yield incomplete nonzero coverage, valid negative elevations remain valid', () => {
  const result = integrateSurfaceVolume({ ...grid, values: [-2000, -9999, NaN, -2000], nodata: -9999, reference: { type: 'custom', elevationM: -2001 } });
  near(result.coverage, .5); near(result.cutM3, 2); assert.equal(result.status, 'incomplete');
  const missing = integrateSurfaceVolume({ ...grid, values: [11], width: 1, height: 1, bounds: { minE: 0, minN: 0, maxE: 1, maxN: 1 } });
  near(missing.coverage, .25); assert.equal(missing.status, 'incomplete');
});
test('windowed accumulation matches a full native read', () => {
  const a = createSurfaceAccumulator(grid);
  a.addGrid({ values: [12, 8], width: 2, height: 1, bounds: { minE: 0, minN: 1, maxE: 2, maxN: 2 } });
  a.addGrid({ values: [11, 9], width: 2, height: 1, bounds: { minE: 0, minN: 0, maxE: 2, maxN: 1 } });
  assert.deepEqual(a.result(), integrateSurfaceVolume({ ...grid, values: [12, 8, 11, 9] }));
});
test('boundary references use boundary values, fitted planes center large coordinates', () => {
  const vertices = [[0, 0, 2], [1, 0, 4], [1, 1, 7], [0, 1, 5]].map(([x, y, z]) => [x + 600000, y + 4500000, z]);
  near(createReference(vertices, { type: 'fitted-plane' }).sample(600000.5, 4500000.5), 4.5);
  near(createReference(vertices, { type: 'lowest-boundary', offsetM: 1 }).sample(0, 0), 3);
  near(createReference(vertices, { type: 'highest-boundary' }).sample(0, 0), 7);
  near(createReference(vertices, { type: 'average-boundary' }).sample(0, 0), 4.5);
});
test('invalid polygons, references and oversized native selections fail closed', () => {
  assert.throws(() => triangulatePolygon([[0, 0], [1, 1], [0, 1], [1, 0]]), /cross/);
  assert.throws(() => createReference([[0, 0], [1, 0], [0, 1]]), /elevations/);
  assert.throws(() => integrateSurfaceVolume({ ...grid, values: [1, 1, 1, 1], maxCells: 3 }), { code: 'measurement_limit' });
  assert.throws(() => createReference(square, { type: 'custom', elevationM: NaN }), /required/);
});

test('interior-cell optimization keeps exact sloping-plane cut and fill at large coordinates', () => {
  const vertices = [[0,0,0],[10,0,10],[10,10,10],[0,10,0]].map(([x,y,z])=>[600000+x,4500000+y,z]);
  const result = integrateSurfaceVolume({vertices,values:new Float64Array(100).fill(4.25),width:10,height:10,bounds:{minE:600000,minN:4500000,maxE:600010,maxN:4500010}});
  near(result.cutM3, 4.25 * 4.25 * 5);
  near(result.fillM3, 5.75 * 5.75 * 5);
  near(result.validAreaM2,100); assert.equal(result.sampleCount,100);
});

test('work limits apply cumulatively across streamed grids independently of cell limits', () => {
  const a=createSurfaceAccumulator({...grid,maxCells:100,maxWork:7});
  a.addGrid({values:[12,12],width:2,height:1,bounds:{minE:0,minN:1,maxE:2,maxN:2}});
  assert.throws(()=>a.addGrid({values:[12,12],width:2,height:1,bounds:{minE:0,minN:0,maxE:2,maxN:1}}),{code:'measurement_limit'});
  const result=integrateSurfaceVolume({...grid,values:[12,12,12,12],maxWork:8});
  near(result.cutM3,8);
});

const inventory=result=>estimateMeasurementInventory({results:result,materialDensity:{value:1000,unit:'kg/m3',basis:'as_fed'}});
test('owned staging fractional DSM fixture certifies full coverage without changing cut',()=>{
  const vertices=[[500001.05875944503,4800001.574141548,0],[500001.058759551,4800000.897280903,0],[500001.6701048866,4800000.897281026,0],[500001.67010471947,4800001.574141671,0]];
  const result=integrateSurfaceVolume({vertices,reference:{type:'custom',elevationM:100.125},values:Array(9).fill(101.125),width:3,height:3,bounds:{minE:500000,minN:4800000,maxE:500003,maxN:4800003}});
  assert.equal(result.coverage,1);assert.equal(result.status,'complete');
  near(result.cutM3,0.41379557771655207);
  assert.ok(result.coverageEvidence.rawCoverage<1);assert.ok(inventory(result));
});
test('fully partitioned fractional UTM grid normalizes roundoff without changing integrated volume',()=>{
  const x=600000.12345,y=4900000.23456,s=.1124;
  const result=integrateSurfaceVolume({vertices:[[x,y,0],[x+s,y,0],[x+s,y+s,0],[x,y+s,0]],reference:{type:'custom',elevationM:0},values:Array(9).fill(1),width:3,height:3,bounds:{minE:x,minN:y,maxE:x+s,maxN:y+s}});
  assert.equal(result.status,'complete');assert.equal(result.coverage,1);assert.equal(result.missingAreaM2,0);
  assert.ok(result.coverageEvidence.rawCoverage<1);assert.equal(result.coverageEvidence.gridPartitionCoversFootprint,true);
  assert.equal(result.cutM3,result.validAreaM2);assert.ok(inventory(result));
  assert.equal(inventory({...result,coverage:result.coverageEvidence.rawCoverage}),null,'legacy near-one coverage is not accepted by the density consumer');
});
test('tiny intersecting NoData slivers remain unavailable below the integration area threshold',()=>{
  const result=integrateSurfaceVolume({vertices:[[0,0,0],[1+5e-11,0,0],[1+5e-11,1,0],[0,1,0]],reference:{type:'custom',elevationM:0},values:[1,NaN],width:2,height:1,bounds:{minE:0,minN:0,maxE:2,maxN:1}});
  assert.ok(result.coverage>=1-1e-8);assert.equal(result.coverageEvidence.invalidSurfaceIntersection,true);
  assert.equal(result.status,'incomplete');assert.equal(inventory(result),null);
});
test('tiny outside-source strips never become a complete surface through numeric tolerance',()=>{
  const result=integrateSurfaceVolume({vertices:[[0,0,0],[1+5e-11,0,0],[1+5e-11,1,0],[0,1,0]],reference:{type:'custom',elevationM:0},values:[1],width:1,height:1,bounds:{minE:0,minN:0,maxE:1,maxN:1}});
  assert.ok(result.coverage>=1-1e-8);assert.equal(result.coverageEvidence.gridPartitionCoversFootprint,false);
  assert.equal(result.status,'incomplete');assert.equal(inventory(result),null);
});
test('tiny window gaps and overlaps refuse completeness independently of summed area',()=>{
  for(const start of [.5-5e-11,.5+5e-11]){
    const accumulator=createSurfaceAccumulator({vertices:[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],reference:{type:'custom',elevationM:0}});
    accumulator.addGrid({values:[1],width:1,height:1,bounds:{minE:0,minN:0,maxE:.5,maxN:1}});
    accumulator.addGrid({values:[1],width:1,height:1,bounds:{minE:start,minN:0,maxE:1,maxN:1}});
    const result=accumulator.result();assert.equal(result.coverageEvidence.gridPartitionCoversFootprint,false);assert.equal(result.status,'incomplete');assert.equal(inventory(result),null);
  }
});
test('NoData outside the footprint does not invalidate an otherwise complete grid',()=>{
  const result=integrateSurfaceVolume({vertices:[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],reference:{type:'custom',elevationM:0},values:[1,NaN],width:2,height:1,bounds:{minE:0,minN:0,maxE:2,maxN:1}});
  assert.equal(result.coverageEvidence.invalidSurfaceIntersection,false);assert.equal(result.status,'complete');assert.ok(inventory(result));
});
test('empty point-style grid cells refuse complete inventory even at full source extent',()=>{
  const result=integrateSurfaceVolume({...grid,values:[1,1,NaN,1],reference:{type:'custom',elevationM:0}});
  assert.equal(result.coverageEvidence.gridPartitionCoversFootprint,true);assert.equal(result.status,'incomplete');assert.equal(inventory(result),null);
});
test('completeness certification is bounded and refuses excessive window fragmentation',()=>{
  const accumulator=createSurfaceAccumulator({vertices:[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],reference:{type:'custom',elevationM:0}});
  for(let i=0;i<4097;i++)accumulator.addGrid({values:[1],width:1,height:1,bounds:{minE:i/4097,minN:0,maxE:(i+1)/4097,maxN:1}});
  const result=accumulator.result();assert.equal(result.coverageEvidence.gridPartitionCoversFootprint,false);assert.equal(result.status,'incomplete');assert.equal(inventory(result),null);
});
