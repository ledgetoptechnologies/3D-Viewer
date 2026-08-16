import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configureLodRenderer,
  decideLodStartup,
  detailToErrorTarget,
  inspectLodProvenance,
  inspectLodTileset,
  lodCacheBudget,
  refreshLodResolution,
  visibleLodFrontier,
} from '../lod-policy.mjs';

test('detail slider maps monotonically to a bounded SSE target', () => {
  assert.equal(detailToErrorTarget(2), 24);
  assert.equal(detailToErrorTarget(20), 6);
  assert.equal(detailToErrorTarget(24), 2);
  assert.equal(detailToErrorTarget(-100), 24);
  assert.equal(detailToErrorTarget(100), 2);
});

test('renderer configuration pins full-depth REPLACE fallback behavior', () => {
  const calls = [];
  const tiles = {
    lruCache: {},
    setCamera: (camera) => calls.push(['camera', camera]),
    setResolutionFromRenderer: (camera, renderer) => calls.push(['resolution', camera, renderer]),
  };
  const camera = {};
  const renderer = {};
  const budget = configureLodRenderer(tiles, { camera, renderer, detail: 24, deviceMemoryGiB: 4 });
  assert.deepEqual(calls, [['camera', camera], ['resolution', camera, renderer]]);
  assert.equal(tiles.errorTarget, 2);
  assert.equal(tiles.loadAncestors, true);
  assert.equal(tiles.loadSiblings, true);
  assert.equal(tiles.maxDepth, Infinity);
  assert.deepEqual(tiles.lruCache, budget);
  assert.deepEqual(budget, lodCacheBudget(4));
  assert.ok(budget.maxBytesSize < lodCacheBudget(8).maxBytesSize);
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
    schemaVersion: 1,
    sourceAsset: 'model.glb',
    sourceSha256: 'a'.repeat(64),
    geometry: 'preserved',
    textures: 'preserved',
    leafGeometricError: 0,
  };
  assert.deepEqual(inspectLodProvenance(valid, '/assets/p/derivatives/model.glb'), {
    verified: true,
    errors: [],
  });
  assert.equal(inspectLodProvenance(null, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...valid, sourceAsset: 'other.glb' }, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...valid, geometry: 'decimated' }, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...valid, textures: 'reduced' }, '/assets/p/derivatives/model.glb').verified, false);
  assert.equal(inspectLodProvenance({ ...valid, sourceAsset: 'model.obj' }, '/assets/p/webodm/model.obj').verified, true);
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
