'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  CAMERA_MARKER_COLORS,
  CAMERA_MARKER_OPACITY,
  CAMERA_MARKER_STYLE,
  DEFAULT_CAMERA_MARKER_SCALE,
  cameraMarkerGeometryData,
  cameraMarkerLocalFrame,
  cameraMarkerScaleForView,
  selectCameraMarkerRepresentatives,
  createCameraClickTracker,
  createPointCloudCameraLayer,
  normalizeCameraMarkers,
} = require('../public/pointcloud-cameras.js');

test('point-cloud cameras use the same compact WebODM-style marker as the model', async () => {
  const model = await import('../camera-markers.mjs');
  assert.deepEqual(CAMERA_MARKER_COLORS, model.CAMERA_MARKER_COLORS);
  assert.deepEqual(CAMERA_MARKER_OPACITY, model.CAMERA_MARKER_OPACITY);
  assert.deepEqual(CAMERA_MARKER_STYLE, model.CAMERA_MARKER_STYLE);
  assert.equal(DEFAULT_CAMERA_MARKER_SCALE, model.DEFAULT_CAMERA_MARKER_SCALE);
  assert.deepEqual(cameraMarkerGeometryData(), model.cameraMarkerGeometryData());
  assert.equal(
    cameraMarkerScaleForView({ baseScale: 1, depth: 3, fovDegrees: 60, viewportHeight: 900 }),
    model.cameraMarkerScaleForView({ baseScale: 1, depth: 3, fovDegrees: 60, viewportHeight: 900 }),
  );
  assert.equal(cameraMarkerScaleForView(), 0.5);
  assert.deepEqual(
    selectCameraMarkerRepresentatives([{ index: 3, x: 10, y: 10, depth: 2 }], { width: 100, height: 100 }),
    model.selectCameraMarkerRepresentatives([{ index: 3, x: 10, y: 10, depth: 2 }], { width: 100, height: 100 }),
  );
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

test('Potree r124 allocates all WebODM-like instance-color buffers before the active draw count becomes zero', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'pointcloud-cameras.js'), 'utf8');
  const allocations = ['orange', 'white', 'yellow'].map((name) => source.indexOf(`${name}Mesh.setColorAt(0, new THREE.Color(CAMERA_MARKER_COLORS.${name}))`));
  const zeroCount = source.indexOf('orangeMesh.count = 0');
  assert.ok(allocations.every((index) => index >= 0), 'all three full-capacity instance-color buffers are initialized');
  assert.ok(allocations.every((index) => index < zeroCount), 'legacy Three allocates from mesh.count, so colors must precede count=0');
});

test('point-cloud hover follows source indices when representative draw slots change', async () => {
  const THREE = await import('three');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 0);
  camera.lookAt(0, 0, -1);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const dom = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const layer = createPointCloudCameraLayer({ THREE, scene, dom, getCamera: () => camera });
  layer.setMarkers([
    { translation: [0, 0, -2], rotation: [0, 0, 0] },
    { translation: [0.01, 0, -1], rotation: [0, 0, 0] },
    { translation: [0.8, 0, -2], rotation: [0, 0, 0] },
  ]);
  layer.setVisible(true);
  const [orange] = layer.group.children;
  for (const mesh of layer.group.children) {
    assert.equal(mesh.material.depthTest, false, 'Potree overlay markers must not be hidden by point-cloud depth');
    assert.equal(mesh.material.depthWrite, false);
  }
  const normal = orange.getColorAt(0, new THREE.Color()).toArray();
  assert.equal(layer.setHovered(1), true);
  const highlighted = orange.getColorAt(0, new THREE.Color()).toArray();
  assert.notDeepEqual(highlighted, normal);

  camera.position.set(0, 0, -3);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  layer.updateView(true);
  const replacement = orange.getColorAt(0, new THREE.Color()).toArray();
  replacement.forEach((component, index) => assert.ok(Math.abs(component - normal[index]) < 1e-9));
  assert.equal(layer.setHovered(0), true);
  assert.notDeepEqual(orange.getColorAt(0, new THREE.Color()).toArray(), normal);
  layer.dispose();
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
