import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCameraFeatureCollection, normalizeCameraPhotoKey } from '../camera-runtime.mjs';

test('WebODM camera features accept translation or geometry coordinates and skip malformed shots independently', () => {
  const converted = [];
  const features = normalizeCameraFeatureCollection({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { filename: 'DJI_0001.JPG', translation: [500001, 4900001, 212], rotation: [0.1, 0.2, 0.3] }, geometry: null },
      { type: 'Feature', properties: { filename: 'images/DJI_0002.JPG' }, geometry: { type: 'Point', coordinates: [-87.2, 44.1, 215] } },
      { type: 'Feature', properties: { filename: 'missing.JPG', rotation: ['bad', 0, 0] }, geometry: { type: 'Point', coordinates: [500003, 4900003, 217] } },
      { type: 'Feature', properties: { filename: 'broken.JPG' }, geometry: { type: 'Point', coordinates: [null, 44, 200] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
      null,
    ],
  }, {
    latLonToProjected: (lat, lon) => { converted.push([lat, lon]); return [500002, 4900002]; },
  });

  assert.equal(features.length, 3);
  assert.deepEqual(features[0].properties.translation, [500001, 4900001, 212]);
  assert.deepEqual(features[0].properties.rotation, [0.1, 0.2, 0.3]);
  assert.deepEqual(features[1].properties.translation, [500002, 4900002, 215]);
  assert.equal(features[1].properties.photoKey, 'images/DJI_0002.JPG');
  assert.deepEqual(features[2].properties.translation, [500003, 4900003, 217]);
  assert.deepEqual(features[2].properties.rotation, [0, 0, 0]);
  assert.deepEqual(converted, [[44.1, -87.2]]);
});

test('camera photo keys allow exact nested JPEG paths without allowing traversal', () => {
  assert.equal(normalizeCameraPhotoKey('images/originals/DJI_0001.jpeg'), 'images/originals/DJI_0001.jpeg');
  for (const value of ['../DJI.JPG', 'images/../DJI.JPG', '/images/DJI.JPG', 'images\\DJI.JPG', 'images//DJI.JPG', 'DJI.png']) {
    assert.equal(normalizeCameraPhotoKey(value), null, value);
  }
});
