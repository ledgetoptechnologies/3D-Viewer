import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LRUCache, TilesRenderer } from '3d-tiles-renderer';
import { resolveLodMemoryProfile } from '../lod-memory-profile.mjs';
import { PerspectiveCamera, Sphere, Vector3 } from 'three';
import {
  advanceLodMemoryPressure,
  configureLodRenderer,
  DEFAULT_LOD_DETAIL,
  decideLodStartup,
  detectLodStarvation,
  detailToErrorTarget,
  inspectLodProvenance,
  inspectLodTileset,
  installLodOverviewRetention,
  classifyLodQuality,
  createLodFocusPriorityCallback,
  createLodFocusPriorityPlugin,
  lodBranchBlockerCut,
  lodBranchBlockerGroups,
  lodFallbackShellMaxBytes,
  lodFallbackShellPlan,
  lodFocusPriorityPenalty,
  lodPeripheralErrorTarget,
  lodProjectedSphereFocusOverlap,
  lodTileInLockedFocalOwner,
  LOD_BOOTSTRAP_COVERAGE_MIN_ERROR_TARGET,
  LOD_BOOTSTRAP_ROOT_MIN_ERROR_TARGET,
  LOD_REFINEMENT_STEP,
  LOD_WARMUP_DETAIL,
  lodBootstrapCoverageErrorTarget,
  lodBootstrapRootErrorTarget,
  lodCacheMaxBytesForOverview,
  lodErrorScaleForCoverage,
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
  retainLodOverviewTiles,
  selectLodRecentFrontier,
  resolveLodDetailRequest,
  resolveLodMemoryPressure,
  resolveLodWarmupAdvance,
  scaledDetailToErrorTarget,
  screenSpaceErrorPriority,
  steadyStateLodErrorTarget,
  visibleLodFrontier,
  visibleLodTargetSatisfied,
} from '../lod-policy.mjs';

test('recent frontier retains focused REPLACE cuts atomically under production pressure', () => {
  const MiB = 1024 ** 2;
  const focalOwner = { __ltdsFocusOverlap: 0.9, traversal: { distanceFromCamera: 10 } };
  const peripheralOwners = Array.from({ length: 10 }, (_, index) => ({
    __ltdsFocusOverlap: 0.2 - index / 100,
    traversal: { distanceFromCamera: 20 + index },
  }));
  const focal = Array.from({ length: 15 }, () => ({
    __ltdsFallbackOwner: focalOwner,
    __ltdsFocusOverlap: 0.9,
    traversal: { distanceFromCamera: 10 },
  }));
  const peripheral = peripheralOwners.flatMap((owner, ownerIndex) => (
    Array.from({ length: 14 }, () => ({
      __ltdsFallbackOwner: owner,
      __ltdsFocusOverlap: owner.__ltdsFocusOverlap,
      traversal: { distanceFromCamera: 20 + ownerIndex },
    }))
  ));
  const selected = selectLodRecentFrontier(
    [...focal, ...peripheral].map(tile => [tile, 2_000]),
    { now: 1_000, maxTiles: 128, maxBytes: 512 * MiB, getBytes: () => 24 * MiB },
  );
  assert.equal(focal.every(tile => selected.has(tile)), true,
    'peripheral admission must not evict any member of the complete focused cut');
  for (const owner of peripheralOwners) {
    const group = peripheral.filter(tile => tile.__ltdsFallbackOwner === owner);
    const retained = group.filter(tile => selected.has(tile)).length;
    assert.ok(retained === 0 || retained === group.length, 'a peripheral REPLACE cut was partially retained');
  }
});

test('oversize focused REPLACE cut is skipped instead of partially pinned', () => {
  const MiB = 1024 ** 2;
  const focalOwner = { __ltdsFocusOverlap: 1, traversal: { distanceFromCamera: 5 } };
  const peripheralOwner = { __ltdsFocusOverlap: 0.1, traversal: { distanceFromCamera: 20 } };
  const focal = Array.from({ length: 22 }, () => ({
    __ltdsFallbackOwner: focalOwner,
    __ltdsFocusOverlap: 1,
    traversal: { distanceFromCamera: 5 },
  }));
  const peripheral = Array.from({ length: 14 }, () => ({
    __ltdsFallbackOwner: peripheralOwner,
    __ltdsFocusOverlap: 0.1,
    traversal: { distanceFromCamera: 20 },
  }));
  const selected = selectLodRecentFrontier(
    [...focal, ...peripheral].map(tile => [tile, 2_000]),
    { now: 1_000, maxTiles: 128, maxBytes: 512 * MiB, getBytes: () => 24 * MiB },
  );
  assert.equal(focal.some(tile => selected.has(tile)), false,
    'an oversize focused cut must fall back to its coarse owner, not partial detail');
  assert.equal(peripheral.every(tile => selected.has(tile)), true);
});

test('detail slider maps monotonically across a perceptible bounded SSE range', () => {
  assert.equal(detailToErrorTarget(2), 512);
  assert.equal(detailToErrorTarget(24), 2);
  assert.ok(detailToErrorTarget(20) > 2 && detailToErrorTarget(20) < detailToErrorTarget(12));
  assert.ok(detailToErrorTarget(12) < 512);
  assert.equal(detailToErrorTarget(-100), 512);
  assert.equal(detailToErrorTarget(100), 2);
  assert.equal(detailToErrorTarget(undefined), 5.481, 'missing detail defaults to direct Detail 20 refinement');
});

test('overview bootstrap computes a direct-child prefetch target without scaling steady detail', () => {
  assert.equal(LOD_BOOTSTRAP_ROOT_MIN_ERROR_TARGET, 4096);
  assert.equal(LOD_BOOTSTRAP_COVERAGE_MIN_ERROR_TARGET, 1024);
  assert.equal(lodBootstrapRootErrorTarget(1983.5), 4096);
  assert.equal(lodBootstrapRootErrorTarget(5000), 5500);
  assert.equal(lodBootstrapCoverageErrorTarget(1983.5, [418, 524, 729]), 1024);
  assert.equal(lodBootstrapCoverageErrorTarget(900, [800, 700]), 850);
  assert.equal(steadyStateLodErrorTarget(20, lodErrorScaleForCoverage(1024)), 5.481);
  assert.equal(steadyStateLodErrorTarget(24, lodErrorScaleForCoverage(1024)), 2);
});

test('steady-state detail target is always the raw camera SSE', () => {
  const coverageTarget = lodBootstrapCoverageErrorTarget(1983.5, [418, 524, 729]);
  const coverageScale = lodErrorScaleForCoverage(coverageTarget);
  assert.equal(coverageTarget, 1024);
  assert.equal(steadyStateLodErrorTarget(16, coverageScale), detailToErrorTarget(16));
  assert.ok(steadyStateLodErrorTarget(16, coverageScale) < coverageTarget);
  assert.ok(steadyStateLodErrorTarget(24, coverageScale) < steadyStateLodErrorTarget(16, coverageScale));
  assert.equal(steadyStateLodErrorTarget(16), detailToErrorTarget(16));
});

test('renderer configuration streams without pinning ancestors or siblings', () => {
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
  assert.equal(tiles.loadAncestors, false);
  assert.equal(tiles.loadSiblings, false);
  assert.equal(tiles.loadAncestorSiblings, false);
  assert.equal(typeof tiles.downloadQueue.priorityCallback, 'function');
  assert.equal(tiles.parseQueue.priorityCallback, tiles.downloadQueue.priorityCallback);
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
    activeDetail: 24,
    maximumDetail: 24,
    reduced: false,
  });
  assert.deepEqual(lodCacheBudget(8), {
    minBytesSize: 0.4 * 1024 * 1024 * 1024,
    maxBytesSize: 3 * 1024 * 1024 * 1024,
    minSize: 8,
    maxSize: 1024,
    unloadPercent: 0.20,
  });
  assert.deepEqual(lodCacheBudget(16), {
    minBytesSize: 0.4 * 1024 * 1024 * 1024,
    maxBytesSize: 3 * 1024 * 1024 * 1024,
    minSize: 8,
    maxSize: 1024,
    unloadPercent: 0.20,
  }, 'normal clients reserve 1.75 GiB above the bounded fallback for focal refinement');
  assert.ok(
    lodCacheBudget(8).maxSize >= 1024,
    'item admission must not block a valid multi-branch frontier before the byte ceiling',
  );
  assert.ok(
    lodCacheBudget(8).maxBytesSize > 1.61 * 1024 * 1024 * 1024,
    'the hard cap must fit the measured camera-selected close-up frontier',
  );
  assert.ok(
    lodCacheBudget(8).minBytesSize < lodCacheBudget(8).maxBytesSize / 2,
    'the warm floor must leave room to replace stale off-view content',
  );

  const defaultRenderer = {
    lruCache: {}, downloadQueue: { maxJobs: 25 }, parseQueue: { maxJobs: 5 },
    setCamera() {}, setResolutionFromRenderer() {},
  };
  const defaultProfile = configureLodRenderer(defaultRenderer, { camera, renderer, deviceMemoryGiB: 8 });
  assert.equal(DEFAULT_LOD_DETAIL, 20);
  assert.equal(defaultRenderer.errorTarget, 5.481, 'desktop starts at raw Detail 20');
  assert.deepEqual(defaultProfile, {
    budget: lodCacheBudget(8),
    requestedDetail: 20,
    activeDetail: 20,
    maximumDetail: 24,
    reduced: false,
  });
  assert.deepEqual(lodRuntimeProfile(undefined, 8), defaultProfile);
  assert.equal(lodDetailRequestPending(defaultProfile), false);

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

test('desktop fallback promotion requires a complete bounded direct-child shell and excludes the root', () => {
  const root = { name: 'root', internal: { hasRenderableContent: true }, children: [] };
  const first = { name: 'first', internal: { hasRenderableContent: true } };
  const second = { name: 'second', content: { uri: 'second.b3dm' }, internal: {} };
  const external = { name: 'external', content: { uri: 'nested.json' }, internal: { hasUnrenderableContent: true } };
  root.children = [first, second, external];
  const attached = new Set([first]);
  const bytes = new Map([[first, 300], [second, 400], [root, 900]]);
  const options = {
    isReady: tile => attached.has(tile),
    getBytes: tile => bytes.get(tile),
    maxBytes: 1_000,
  };

  assert.deepEqual(lodFallbackShellPlan(root, options), {
    shell: [first, second],
    ready: [first],
    bytes: 700,
    complete: false,
    overSoftBudget: false,
    overBudget: false,
    unsupported: true,
    pending: 1,
  });

  attached.add(second);
  const complete = lodFallbackShellPlan(root, options);
  assert.equal(complete.complete, false,
    'a mixed external/contentless root child must fail closed rather than leave a spatial hole');
  assert.deepEqual(complete.shell, [first, second]);
  assert.equal(complete.shell.includes(root), false, 'whole-model root must never enter the steady fallback set');
  assert.equal(complete.shell.includes(external), false, 'delegating children are not renderable fallback content');

  root.children = [first, second];
  const supported = lodFallbackShellPlan(root, options);
  assert.equal(supported.complete, true);
  assert.equal(supported.unsupported, false);

  const overBudget = lodFallbackShellPlan(root, { ...options, maxBytes: 699 });
  assert.equal(overBudget.complete, false);
  assert.equal(overBudget.overBudget, true);
});

test('renderer configuration applies bounded memory profiles without breaking legacy callers', () => {
  const renderer = {};
  const camera = {};
  const createTiles = () => ({
    lruCache: {},
    downloadQueue: { maxJobs: 25 },
    parseQueue: { maxJobs: 5 },
    setCamera() {},
    setResolutionFromRenderer() {},
  });

  const highMemory = resolveLodMemoryProfile({ mode: 'high', deviceMemoryGiB: 8 });
  const highTiles = createTiles();
  const high = configureLodRenderer(highTiles, {
    camera, renderer, detail: 24, deviceMemoryGiB: 8, memoryProfile: highMemory,
  });
  assert.equal(high.reduced, false);
  assert.equal(high.activeDetail, 24);
  assert.equal(high.memoryProfile.mode, 'high');
  assert.equal(highTiles.lruCache.softBytesSize, 4 * 1024 ** 3);
  assert.equal(highTiles.lruCache.maxBytesSize, 5 * 1024 ** 3,
    'renderer hard admission uses the profile overflow ceiling');
  assert.equal(highTiles.downloadQueue.maxJobs, 10);
  assert.equal(highTiles.parseQueue.maxJobs, 3);

  const constrainedMemory = resolveLodMemoryProfile({ mode: 'high', deviceMemoryGiB: 4 });
  const constrainedTiles = createTiles();
  const constrained = configureLodRenderer(constrainedTiles, {
    camera, renderer, detail: 24, deviceMemoryGiB: 4, memoryProfile: constrainedMemory,
  });
  assert.equal(constrainedMemory.mode, 'high', 'the stable preference is not rewritten');
  assert.equal(constrainedMemory.policyKey, 'constrained');
  assert.equal(constrained.reduced, true, 'known low-memory devices retain the Detail-13 safety contract');
  assert.equal(constrained.activeDetail, 13);
  assert.equal(constrainedTiles.lruCache.softBytesSize, 768 * 1024 ** 2);
  assert.equal(constrainedTiles.lruCache.maxBytesSize, 1 * 1024 ** 3);
  assert.equal(constrainedTiles.downloadQueue.maxJobs, 4);
  assert.equal(constrainedTiles.parseQueue.maxJobs, 1);

  const boundedTiles = createTiles();
  boundedTiles.downloadQueue.maxJobs = 3;
  boundedTiles.parseQueue.maxJobs = 1;
  configureLodRenderer(boundedTiles, {
    camera, renderer, memoryProfile: highMemory,
  });
  assert.equal(boundedTiles.downloadQueue.maxJobs, 3,
    'existing lower host queue limits remain authoritative');
  assert.equal(boundedTiles.parseQueue.maxJobs, 1);
});

test('fallback shell allowance admits the measured church shell without starving detail headroom', () => {
  const MiB = 1024 * 1024;
  const GiB = 1024 * MiB;
  const desktopLimit = lodFallbackShellMaxBytes(3 * GiB, { bootstrapResidentBytes: 31 * MiB });
  assert.equal(desktopLimit, 1408 * MiB,
    'the 3 GiB cache keeps 1664 MiB reserved for focused detail');
  assert.equal(lodFallbackShellMaxBytes(6 * GiB), 1.5 * GiB,
    'large caches must not make fallback retention unbounded');
  assert.equal(lodFallbackShellMaxBytes(2 * GiB), 384 * MiB,
    'smaller caches must preserve the minimum focused-detail reserve');
  assert.equal(lodFallbackShellMaxBytes(undefined), 0,
    'an unknown cache budget must fail closed instead of guessing');
  assert.equal(lodFallbackShellMaxBytes(3 * GiB, { bootstrapResidentBytes: 2.75 * GiB }), 256 * MiB,
    'the root and shell must fit together during bootstrap');

  const root = { children: [] };
  const shell = Array.from({ length: 16 }, (_, index) => ({
    name: `church-shell-${index}`,
    internal: { hasRenderableContent: true },
  }));
  root.children = shell;
  const measuredChurchBytes = 1329 * MiB;
  const bytesPerTile = measuredChurchBytes / shell.length;
  const ready = new Set(shell.slice(0, 15));
  const options = {
    isReady: tile => ready.has(tile),
    getBytes: () => bytesPerTile,
    softMaxBytes: 1.25 * GiB,
    maxBytes: desktopLimit,
  };
  const partial = lodFallbackShellPlan(root, options);
  assert.equal(partial.complete, false, '15 of 16 children must never promote');
  assert.equal(partial.pending, 1);
  assert.equal(partial.overSoftBudget, true, 'the old threshold remains visible as telemetry');
  assert.equal(partial.overBudget, false, 'the measured shell is safe under the cache-derived hard limit');

  ready.add(shell[15]);
  const complete = lodFallbackShellPlan(root, options);
  assert.equal(complete.complete, true, 'the complete measured production shell must promote');
  assert.equal(complete.overSoftBudget, true);
  assert.equal(complete.overBudget, false);

  const unsafe = lodFallbackShellPlan(root, {
    ...options,
    isReady: () => true,
    getBytes: () => (desktopLimit + 1) / shell.length,
  });
  assert.equal(unsafe.complete, false, 'a shell one byte beyond the hard limit must remain root-only');
  assert.equal(unsafe.overBudget, true);
});

test('full-detail status requires a stable attached frontier with no pending replacement work', () => {
  const settled = {
    requiredTiles: 8,
    attachedRequiredTiles: 8,
    attachedVisibleTiles: 8,
    pendingRequiredTiles: 0,
    pendingHierarchyNodes: 0,
    positiveErrorFallbackTiles: 0,
    queueCounts: {
      download: { queued: 0, running: 0 },
      parse: { queued: 0, running: 0 },
      process: { queued: 0, running: 0 },
    },
  };
  const profile = { requestedDetail: 20, activeDetail: 20 };
  const frontier = { fullDetail: true, visibleCount: 8, maximumGeometricError: 0 };
  const classify = overrides => classifyLodQuality({
    bootstrapPhase: 'complete',
    runtimeProfile: profile,
    snapshot: settled,
    frontier,
    queuesSettled: true,
    targetSatisfied: true,
    stableFrames: 2,
    ...overrides,
  });

  assert.deepEqual(classify().reasons, []);
  assert.equal(classify().fullDetail, true);
  assert.ok(classify({ snapshot: { ...settled, pendingRequiredTiles: 1 } }).reasons.includes('required-content-pending'));
  assert.ok(classify({ snapshot: { ...settled, requiredTiles: 0, attachedRequiredTiles: 0 } }).reasons.includes('no-required-content'));
  assert.ok(classify({ snapshot: { ...settled, attachedRequiredTiles: 7 } }).reasons.includes('required-content-detached'));
  assert.ok(classify({ snapshot: { ...settled, attachedVisibleTiles: 7 } }).reasons.includes('visible-content-detached'));
  assert.ok(classify({ snapshot: { ...settled, pendingHierarchyNodes: 1 } }).reasons.includes('hierarchy-pending'));
  assert.ok(classify({ snapshot: { ...settled, positiveErrorFallbackTiles: 1 } }).reasons.includes('fallback-visible'));
  assert.ok(classify({
    snapshot: {
      ...settled,
      queueCounts: { ...settled.queueCounts, download: { queued: 1, running: 0 } },
    },
  }).reasons.includes('queues-active'));
  assert.ok(classify({ stableFrames: 1 }).reasons.includes('not-stable'));
  assert.ok(classify({ bootstrapPhase: 'root-only' }).reasons.includes('bootstrap'));
});

test('branch-blocker cut finds cold children for any visible positive-error REPLACE fallback', () => {
  const ready = { internal: { hasRenderableContent: true }, traversal: { used: true, inFrustum: true } };
  const cold = { content: { uri: 'cold.b3dm' }, internal: {}, traversal: { used: true, inFrustum: true } };
  const outside = { content: { uri: 'outside.b3dm' }, internal: {}, traversal: { used: true, inFrustum: false } };
  const wrappedCold = { content: { uri: 'wrapped.b3dm' }, internal: {}, traversal: { used: true, inFrustum: true } };
  const wrapper = {
    internal: { hasUnrenderableContent: true }, traversal: { used: true, inFrustum: true }, children: [wrappedCold],
  };
  const deepFallback = {
    refine: 'REPLACE', geometricError: 4, children: [ready, cold, outside, wrapper],
  };
  const unrelated = { refine: 'REPLACE', geometricError: 0, children: [cold] };
  assert.deepEqual(lodBranchBlockerCut([deepFallback, unrelated], { isReady: tile => tile === ready }),
    [wrappedCold, cold]);
});

test('branch blockers belong to the nearest visible fallback owner', () => {
  const sharedCold = {
    content: { uri: 'shared-cold.b3dm' },
    internal: {},
    traversal: { used: true, inFrustum: true, distanceFromCamera: 3 },
    __ltdsFocusOverlap: 0.9,
  };
  const nestedOwner = {
    refine: 'REPLACE',
    geometricError: 8,
    content: { uri: 'nested-ready.b3dm' },
    internal: { hasRenderableContent: true },
    traversal: { used: true, inFrustum: true, distanceFromCamera: 4 },
    children: [sharedCold],
    __ltdsFocusOverlap: 0.8,
  };
  const wrapper = {
    internal: { hasUnrenderableContent: true },
    traversal: { used: true, inFrustum: true },
    children: [nestedOwner],
  };
  const outerOwner = {
    refine: 'REPLACE',
    geometricError: 32,
    traversal: { used: true, inFrustum: true, distanceFromCamera: 8 },
    children: [wrapper],
    __ltdsFocusOverlap: 0.1,
  };

  const groups = lodBranchBlockerGroups([outerOwner, nestedOwner], {
    isReady: tile => tile === nestedOwner,
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].owner, nestedOwner);
  assert.deepEqual(groups[0].blockers, [sharedCold]);
  assert.equal(sharedCold.__ltdsFallbackOwner, nestedOwner);
  assert.equal(sharedCold.__ltdsOwnerRank, 0);
});

test('focal owner rank stays latched until its complete replacement cut attaches', () => {
  const blocker = (uri, overlap, distance, activity = 100) => ({
    content: { uri },
    internal: {},
    traversal: { used: true, inFrustum: true, distanceFromCamera: distance },
    __ltdsFocusOverlap: overlap,
    __ltdsFocusActivityTime: activity,
  });
  const focalA = blocker('a.b3dm', 1, 20);
  const focalASecond = blocker('a-2.b3dm', 0.95, 22);
  const peripheralB = blocker('b.b3dm', 0.2, 5);
  const ownerA = {
    refine: 'REPLACE', geometricError: 8, children: [focalA, focalASecond],
    traversal: { distanceFromCamera: 20 }, __ltdsFocusOverlap: 0.9, __ltdsFocusActivityTime: 100,
  };
  const ownerB = {
    refine: 'REPLACE', geometricError: 8, children: [peripheralB],
    traversal: { distanceFromCamera: 5 }, __ltdsFocusOverlap: 0.2, __ltdsFocusActivityTime: 100,
  };
  const ready = new Set();
  const first = lodBranchBlockerGroups([ownerA, ownerB], { isReady: tile => ready.has(tile) });
  assert.equal(first[0].owner, ownerA);
  assert.equal(first[0].focal, true);
  assert.equal(first[0].blockers.length, 2);
  assert.equal(peripheralB.__ltdsOwnerRank, 1);

  // Idle-time overlap drift alone must not abandon an incomplete focal cut.
  ownerA.__ltdsFocusOverlap = 0;
  focalA.__ltdsFocusOverlap = 0;
  focalASecond.__ltdsFocusOverlap = 0;
  ownerB.__ltdsFocusOverlap = 1;
  peripheralB.__ltdsFocusOverlap = 1;
  const stillA = lodBranchBlockerGroups([ownerA, ownerB], { isReady: tile => ready.has(tile) });
  assert.equal(stillA[0].owner, ownerA);

  ready.add(focalA);
  assert.equal(
    lodBranchBlockerGroups([ownerA, ownerB], { isReady: tile => ready.has(tile) })[0].owner,
    ownerA,
    'one attached tile is not enough to retire the focal owner',
  );
  ready.add(focalASecond);
  const afterAttach = lodBranchBlockerGroups([ownerA, ownerB], { isReady: tile => ready.has(tile) });
  assert.equal(afterAttach[0].owner, ownerB, 'the next owner begins only after the focal cut attaches');
  assert.equal(afterAttach[0].focal, false,
    'peripheral queue work must not inherit focus merely because the focused cut completed');
  assert.equal(ownerA.__ltdsFocalOwnerLocked, true,
    'completed focused owner remains the raw-SSE camera focus identity');
  assert.equal(ownerB.__ltdsFocalOwnerLocked, false);
});

test('new interaction epoch may deliberately move the focal owner lock', () => {
  const tileA = {
    content: { uri: 'a.b3dm' }, internal: {},
    traversal: { used: true, inFrustum: true, distanceFromCamera: 5 },
    __ltdsFocusOverlap: 1, __ltdsFocusActivityTime: 100,
  };
  const tileB = {
    content: { uri: 'b.b3dm' }, internal: {},
    traversal: { used: true, inFrustum: true, distanceFromCamera: 5 },
    __ltdsFocusOverlap: 0, __ltdsFocusActivityTime: 100,
  };
  const ownerA = { refine: 'REPLACE', geometricError: 8, children: [tileA], traversal: {} };
  const ownerB = { refine: 'REPLACE', geometricError: 8, children: [tileB], traversal: {} };
  assert.equal(lodBranchBlockerGroups([ownerA, ownerB])[0].owner, ownerA);

  tileA.__ltdsFocusOverlap = 0;
  tileA.__ltdsFocusActivityTime = 200;
  tileB.__ltdsFocusOverlap = 1;
  tileB.__ltdsFocusActivityTime = 200;
  assert.equal(lodBranchBlockerGroups([ownerA, ownerB])[0].owner, ownerB);
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

test('pinned renderer retains loaded replacement branches and recovers before parse discard', () => {
  const packageRoot = path.resolve('node_modules/3d-tiles-renderer');
  const traversal = fs.readFileSync(path.join(packageRoot, 'src/core/renderer/tiles/traverseFunctions.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(packageRoot, 'src/core/renderer/tiles/TilesRendererBase.js'), 'utf8');
  assert.match(traversal,
    /renderer\.loadAncestors && tile\.internal\.hasContent \)/,
    'loaded replacement branches must remain retained until their parent can finish refining');
  assert.doesNotMatch(traversal,
    /renderer\.loadAncestors && tile\.internal\.hasContent && ! isDownloadFinished\( tile\.internal\.loadingState \)/,
    'loaded non-active descendants must not be evicted behind an ancestor readiness barrier');
  assert.match(traversal,
    /renderer\.loadAncestors && ! tile\.traversal\.allChildrenLoaded[\s\S]*?tile\.traversal\.isLeaf = true/,
    'each incomplete branch must stop at its own loaded parent fallback');
  assert.match(traversal,
    /tile\.traversal\.active = true;\s*kickActiveChildren\( tile, renderer \)/,
    'strict REPLACE traversal must never render a parent and its descendants simultaneously');
  assert.match(traversal,
    /const childIsReady = c\.internal\.hasRenderableContent\s*\? c\.internal\.loadingState === LOADED\s*: c\.traversal\.allChildrenLoaded/,
    'only LOADED renderable children retire a parent; contentless branches recurse');
  assert.match(renderer,
    /const queuedBytesUsed = this\.getBytesUsed\( tile \);[\s\S]*?lruCache\.cachedBytes \+ queuedBytesUsed > lruCache\.maxBytesSize[\s\S]*?bytesUsed: queuedBytesUsed[\s\S]*?lruCache\.setMemoryUsage\( tile, queuedBytesUsed \)/,
    'known requeue bytes must receive a prospective guard before cache reservation');
  assert.match(renderer,
    /const previousBytesUsed = lruCache\.getMemoryUsage\( tile \);\s*const additionalBytesUsed = Math\.max\( 0, bytesUsed - previousBytesUsed \);[\s\S]*?lruCache\.cachedBytes \+ additionalBytesUsed > lruCache\.maxBytesSize[\s\S]*?bytesUsed: additionalBytesUsed/,
    'decoded estimate growth must reserve only its positive incremental bytes');
  assert.doesNotMatch(renderer, /lruCache\.getMemoryUsage\( tile \) === 0 && bytesUsed > 0/,
    'a prior nonzero estimate must not bypass decoded-delta admission');
  assert.ok(renderer.indexOf("type: 'tile-memory-pressure'") < renderer.indexOf('lruCache.remove( tile )'),
    'pre-discard recovery must precede renderer removal');
  const built = fs.readdirSync(path.join(packageRoot, 'build'))
    .filter(name => /^renderer-.*\.js$/.test(name))
    .map(name => fs.readFileSync(path.join(packageRoot, 'build', name), 'utf8'));
  const builtAncestor = /([A-Za-z_$][\w$]*)\.loadAncestors && ([A-Za-z_$][\w$]*)\.internal\.hasContent && \(\1\.markTileUsed\(\2\), \1\.queueTileForDownload\(\2\)\)/;
  assert.equal(built.filter(source => builtAncestor.test(source)).length, 1,
    'the browser-consumed build retains loaded replacement branches too');
  const builtReadiness = /let ([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$]*)\.internal\.hasRenderableContent \? \2\.internal\.loadingState === 4 : \2\.traversal\.allChildrenLoaded;\s*\1 \|\|/;
  assert.equal(built.filter(source => builtReadiness.test(source)).length, 1,
    'the browser-consumed build uses the same branch-local readiness rule');
  const builtQueuedRecovery = /const ltdsQueuedBytes = this\.getBytesUsed\(([A-Za-z_$][\w$]*)\);[\s\S]*?bytesUsed: ltdsQueuedBytes[\s\S]*?\.setMemoryUsage\(\1, ltdsQueuedBytes\)/;
  assert.equal(built.filter(source => builtQueuedRecovery.test(source)).length, 1,
    'the browser-consumed build guards known requeue bytes before reservation');
  const builtRecovery = /const ltdsPreviousBytes = ([A-Za-z_$][\w$]*)\.getMemoryUsage\(([A-Za-z_$][\w$]*)\);\s*const ltdsAdditionalBytes = Math\.max\(0, ([A-Za-z_$][\w$]*) - ltdsPreviousBytes\);[\s\S]*?bytesUsed: ltdsAdditionalBytes[\s\S]*?\1\.setMemoryUsage\(\2, \3\)/;
  assert.equal(built.filter(source => builtRecovery.test(source)).length, 1,
    'the browser-consumed build rechecks incremental decoded bytes after synchronous recovery');
});

test('pinned renderer source and browser-build admission patch is idempotent', () => {
  const script = path.resolve('scripts/patch-3d-tiles-renderer.mjs');
  for (let run = 1; run <= 2; run += 1) {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 0,
      `renderer patch run ${run} failed: ${result.stderr || result.stdout}`);
  }
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
  assert.equal(lodCacheRetentionMinBytes(desktopBudget, false), 0.4 * 1024 ** 3);
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

test('prospective recovery loops only until the incoming decoded tile fits', () => {
  const memoryProfile = resolveLodMemoryProfile({ mode: 'balanced', deviceMemoryGiB: 8 });
  const budget = lodCacheBudget(8, memoryProfile);
  const cache = new LRUCache();
  Object.assign(cache, budget);
  const items = Array.from({ length: 8 }, (_, index) => ({ index }));
  for (const item of items) {
    cache.add(item, () => {});
    cache.setLoaded(item, true);
  }
  for (const item of items) cache.setMemoryUsage(item, 0.5 * 1024 ** 3);
  for (const item of items.slice(0, 3)) cache.markUnused(item);

  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;
  try {
    assert.equal(recoverLodCacheAdmission(cache, budget, 0.5 * 1024 ** 3), true);
  } finally {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }

  assert.ok(cache.cachedBytes + 0.5 * 1024 ** 3 <= budget.maxBytesSize,
    'recovery accounts for bytes that have been decoded but not yet registered');
  assert.ok(cache.itemSet.size >= 5, 'used/pinned tiles remain resident');
  for (const item of items.slice(3)) assert.equal(cache.has(item), true);
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

test('memory-pressure coordinator preserves camera-driven quality while requesting eviction', () => {
  const blocked = {
    pendingRequiredLeaves: 2,
    queues: { download: false, parse: false, process: false },
    cache: { full: true },
  };
  const profile = { requestedDetail: 16, activeDetail: 13, maximumDetail: 24, reduced: false };
  let samples = 0;
  let clearSamples = 0;
  let currentProfile = { ...profile, peripheralPressureScale: 1 };

  for (let index = 0; index < 8; index += 1) {
    const result = advanceLodMemoryPressure(blocked, currentProfile, {
      consecutiveSamples: samples,
      clearSamples,
      starvedAtDetail: null,
      lastSettledDetail: 13,
    });
    samples = result.consecutiveSamples;
    clearSamples = result.clearSamples;
    currentProfile = result.profile;
    assert.equal(result.profile.activeDetail, 13);
    assert.equal(result.starvedAtDetail, null, 'transient cache admission cannot latch a quality ceiling');
    assert.equal(result.recoveryRequired, index > 0);
    assert.equal(
      result.profile.peripheralPressureScale,
      index < 3 ? 1 : index === 3 ? 2 : 4,
      'persistent pressure may relax only camera-peripheral work while focal SSE remains unchanged',
    );
  }

  const settled = {
    pendingRequiredLeaves: 0,
    pendingRequiredTiles: 0,
    queues: { download: false, parse: false, process: false },
    cache: { full: false },
  };
  for (let index = 0; index < 8; index += 1) {
    const result = advanceLodMemoryPressure(settled, currentProfile, {
      consecutiveSamples: samples,
      clearSamples,
      starvedAtDetail: null,
      lastSettledDetail: 13,
    });
    samples = result.consecutiveSamples;
    clearSamples = result.clearSamples;
    currentProfile = result.profile;
    assert.equal(result.recoveryRequired, false);
    assert.equal(result.profile.activeDetail, 13);
  }
  assert.equal(samples, 0);
  assert.equal(currentProfile.peripheralPressureScale, 1,
    'a settled frontier automatically restores the unscaled full camera selection');
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

test('Detail changes apply raw SSE directly while reduced-memory clients stay capped', () => {
  const desktop = { requestedDetail: 2, activeDetail: 2, maximumDetail: 24, reduced: false };
  assert.equal(lodDetailRequestPending(desktop), false);
  assert.deepEqual(resolveLodDetailRequest(desktop, false, 2), {
    requestedDetail: 2, activeDetail: 2, warmupComplete: true,
  });
  assert.deepEqual(resolveLodDetailRequest(desktop, false, 24), {
    requestedDetail: 24, activeDetail: 24, warmupComplete: true,
  });
  assert.equal(lodDetailRequestPending({ ...desktop, ...resolveLodDetailRequest(desktop, false, 24) }), false);
  assert.deepEqual(resolveLodDetailRequest({ maximumDetail: 13, reduced: true }, false, 24), {
    requestedDetail: 24, activeDetail: 13, warmupComplete: true,
  });
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
    errorTarget: 2, rawErrorTarget: 2, peripheralPressureScale: 1,
    prefetch: {
      elapsedMs: null,
      exitReason: null,
      fallbackTiles: 0,
      fallbackMiB: null,
      shellMiB: null,
      overSoftBudget: false,
      shellSoftLimitMiB: null,
      shellLimitMiB: null,
      detailReserveMiB: null,
    },
    focusPriority: null,
    visible: { root: 0, lod0: 1, lod1: 0, other: 0 },
    visibleDepths: { 0: 1 },
    requiredLeaves: 2, attachedRequiredLeaves: 1, pendingRequiredLeaves: 1,
    requiredTiles: 2, attachedRequiredTiles: 1, pendingRequiredTiles: 1,
    attachedVisibleTiles: 1, positiveErrorFallbackTiles: 0, pendingHierarchyNodes: 0,
    queues: { download: false, parse: true, process: false },
    queueCounts: {
      download: { queued: 0, running: 0 },
      parse: { queued: 0, running: 0 },
      process: { queued: 0, running: 0 },
    },
    cache: {
      usedMiB: 1536, softMiB: null, maxMiB: 3072, full: false,
      fullByBytes: false, fullByItems: false, prospectiveFull: false,
      pendingAdmissionMiB: 0,
    },
  });
  const prospective = lodDebugSnapshot(renderer, {
    requestedDetail: 24,
    activeDetail: 24,
    maximumDetail: 24,
    reduced: false,
    prospectiveAdmissionBlocked: true,
    pendingAdmissionBytes: 256 * 1024 * 1024,
  }, true);
  assert.equal(prospective.cache.fullByBytes, false,
    'current residency remains truthfully below the hard limit');
  assert.equal(prospective.cache.prospectiveFull, true);
  assert.equal(prospective.cache.pendingAdmissionMiB, 256);
  assert.equal(prospective.cache.full, true,
    'a confirmed incoming-byte refusal participates in starvation recovery');
  assert.deepEqual(detectLodStarvation({
    ...prospective,
    queues: { download: false, parse: false, process: false },
  }, 1), { count: 2, starved: true });
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

test('LOD queue priority favors the closest in-frustum replacement work', () => {
  const tile = ({ used = true, inFrustum = true, error, distanceFromCamera, depth = 1 } = {}) => ({
    priority: 0,
    traversal: { used, inFrustum, error, distanceFromCamera },
    internal: { depthFromRenderedParent: depth, hasUnrenderableContent: false },
  });
  const nearLeaf = tile({ error: 0, distanceFromCamera: 5, depth: 2 });
  const farParent = tile({ error: 900, distanceFromCamera: 30 });
  const outside = tile({ inFrustum: false, error: 1000, distanceFromCamera: 1 });
  const malformedDistance = tile({ error: 1000, distanceFromCamera: Number.NaN });
  assert.equal(screenSpaceErrorPriority(nearLeaf, farParent), 1,
    'a selected zero-error leaf near the camera must load before a farther coarse tile');
  assert.equal(screenSpaceErrorPriority(farParent, nearLeaf), -1);
  assert.equal(screenSpaceErrorPriority(nearLeaf, outside), 1);
  assert.equal(screenSpaceErrorPriority(outside, nearLeaf), -1);
  assert.equal(screenSpaceErrorPriority(farParent, malformedDistance), 1,
    'non-finite distance remains lowest priority');
});

test('focus priority penalizes only peripheral queue work and decays after idle', () => {
  const focal = { __ltdsFocusOverlap: 1, traversal: { used: true, inFrustum: true, distanceFromCamera: 10 } };
  const peripheral = { __ltdsFocusOverlap: 0, traversal: { used: true, inFrustum: true, distanceFromCamera: 10 } };
  const moving = { activeMotion: true, lastActivityTime: 1_000 };
  assert.equal(lodFocusPriorityPenalty(focal, moving, 1_000), 1);
  assert.equal(lodFocusPriorityPenalty(peripheral, moving, 1_000), 4);
  const idle = { activeMotion: false, lastActivityTime: 1_000 };
  assert.equal(lodFocusPriorityPenalty(peripheral, idle, 1_250), 4);
  assert.equal(lodFocusPriorityPenalty(peripheral, idle, 1_500), 2.5);
  assert.equal(lodFocusPriorityPenalty(peripheral, idle, 1_750), 1);
  const compare = createLodFocusPriorityCallback(() => moving, () => 1_000);
  assert.ok(compare(focal, peripheral) > 0, 'focal tile must sort as higher-priority work');

  const blocker = { ...peripheral, __ltdsBranchBlocker: true };
  assert.ok(compare(blocker, focal) > 0,
    'a child blocking a visible REPLACE parent must outrank even focal work');
  assert.ok(compare(focal, blocker) < 0);
});

test('focus overlap includes projected bounding-sphere extent rather than only its center', () => {
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const grazingSphere = new Sphere(new Vector3(0.8, 0, -1), 0.3);
  const overlap = lodProjectedSphereFocusOverlap(camera, grazingSphere);
  assert.ok(overlap > 0 && overlap < 1,
    'a sphere whose projected edge reaches the focus cone must not be scored as fully peripheral');
  assert.equal(
    lodProjectedSphereFocusOverlap(camera, new Sphere(new Vector3(0.5, 0, -1), 0.6)),
    1,
    'a projected sphere covering the focal ray receives full overlap',
  );
  assert.equal(
    lodProjectedSphereFocusOverlap(camera, new Sphere(new Vector3(2, 0, -1), 0.01)),
    0,
    'a genuinely peripheral projected extent remains outside the focus cone',
  );
});

test('locked focal owner and all descendants retain raw requested SSE metadata', () => {
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const state = { activeMotion: true, lastActivityTime: 1_000 };
  const plugin = createLodFocusPriorityPlugin(camera, () => state);
  plugin.init({ errorTarget: 5.481, __ltdsPeripheralPressureScale: 4 });
  const sphere = new Sphere(new Vector3(0.9, 0, -1), 0.02);
  const tile = {
    refine: 'REPLACE',
    engineData: { boundingVolume: { getSphere: target => target.copy(sphere) } },
  };

  assert.equal(plugin.calculateTileViewError(tile), false, 'the plugin never overrides camera visibility');
  assert.ok(tile.__ltdsPeripheralErrorTarget > 5.481);
  assert.equal(tile.refine, 'REPLACE');

  const owner = {
    __ltdsFocalOwnerLocked: true,
    __ltdsFocalOwnerPending: true,
  };
  const child = { parent: owner };
  const grandchild = { ...tile, parent: child };
  assert.equal(lodTileInLockedFocalOwner(owner), true);
  assert.equal(lodTileInLockedFocalOwner(child), true);
  assert.equal(lodTileInLockedFocalOwner(grandchild), true);
  assert.equal(plugin.calculateTileViewError(grandchild), false);
  assert.equal(grandchild.__ltdsPeripheralErrorTarget, 5.481,
    'projected position cannot penalize a descendant of the active focal owner');
  assert.equal(lodPeripheralErrorTarget(5.481, owner, state, 1_000), 5.481);

  owner.__ltdsFocalOwnerLocked = false;
  owner.__ltdsFocalOwnerPending = false;
  assert.equal(lodTileInLockedFocalOwner(grandchild), false);
  assert.ok(lodPeripheralErrorTarget(5.481, grandchild, state, 1_000, 4) > 5.481,
    'active memory-pressure policy resumes once the owner replacement cut attaches');
  plugin.dispose();
});

test('pointer position cannot move camera-centered focus or change owner scheduling', () => {
  const camera = new PerspectiveCamera(90, 1, 0.1, 100);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const state = {
    activeMotion: false,
    lastActivityTime: 1_000,
    focusNdc: [-0.95, 0.7],
  };
  const plugin = createLodFocusPriorityPlugin(camera, () => state);
  plugin.init({ errorTarget: 5.481 });
  const tile = center => ({
    content: { uri: `${center.x}.b3dm` },
    internal: {},
    traversal: { used: true, inFrustum: true, distanceFromCamera: 5 },
    engineData: {
      boundingVolume: {
        getSphere: target => target.copy(new Sphere(center, 0.05)),
      },
    },
  });
  const centerTile = tile(new Vector3(0, 0, -1));
  const rightTile = tile(new Vector3(0.8, 0, -1));
  plugin.calculateTileViewError(centerTile);
  plugin.calculateTileViewError(rightTile);
  const before = {
    centerOverlap: centerTile.__ltdsFocusOverlap,
    rightOverlap: rightTile.__ltdsFocusOverlap,
    centerTarget: centerTile.__ltdsPeripheralErrorTarget,
    rightTarget: rightTile.__ltdsPeripheralErrorTarget,
  };
  const ownerAtCenter = {
    refine: 'REPLACE', geometricError: 8, children: [centerTile], traversal: { distanceFromCamera: 5 },
  };
  const ownerAtRight = {
    refine: 'REPLACE', geometricError: 8, children: [rightTile], traversal: { distanceFromCamera: 5 },
  };
  const firstRank = lodBranchBlockerGroups([ownerAtCenter, ownerAtRight]).map(group => group.owner);

  // Simulate ordinary pointer movement without a camera or interaction-timing
  // change. Runtime focus must remain the view-center ray at NDC [0, 0].
  state.focusNdc = [0.95, -0.8];
  plugin.calculateTileViewError(centerTile);
  plugin.calculateTileViewError(rightTile);
  assert.deepEqual({
    centerOverlap: centerTile.__ltdsFocusOverlap,
    rightOverlap: rightTile.__ltdsFocusOverlap,
    centerTarget: centerTile.__ltdsPeripheralErrorTarget,
    rightTarget: rightTile.__ltdsPeripheralErrorTarget,
  }, before);
  assert.deepEqual(
    lodBranchBlockerGroups([ownerAtCenter, ownerAtRight]).map(group => group.owner),
    firstRank,
  );
  assert.ok(centerTile.__ltdsFocusOverlap > rightTile.__ltdsFocusOverlap,
    'the camera-center tile remains focal regardless of cursor coordinates');
  plugin.dispose();
});

test('focus penalty persists while the focal replacement cut is incomplete', () => {
  const peripheralBlocker = {
    __ltdsFocusOverlap: 0,
    __ltdsBranchBlocker: true,
    __ltdsFocusPending: true,
  };
  const idle = { activeMotion: false, lastActivityTime: 1_000 };
  assert.equal(lodFocusPriorityPenalty(peripheralBlocker, idle, 60_000), 4,
    'idle time cannot dissolve focus while its owner cut is pending');
  peripheralBlocker.__ltdsBranchBlocker = false;
  assert.equal(lodFocusPriorityPenalty(peripheralBlocker, idle, 60_000), 1,
    'the normal decay resumes after the replacement cut completes');
});

test('peripheral selection target preserves focal SSE and relaxes only under explicit memory pressure', () => {
  const moving = { activeMotion: true, lastActivityTime: 1_000 };
  assert.equal(lodPeripheralErrorTarget(5.481, { __ltdsFocusOverlap: 1 }, moving, 1_000), 5.481);
  assert.equal(lodPeripheralErrorTarget(5.481, { __ltdsFocusOverlap: 0 }, moving, 1_000), 5.481,
    'camera motion changes queue order but cannot coarsen traversal selection');
  assert.equal(lodPeripheralErrorTarget(
    5.481,
    { __ltdsFocusOverlap: 0 },
    moving,
    1_000,
    4,
  ), 21.924, 'persistent memory pressure may relax genuinely peripheral selection');
  assert.equal(lodPeripheralErrorTarget(5.481, { __ltdsFocusOverlap: 0 }, {
    activeMotion: false,
    lastActivityTime: 1_000,
  }, 2_000), 5.481, 'settled peripheral work eventually converges at the raw requested SSE');
});

test('active pan and orbit timing cannot deselect an already-loaded peripheral branch', () => {
  const rawTarget = 5.481;
  const peripheral = { __ltdsFocusOverlap: 0 };
  const branchError = 8;
  const idleTarget = lodPeripheralErrorTarget(rawTarget, peripheral, {
    activeMotion: false,
    lastActivityTime: 0,
  }, 10_000, 1);
  const panTarget = lodPeripheralErrorTarget(rawTarget, peripheral, {
    activeMotion: true,
    lastActivityTime: 10_000,
  }, 10_000, 1);
  const orbitTarget = lodPeripheralErrorTarget(rawTarget, peripheral, {
    activeMotion: true,
    lastActivityTime: 10_010,
  }, 10_010, 1);

  assert.equal(idleTarget, rawTarget);
  assert.equal(panTarget, rawTarget);
  assert.equal(orbitTarget, rawTarget);
  assert.equal(branchError > idleTarget, true);
  assert.equal(branchError > panTarget, true,
    'pan timing must leave the same refined REPLACE branch selected');
  assert.equal(branchError > orbitTarget, true,
    'orbit timing must leave the same refined REPLACE branch selected');
});

test('owner-grouped priority completes the focal cut before peripheral blockers', () => {
  const tile = (distanceFromCamera, ownerRank) => ({
    __ltdsBranchBlocker: true,
    __ltdsOwnerRank: ownerRank,
    traversal: { used: true, inFrustum: true, distanceFromCamera },
  });
  const focalFar = tile(100, 0);
  const focalNear = tile(10, 0);
  const peripheralNear = tile(1, 1);
  const compare = createLodFocusPriorityCallback(() => ({ activeMotion: false }), () => 10_000);
  assert.ok(compare(focalFar, peripheralNear) > 0,
    'every tile in the focal owner cut outranks a nearer peripheral owner');
  assert.ok(compare(peripheralNear, focalFar) < 0);
  assert.ok(compare(focalNear, focalFar) > 0,
    'distance is deterministic only after owner rank has been satisfied');
});

test('overview retention pins only the captured coarse frontier in the LRU', () => {
  const retained = { id: 'overview' };
  const evicted = { id: 'not-cached' };
  const marked = [];
  const renderer = {
    lruCache: { has: (tile) => tile === retained },
    markTileUsed: (tile) => marked.push(tile),
  };
  assert.equal(retainLodOverviewTiles(renderer, [retained, evicted]), 1);
  assert.deepEqual(marked, [retained]);
  assert.equal(retainLodOverviewTiles(null, [retained]), 0);
});

test('overview retention restores the shared LRU scheduler on dispose', () => {
  const retained = { id: 'overview' };
  const calls = [];
  const cache = {
    has: (tile) => tile === retained,
    scheduleUnload(...args) { calls.push(['schedule', ...args]); return 'scheduled'; },
  };
  const original = cache.scheduleUnload;
  const renderer = {
    lruCache: cache,
    markTileUsed: (tile) => calls.push(['used', tile]),
  };
  const restore = installLodOverviewRetention(renderer, () => [retained]);
  assert.notEqual(cache.scheduleUnload, original);
  assert.equal(cache.scheduleUnload('frame'), 'scheduled');
  assert.deepEqual(calls, [['used', retained], ['schedule', 'frame']]);
  assert.equal(restore(), true);
  assert.equal(cache.scheduleUnload, original);
  assert.equal(restore(), false, 'restoration is idempotent');

  const secondMarked = [];
  const secondRenderer = { lruCache: cache, markTileUsed: tile => secondMarked.push(tile) };
  const restoreSecond = installLodOverviewRetention(secondRenderer, () => [retained]);
  cache.scheduleUnload('second');
  assert.deepEqual(secondMarked, [retained], 'a second renderer receives one wrapper, not a retained call chain');
  assert.equal(restoreSecond(), true);
  assert.equal(cache.scheduleUnload, original);
});

test('large measured overview gets bounded branch-completion headroom', () => {
  const GiB = 1024 * 1024 * 1024;
  assert.equal(lodCacheMaxBytesForOverview(1.75 * GiB, 1.27 * GiB, false), 3 * GiB);
  assert.equal(lodCacheMaxBytesForOverview(1.75 * GiB, 0.2 * GiB, false), 1.75 * GiB,
    'small models keep the normal streaming ceiling');
  assert.equal(lodCacheMaxBytesForOverview(768 * 1024 * 1024, 1.27 * GiB, true),
    768 * 1024 * 1024, 'reduced-memory clients never expand');
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

test('controlled KTX2 provenance is accepted by the browser policy', () => {
  const valid = {
    schemaVersion: 3,
    sourceAsset: 'model.glb',
    sourceSha256: 'a'.repeat(64),
    geometry: 'controlled-bidirectional-surface-equivalence',
    textures: 'controlled-atlas-material-equivalence',
    leafGeometricError: 0,
    converter: {
      name: 'OpenDroneMap/Obj2Tiles',
      version: '1.6.2',
      commandSha256: '8d0931aa44aae76b48832212cd6c649b73e9b9843d5d5f07462f167d0e8d5752',
      binarySha256: '40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274',
    },
    audit: {
      algorithm: 'ltds-obj2tiles-surface-equivalence-v3',
      sourceTriangleCount: 2,
      leafTriangleCount: 2,
      equivalenceSha256: 'b'.repeat(64),
      artifactCount: 3,
      surfaceTolerance: 0.0001,
      maximumSurfaceDistance: 0.00001,
      minimumNormalDot: 0.999,
      maximumReversedNormalFraction: 0,
    },
  };
  assert.deepEqual(inspectLodProvenance(valid, '/assets/p/derivatives/model.glb'), { verified: true, errors: [] });
  assert.equal(inspectLodProvenance({ ...valid, converter: { ...valid.converter, commandSha256: 'c'.repeat(64) } }, '/assets/p/derivatives/model.glb').verified, false);

  const v4 = {
    ...valid,
    schemaVersion: 4,
    audit: {
      ...valid.audit,
      algorithm: 'ltds-obj2tiles-surface-equivalence-v4',
      policyRevision: 'ltds-controlled-surface-policy-v4',
      acceptance: 'gray-zone',
      areaRelativeDelta: 10.618457348535776e-6,
      numericalAgreement: 0,
    },
  };
  assert.deepEqual(inspectLodProvenance(v4, '/assets/p/derivatives/model.glb'), { verified: true, errors: [] });
  assert.equal(inspectLodProvenance({ ...v4, audit: { ...v4.audit, areaRelativeDelta: 1.3e-5 } }, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...v4, audit: { ...v4.audit, policyRevision: 'unreviewed' } }, '/assets/p/derivatives/model.glb').verified, false);
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
