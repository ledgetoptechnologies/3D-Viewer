import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCameraFeatureCollection, normalizeCameraPhotoKey } from '../camera-runtime.mjs';
import {
  CAMERA_MARKER_COLORS,
  CAMERA_MARKER_OPACITY,
  CAMERA_MARKER_STYLE,
  DEFAULT_CAMERA_MARKER_SCALE,
  cameraMarkerGeometryData,
  cameraMarkerScaleForView,
  selectCameraMarkerRepresentatives,
} from '../camera-markers.mjs';

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

test('camera markers use an independent WebODM-like orange white and yellow frustum', () => {
  const geometry = cameraMarkerGeometryData();
  const bounds = (positions) => {
    const axes = [[], [], []];
    positions.forEach((value, index) => axes[index % 3].push(value));
    return axes.map((axis) => ({ min: Math.min(...axis), max: Math.max(...axis) }));
  };
  for (const key of ['orange', 'white', 'yellow']) {
    assert.ok(geometry[key].length >= 36 && geometry[key].length % 9 === 0, `${key} primitive is triangulated`);
  }
  assert.equal(geometry.body, undefined, 'the prior solid camera housing is removed');
  assert.equal(geometry.lens, undefined, 'the prior cylinder lens is removed');
  const [orangeX, orangeY, orangeZ] = bounds(geometry.orange);
  const [whiteX, whiteY, whiteZ] = bounds(geometry.white);
  const [yellowX, yellowY, yellowZ] = bounds(geometry.yellow);
  assert.ok(orangeZ.min < 0 && orangeZ.max >= 0, 'orange rear housing contains the camera position');
  assert.ok(whiteZ.min <= orangeZ.max && whiteZ.max > orangeZ.max, 'white frustum bridges housing to lens');
  assert.ok(yellowZ.max > whiteZ.min, 'yellow forward primitive makes view direction legible');
  assert.ok(yellowX.min > whiteX.min && yellowX.max < whiteX.max);
  assert.ok(yellowY.min > whiteY.min && yellowY.max < whiteY.max);
  assert.equal(CAMERA_MARKER_COLORS.orange, 0xEE5007);
  assert.equal(CAMERA_MARKER_COLORS.white, 0xFFFFFF);
  assert.equal(CAMERA_MARKER_COLORS.yellow, 0xFFA200);
  assert.deepEqual(CAMERA_MARKER_OPACITY, { normal: 0.7, hover: 1 });
  assert.equal(DEFAULT_CAMERA_MARKER_SCALE, 0.5);
  const allX = { min: Math.min(orangeX.min, whiteX.min, yellowX.min), max: Math.max(orangeX.max, whiteX.max, yellowX.max) };
  const allY = { min: Math.min(orangeY.min, whiteY.min, yellowY.min), max: Math.max(orangeY.max, whiteY.max, yellowY.max) };
  const allZ = { min: Math.min(orangeZ.min, whiteZ.min, yellowZ.min), max: Math.max(orangeZ.max, whiteZ.max, yellowZ.max) };
  const markerDiameter = Math.hypot(
    allX.max - allX.min,
    allY.max - allY.min,
    allZ.max - allZ.min,
  );
  assert.deepEqual(CAMERA_MARKER_STYLE, {
    width: markerDiameter,
    maxPixels: 10,
    cellPixels: 18,
    maxVisible: 4000,
    pickRadius: 12,
  });
});

test('camera marker scale remains fixed in world space across zoom and depth', () => {
  const requested = 0.7;
  const views = [
    { depth: 0.1, fovDegrees: 60, zoom: 10, viewportHeight: 900 },
    { depth: 3, fovDegrees: 35, zoom: 2, viewportHeight: 1440 },
    { depth: 200, fovDegrees: 90, zoom: 0.1, viewportHeight: 480 },
  ];
  for (const view of views) {
    assert.equal(cameraMarkerScaleForView({ baseScale: requested, ...view }), requested);
  }
  assert.equal(cameraMarkerScaleForView({ baseScale: 0.01, depth: 10, fovDegrees: 60, zoom: 1, viewportHeight: 900 }), 0.1);
  assert.equal(cameraMarkerScaleForView({ baseScale: 10, depth: 10, fovDegrees: 60, zoom: 1, viewportHeight: 900 }), 4);
});

test('dense camera projections keep the nearest stable representative in each screen cell', () => {
  const candidates = [
    { index: 0, x: 5, y: 5, depth: 20 },
    { index: 1, x: 7, y: 7, depth: 10 },
    { index: 2, x: 25, y: 5, depth: 30 },
    { index: 3, x: 95, y: 95, depth: 5 },
    { index: 4, x: -20, y: 20, depth: 2 },
    { index: 5, x: 50, y: 50, depth: -1 },
    { index: 6, x: Number.NaN, y: 10, depth: 1 },
  ];
  assert.deepEqual(selectCameraMarkerRepresentatives(candidates, { width: 100, height: 100 }), [1, 2, 3]);
  assert.deepEqual(
    selectCameraMarkerRepresentatives(candidates, { width: 100, height: 100, maxVisible: 2 }),
    [1, 3],
    'the nearest representatives survive the global cap while output remains source-index stable',
  );
  assert.deepEqual(selectCameraMarkerRepresentatives(candidates, { width: 0, height: 100 }), []);
});
