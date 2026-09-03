import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraFeatureImageUpBearing, cameraFeatureMapPosition, normalizeCameraFeatureCollection, normalizeCameraPhotoKey } from '../camera-runtime.mjs';
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

test('camera markers use a shared WebODM-inspired body, front cue, and LTDS image-up tab', () => {
  const geometry = cameraMarkerGeometryData();
  const bounds = (positions) => {
    const axes = [[], [], []];
    positions.forEach((value, index) => axes[index % 3].push(value));
    return axes.map((axis) => ({ min: Math.min(...axis), max: Math.max(...axis) }));
  };
  for (const key of ['body', 'face', 'cue', 'tab']) {
    assert.ok(geometry[key].length >= 18 && geometry[key].length % 9 === 0, `${key} primitive is triangulated`);
  }
  const [bodyX, bodyY, bodyZ] = bounds(geometry.body);
  const [faceX, faceY, faceZ] = bounds(geometry.face);
  const [cueX, cueY, cueZ] = bounds(geometry.cue);
  const [tabX, tabY, tabZ] = bounds(geometry.tab);
  assert.ok(bodyZ.min < 0 && bodyZ.max > 0, 'shallow body contains the camera position');
  assert.ok(faceZ.min > bodyZ.max, 'light face marks local +Z/front');
  assert.ok(cueZ.min > faceZ.max, 'amber samples sit visibly in front of the face');
  assert.ok(cueX.min > faceX.min && cueX.max < faceX.max);
  assert.ok(cueY.min > faceY.min && cueY.max < faceY.max);
  assert.ok(tabY.max > bodyY.max && tabY.min >= faceY.max, 'orange tab protrudes along local +Y/image-up');
  assert.ok(tabX.min > bodyX.min && tabX.max < bodyX.max);
  assert.ok(tabZ.min >= bodyZ.min && tabZ.max <= faceZ.max);
  assert.deepEqual(CAMERA_MARKER_COLORS, { body: 0x6F7782, face: 0xD8DEE6, cue: 0xF8CB2E, tab: 0xEE5007 });
  assert.deepEqual(CAMERA_MARKER_OPACITY, { normal: 0.82, hover: 1 });
  assert.equal(DEFAULT_CAMERA_MARKER_SCALE, 0.5);
  const componentBounds = [geometry.body, geometry.face, geometry.cue, geometry.tab].map(bounds);
  const allX = { min: Math.min(...componentBounds.map(value => value[0].min)), max: Math.max(...componentBounds.map(value => value[0].max)) };
  const allY = { min: Math.min(...componentBounds.map(value => value[1].min)), max: Math.max(...componentBounds.map(value => value[1].max)) };
  const allZ = { min: Math.min(...componentBounds.map(value => value[2].min)), max: Math.max(...componentBounds.map(value => value[2].max)) };
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

test('orthophoto camera placement prefers geographic geometry and otherwise uses the active projection', () => {
  const geographic = { geometry: { type: 'Point', coordinates: [-88.25, 43.1, 220] }, properties: { translation: [500000, 4800000, 220], rotation: [0, 0, 0] } };
  assert.deepEqual(cameraFeatureMapPosition(geographic, { projectedToLatLon: () => [1, 2] }), [43.1, -88.25]);
  const projected = { geometry: { type: 'Point', coordinates: [500000, 4800000, 220] }, properties: { translation: [500000, 4800000, 220], rotation: [0, 0, Math.PI / 2] } };
  assert.deepEqual(cameraFeatureMapPosition(projected, { projectedToLatLon: (e, n) => [n / 100000, e / 100000] }), [48, 5]);
  assert.equal(cameraFeatureMapPosition({ properties: {} }, { projectedToLatLon: () => [0, 0] }), null);
  assert.equal(cameraFeatureImageUpBearing(geographic), 0);
  assert.ok(Math.abs(cameraFeatureImageUpBearing(projected) - 90) < 1e-9, 'map tab follows the same inverse angle-axis transform as 3D');
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
