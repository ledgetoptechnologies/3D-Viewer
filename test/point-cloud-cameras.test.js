'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CAMERA_MARKER_COLORS,
  cameraMarkerGeometryData,
  cameraMarkerLocalFrame,
  createCameraClickTracker,
  normalizeCameraMarkers,
} = require('../public/pointcloud-cameras.js');

test('point-cloud cameras use the same two-tone forward marker as the model', async () => {
  const model = await import('../camera-markers.mjs');
  assert.deepEqual(CAMERA_MARKER_COLORS, model.CAMERA_MARKER_COLORS);
  assert.deepEqual(cameraMarkerGeometryData(), model.cameraMarkerGeometryData());
});

test('point-cloud camera payload accepts only bounded finite poses', () => {
  const valid = { translation: [367000, 4760000, 220], rotation: [0.1, -0.2, 0.3] };
  assert.deepEqual(normalizeCameraMarkers([valid]), [valid]);
  assert.deepEqual(normalizeCameraMarkers([
    valid,
    { translation: [1, 2], rotation: [0, 0, 0] },
    { translation: [1, 2, Infinity], rotation: [0, 0, 0] },
    { translation: [1, 2, 3], rotation: [0, Number.NaN, 0] },
  ]), [valid]);
  assert.deepEqual(normalizeCameraMarkers(new Array(100_001).fill(valid)), [], 'oversized cross-frame payloads fail closed');
});

test('large projected camera positions are rebased before Float32 instance matrices', () => {
  const markers = [
    { translation: [367000.125, 4760000.25, 220.5], rotation: [0, 0, 0] },
    { translation: [367001.375, 4760002.5, 221.25], rotation: [0.1, 0.2, 0.3] },
  ];
  const frame = cameraMarkerLocalFrame(markers);
  assert.deepEqual(frame.origin, markers[0].translation);
  assert.deepEqual(frame.markers.map(marker => marker.translation), [[0, 0, 0], [1.25, 2.25, 0.75]]);
  assert.deepEqual(markers[0].translation, [367000.125, 4760000.25, 220.5], 'input payload remains immutable');
});

test('camera click tracker accepts one tap and rejects drags, pinches, and cancellations', () => {
  const tracker = createCameraClickTracker({ threshold: 5 });
  tracker.pointerDown({ pointerId: 1, button: 0, clientX: 10, clientY: 20 });
  assert.deepEqual(tracker.pointerUp({ pointerId: 1, button: 0, clientX: 12, clientY: 22 }), { x: 12, y: 22 });

  tracker.pointerDown({ pointerId: 2, button: 0, clientX: 10, clientY: 20 });
  tracker.pointerMove({ pointerId: 2, clientX: 16, clientY: 20 });
  assert.equal(tracker.pointerUp({ pointerId: 2, button: 0, clientX: 16, clientY: 20 }), null);

  tracker.pointerDown({ pointerId: 3, button: 0, clientX: 10, clientY: 20 });
  tracker.pointerDown({ pointerId: 4, button: 0, clientX: 30, clientY: 40 });
  assert.equal(tracker.pointerUp({ pointerId: 4, button: 0, clientX: 30, clientY: 40 }), null);
  assert.equal(tracker.pointerUp({ pointerId: 3, button: 0, clientX: 10, clientY: 20 }), null);

  tracker.pointerDown({ pointerId: 5, button: 0, clientX: 10, clientY: 20 });
  tracker.pointerCancel({ pointerId: 5 });
  assert.equal(tracker.pointerUp({ pointerId: 5, button: 0, clientX: 10, clientY: 20 }), null);
});
