const test = require('node:test');
const assert = require('node:assert/strict');
const { guardRendererResize, createAdaptivePointBudget } = require('../public/pointcloud-performance.js');

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
