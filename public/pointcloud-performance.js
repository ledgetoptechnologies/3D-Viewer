(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudPerformance = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Potree calls setSize on every frame. Its pinned Three version assigns
  // canvas.width/height even when unchanged, resetting the drawing buffer.
  // Preserve setSize's viewport reset, but only resize the canvas on change.
  function guardRendererResize(renderer) {
    const original = renderer.setSize;
    let previous = null;
    renderer.setSize = function (width, height, updateStyle) {
      if (this.xr?.isPresenting) { previous = null; return original.call(this, width, height, updateStyle); }
      const ratio = this.getPixelRatio();
      const canvas = this.domElement;
      if (previous && previous.width === width && previous.height === height &&
          previous.ratio === ratio && previous.style === updateStyle &&
          canvas.width === Math.floor(width * ratio) && canvas.height === Math.floor(height * ratio)) {
        if (updateStyle !== false && canvas.style) {
          if (canvas.style.width !== width + 'px') canvas.style.width = width + 'px';
          if (canvas.style.height !== height + 'px') canvas.style.height = height + 'px';
        }
        this.setViewport(0, 0, width, height);
        return;
      }
      const result = original.call(this, width, height, updateStyle);
      previous = { width, height, ratio, style: updateStyle };
      return result;
    };
  }

  // Potree owns a Three animation loop which keeps updating visibility and
  // submitting GPU work when its iframe is display:none in the parent page.
  // Retain the loaded cloud/view, but run no frame work until it is visible.
  // Do not stop the animation scheduler: visibility must resume automatically.
  function installViewerActivityGate(viewer, { isActive }) {
    if (typeof viewer?.loop !== 'function' || typeof viewer?.renderer?.setAnimationLoop !== 'function') return false;
    let suspended = false;
    const loop = viewer.loop.bind(viewer);
    viewer.renderer.setAnimationLoop(function (timestamp, frame) {
      // Preserve Three's XR scheduling semantics even if the page is hidden.
      if (!viewer.renderer.xr?.isPresenting && !isActive()) {
        suspended = true;
        return;
      }
      if (suspended) {
        // A hidden minute must not advance controls/animations by a minute.
        viewer.clock?.getDelta?.();
        suspended = false;
      }
      return loop(timestamp, frame);
    });
    return true;
  }

  function withPointPickCleanup(pointcloud, viewer, timing, pick) {
    const material = pointcloud.material;
    try {
      return pick();
    } catch (error) {
      // The pinned picker restores these on success, but can throw while a
      // streamed node is being disposed. Do not leave its pick material active.
      viewer.renderer.setRenderTarget(null);
      viewer.renderer.state.reset();
      viewer.renderer.setScissorTest(false);
      throw error;
    } finally {
      pointcloud.material = material;
      // Potree appends pick timing entries even when profiling is disabled.
      // Bound ordinary navigation history while retaining explicit profiling.
      if (!timing.measureTimings) {
        timing.performance.clearMarks('pick-start');
        timing.performance.clearMarks('pick-end');
        timing.performance.clearMeasures('pick');
      }
    }
  }

  function createAdaptivePointBudget(initialTarget = 10_000_000) {
    const state = { target: initialTarget, live: initialTarget, auto: false, points: 0 };
    let frameMs = 1000 / 60, lastFrame = null, samples = 0, elapsed = 0, healthyMs = 0, longFrames = 0;
    let probeBase = null, probeAgeMs = 0, recoveryDelayMs = 4000;
    function resetTiming() { lastFrame = null; samples = 0; elapsed = 0; healthyMs = 0; }
    return {
      state,
      fps: () => 1000 / frameMs,
      setTarget(value) {
        if (!Number.isFinite(value) || value <= 0) return state.live;
        state.target = state.live = Math.round(value);
        state.auto = false;
        probeBase = null; probeAgeMs = 0; recoveryDelayMs = 4000;
        resetTiming();
        return state.live;
      },
      sample(time, { active = true, minimum = 250_000, visiblePoints = state.points } = {}) {
        if (!active || !Number.isFinite(time)) { longFrames = 0; resetTiming(); return state.live; }
        const floor = Math.min(state.target, Math.max(250_000, Number.isFinite(minimum) ? minimum : 250_000));
        // Hierarchy metadata may arrive after the budget has already adapted.
        // Keep the root drawable, without overriding the user's requested ceiling.
        if (state.live < floor) state.live = floor;
        state.auto = state.live < state.target;
        if (lastFrame === null) { lastFrame = time; return state.live; }
        let dt = time - lastFrame;
        lastFrame = time;
        // Ignore one isolated stall; sustained active <1-FPS rendering must
        // still adapt. Hidden views are excluded by the caller above.
        if (dt <= 0) { resetTiming(); return state.live; }
        longFrames = dt > 1000 ? longFrames + 1 : 0;
        if (longFrames === 1) { samples = 0; elapsed = 0; healthyMs = 0; return state.live; }
        dt = Math.min(1000, dt);
        frameMs += (dt - frameMs) * (1 - Math.exp(-dt / 350));
        samples++; elapsed += dt;
        // A stable 23–30 FPS browser may have ample point capacity despite
        // never reaching 45 FPS. Probe density after sustained <=44ms frames;
        // keep a dead band below the existing >45ms overload threshold.
        healthyMs = frameMs <= 44 ? healthyMs + dt : 0;
        if (probeBase !== null) {
          probeAgeMs += dt;
          if (probeAgeMs >= 2000 && frameMs <= 45 && visiblePoints >= state.live * 0.7) {
            probeBase = null; recoveryDelayMs = 4000;
          }
        }
        if (samples < 8 || elapsed < 1000) return state.live;
        if (frameMs > 45 && state.live > floor) {
          if (probeBase !== null) {
            // An unsuccessful probe rolls back exactly once, then backs off
            // 8/16/32/60s. Do not oscillate continuously on an overloaded GPU.
            state.live = Math.max(floor, probeBase);
            recoveryDelayMs = Math.min(60000, recoveryDelayMs * 2);
            probeBase = null;
          } else {
            state.live = Math.max(floor, Math.floor(state.live * (frameMs > 90 ? 0.5 : 0.75)));
          }
          elapsed = 0; samples = 0; healthyMs = 0;
        } else if (probeBase === null && healthyMs >= recoveryDelayMs && visiblePoints >= state.live * 0.7 && state.live < state.target) {
          // Do not mistake an almost-empty/loading scene for capacity to draw more.
          probeBase = state.live; probeAgeMs = 0;
          state.live = Math.min(state.target, Math.ceil(state.live * 1.15));
          elapsed = 0; samples = 0; healthyMs = 0;
        }
        state.auto = state.live < state.target;
        return state.live;
      },
    };
  }
  return { guardRendererResize, installViewerActivityGate, withPointPickCleanup, createAdaptivePointBudget };
}));
