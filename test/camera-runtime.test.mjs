import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCameraFeatureCollection, normalizeCameraPhotoKey } from '../camera-runtime.mjs';
import {
  CAMERA_MARKER_COLORS,
  CAMERA_MARKER_OPACITY,
  CAMERA_MARKER_STYLE,
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

test('camera markers use a compact WebODM-style body and forward lens', () => {
  const geometry = cameraMarkerGeometryData();
  const bounds = (positions) => {
    const axes = [[], [], []];
    positions.forEach((value, index) => axes[index % 3].push(value));
    return axes.map((axis) => ({ min: Math.min(...axis), max: Math.max(...axis) }));
  };
  assert.ok(geometry.body.length >= 36 && geometry.body.length % 9 === 0);
  assert.ok(geometry.lens.length >= 36 && geometry.lens.length % 9 === 0);
  assert.equal(geometry.direction, undefined, 'the long filled direction spear is removed');
  const [bodyX, bodyY, bodyZ] = bounds(geometry.body);
  const [lensX, lensY, lensZ] = bounds(geometry.lens);
  const bodyWidth = bodyX.max - bodyX.min;
  const bodyHeight = bodyY.max - bodyY.min;
  assert.ok(bodyWidth > bodyHeight, 'camera body keeps a recognizable landscape silhouette');
  assert.ok(bodyZ.min < 0 && bodyZ.max > 0, 'camera position remains inside the compact body');
  assert.ok(lensZ.min >= bodyZ.max - 1e-9, 'lens begins at the front face');
  assert.ok(lensZ.max - bodyZ.max <= bodyWidth * 0.25, 'lens stays compact instead of becoming a direction wedge');
  assert.ok(lensX.min > bodyX.min && lensX.max < bodyX.max);
  assert.ok(lensY.min > bodyY.min && lensY.max < bodyY.max);
  assert.equal(CAMERA_MARKER_COLORS.body, 0xEE5007);
  assert.equal(CAMERA_MARKER_COLORS.lens, 0xF8CB2E);
  assert.equal(CAMERA_MARKER_COLORS.bodyHover, 0xF8CB2E);
  assert.equal(CAMERA_MARKER_COLORS.lensHover, 0xFFFFFF);
  assert.deepEqual(CAMERA_MARKER_OPACITY, { body: 0.62, lens: 0.72 });
  const markerDiameter = Math.hypot(
    Math.max(bodyX.max, lensX.max) - Math.min(bodyX.min, lensX.min),
    Math.max(bodyY.max, lensY.max) - Math.min(bodyY.min, lensY.min),
    Math.max(bodyZ.max, lensZ.max) - Math.min(bodyZ.min, lensZ.min),
  );
  assert.deepEqual(CAMERA_MARKER_STYLE, {
    width: markerDiameter,
    maxPixels: 10,
    cellPixels: 18,
    maxVisible: 4000,
    pickRadius: 12,
  });
});

test('camera marker scale only shrinks glyphs that would exceed the projected size ceiling', () => {
  const projectionPixels = ({ scale, depth, zoom = 1 }) => (
    CAMERA_MARKER_STYLE.width * scale * 900 * zoom
      / (2 * depth * Math.tan(60 * Math.PI / 360))
  );
  const near = cameraMarkerScaleForView({ baseScale: 1, depth: 3, fovDegrees: 60, zoom: 1, viewportHeight: 900 });
  const nearZoomed = cameraMarkerScaleForView({ baseScale: 1, depth: 3, fovDegrees: 60, zoom: 2, viewportHeight: 900 });
  const nearPlane = cameraMarkerScaleForView({ baseScale: 1, depth: 0.1, fovDegrees: 60, zoom: 1, viewportHeight: 900 });
  const far = cameraMarkerScaleForView({ baseScale: 1, depth: 200, fovDegrees: 60, zoom: 1, viewportHeight: 900 });
  assert.ok(near > 0 && near < 1);
  assert.ok(projectionPixels({ scale: near, depth: 3 }) <= CAMERA_MARKER_STYLE.maxPixels + 1e-9);
  assert.ok(nearZoomed < near, 'camera zoom tightens the projected-size cap');
  assert.ok(projectionPixels({ scale: nearZoomed, depth: 3, zoom: 2 }) <= CAMERA_MARKER_STYLE.maxPixels + 1e-9);
  assert.ok(nearPlane > 0);
  assert.ok(projectionPixels({ scale: nearPlane, depth: 0.1 }) <= CAMERA_MARKER_STYLE.maxPixels + 1e-9, 'near-plane glyphs remain pixel-bounded');
  assert.equal(far, 1, 'distant markers retain the user-selected scale instead of becoming constant-size clutter');
  assert.equal(cameraMarkerScaleForView({ baseScale: 0.5, depth: -1, fovDegrees: 60, viewportHeight: 900 }), 0.5);
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
