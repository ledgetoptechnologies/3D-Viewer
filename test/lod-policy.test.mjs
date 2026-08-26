import assert from 'node:assert/strict';
import test from 'node:test';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  configureLodRenderer,
  decideLodStartup,
  detailToErrorTarget,
  enableTransientRootLodBackdrop,
  inspectLodProvenance,
  inspectLodTileset,
  lodQueuesSettled,
  lodCacheBudget,
  refreshLodResolution,
  releaseStaleLodDetails,
  screenSpaceErrorPriority,
  syncTransientRootLodBackdrop,
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

test('renderer configuration uses REPLACE transitions without ancestor or sibling overfetch', () => {
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
    maxBytesSize: 2.75 * 1024 * 1024 * 1024,
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

test('full-detail queue settlement includes lazy hierarchy preprocessing', () => {
  assert.equal(lodQueuesSettled({ downloadQueue: {}, parseQueue: {}, processNodeQueue: {} }), true);
  assert.equal(lodQueuesSettled({ downloadQueue: { running: true }, parseQueue: {}, processNodeQueue: {} }), false);
  assert.equal(lodQueuesSettled({ downloadQueue: {}, parseQueue: { running: true }, processNodeQueue: {} }), false);
  assert.equal(lodQueuesSettled({ downloadQueue: {}, parseQueue: {}, processNodeQueue: { running: true } }), false);
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

test('transient root backdrop hides only after every required visible fine leaf is attached', () => {
  const rootMaterial = { visible: true };
  const rootScene = { traverse: (callback) => callback({ isMesh: true, material: rootMaterial }) };
  const leafSceneA = {};
  const leafSceneB = {};
  const leafA = { geometricError: 0, traversal: { used: true, inFrustum: true }, engineData: { scene: leafSceneA }, children: [] };
  const leafB = { geometricError: 0, traversal: { used: true, inFrustum: true }, engineData: { scene: leafSceneB }, children: [] };
  const root = {
    refine: 'REPLACE',
    content: { uri: 'root.b3dm' },
    engineData: { scene: rootScene },
    children: [leafA, leafB],
  };
  const tiles = { root, group: { children: [rootScene, leafSceneA] } };

  assert.equal(enableTransientRootLodBackdrop(tiles), true);
  assert.equal(root.refine, 'ADD');
  assert.equal(leafA.refine, 'REPLACE');
  assert.equal(leafB.refine, 'REPLACE');
  assert.deepEqual(syncTransientRootLodBackdrop(tiles), {
    complete: false,
    requiredLeaves: 2,
    attachedLeaves: 1,
    backdropVisible: true,
  });
  assert.equal(rootMaterial.visible, true);

  tiles.group.children.push(leafSceneB);
  assert.deepEqual(syncTransientRootLodBackdrop(tiles), {
    complete: true,
    requiredLeaves: 2,
    attachedLeaves: 2,
    backdropVisible: false,
  });
  assert.equal(rootMaterial.visible, false);

  leafB.traversal.inFrustum = false;
  assert.deepEqual(syncTransientRootLodBackdrop(tiles), {
    complete: true,
    requiredLeaves: 1,
    attachedLeaves: 1,
    backdropVisible: false,
  });

  leafA.traversal.used = false;
  assert.equal(syncTransientRootLodBackdrop(tiles).backdropVisible, true, 'coarse-only views retain the root');

  const externalRoot = { refine: 'REPLACE', content: { uri: 'nested/tileset.json' } };
  assert.equal(enableTransientRootLodBackdrop({ root: externalRoot }), false);
  assert.equal(externalRoot.refine, 'REPLACE');
});

test('runtime root ADD does not contaminate lazy descendant REPLACE inheritance', () => {
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
    assert.equal(enableTransientRootLodBackdrop(renderer), true);
    renderer.preprocessNode(child, document.root.internal.basePath, document.root);
    assert.equal(child.refine, 'REPLACE');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('an in-frustum fine leaf survives a stale out-of-frustum parent result', () => {
  const leafScene = {};
  const leaf = {
    geometricError: 0,
    children: [],
    traversal: { used: true, inFrustum: true, active: true, visible: true },
    engineData: { scene: leafScene },
  };
  const parent = {
    geometricError: 3,
    traversal: { used: false, inFrustum: false, error: 1 },
    children: [leaf],
  };
  const calls = [];
  const tiles = {
    root: { refine: 'ADD', children: [parent] },
    group: { children: [leafScene] },
    errorTarget: 2,
    setTileVisible: (...args) => calls.push(['visible', ...args]),
    setTileActive: (...args) => calls.push(['active', ...args]),
    lruCache: { markUnused: (...args) => calls.push(['unused', ...args]), scheduleUnload: () => calls.push(['unload']) },
  };
  assert.equal(releaseStaleLodDetails(tiles), 0);
  assert.deepEqual(calls, []);
  assert.equal(leaf.traversal.active, true);
  assert.equal(leaf.traversal.visible, true);
});

test('a coarse Detail target releases a fine leaf once its in-frustum parent is sufficient', () => {
  const leafScene = {};
  const leaf = {
    geometricError: 0,
    children: [],
    traversal: { used: true, inFrustum: true, active: true, visible: true },
    engineData: { scene: leafScene },
  };
  const parent = {
    geometricError: 3,
    traversal: { used: true, inFrustum: true, error: 36 },
    children: [leaf],
  };
  const calls = [];
  const tiles = {
    root: { refine: 'ADD', children: [parent] },
    group: { children: [leafScene] },
    errorTarget: 512,
    setTileVisible: (...args) => calls.push(['visible', ...args]),
    setTileActive: (...args) => calls.push(['active', ...args]),
    lruCache: { markUnused: (...args) => calls.push(['unused', ...args]), scheduleUnload: () => calls.push(['unload']) },
  };
  assert.equal(releaseStaleLodDetails(tiles), 1);
  assert.deepEqual(calls.map((call) => call[0]), ['visible', 'active', 'unused', 'unload']);
  assert.equal(leaf.traversal.active, false);
  assert.equal(leaf.traversal.visible, false);
  assert.equal(leafScene.visible, undefined, 'cached scene visibility must not be mutated');
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
