'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePhotoCaptureMetadata, MAX_HEADER_BYTES } = require('../server/photoCaptureMetadata');
const { jpegMetadata } = require('../server/storageManager');

function app1(payload) {
  const header = Buffer.from([255, 225, 0, 0]); header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}
function xmp(body, namespace = 'http://www.dji.com/drone-dji/1.0/') {
  return app1(Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:d="${namespace}">${body}</x:xmpmeta>`));
}
function jpeg(...parts) { return Buffer.concat([Buffer.from([255, 216]), ...parts, Buffer.from([255, 217])]); }
function cameraExif(little) {
  const tiff = Buffer.alloc(56), u16 = (n, at) => little ? tiff.writeUInt16LE(n, at) : tiff.writeUInt16BE(n, at);
  const u32 = (n, at) => little ? tiff.writeUInt32LE(n, at) : tiff.writeUInt32BE(n, at);
  tiff.write(little ? 'II' : 'MM'); u16(42, 2); u32(8, 4); u16(2, 8);
  for (const [at, tag, size, value] of [[10, 0x010f, 4, null], [22, 0x0110, 12, 40]]) {
    u16(tag, at); u16(2, at + 2); u32(size, at + 4);
    if (value) u32(value, at + 8); else tiff.write('DJI\0', at + 8);
  }
  tiff.write('Zenmuse P1\0', 40);
  return app1(Buffer.concat([Buffer.from('Exif\0\0'), tiff]));
}

test('DJI numeric attributes and elements are retained without promoting datum or accuracy', () => {
  const photo = jpeg(xmp('<rdf:Description d:AbsoluteAltitude="+315.120" d:RelativeAltitude="-1.300" d:RtkFlag="50" d:RtkStdLat="0.014" d:RtkStdLon="0.013"><d:RtkStdHgt>0.023</d:RtkStdHgt></rdf:Description>'));
  const evidence = parsePhotoCaptureMetadata(photo);
  assert.deepEqual(evidence.djiTags, { AbsoluteAltitude: '+315.120', RelativeAltitude: '-1.300', RtkFlag: '50', RtkStdLat: '0.014', RtkStdLon: '0.013', RtkStdHgt: '0.023' });
  assert.equal(evidence.verification, 'unverified'); assert.equal(evidence.verticalDatum, 'unknown');
  assert.equal(evidence.accuracy, 'not-established');
  assert.deepEqual(jpegMetadata(photo).captureEvidence, evidence, 'shared ingestion preserves evidence in per-file metadata');
});

test('both EXIF byte orders preserve make and camera-specific model', () => {
  for (const little of [true, false]) assert.deepEqual(parsePhotoCaptureMetadata(jpeg(cameraExif(little))).camera,
    { make: 'DJI', model: 'Zenmuse P1' });
});

test('contradictory duplicate tags are explicitly conflicted, never silently selected', () => {
  const evidence = parsePhotoCaptureMetadata(jpeg(xmp('<r d:AbsoluteAltitude="310"/>'), xmp('<r d:AbsoluteAltitude="311" d:RtkFlag="16"/>')));
  assert.deepEqual(evidence.conflictingTags, ['AbsoluteAltitude']);
  assert.deepEqual(evidence.djiTags, { RtkFlag: '16' });
});

test('missing, wrong namespace, non-JPEG and out-of-bound data are not RTK evidence', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(MAX_HEADER_BYTES + 1), Buffer.from('x'), jpeg(), jpeg(xmp('<r d:RtkFlag="50"/>', 'https://not-dji.invalid/'))])
    assert.equal(parsePhotoCaptureMetadata(bytes), null);
  const truncated = jpeg(xmp('<r d:RtkFlag="50"/>')).subarray(0, 30);
  assert.equal(parsePhotoCaptureMetadata(truncated), null);
});

test('entities and invalid numeric fields are not evaluated or promoted', () => {
  const entities = parsePhotoCaptureMetadata(jpeg(xmp('<!DOCTYPE x [<!ENTITY evil SYSTEM "file:///private">]><r d:AbsoluteAltitude="&evil;"/>')));
  assert.deepEqual(entities.warnings, ['unsupported-xmp-entities']); assert.equal(entities.djiTags, undefined);
  const invalid = parsePhotoCaptureMetadata(jpeg(xmp('<r d:RtkFlag="Infinity" d:RtkStdHgt="NaN" d:AbsoluteAltitude="1e999"/>')));
  assert.equal(invalid.djiTags, undefined); assert.equal(invalid.warnings.length, 3);
});

test('ordinary GPS photo parsing does not receive new fields or changed coordinates', async () => {
  const { parsePhotoExif } = await import('../server/photoExif.mjs');
  assert.equal(parsePhotoExif(jpeg(xmp('<r d:GpsLatitude="43" d:GpsLongitude="-89"/>'))), null);
  assert.equal(jpegMetadata(Buffer.from('not a JPEG')).captureEvidence, undefined);
});
