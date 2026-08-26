import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureLodRenderer,
  decideLodStartup,
  detailToErrorTarget,
  enableRootLodBackdrop,
  inspectLodProvenance,
  inspectLodTileset,
  lodCacheBudget,
  refreshLodResolution,
  releaseStaleLodDetails,
  screenSpaceErrorPriority,
  visibleLodFrontier,
} from '../lod-policy.mjs';

test('detail slider maps monotonically across a perceptible bounded SSE range', () => {
  assert.equal(detailToErrorTarget(2), 512);
  assert.equal(detailToErrorTarget(24), 2);
  assert.ok(detailToErrorTarget(20) > 2 && detailToErrorTarget(20) < detailToErrorTarget(12));
  assert.ok(detailToErrorTarget(12) < 512);
  assert.equal(detailToErrorTarget(-100), 512);
  assert.equal(detailToErrorTarget(100), 2);
  assert.equal(detailToErrorTarget(undefined), 2, 'missing detail defaults to maximum quality');
});

test('renderer configuration prioritizes highest screen-space error without ancestor overfetch', () => {
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
  const budget = configureLodRenderer(tiles, { camera, renderer, detail: 24, deviceMemoryGiB: 4 });
  assert.deepEqual(calls, [['camera', camera], ['resolution', camera, renderer]]);
  assert.equal(tiles.errorTarget, 2);
  assert.equal(tiles.loadAncestors, false);
  assert.equal(tiles.loadSiblings, false);
  assert.equal(tiles.downloadQueue.priorityCallback, screenSpaceErrorPriority);
  assert.equal(tiles.parseQueue.priorityCallback, screenSpaceErrorPriority);
  assert.equal(tiles.downloadQueue.maxJobs, 6, 'foreground priority must survive the first request batch');
  assert.equal(tiles.parseQueue.maxJobs, 2, 'parsing must yield often enough to reprioritize after camera moves');
  assert.equal(tiles.maxDepth, Infinity);
  assert.deepEqual(tiles.lruCache, budget);
  assert.deepEqual(budget, {
    minBytesSize: 384 * 1024 * 1024,
    maxBytesSize: 768 * 1024 * 1024,
    minSize: 8,
    maxSize: 24,
    unloadPercent: 0.20,
  });
  assert.deepEqual(lodCacheBudget(8), {
    minBytesSize: 0.4 * 1024 * 1024 * 1024,
    maxBytesSize: 1.75 * 1024 * 1024 * 1024,
    minSize: 8,
    maxSize: 48,
    unloadPercent: 0.20,
  });

  const alreadyBounded = {
    lruCache: {}, downloadQueue: { maxJobs: 4 }, parseQueue: { maxJobs: 1 },
    setCamera() {}, setResolutionFromRenderer() {},
  };
  configureLodRenderer(alreadyBounded, { camera, renderer });
  assert.equal(alreadyBounded.downloadQueue.maxJobs, 4);
  assert.equal(alreadyBounded.parseQueue.maxJobs, 1);
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
  assert.equal(screenSpaceErrorPriority(foreground, background), 1);
  assert.equal(screenSpaceErrorPriority(background, foreground), -1);
  assert.equal(screenSpaceErrorPriority(foreground, outside), 1);
  assert.equal(screenSpaceErrorPriority(outside, foreground), -1);
});

test('a renderable root can become a runtime-only coarse backdrop', () => {
  const root = { refine: 'REPLACE', content: { uri: 'root.b3dm' } };
  assert.equal(enableRootLodBackdrop({ root }), true);
  assert.equal(root.refine, 'ADD');

  const externalRoot = { refine: 'REPLACE', content: { uri: 'nested/tileset.json' } };
  assert.equal(enableRootLodBackdrop({ root: externalRoot }), false);
  assert.equal(externalRoot.refine, 'REPLACE');

  const emptyRoot = { refine: 'REPLACE' };
  assert.equal(enableRootLodBackdrop({ root: emptyRoot }), false);
  assert.equal(emptyRoot.refine, 'REPLACE');
});

test('stale full-detail leaves are released only after their parent is out of view or coarse enough', () => {
  const oldLeaf = {
    geometricError: 0,
    traversal: { active: true, visible: true },
    engineData: { scene: { visible: true } },
    children: [],
  };
  const settledLeaf = {
    geometricError: 0,
    traversal: { active: true, visible: true },
    engineData: { scene: { visible: true } },
    children: [],
  };
  const activeLeaf = {
    geometricError: 0,
    traversal: { active: true, visible: true },
    engineData: { scene: { visible: true } },
    children: [],
  };
  const intermediate = {
    geometricError: 3,
    traversal: { active: true, visible: true },
    engineData: { scene: { visible: true } },
    children: [],
  };
  const root = {
    refine: 'ADD',
    geometricError: 100,
    traversal: { active: true, visible: true },
    engineData: { scene: { visible: true } },
    children: [
      { geometricError: 3, traversal: { inFrustum: false }, children: [oldLeaf] },
      { geometricError: 3, traversal: { inFrustum: true, error: 6 }, children: [settledLeaf] },
      { geometricError: 3, traversal: { inFrustum: true, error: 7 }, children: [activeLeaf] },
      intermediate,
    ],
  };
  const unused = [];
  const visibilityChanges = [];
  const activeChanges = [];
  let unloads = 0;
  const tiles = {
    root,
    errorTarget: 6,
    setTileVisible: (tile, visible) => visibilityChanges.push([tile, visible]),
    setTileActive: (tile, active) => activeChanges.push([tile, active]),
    lruCache: {
      markUnused: (tile) => unused.push(tile),
      scheduleUnload: () => { unloads += 1; },
    },
  };

  assert.equal(releaseStaleLodDetails(tiles), 2);
  assert.equal(oldLeaf.engineData.scene.visible, true);
  assert.equal(oldLeaf.traversal.active, false);
  assert.equal(oldLeaf.traversal.visible, false);
  assert.equal(settledLeaf.engineData.scene.visible, true);
  assert.equal(activeLeaf.engineData.scene.visible, true);
  assert.equal(intermediate.engineData.scene.visible, true);
  assert.deepEqual(visibilityChanges, [[oldLeaf, false], [settledLeaf, false]]);
  assert.deepEqual(activeChanges, [[oldLeaf, false], [settledLeaf, false]]);
  assert.deepEqual(unused, [oldLeaf, settledLeaf]);
  assert.equal(unloads, 1);
});

test('stale full-detail leaves stay intact without a coarse backdrop', () => {
  const leaf = {
    geometricError: 0,
    traversal: { active: true, visible: true },
    engineData: { scene: { visible: true } },
    children: [],
  };
  const root = {
    refine: 'REPLACE',
    geometricError: 100,
    children: [{ geometricError: 3, traversal: { inFrustum: false }, children: [leaf] }],
  };
  const unused = [];
  assert.equal(releaseStaleLodDetails({
    root,
    errorTarget: 6,
    lruCache: { markUnused: (tile) => unused.push(tile), scheduleUnload: () => { throw new Error('must not unload'); } },
  }), 0);
  assert.equal(leaf.engineData.scene.visible, true);
  assert.deepEqual(unused, []);
});

test('standard ancestor loading owns visibility transitions without manual cache eviction', () => {
  const leaf = {
    geometricError: 0,
    traversal: { active: true, visible: true },
    children: [],
  };
  const root = {
    refine: 'ADD',
    children: [{ geometricError: 3, traversal: { inFrustum: false }, children: [leaf] }],
  };
  const tiles = {
    root,
    loadAncestors: true,
    errorTarget: 6,
    setTileVisible: () => { throw new Error('standard traversal must own visibility'); },
    setTileActive: () => { throw new Error('standard traversal must own activation'); },
    lruCache: { markUnused: () => { throw new Error('standard traversal must own cache use'); } },
  };
  assert.equal(releaseStaleLodDetails(tiles), 0);
  assert.deepEqual(leaf.traversal, { active: true, visible: true });
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
