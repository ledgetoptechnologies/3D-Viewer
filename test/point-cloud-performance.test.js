const test = require('node:test');
const assert = require('node:assert/strict');
const { guardRendererResize, installViewerActivityGate, withPointPickCleanup, createAdaptivePointBudget } = require('../public/pointcloud-performance.js');

test('native point picks restore materials and bound timing entries without adding success-path GPU resets', () => {
  let resets = 0; const cleared = [], material = {}, pointcloud = { material };
  const viewer = { renderer: { setRenderTarget() { resets++; }, state: { reset() { resets++; } }, setScissorTest() { resets++; } } };
  const timing = { measureTimings: false, performance: { clearMarks(name) { cleared.push(name); }, clearMeasures(name) { cleared.push(name); } } };
  const point = { position: [1, 2, 3] };
  assert.equal(withPointPickCleanup(pointcloud, viewer, timing, () => { pointcloud.material = {}; return point; }), point);
  assert.equal(pointcloud.material, material); assert.equal(resets, 0);
  assert.deepEqual(cleared, ['pick-start', 'pick-end', 'pick']);
  const failure = new Error('node disposed');
  assert.throws(() => withPointPickCleanup(pointcloud, viewer, timing, () => { pointcloud.material = {}; throw failure; }), error => error === failure);
  assert.equal(pointcloud.material, material); assert.equal(resets, 3); assert.equal(cleared.length, 6);
  timing.measureTimings = true;
  withPointPickCleanup(pointcloud, viewer, timing, () => point);
  assert.equal(cleared.length, 6);
});

test('hidden iframe schedules no Potree updates or renders and resumes without losing its view or assets', () => {
  let callback, active = true, clockResets = 0;
  const retainedCloud = { name: 'retained cloud' }, view = { yaw: 1.25 }, frames = [];
  const viewer = { scene: { pointclouds: [retainedCloud], view }, clock: { getDelta() { clockResets++; } },
    renderer: { xr: { isPresenting: false }, setAnimationLoop(fn) { callback = fn; } },
    loop(t, frame) { assert.equal(this, viewer); frames.push([t, frame]); },
  };
  assert.equal(installViewerActivityGate(viewer, { isActive: () => active }), true);
  callback(1);
  active = false;
  for (let i = 0; i < 60; i++) callback(i + 2);
  assert.deepEqual(frames, [[1, undefined]]);
  assert.equal(viewer.scene.pointclouds[0], retainedCloud);
  assert.equal(viewer.scene.view, view);
  active = true; callback(100);
  assert.equal(clockResets, 1);
  assert.equal(frames.length, 2);
  callback(101); assert.equal(clockResets, 1);
  active = false; viewer.renderer.xr.isPresenting = true;
  const xrFrame = {}; callback(102, xrFrame);
  assert.deepEqual(frames[3], [102, xrFrame]);
});

test('activity gate fails safely when a different renderer does not expose animation scheduling', () => {
  assert.equal(installViewerActivityGate({}, { isActive: () => true }), false);
});

test('camera overlay is submitted only when markers are visible and there is something to draw', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../public/pointcloud.html'), 'utf8');
  assert.match(source, /if \(pointCloudCameraLayer\.group\.visible && pointCloudCameraLayer\.drawnCount > 0\) \{\s*viewer\.renderer\.render\(cameraOverlayScene/);
  assert.match(source, /installViewerActivityGate\(viewer, \{\s*isActive: \(\) => !document\.hidden && viewer\.renderArea\.clientWidth > 0 && viewer\.renderArea\.clientHeight > 0/);
});

test('unchanged Potree frames avoid canvas buffer resets but preserve viewport; resize and DPR still work', () => {
  let resizes = 0, viewports = 0, ratio = 1;
  const renderer = { domElement: { style: {} }, xr: { isPresenting: false }, getPixelRatio: () => ratio,
    setViewport() { viewports++; },
    setSize(w, h) { if (this.xr.isPresenting) return; resizes++; this.domElement.width = Math.floor(w * ratio); this.domElement.height = Math.floor(h * ratio); this.setViewport(); },
  };
  guardRendererResize(renderer);
  for (let i = 0; i < 120; i++) renderer.setSize(800, 600);
  assert.equal(resizes, 1); assert.equal(viewports, 120);
  renderer.domElement.style.width = '10px'; renderer.setSize(800, 600);
  assert.equal(renderer.domElement.style.width, '800px'); assert.equal(resizes, 1);
  renderer.xr.isPresenting = true; renderer.setSize(800, 600); assert.equal(viewports, 121);
  renderer.xr.isPresenting = false; renderer.setSize(800, 600); assert.equal(resizes, 2);
  renderer.setSize(801, 600); assert.equal(resizes, 3);
  ratio = 2; renderer.setSize(801, 600); assert.equal(resizes, 4);
  renderer.setSize(801, 600, false); assert.equal(resizes, 5);
  renderer.domElement.width = 10; renderer.setSize(801, 600, false); assert.equal(resizes, 6);
});

function frames(controller, count, dt, options = {}) {
  for (let i = 0; i < count; i++) controller.sample(i * dt, options);
}

test('severe sustained frame time can reduce below the old 1.5M floor, retaining the root', () => {
  const c = createAdaptivePointBudget();
  frames(c, 100, 200, { minimum: 400_000 });
  assert.equal(c.state.live, 400_000);
  assert.equal(c.state.target, 10_000_000); assert.equal(c.state.auto, true);
});

test('background/throttled tabs and isolated stalls do not lower detail', () => {
  const c = createAdaptivePointBudget();
  frames(c, 50, 200, { active: false });
  c.sample(20_000); c.sample(22_000);
  assert.equal(c.state.live, c.state.target);
});

test('sustained extremely slow active frames still adapt', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 2000);
  assert.equal(c.state.live, 250_000);
});

test('late hierarchy metadata raises an adapted budget enough to draw the root', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 200);
  assert.equal(c.state.live, 250_000);
  c.sample(20_000, { minimum: 900_000 });
  assert.equal(c.state.live, 900_000);
});

test('growth requires sustained fast rendering and a populated scene; never exceeds requested budget', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 200);
  const low = c.state.live;
  frames(c, 1000, 16, { visiblePoints: 0 }); assert.equal(c.state.live, low);
  frames(c, 15000, 16, { visiblePoints: 10_000_000 }); assert.equal(c.state.live, c.state.target);
  c.setTarget(1_000_000); frames(c, 100, 200, { minimum: 2_000_000 });
  assert.equal(c.state.live, 1_000_000);
  c.setTarget(NaN); assert.equal(c.state.target, 1_000_000);
});

test('density recovers after transient load at a stable 23, 25, or 30 FPS without requiring 45 FPS', () => {
  for (const fps of [23, 25, 30]) {
    const c = createAdaptivePointBudget(); frames(c, 100, 200);
    assert.equal(c.state.live, 250_000);
    let time = 20_000;
    const dt = 1000 / fps;
    for (let i = 0; i < fps * 150; i++) {
      time += dt; c.sample(time, { visiblePoints: c.state.live });
    }
    assert.equal(c.state.live, c.state.target, `${fps} FPS must be allowed to recover density`);
  }
});

test('a density probe which actually overloads the device rolls back and backs off rather than forcing full detail', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 200);
  const base = c.state.live;
  let time = 20_000, probes = [], previous = base, maximum = base;
  while (time < 200_000) {
    // This synthetic device supports the base at 25 FPS; extra points genuinely
    // overload it. A probe must not cause continuing budget oscillation.
    time += c.state.live > base ? 100 : 40;
    c.sample(time, { visiblePoints: c.state.live });
    if (c.state.live > previous) probes.push(time);
    maximum = Math.max(maximum, c.state.live); previous = c.state.live;
  }
  assert.ok(probes.length >= 4 && probes.length <= 7, `bounded retries: ${probes.length}`);
  assert.ok(probes[2] - probes[1] > probes[1] - probes[0], 'failed probes back off');
  assert.ok(probes.at(-1) - probes.at(-2) >= 60_000, 'retry delay is capped at one minute');
  assert.equal(maximum, Math.ceil(base * 1.15));
  assert.equal(c.state.live, base);
});

test('empty scenes, sustained overload, and explicit lower targets still constrain recovery', () => {
  const c = createAdaptivePointBudget(); frames(c, 100, 200);
  let time = 20_000;
  for (let i = 0; i < 3000; i++) { time += 40; c.sample(time, { visiblePoints: 0 }); }
  assert.equal(c.state.live, 250_000);
  for (let i = 0; i < 3000; i++) { time += 80; c.sample(time, { visiblePoints: c.state.live }); }
  assert.equal(c.state.live, 250_000);
  c.setTarget(500_000);
  for (let i = 0; i < 3000; i++) { time += 40; c.sample(time, { visiblePoints: c.state.live }); }
  assert.equal(c.state.live, 500_000);
});
