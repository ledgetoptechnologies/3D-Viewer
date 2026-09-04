import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import * as THREE from 'three';

const require = createRequire(import.meta.url);
const navigation = require('../public/pointcloud-navigation.js');
const shell = fs.readFileSync(new URL('../public/pointcloud.html', import.meta.url), 'utf8');
const start = shell.indexOf('class PCPointerControls {');
const end = shell.indexOf('// Replace Potree\'s EarthControls', start);
assert.ok(start >= 0 && end > start);
// Exercise the shipped controller methods, rather than a second implementation.
const Controls = vm.runInNewContext(`${shell.slice(start, end)}\nPCPointerControls`, {
  THREE, ...navigation, performance, window: {},
});

function fixture(position = new THREE.Vector3(0, -200, 150), origin = new THREE.Vector3()) {
  position = position.clone().add(origin);
  const target = origin.clone();
  const direction = target.clone().sub(position).normalize();
  const view = {
    position: position.clone(), radius: position.distanceTo(target),
    getPivot() { return this.position.clone().addScaledVector(direction, this.radius); },
    lookAt(point) { this.radius = point.distanceTo(this.position); direction.copy(point).sub(this.position).normalize(); },
  };
  const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100000);
  camera.up.set(0, 0, 1);
  const controls = Object.create(Controls.prototype);
  controls.view = view;
  controls.enabled = true;
  controls.pivot = target.clone();
  controls._inertia = { active: false, yaw: 0, pitch: 0 };
  controls._panPlane = new THREE.Plane();
  controls._panStart = new THREE.Vector3();
  controls._showPivot = () => {};
  controls.dom = {
    clientHeight: 1000, clientWidth: 1000,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 1000 }),
    setPointerCapture() {}, focus() {},
  };
  controls._cam = () => {
    camera.position.copy(view.position);
    camera.lookAt(view.getPivot());
    camera.updateMatrixWorld(true);
    return camera;
  };
  controls._pointPick = () => null;
  const bounds = new THREE.Box3(new THREE.Vector3(-50, -50, -10).add(origin), new THREE.Vector3(50, 50, 10).add(origin));
  controls._cloudBounds = () => bounds;
  return { controls, view, bounds };
}

function pointer(button, x = 500, y = 500) {
  return { pointerId: 1, pointerType: 'mouse', button, clientX: x, clientY: y, preventDefault() {} };
}

test('zoom-out preserves the world focal plane and overview orbit with no decoded point hit', () => {
  const { controls, view } = fixture();
  const originalPivot = view.getPivot();
  const originalRadius = view.radius;
  controls._zoomTowards(originalPivot, 4);
  assert.ok(view.getPivot().distanceTo(originalPivot) < 1e-9, 'dolly must not carry the focal plane away with the camera');
  assert.ok(Math.abs(view.radius - originalRadius * 4) < 1e-9);
  controls._pointerDown(pointer(0));
  assert.equal(controls._mode, 'orbit', 'sparse overview remains orbitable after zoom-out');
  assert.ok(controls.pivot.distanceTo(originalPivot) < 1e-8);
  const before = view.position.clone();
  controls._pointerMove(pointer(0, 520));
  assert.ok(view.position.distanceTo(before) > 1, 'orbit actually moves the camera');
  assert.ok(view.position.toArray().every(Number.isFinite));
});

test('middle-pan and ground-pan retain proportional screen speed after dolly zoom-out', () => {
  for (const button of [1, 2]) {
    const measurements = [];
    for (const scale of [1, 4]) {
      const { controls, view } = fixture();
      controls._zoomTowards(view.getPivot(), scale);
      const before = view.position.clone();
      controls._pointerDown(pointer(button));
      assert.equal(controls._mode, button === 1 ? 'screenpan' : 'pan');
      controls._pointerMove(pointer(button, 520));
      measurements.push(view.position.distanceTo(before));
    }
    assert.ok(measurements[0] > 0);
    assert.ok(Math.abs(measurements[1] / measurements[0] - 4) < 1e-8, `button ${button}: same pixels retain same visual movement at four times distance`);
  }
});

test('off-center wheel dolly preserves heading and focal-plane depth', () => {
  const { controls, view } = fixture();
  const originalPivot = view.getPivot();
  const direction = originalPivot.clone().sub(view.position).normalize();
  const target = controls._depthAnchor({ x: 560, y: 530 });
  controls._zoomTowards(target, 2);
  const nextDirection = view.getPivot().sub(view.position).normalize();
  assert.ok(nextDirection.distanceTo(direction) < 1e-12, 'zoom does not turn or re-center the camera');
  assert.ok(Math.abs(view.getPivot().sub(originalPivot).dot(direction)) < 1e-9, 'off-center zoom keeps the focal plane depth');
  controls._zoomTowards(target, 0.5);
  assert.ok(view.getPivot().distanceTo(originalPivot) < 1e-9, 'reverse dolly restores target');
});

test('projected UTM coordinates retain sparse overview orbit after repeated zoom reversals', () => {
  const { controls, view } = fixture(new THREE.Vector3(0, -200, 150), new THREE.Vector3(367000, 4760000, 220));
  const originalPivot = view.getPivot();
  for (const scale of [4, 0.25, 3, 1 / 3]) {
    controls._zoomTowards(originalPivot, scale);
    assert.ok(view.getPivot().distanceTo(originalPivot) < 1e-7);
    controls._pointerDown(pointer(0));
    assert.equal(controls._mode, 'orbit');
    assert.ok(controls.pivot.distanceTo(originalPivot) < 1e-5, 'UTM ray intersection stays within ten micrometres of the focal point');
  }
});

test('oblique sparse overview returns a bounded ray hit when the focal plane misses the cloud', () => {
  const { controls, bounds } = fixture();
  let sample = null;
  for (let y = 350; y <= 650 && !sample; y += 5) {
    for (let x = 350; x <= 650 && !sample; x += 5) {
      const px = { x, y };
      const depth = controls._depthAnchor(px);
      const padded = bounds.clone().expandByScalar(bounds.getSize(new THREE.Vector3()).length() * navigation.NAVIGATION_POLICY.overviewBoundsPaddingRatio);
      if (controls._ray(px).intersectBox(padded, new THREE.Vector3()) && !padded.containsPoint(depth)) sample = px;
    }
  }
  assert.ok(sample, 'fixture contains an oblique volume hit whose focal-plane point lies outside');
  const anchor = controls._surfaceAnchor(sample);
  assert.ok(anchor, 'a ray through a sparse overview cloud remains orbitable');
  assert.equal(navigation.canUseOverviewAnchor({
    point: anchor, bounds, referenceDistance: controls.view.radius,
    cloudDiameter: bounds.getSize(new THREE.Vector3()).length(),
  }), true, 'the actual returned anchor is bounded');
});

test('close no-hit and empty background still refuse orbit while real close hits work', () => {
  const overview = fixture();
  overview.controls._pointerDown(pointer(0, 0, 0));
  assert.equal(overview.controls._mode, 'none', 'empty background cannot create a fake orbit pivot');
  const close = fixture(new THREE.Vector3(0, -20, 15));
  close.controls._pointerDown(pointer(0));
  assert.equal(close.controls._mode, 'none', 'close inspection still requires a point hit');
  close.controls._pointPick = () => new THREE.Vector3();
  close.controls._pointerDown(pointer(0));
  assert.equal(close.controls._mode, 'orbit');
});
