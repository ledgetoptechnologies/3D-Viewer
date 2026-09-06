import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeArrayBuffer } from 'geotiff';
import { calculateNativeRaster, nativeRasterDefinition } from '../server/measurementRasterCalculation.mjs';
function image(overrides = {}) {
  return { getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616, ProjLinearUnitsGeoKey: 9001, VerticalUnitsGeoKey: 9001 }), fileDirectory: { BitsPerSample: [32], RowsPerStrip: 2 }, getOrigin: () => [0, 2], getResolution: () => [1, -1], getWidth: () => 2, getHeight: () => 2, ...overrides };
}
test('native source validation rejects CRS, units, point pixels, rotation and oversized codec blocks', () => {
  const request = { coordinateReference: { crs: 'EPSG:32616' } };
  assert.equal(nativeRasterDefinition(image(), request).dx, 1);
  assert.throws(() => nativeRasterDefinition(image(), { coordinateReference: { crs: 'EPSG:32617' } }), { code: 'measurement_source_crs_mismatch' });
  assert.throws(() => nativeRasterDefinition(image({ getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616, VerticalUnitsGeoKey: 9002 }) }), request), { code: 'measurement_source_vertical_units_unsupported' });
  assert.throws(() => nativeRasterDefinition(image({ getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616, GTRasterTypeGeoKey: 2 }) }), request), { code: 'measurement_pixel_is_point_unsupported' });
  assert.throws(() => nativeRasterDefinition(image({ getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616 }) }), request), { code: 'measurement_source_vertical_units_required' });
  assert.throws(() => nativeRasterDefinition(image({ getWidth: () => 20_000_000 }), request), { code: 'measurement_raster_block_too_large' });
});
test('actual GeoTIFF native windows preserve zero and fractional pixels, source hashes and caps', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-native-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'dsm.tif');
  const bytes = Buffer.from(writeArrayBuffer([0, 2, 4, 6], { width: 2, height: 2, ModelPixelScale: [1,1,0], ModelTiepoint: [0,0,0,0,2,0], ProjectedCSTypeGeoKey: 32616, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1 })); fs.writeFileSync(file, bytes);
  const request = { modelVersionId: 'v1', coordinateReference: { crs: 'EPSG:32616' }, sourceVerticalUnit: 'm', source: { id: 'a', kind: 'dsm', byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, vertices: [[0,0,0],[2,0,0],[2,2,0],[0,2,0]], reference: { type: 'custom', elevationM: 0 } };
  const result = await calculateNativeRaster(file, request, { windowSize: 1 });
  assert.equal(result.cutM3, 12); assert.equal(result.coverage, 1); assert.equal(result.sampleCount, 4); assert.equal(result.source.verticalUnitBasis, 'administrator-declared');
  await assert.rejects(calculateNativeRaster(file, request, { maxCells: 3 }), { code: 'measurement_limit' });
  await assert.rejects(calculateNativeRaster(file, { ...request, source: { ...request.source, sha256: '0'.repeat(64) } }), { code: 'measurement_source_changed' });
  const map={...request,collection:'map',vertices:[[.25,.25,0],[1.75,.25,0],[1.75,1.75,0],[.25,1.75,0]],reference:{type:'boundary-triangulated'}};
  const sampled=await calculateNativeRaster(file,map);assert.ok(Math.abs(sampled.netM3)<1e-9);assert.ok(sampled.preview.samples.some(p=>p[3]>0));
  await assert.rejects(calculateNativeRaster(file,{...map,vertices:request.vertices}),{code:'measurement_boundary_elevation_unavailable'});
  const triangle=await calculateNativeRaster(file,{...request,vertices:[[0,0,0],[2,0,0],[0,2,0]]});
  assert.ok(triangle.preview.samples.every(([e,n])=>e+n<=2));
});
