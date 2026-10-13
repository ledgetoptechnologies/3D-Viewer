import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fromArrayBuffer } from 'geotiff';
import { nativeTiffFixture } from './helpers/native-tiff-fixture.mjs';
import { nativeRasterDefinition, preflightNativeRaster, calculateNativeRaster } from '../server/measurementRasterCalculation.mjs';
import { inspectProcessingRasterUnits } from '../server/processingRasterUnitInspection.mjs';

function unreferencedFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-no-geokeys-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bytes = nativeTiffFixture();
  // Remove only the GeoKeyDirectory tag from an otherwise readable TIFF.
  // Keep the pixel layout and transform intact; neither establishes its CRS.
  const ifd = bytes.readUInt32LE(4), count = bytes.readUInt16LE(ifd);
  let removed = false;
  for (let index = 0; index < count; index++) {
    const offset = ifd + 2 + index * 12;
    if (bytes.readUInt16LE(offset) === 34735) {
      bytes.writeUInt16LE(65000, offset);
      removed = true;
    }
  }
  assert.equal(removed, true);
  const file = path.join(directory, 'unreferenced-dsm.tif');
  fs.writeFileSync(file, bytes);
  const source = { id: 'unreferenced', kind: 'dsm', byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  const request = { modelVersionId: 'v', source, coordinateReference: { crs: 'EPSG:32616' }, sourceVerticalUnit: 'm', vertices: [[0,0,0],[2,0,0],[2,2,0],[0,2,0]], reference: { type: 'custom', elevationM: 0 } };
  return { bytes, file, source, request };
}

test('missing GeoKeys reject native calculations with the CRS diagnostic, not TypeError', () => {
  for (const keys of [null, undefined, {}]) {
    const image = { getGeoKeys: () => keys, fileDirectory: {} };
    const request = { coordinateReference: { crs: 'EPSG:32616' }, sourceVerticalUnit: 'm' };
    assert.throws(() => nativeRasterDefinition(image, request), { code: 'measurement_source_crs_mismatch' });
  }
});

test('a genuine TIFF without GeoKeys cannot acquire CRS or metre evidence from its transform', async t => {
  const f = unreferencedFixture(t);
  const tiff = await fromArrayBuffer(f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength));
  try {
    const image = await tiff.getImage(0);
    assert.equal(image.getGeoKeys(), null);
    assert.deepEqual(image.getOrigin(), [0, 2, 0]);
  } finally { await tiff.close(); }
  assert.equal(await inspectProcessingRasterUnits(f.file, f.source), null);
  await assert.rejects(preflightNativeRaster(f.file, f.request), { code: 'measurement_source_crs_mismatch' });
  await assert.rejects(calculateNativeRaster(f.file, f.request), { code: 'measurement_source_crs_mismatch' });
});

test('missing GeoKeys do not bypass source-integrity or cancellation checks', async t => {
  const f = unreferencedFixture(t);
  await assert.rejects(inspectProcessingRasterUnits(f.file, { ...f.source, sha256: '0'.repeat(64) }), { code: 'source_changed' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectProcessingRasterUnits(f.file, f.source, { signal: controller.signal }), { name: 'AbortError' });
});
