import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EarthLikeControls, mouseNavigationProfiles } from '../earth-controls.js';

function withControls(run) {
  const previousDocument = globalThis.document, previousWindow = globalThis.window;
  const noop = () => {};
  globalThis.document = { createElement: () => ({ getContext: () => ({ beginPath: noop, arc: noop, stroke: noop, fill: noop }) }) };
  globalThis.window = { addEventListener: noop, removeEventListener: noop };
  const released = [];
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 10, 10); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const dom = { clientHeight: 100, addEventListener: noop, removeEventListener: noop, setPointerCapture: noop,
    releasePointerCapture: id => released.push(id), getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) };
  const controls = new EarthLikeControls(camera, dom, { surfacePick: () => new THREE.Vector3() });
  try { run({ controls, camera, released }); } finally { controls.dispose(); globalThis.document = previousDocument; globalThis.window = previousWindow; }
}
function pointer(button, extra = {}) { return { button, pointerId: 7, pointerType: 'mouse', clientX: 50, clientY: 50, preventDefault() {}, ...extra }; }

test('profile mappings preserve default and apply Todd button permutation', () => {
  assert.deepEqual([0, 1, 2].map(b => mouseNavigationProfiles.actionForButton('default', b)), ['orbit', 'screenpan', 'pan']);
  assert.deepEqual([0, 1, 2].map(b => mouseNavigationProfiles.actionForButton('alternate', b)), ['screenpan', 'pan', 'orbit']);
  assert.equal(mouseNavigationProfiles.normalizeProfile('invalid'), 'default');
  assert.equal(mouseNavigationProfiles.actionForButton('default', 3), 'none');
  assert.ok(Object.isFrozen(mouseNavigationProfiles.getProfile('default').buttons));
});

test('mesh controller routes all buttons through both profiles and moves the camera', () => withControls(({ controls, camera }) => {
  for (const profile of ['default', 'alternate']) {
    controls.setMouseProfile(profile);
    for (const button of [0, 1, 2]) {
      const before = camera.position.clone();
      controls._pointerDown(pointer(button));
      assert.equal(controls._mode, mouseNavigationProfiles.actionForButton(profile, button));
      controls._pointerMove(pointer(button, { clientX: 55, clientY: 53 }));
      assert.ok(camera.position.distanceTo(before) > 0);
      controls._pointerUp(pointer(button));
      camera.updateMatrixWorld(true);
    }
  }
}));

test('switching profile cancels held drag and inertia without moving the camera', () => withControls(({ controls, camera, released }) => {
  controls._pointerDown(pointer(0));
  controls._inertia.active = true;
  controls._inertia.yaw = 2;
  const before = camera.position.clone();
  assert.equal(controls.setMouseProfile('alternate').id, 'alternate');
  assert.equal(controls._mode, 'none');
  assert.equal(controls._inertia.active, false);
  assert.deepEqual(released, [7]);
  controls._pointerMove(pointer(0, { clientX: 80 }));
  controls.update(0.1);
  assert.deepEqual(camera.position.toArray(), before.toArray());
}));

test('touch remains orbit-first in alternate mode and unknown mouse buttons do not start a drag', () => withControls(({ controls }) => {
  controls.setMouseProfile('alternate');
  controls._pointerDown(pointer(3));
  assert.equal(controls._mode, 'none');
  controls._pointerDown(pointer(0, { pointerType: 'touch' }));
  assert.equal(controls._mode, 'orbit');
}));
