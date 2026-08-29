import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LRUCache, TilesRenderer } from '3d-tiles-renderer';
import {
  advanceLodMemoryPressure,
  configureLodRenderer,
  DEFAULT_LOD_DETAIL,
  decideLodStartup,
  detectLodStarvation,
  detailToErrorTarget,
  inspectLodProvenance,
  inspectLodTileset,
  LOD_REFINEMENT_STEP,
  LOD_WARMUP_DETAIL,
  lodQueuesSettled,
  lodCacheBudget,
  lodCacheRetentionMinBytes,
  lodDebugSnapshot,
  lodDetailRequestPending,
  lodRuntimeProfile,
  lodViewChangeRequiresRetry,
  lodWarmupSatisfiedByDetail,
  refreshLodResolution,
  recoverLodCacheAdmission,
  resolveLodDetailRequest,
  resolveLodMemoryPressure,
  resolveLodWarmupAdvance,
  screenSpaceErrorPriority,
  visibleLodFrontier,
  visibleLodTargetSatisfied,
} from '../lod-policy.mjs';

test('detail slider maps monotonically across a perceptible bounded SSE range', () => {
  assert.equal(detailToErrorTarget(2), 512);
  assert.equal(detailToErrorTarget(24), 2);
  assert.ok(detailToErrorTarget(20) > 2 && detailToErrorTarget(20) < detailToErrorTarget(12));
  assert.ok(detailToErrorTarget(12) < 512);
  assert.equal(detailToErrorTarget(-100), 512);
  assert.equal(detailToErrorTarget(100), 2);
  assert.equal(detailToErrorTarget(undefined), 15.023, 'missing detail defaults to balanced staged view-local refinement');
});

test('renderer configuration keeps ancestor fallback without enabling explicit sibling preload', () => {
  const calls = [];
  const tiles = {
    lruCache: {},
    downloadQueue: { maxJobs: 25 },
    parseQueue: { maxJobs: 5 },
    setCamera: (camera) => calls.push(['camera', camera]),
    setResolutionFromRenderer: (camera, renderer) => calls.push(['resolution', camera, renderer]),
  };
  const camera = {};
  const renderer = {};
  const profile = configureLodRenderer(tiles, { camera, renderer, detail: 24, deviceMemoryGiB: 4 });
  assert.deepEqual(calls, [['camera', camera], ['resolution', camera, renderer]]);
  assert.equal(LOD_WARMUP_DETAIL, 13);
  assert.equal(tiles.errorTarget, 32, 'low-memory clients start and remain on the LOD-1 warmup target');
  assert.equal(tiles.loadAncestors, true);
  assert.equal(tiles.loadSiblings, false);
  assert.equal(tiles.loadAncestorSiblings, false);
  assert.equal(tiles.downloadQueue.priorityCallback, screenSpaceErrorPriority);
  assert.equal(tiles.parseQueue.priorityCallback, screenSpaceErrorPriority);
  assert.equal(tiles.downloadQueue.maxJobs, 6, 'foreground priority must survive the first request batch');
  assert.equal(tiles.parseQueue.maxJobs, 2, 'parsing must yield often enough to reprioritize after camera moves');
  assert.equal(tiles.maxDepth, Infinity);
  assert.deepEqual(profile, {
    budget: {
      minBytesSize: 640 * 1024 * 1024,
      maxBytesSize: 768 * 1024 * 1024,
      minSize: 256,
      maxSize: 512,
      unloadPercent: 0.20,
    },
    requestedDetail: 24,
    activeDetail: 13,
    maximumDetail: 13,
    reduced: true,
  });
  assert.deepEqual(tiles.lruCache, profile.budget);
  assert.deepEqual(lodRuntimeProfile(24, 8), {
    budget: lodCacheBudget(8),
    requestedDetail: 24,
    activeDetail: 13,
    maximumDetail: 24,
    reduced: false,
  });
  assert.deepEqual(lodCacheBudget(8), {
    minBytesSize: 3.25 * 1024 * 1024 * 1024,
    maxBytesSize: 3.5 * 1024 * 1024 * 1024,
    minSize: 512,
    maxSize: 1024,
    unloadPercent: 0.20,
  });
  assert.ok(
    lodCacheBudget(8).minBytesSize > 3_325_605_911,
    'the warm floor must retain the measured 15-leaf frontier plus ancestor fallback across small camera motion',
  );
  assert.ok(
    lodCacheBudget(8).minBytesSize < lodCacheBudget(8).maxBytesSize,
    'the hard cap must retain admission headroom for a newly visible branch',
  );

  const defaultRenderer = {
    lruCache: {}, downloadQueue: { maxJobs: 25 }, parseQueue: { maxJobs: 5 },
    setCamera() {}, setResolutionFromRenderer() {},
  };
  const defaultProfile = configureLodRenderer(defaultRenderer, { camera, renderer, deviceMemoryGiB: 8 });
  assert.equal(DEFAULT_LOD_DETAIL, 16);
  assert.equal(defaultRenderer.errorTarget, 32, 'desktop starts on the bounded Detail 13 frontier');
  assert.deepEqual(defaultProfile, {
    budget: lodCacheBudget(8),
    requestedDetail: 16,
    activeDetail: 13,
    maximumDetail: 24,
    reduced: false,
  });
  assert.deepEqual(lodRuntimeProfile(undefined, 8), defaultProfile);
  assert.equal(lodDetailRequestPending(defaultProfile), true);

  const alreadyBounded = {
    lruCache: {}, downloadQueue: { maxJobs: 4 }, parseQueue: { maxJobs: 1 },
    setCamera() {}, setResolutionFromRenderer() {},
  };
  configureLodRenderer(alreadyBounded, { camera, renderer });
  assert.equal(alreadyBounded.downloadQueue.maxJobs, 4);
  assert.equal(alreadyBounded.parseQueue.maxJobs, 1);
});

test('full-detail queue settlement includes lazy hierarchy preprocessing', () => {
  assert.equal(lodQueuesSettled({ downloadQueue: {}, parseQueue: {}, processNodeQueue: {} }), true);
  assert.equal(lodQueuesSettled({ downloadQueue: { running: true }, parseQueue: {}, processNodeQueue: {} }), false);
  assert.equal(lodQueuesSettled({ downloadQueue: {}, parseQueue: { running: true }, processNodeQueue: {} }), false);
  assert.equal(lodQueuesSettled({ downloadQueue: {}, parseQueue: {}, processNodeQueue: { running: true } }), false);
});

test('LOD warmup advances only after the visible REPLACE frontier satisfies its target', () => {
  const root = { geometricError: 64, traversal: { visible: true, error: 140 }, children: [] };
  assert.equal(visibleLodTargetSatisfied(root, 32), false);
  root.traversal.visible = false;
  root.children = [
    { traversal: { visible: true, error: 18 }, children: [] },
    { traversal: { visible: true, error: 31.5 }, children: [] },
  ];
  assert.equal(visibleLodTargetSatisfied(root, 32), true);
  root.children[1].traversal.error = 33;
  assert.equal(visibleLodTargetSatisfied(root, 32), false);
  root.children[1].traversal.visible = false;
  assert.equal(visibleLodTargetSatisfied(root, 32), true, 'only the rendered frontier gates warmup');
  assert.equal(visibleLodTargetSatisfied(null, 32), false);
});

test('pinned renderer patch keeps ancestor fallback scoped to visible branches', () => {
  const packageRoot = path.resolve('node_modules/3d-tiles-renderer');
  const source = fs.readFileSync(path.join(packageRoot, 'src/core/renderer/tiles/traverseFunctions.js'), 'utf8');
  assert.match(source, /renderer\.loadSiblings \|\| \( renderer\.loadAncestors && renderer\.loadAncestorSiblings !== false \)/);
  assert.doesNotMatch(source, /renderer\.loadSiblings \|\| renderer\.loadAncestors/);
  const builtMatches = fs.readdirSync(path.join(packageRoot, 'build'))
    .filter((name) => /^renderer-[A-Za-z0-9_-]+\.js$/.test(name))
    .map((name) => fs.readFileSync(path.join(packageRoot, 'build', name), 'utf8'))
    .filter((built) => /\.loadSiblings \|\| \([A-Za-z_$][\w$]*\.loadAncestors && [A-Za-z_$][\w$]*\.loadAncestorSiblings !== false\)/.test(built));
  assert.equal(builtMatches.length, 1, 'the runtime renderer chunk must carry the same scoped fallback patch');
});

test('zero-error terminal leaves satisfy warmup at infinite SSE while refinable tiles do not', () => {
  const zeroErrorLeaf = {
    geometricError: 0,
    traversal: { visible: true, error: Infinity },
    children: [],
  };
  assert.equal(visibleLodTargetSatisfied(zeroErrorLeaf, 32), true);

  const coarseLeaf = {
    geometricError: 8,
    traversal: { visible: true, error: Infinity },
    children: [],
  };
  assert.equal(visibleLodTargetSatisfied(coarseLeaf, 32), false);
  assert.equal(visibleLodTargetSatisfied({
    traversal: { visible: true, error: Infinity }, children: [],
  }, 32), false, 'a missing geometric error must not be coerced into a zero-error leaf');
  assert.equal(visibleLodTargetSatisfied({
    geometricError: '0', traversal: { visible: true, error: Infinity }, children: [],
  }, 32), false, 'only a numeric zero-error leaf is terminal full detail');

  const zeroErrorParent = {
    geometricError: 0,
    traversal: { visible: true, error: Infinity },
    children: [{
      geometricError: 0,
      traversal: { visible: false, error: 0 },
      children: [],
    }],
  };
  assert.equal(
    visibleLodTargetSatisfied(zeroErrorParent, 32),
    false,
    'a visible internal tile at infinite SSE can still refine and must block warmup',
  );

  zeroErrorLeaf.traversal.error = 100;
  assert.equal(
    visibleLodTargetSatisfied(zeroErrorLeaf, 32),
    true,
    'terminal zero-error content always represents a satisfied frontier',
  );
});

test('LOD starvation waits one sample for scheduled eviction before confirming a pinned cache', () => {
  const snapshot = {
    pendingRequiredLeaves: 2,
    queues: { download: false, parse: false, process: false },
    cache: { full: true },
  };
  assert.deepEqual(detectLodStarvation(snapshot), { count: 1, starved: false });
  assert.deepEqual(detectLodStarvation(snapshot, 1), { count: 2, starved: true });
  assert.deepEqual(detectLodStarvation(snapshot, 2), { count: 3, starved: true });
  assert.deepEqual(detectLodStarvation(snapshot, 9), { count: 10, starved: true });

  assert.deepEqual(detectLodStarvation({ ...snapshot, cache: { full: false } }, 2), {
    count: 0, starved: false,
  });
  assert.deepEqual(detectLodStarvation({ ...snapshot, pendingRequiredLeaves: 0 }, 2), {
    count: 0, starved: false,
  });

  for (const queue of ['download', 'parse', 'process']) {
    assert.deepEqual(detectLodStarvation({
      ...snapshot,
      queues: { ...snapshot.queues, [queue]: true },
    }, 2), { count: 0, starved: false });
  }
  assert.deepEqual(detectLodStarvation(snapshot, 0, 1), { count: 1, starved: true });
  assert.deepEqual(detectLodStarvation({
    ...snapshot,
    pendingRequiredLeaves: 0,
    pendingRequiredTiles: 1,
  }), { count: 1, starved: false }, 'a refinable selected tile begins the bounded starvation confirmation window');
});

test('bounded LRU admission recovery frees one stale tile without purging the recent cache', () => {
  const makeCache = (minBytesSize, itemCount = 7) => {
    const cache = new LRUCache();
    cache.minBytesSize = minBytesSize;
    cache.maxBytesSize = 3.5 * 1024 ** 3;
    cache.minSize = 512;
    cache.maxSize = 1024;
    cache.unloadPercent = 0.20;
    const items = Array.from({ length: itemCount }, (_, index) => ({ index }));
    for (const item of items) {
      cache.add(item, () => {});
      cache.setLoaded(item, true);
    }
    for (const item of items) {
      cache.setMemoryUsage(item, 0.5 * 1024 ** 3);
    }
    cache.markUnused(items[0]);
    return cache;
  };
  const snapshot = (cache) => ({
    pendingRequiredTiles: 1,
    queues: { download: false, parse: false, process: false },
    cache: { full: cache.isFull() },
  });

  const evictable = makeCache(3 * 1024 ** 3);
  assert.deepEqual(detectLodStarvation(snapshot(evictable)), { count: 1, starved: false });
  evictable.unloadUnusedContent();
  assert.equal(evictable.isFull(), false, 'the scheduled unload should free admission room');
  assert.deepEqual(detectLodStarvation(snapshot(evictable), 1), { count: 0, starved: false });

  const pinned = makeCache(3.25 * 1024 ** 3);
  assert.deepEqual(detectLodStarvation(snapshot(pinned)), { count: 1, starved: false });
  pinned.unloadUnusedContent();
  assert.equal(pinned.isFull(), true, 'the unused tile is larger than the soft-floor gap and cannot be evicted');
  const confirmedPressure = advanceLodMemoryPressure(snapshot(pinned), {
    requestedDetail: 24, activeDetail: 24, maximumDetail: 24, reduced: false,
  }, {
    consecutiveSamples: 1, starvedAtDetail: null, lastSettledDetail: 13,
  });
  assert.equal(confirmedPressure.recoveryRequired, true);
  assert.equal(confirmedPressure.changed, false, 'admission recovery must run before quality rollback');
  const desktopBudget = lodCacheBudget(8);
  assert.equal(lodCacheRetentionMinBytes(desktopBudget, false), 3.25 * 1024 ** 3);
  assert.equal(recoverLodCacheAdmission(pinned, desktopBudget), true,
    'a completed foreground parse can synchronously displace one stale LRU tile');
  assert.ok(pinned.minBytesSize > 0, 'recovery must never reset the byte floor to zero');
  assert.ok(pinned.minBytesSize <= 3 * 1024 ** 3, 'recovery must make room for the largest unused tile');
  assert.equal(pinned.isFull(), false, 'confirmed starvation must temporarily restore LRU admission headroom');
  assert.equal(pinned.itemSet.size, 6, 'bounded recovery evicts only the one stale tile needed for admission');
  pinned.minBytesSize = lodCacheRetentionMinBytes(desktopBudget, false);
  assert.equal(pinned.minBytesSize, desktopBudget.minBytesSize, 'settled recovery restores normal retention');

  const overshot = makeCache(3.25 * 1024 ** 3, 8);
  overshot.markUnused(overshot.itemList[1]);
  overshot.unloadPercent = 1;
  assert.equal(overshot.cachedBytes, 4 * 1024 ** 3);
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  try {
    assert.equal(recoverLodCacheAdmission(overshot, desktopBudget), true);
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
  assert.equal(overshot.isFull(), false,
    'synchronous recovery also runs when the existing floor already permits eviction');
});

test('memory pressure returns to the last complete frontier and remembers the failed ceiling', () => {
  const profile = {
    requestedDetail: 24,
    activeDetail: 24,
    maximumDetail: 24,
    reduced: false,
  };
  assert.equal(LOD_REFINEMENT_STEP, 3);
  assert.deepEqual(resolveLodMemoryPressure(profile, null, 13), {
    ...profile,
    activeDetail: 13,
    starvedAtDetail: 24,
  });
  assert.deepEqual(profile, {
    requestedDetail: 24,
    activeDetail: 24,
    maximumDetail: 24,
    reduced: false,
  }, 'the pure helper must not mutate its input');

  assert.deepEqual(resolveLodMemoryPressure({ ...profile, activeDetail: 23 }, 24, 19), {
    ...profile,
    activeDetail: 19,
    starvedAtDetail: 23,
  });
  assert.deepEqual(resolveLodMemoryPressure(profile, 20, 16), {
    ...profile,
    activeDetail: 16,
    starvedAtDetail: 20,
  }, 'a recovered detail cannot rise back through the lowest known failing ceiling');
  assert.deepEqual(resolveLodMemoryPressure({ ...profile, activeDetail: 24 }, null), {
    ...profile,
    activeDetail: 21,
    starvedAtDetail: 24,
  }, 'missing completion history falls back by one bounded refinement stage');
});

test('memory-pressure ceiling treats null as unset and stops honestly at the detail floor', () => {
  const profile = { requestedDetail: 24, activeDetail: 13, maximumDetail: 24, reduced: false };
  assert.deepEqual(resolveLodMemoryPressure(profile, null, 2), {
    ...profile,
    activeDetail: 2,
    starvedAtDetail: 13,
  });
  assert.deepEqual(resolveLodMemoryPressure(profile, undefined, 10), {
    ...profile,
    activeDetail: 10,
    starvedAtDetail: 13,
  });
  assert.deepEqual(resolveLodMemoryPressure({ ...profile, activeDetail: 3 }, null, 2), {
    ...profile,
    activeDetail: 2,
    starvedAtDetail: 3,
  });
  assert.equal(resolveLodMemoryPressure({ ...profile, activeDetail: 2 }, null), null);
  assert.equal(resolveLodMemoryPressure({ ...profile, activeDetail: 2 }, 2), null);
  assert.equal(resolveLodMemoryPressure({ ...profile, activeDetail: 'invalid' }, null), null);
});

test('memory-pressure coordinator restores the last complete frontier after confirmed starvation', () => {
  const blocked = {
    pendingRequiredLeaves: 2,
    queues: { download: false, parse: false, process: false },
    cache: { full: true },
  };
  let profile = { requestedDetail: 24, activeDetail: 24, maximumDetail: 24, reduced: false };
  let state = { consecutiveSamples: 0, starvedAtDetail: null, lastSettledDetail: 13 };

  let result = advanceLodMemoryPressure(blocked, profile, state);
  assert.equal(result.changed, false);
  assert.equal(result.recoveryRequired, false);
  assert.equal(result.consecutiveSamples, 1);
  result = advanceLodMemoryPressure(blocked, profile, {
    ...state,
    consecutiveSamples: result.consecutiveSamples,
  });
  assert.equal(result.changed, false);
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.profile.activeDetail, 24);
  assert.equal(result.starvedAtDetail, null);
  assert.equal(result.consecutiveSamples, 2);

  result = advanceLodMemoryPressure(blocked, profile, {
    ...state,
    consecutiveSamples: result.consecutiveSamples,
  });
  assert.equal(result.changed, false);
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.consecutiveSamples, 3);

  result = advanceLodMemoryPressure(blocked, profile, {
    ...state,
    consecutiveSamples: result.consecutiveSamples,
  });
  assert.equal(result.changed, true, 'quality rolls back only after bounded admission recovery remains blocked');
  assert.equal(result.profile.activeDetail, 13);
  assert.equal(result.starvedAtDetail, 24);
  assert.equal(result.consecutiveSamples, 0);

  profile = result.profile;
  state = result;
  result = advanceLodMemoryPressure({ ...blocked, cache: { full: false } }, profile, state);
  assert.equal(result.changed, false);
  assert.equal(result.recoveryRequired, false);
  assert.equal(result.profile.activeDetail, 13, 'cleared pressure must not restore the failed detail');
  assert.equal(result.starvedAtDetail, 24);

  const floorPressure = advanceLodMemoryPressure(blocked, {
    requestedDetail: 24, activeDetail: 2, maximumDetail: 24, reduced: false,
  }, {
    consecutiveSamples: 3, starvedAtDetail: 2, lastSettledDetail: 2,
  });
  assert.equal(floorPressure.changed, false);
  assert.equal(floorPressure.recoveryRequired, true, 'confirmed floor-detail starvation still needs admission recovery');
});

test('memory-pressure ceiling retries only after a materially different camera view', () => {
  const base = {
    position: [0, 40, 50], quaternion: [0, 0, 0, 1], focusDistance: 60,
  };
  assert.equal(lodViewChangeRequiresRetry(base, {
    position: [0.5, 40, 50], quaternion: [0, 0.0087, 0, 0.99996], focusDistance: 59,
  }), false, 'tiny motion retains the stable coarsened frontier and recent cache');
  assert.equal(lodViewChangeRequiresRetry(base, {
    position: [0, 40, 35], quaternion: [0, 0, 0, 1], focusDistance: 45,
  }), true, 'a cumulative close zoom retries requested refinement');
  assert.equal(lodViewChangeRequiresRetry(base, {
    position: [0, 40, 50], quaternion: [0, Math.sin(Math.PI / 18), 0, Math.cos(Math.PI / 18)], focusDistance: 60,
  }), true, 'a materially different orbit retries requested refinement');
});

test('Detail changes cannot bypass an unfinished desktop warmup', () => {
  const desktop = { requestedDetail: 2, activeDetail: 2, maximumDetail: 24, reduced: false };
  assert.equal(lodDetailRequestPending(desktop), false);
  assert.deepEqual(resolveLodDetailRequest(desktop, false, 2), {
    requestedDetail: 2, activeDetail: 2, warmupComplete: false,
  });
  assert.deepEqual(resolveLodDetailRequest(desktop, false, 24), {
    requestedDetail: 24, activeDetail: 13, warmupComplete: false,
  });
  assert.equal(lodDetailRequestPending({ ...desktop, ...resolveLodDetailRequest(desktop, false, 24) }), true);
  assert.deepEqual(resolveLodDetailRequest(desktop, true, 24), {
    requestedDetail: 24, activeDetail: 13, warmupComplete: false,
  });
  const loweredAfterWarmup = resolveLodDetailRequest(desktop, true, 2);
  assert.deepEqual(loweredAfterWarmup, {
    requestedDetail: 2, activeDetail: 2, warmupComplete: false,
  });
  assert.deepEqual(resolveLodDetailRequest(desktop, loweredAfterWarmup.warmupComplete, 24), {
    requestedDetail: 24, activeDetail: 13, warmupComplete: false,
  });
  assert.equal(resolveLodWarmupAdvance({ ...desktop, ...loweredAfterWarmup }), null);
  const restaged = resolveLodDetailRequest(desktop, loweredAfterWarmup.warmupComplete, 24);
  assert.deepEqual(resolveLodWarmupAdvance({ ...desktop, ...restaged }), {
    requestedDetail: 24, activeDetail: 16, warmupComplete: true,
  });
  assert.deepEqual(resolveLodWarmupAdvance({ ...desktop, requestedDetail: 24, activeDetail: 16 }), {
    requestedDetail: 24, activeDetail: 19, warmupComplete: true,
  });
  assert.deepEqual(resolveLodWarmupAdvance({ ...desktop, requestedDetail: 24, activeDetail: 22 }), {
    requestedDetail: 24, activeDetail: 24, warmupComplete: true,
  });
  let dragged = { ...desktop };
  let draggedWarmupComplete = false;
  for (let detail = 3; detail <= 24; detail += 1) {
    const next = resolveLodDetailRequest(dragged, draggedWarmupComplete, detail);
    dragged = { ...dragged, ...next };
    draggedWarmupComplete = next.warmupComplete;
  }
  assert.deepEqual(dragged, {
    ...desktop, requestedDetail: 24, activeDetail: 13, warmupComplete: false,
  }, 'rapid range input cannot bypass the frontier-settlement gate');
  let loadingStage = { ...desktop, requestedDetail: 16, activeDetail: 16 };
  for (let detail = 17; detail <= 24; detail += 1) {
    loadingStage = { ...loadingStage, ...resolveLodDetailRequest(loadingStage, true, detail) };
  }
  assert.equal(loadingStage.activeDetail, 16, 'later slider events cannot promote a stage that is still loading');
  assert.deepEqual(resolveLodWarmupAdvance(loadingStage), {
    requestedDetail: 24, activeDetail: 19, warmupComplete: true,
  });
  assert.equal(lodDetailRequestPending({ ...desktop, requestedDetail: 24, activeDetail: 24 }), false);
  assert.deepEqual(resolveLodDetailRequest({ maximumDetail: 13, reduced: true }, false, 24), {
    requestedDetail: 24, activeDetail: 13, warmupComplete: true,
  });
  assert.equal(lodWarmupSatisfiedByDetail(2), false);
  assert.equal(lodWarmupSatisfiedByDetail(12), false);
  assert.equal(lodWarmupSatisfiedByDetail(13), true);
  assert.equal(lodWarmupSatisfiedByDetail(24), true);
  assert.equal(lodDetailRequestPending({ requestedDetail: 24, activeDetail: 13, maximumDetail: 13 }), false);
});

test('LOD console diagnostics are bounded and strip origins query strings and credentials', () => {
  const attachedScene = {};
  const pendingScene = {};
  const attached = {
    geometricError: 0, children: [], content: { uri: 'LOD-0/Mesh-A.b3dm' },
    traversal: { used: true, inFrustum: true, visible: true, isLeaf: true }, engineData: { scene: attachedScene },
  };
  const pending = {
    geometricError: 0, children: [], content: { uri: 'https://private.example/customer-42/LOD-0/Mesh-B.b3dm?token=secret' },
    traversal: { used: true, inFrustum: true, visible: false, isLeaf: true }, engineData: { scene: pendingScene },
  };
  const root = {
    geometricError: 496, refine: 'REPLACE', children: [attached, pending], content: { uri: 'LOD-2/root.b3dm' },
    traversal: { visible: false }, engineData: { scene: {} },
  };
  const renderer = {
    root, group: { children: [attachedScene] }, errorTarget: 2,
    downloadQueue: { running: false }, parseQueue: { running: true }, processNodeQueue: { running: false },
    lruCache: {
      cachedBytes: 1536 * 1024 * 1024,
      maxBytesSize: 3 * 1024 * 1024 * 1024,
      maxSize: 4,
      itemSet: new Map([[attached, 1], [pending, 2], [root, 3]]),
      usedSet: new Set([attached, pending]),
      loadedSet: new Set([attached, pending, root]),
      bytesMap: new Map([[attached, 512 * 1024 * 1024], [pending, 512 * 1024 * 1024], [root, 512 * 1024 * 1024]]),
      isFull: () => false,
    },
  };
  const value = lodDebugSnapshot(renderer, {
    requestedDetail: 24, activeDetail: 24, maximumDetail: 24, reduced: false,
  }, true);
  assert.deepEqual(value, {
    phase: 'requested-detail', requestedDetail: 24, activeDetail: 24, maximumDetail: 24,
    errorTarget: 2, visible: { root: 0, lod0: 1, lod1: 0, other: 0 },
    requiredLeaves: 2, attachedRequiredLeaves: 1, pendingRequiredLeaves: 1,
    requiredTiles: 2, attachedRequiredTiles: 1, pendingRequiredTiles: 1,
    queues: { download: false, parse: true, process: false },
    cache: {
      usedMiB: 1536, maxMiB: 3072, full: false,
      fullByBytes: false, fullByItems: false,
    },
  });
  assert.equal(lodDebugSnapshot(renderer, {
    requestedDetail: 24, activeDetail: 23, maximumDetail: 24, reduced: false, starvedAtDetail: 24,
  }, true).phase, 'memory-limited');
  assert.equal(lodDebugSnapshot(renderer, {
    requestedDetail: 2, activeDetail: 2, maximumDetail: 24, reduced: false,
  }, false).phase, 'requested-detail', 'a settled conservative request is not a warmup');
  assert.equal(lodDebugSnapshot(renderer, {
    requestedDetail: 24, activeDetail: 13, maximumDetail: 24, reduced: false,
  }, false).phase, 'warmup');
  assert.equal(lodDebugSnapshot(renderer, {
    requestedDetail: 24, activeDetail: 13, maximumDetail: 13, reduced: true,
  }, true).phase, 'reduced-memory');

  assert.doesNotMatch(JSON.stringify(value), /private\.example|customer-42|Mesh-B\.b3dm|token|secret/);
});

test('LOD queue priority favors visible high-error foreground tiles', () => {
  const tile = ({ used = true, inFrustum = true, error, distanceFromCamera, depth = 1 } = {}) => ({
    priority: 0,
    traversal: { used, inFrustum, error, distanceFromCamera },
    internal: { depthFromRenderedParent: depth },
  });
  const foreground = tile({ error: 18, distanceFromCamera: 30 });
  const background = tile({ error: 4, distanceFromCamera: 10 });
  const outside = tile({ inFrustum: false, error: 100, distanceFromCamera: 1 });
  const containingCamera = tile({ error: Infinity, distanceFromCamera: 0 });
  const malformed = tile({ error: Number.NaN, distanceFromCamera: 0 });
  assert.equal(screenSpaceErrorPriority(foreground, background), 1);
  assert.equal(screenSpaceErrorPriority(background, foreground), -1);
  assert.equal(screenSpaceErrorPriority(foreground, outside), 1);
  assert.equal(screenSpaceErrorPriority(outside, foreground), -1);
  assert.equal(screenSpaceErrorPriority(containingCamera, foreground), 1,
    'a refinable tile containing the camera has infinite SSE and must load first');
  assert.equal(screenSpaceErrorPriority(foreground, containingCamera), -1);
  assert.equal(screenSpaceErrorPriority(foreground, malformed), 1,
    'malformed non-finite SSE remains lowest priority');
});

test('standard root REPLACE refinement is inherited by lazy descendants without runtime mutation', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { href: 'http://localhost/' } };
  try {
    const child = {
      geometricError: 0,
      boundingVolume: { sphere: [0, 0, 0, 1] },
      content: { uri: 'leaf.b3dm' },
    };
    const document = {
      asset: { version: '1.0' },
      geometricError: 10,
      root: {
        refine: 'REPLACE',
        geometricError: 10,
        boundingVolume: { sphere: [0, 0, 0, 2] },
        content: { uri: 'root.b3dm' },
        children: [child],
      },
    };
    const renderer = new TilesRenderer('http://localhost/tileset.json');
    renderer.preprocessTileset(document, 'http://localhost/tileset.json');
    renderer.rootTileset = document;
    assert.equal(document.root.refine, 'REPLACE');
    renderer.preprocessNode(child, document.root.internal.basePath, document.root);
    assert.equal(child.refine, 'REPLACE');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('resize refreshes the renderer resolution used by SSE calculations', () => {
  let received = null;
  const tiles = { setResolutionFromRenderer: (...args) => { received = args; } };
  const camera = {};
  const renderer = {};
  assert.equal(refreshLodResolution(tiles, camera, renderer), true);
  assert.deepEqual(received, [camera, renderer]);
  assert.equal(refreshLodResolution(null, camera, renderer), false);
});

test('valid REPLACE hierarchy converges to zero-error full-detail leaves', () => {
  const report = inspectLodTileset({ root: {
    refine: 'REPLACE',
    geometricError: 16,
    content: { uri: 'lod-2.b3dm' },
    children: [{
      geometricError: 4,
      content: { uri: 'lod-1.b3dm' },
      children: [
        { geometricError: 0, content: { uri: 'lod-0-a.b3dm' } },
        { geometricError: 0, content: { uri: 'lod-0-b.b3dm' } },
      ],
    }],
  } });
  assert.equal(report.valid, true);
  assert.equal(report.canConvergeToZeroError, true);
  assert.equal(report.terminalLeafCount, 2);
  assert.equal(report.maxDepth, 2);
});

test('full-quality claim requires provenance for the exact active full mesh', () => {
  const valid = {
    schemaVersion: 2,
    sourceAsset: 'model.glb',
    sourceSha256: 'a'.repeat(64),
    geometry: 'bounded-triangle-equivalence',
    textures: 'byte-identical-material-equivalence',
    leafGeometricError: 0,
    audit: {
      algorithm: 'ltds-glb-leaf-equivalence-v2',
      coordinateTolerance: 1e-6,
      maxNumericDelta: 0,
      triangleCount: 42,
      equivalenceSha256: 'b'.repeat(64),
      artifactCount: 3,
    },
  };
  assert.deepEqual(inspectLodProvenance(valid, '/assets/p/derivatives/model.glb'), {
    verified: true,
    errors: [],
  });
  assert.equal(inspectLodProvenance(null, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...valid, sourceAsset: 'other.glb' }, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...valid, geometry: 'decimated' }, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...valid, textures: 'reduced' }, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...valid, sourceAsset: 'model.obj' }, '/assets/p/webodm/model.obj').verified, false);
});

test('unverified LOD safely falls back to the actual full mesh', () => {
  const tileset = { valid: true, errors: [] };
  assert.deepEqual(decideLodStartup(tileset, { verified: true, errors: [] }, true), {
    action: 'stream-lod',
    reason: null,
  });
  assert.match(
    decideLodStartup(tileset, { verified: false, errors: ['digest mismatch'] }, true).reason,
    /digest mismatch/,
  );
  assert.equal(
    decideLodStartup(tileset, { verified: false, errors: ['missing'] }, true).action,
    'fallback-full-mesh',
  );
  assert.equal(
    decideLodStartup(tileset, { verified: false, errors: ['missing'] }, false).action,
    'disable-lod',
  );
});

test('invalid hierarchy cannot silently claim full-detail convergence', () => {
  const report = inspectLodTileset({ root: {
    refine: 'ADD',
    geometricError: 8,
    children: [{ geometricError: 2, content: { uri: 'decimated-leaf.b3dm' } }],
  } });
  assert.equal(report.valid, false);
  assert.equal(report.canConvergeToZeroError, false);
  assert.match(report.errors.join('\n'), /REPLACE/);
  assert.match(report.errors.join('\n'), /non-zero geometricError/);
});

test('missing geometric error is invalid instead of being coerced to zero', () => {
  const report = inspectLodTileset({ root: {
    refine: 'REPLACE',
    content: { uri: 'leaf.b3dm' },
  } });
  assert.equal(report.valid, false);
  assert.match(report.errors.join('\n'), /geometricError/);
});

test('a zero-error internal tile is rejected because its full-detail children are unreachable', () => {
  const report = inspectLodTileset({ root: {
    refine: 'REPLACE',
    geometricError: 0,
    content: { uri: 'coarse-parent.b3dm' },
    children: [{ geometricError: 0, content: { uri: 'full-leaf.b3dm' } }],
  } });
  assert.equal(report.valid, false);
  assert.equal(report.canConvergeToZeroError, false);
  assert.match(report.errors.join('\n'), /greater than zero while the tile has children/);
});

test('runtime frontier ignores a coarse ADD backdrop only while detail is visible above it', () => {
  const root = {
    refine: 'ADD',
    geometricError: 100,
    traversal: { visible: true },
    children: [
      { geometricError: 0, traversal: { visible: true }, children: [] },
    ],
  };
  assert.deepEqual(visibleLodFrontier(root), {
    visibleCount: 1,
    fullDetail: true,
    maximumGeometricError: 0,
  });

  root.children[0].traversal.visible = false;
  assert.deepEqual(visibleLodFrontier(root), {
    visibleCount: 1,
    fullDetail: false,
    maximumGeometricError: 100,
  });
});

test('runtime frontier reports full detail only when every visible tile is zero-error', () => {
  const root = {
    geometricError: 10,
    traversal: { visible: false },
    children: [
      { geometricError: 0, traversal: { visible: true }, children: [] },
      { geometricError: 0, traversal: { visible: true }, children: [] },
    ],
  };
  assert.deepEqual(visibleLodFrontier(root), {
    visibleCount: 2,
    fullDetail: true,
    maximumGeometricError: 0,
  });
  root.children[1].geometricError = 1;
  assert.deepEqual(visibleLodFrontier(root), {
    visibleCount: 2,
    fullDetail: false,
    maximumGeometricError: 1,
  });
});
