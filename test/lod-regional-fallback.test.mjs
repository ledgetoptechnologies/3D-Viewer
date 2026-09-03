import assert from 'node:assert/strict';
import test from 'node:test';
import { FAILED, LOADED, QUEUED, UNLOADED } from '3d-tiles-renderer/core';
import { createLodRegionalFallbackCoordinator } from '../lod-regional-fallback.mjs';

function fixture(options = {}) {
  const root = { children: [] };
  const cacheItems = new Map();
  const used = new Set();
  const requests = [];
  const listeners = new Map();
  const cache = {
    maxBytesSize: 2_000,
    has: tile => cacheItems.has(tile),
    getMemoryUsage: tile => cacheItems.get(tile) || 0,
    get cachedBytes() { return [...cacheItems.values()].reduce((a, b) => a + b, 0); },
    isFull() { return this.cachedBytes >= this.maxBytesSize; },
  };
  const renderer = {
    root,
    lruCache: cache,
    lodFallbackTiles: new Set(),
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    dispatchEvent(event) { for (const callback of listeners.get(event.type) || []) callback(event); },
    markTileUsed(tile) { used.add(tile); },
    getBytesUsed(tile) { return tile.knownBytes || 0; },
    requestTileContents(tile) {
      requests.push(tile);
      cacheItems.set(tile, tile.knownBytes || 0);
      tile.internal.loadingState = QUEUED;
    },
    removeUnusedPendingTiles() {
      for (const tile of cacheItems.keys()) {
        if (tile.internal.loadingState === QUEUED && !used.has(tile)) {
          cacheItems.delete(tile);
          tile.internal.loadingState = UNLOADED;
        }
      }
      return 'original-result';
    },
  };
  function tile(name, parent, error = 1) {
    return {
      parent, children: [], refine: 'REPLACE', geometricError: error,
      content: { uri: name }, traversal: { inFrustum: true },
      internal: { loadingState: UNLOADED, hasRenderableContent: true, hasUnrenderableContent: false },
      engineData: { boundingVolume: {} },
    };
  }
  function complete(tile_, bytes = 100) {
    tile_.internal.loadingState = LOADED;
    tile_.engineData.scene = {};
    tile_.knownBytes = bytes;
    cacheItems.set(tile_, bytes);
  }
  function owner(name, childCount = 2) {
    const shell = tile(name, root, 2);
    shell.children = Array.from({ length: childCount }, (_, index) => {
      const child = tile(`${name}/region-${index}.b3dm`, shell);
      child.children = [tile('leaf.b3dm', child, 0)];
      return child;
    });
    root.children.push(shell);
    complete(shell);
    renderer.lodFallbackTiles.add(shell);
    return shell;
  }
  const a = owner('shell-a');
  const b = owner('shell-b');
  const originalRemove = renderer.removeUnusedPendingTiles;
  const coordinator = createLodRegionalFallbackCoordinator(renderer, options);
  const update = (overrides = {}) => coordinator.update({
    enabled: true, baseTiles: root.children, candidateOwner: a, maxBytes: 500, now: 0, ...overrides,
  });
  return { root, a, b, renderer, cacheItems, used, requests, complete, coordinator, update, originalRemove, owner, listeners };
}

test('regional cover serializes unknown requests and registers only a complete measured cover', () => {
  const f = fixture();
  assert.equal(f.update().phase, 'prefetch');
  assert.equal(f.coordinator.snapshot().preparationGated, true);
  assert.equal(f.a.__ltdsRegionalCoverPreparing, true);
  assert.equal(f.a.__ltdsRegionalCoverReady, undefined);
  assert.deepEqual(f.requests, [f.a.children[0]]);
  assert.deepEqual(f.coordinator.retainedTiles(), [f.a.children[0]]);
  f.update({ now: 100 });
  assert.equal(f.requests.length, 1, 'queued request was duplicated');
  assert.deepEqual([...f.renderer.lodFallbackTiles], [f.a, f.b]);
  f.complete(f.a.children[0], 120);
  f.update({ now: 200 });
  assert.deepEqual(f.requests, f.a.children);
  assert.equal(f.renderer.lodFallbackTiles.has(f.a.children[0]), false);
  f.complete(f.a.children[1], 140);
  const result = f.update({ now: 300 });
  assert.equal(result.phase, 'ready');
  assert.equal(result.residentBytes, 260);
  assert.equal(result.readyCount, 2);
  assert.equal(result.preparationGated, false);
  assert.equal(f.a.__ltdsRegionalCoverPreparing, undefined);
  assert.equal(f.a.__ltdsRegionalCoverReady, true);
  assert.deepEqual([...f.renderer.lodFallbackTiles], [f.a, f.b, ...f.a.children]);
  assert.deepEqual(f.coordinator.retainedTiles(), f.a.children);
  assert.equal(f.a.refine, 'REPLACE');
  assert.equal(f.a.children[0].traversal.inFrustum, true);
});

test('whole over-budget cover releases optional pins and respects retry cooldown', () => {
  const f = fixture();
  f.update();
  f.complete(f.a.children[0], 501);
  const failed = f.update({ now: 10 });
  assert.equal(failed.reason, 'cover-over-budget');
  assert.deepEqual(f.coordinator.retainedTiles(), []);
  assert.equal(f.a.__ltdsRegionalCoverPreparing, undefined);
  assert.deepEqual([...f.renderer.lodFallbackTiles], [f.a, f.b]);
  f.update({ now: 5_000 });
  assert.equal(f.requests.length, 1);
  f.a.children[1].knownBytes = 10;
  assert.equal(f.update({ now: 10_011, maxBytes: 600 }).phase, 'prefetch');
  assert.equal(f.requests.length, 2);
});

test('already-ready cover is measured before registration and budget shrink unregisters it', () => {
  const f = fixture();
  f.a.children.forEach(tile => f.complete(tile, 200));
  assert.equal(f.update().phase, 'ready');
  assert.equal(f.requests.length, 0);
  assert.equal(f.update({ now: 1, maxBytes: 300 }).reason, 'cover-over-budget');
  assert.equal(f.a.__ltdsRegionalCoverReady, undefined);
  assert.deepEqual([...f.renderer.lodFallbackTiles], [f.a, f.b]);
});

test('owner switch hysteresis holds one cover and never overlaps candidate pins', () => {
  const f = fixture();
  f.a.children.forEach(tile => f.complete(tile));
  f.update();
  f.update({ candidateOwner: f.b, now: 100 });
  assert.deepEqual(f.coordinator.retainedTiles(), f.a.children);
  assert.equal(f.requests.length, 0);
  f.update({ candidateOwner: f.b, now: 2_099 });
  assert.deepEqual(f.coordinator.retainedTiles(), f.a.children);
  f.update({ candidateOwner: f.b, now: 2_100 });
  assert.deepEqual(f.coordinator.retainedTiles(), [f.b.children[0]]);
  assert.deepEqual([...f.renderer.lodFallbackTiles], [f.a, f.b, ...f.a.children]);
  assert.equal(f.coordinator.snapshot().historicalOwnerCount, 1);
  assert.deepEqual(f.requests, [f.b.children[0]]);
});

test('slow preparation preserves the acquired near region while descendant traversal is gated', () => {
  const f = fixture();
  f.renderer.frameCount = 1;
  f.a.children.forEach((tile, index) => {
    tile.traversal.lastFrameVisited = 1;
    tile.traversal.distanceFromCamera = 10 + index * 50;
  });
  assert.equal(f.update().focusRegion, 'shell-a/region-0.b3dm');
  f.renderer.frameCount = 2;
  f.update({ now: 100 });
  f.update({ now: 3_000 });
  assert.equal(f.coordinator.snapshot().focusRegion, 'shell-a/region-0.b3dm',
    'unvisited descendants during preparation are not evidence the near region left view');
  f.complete(f.a.children[0]);
  f.update({ now: 4_000 });
  f.complete(f.a.children[1]);
  assert.equal(f.update({ now: 5_000 }).phase, 'ready');
  assert.equal(f.a.__ltdsRegionalFocusRegion, f.a.children[0]);
});

test('historical eligibility has no pins or requests and any disposed child prunes the whole cover', () => {
  const f = fixture({ switchDelayMs: 0 });
  f.a.children.forEach(tile => f.complete(tile));
  f.update();
  f.used.clear();
  f.update({ candidateOwner: f.b, now: 1 });
  assert.equal(f.a.__ltdsRegionalCoverReady, true);
  assert.equal(f.coordinator.snapshot().historicalTileCount, 2);
  assert.deepEqual(f.coordinator.retainedTiles(), [f.b.children[0]]);
  assert.equal(f.a.children.some(tile => f.used.has(tile)), false, 'historical residency was pinned');
  f.used.clear();
  f.renderer.removeUnusedPendingTiles();
  assert.equal(f.a.children.some(tile => f.used.has(tile)), false, 'prune hook pinned old cover');
  f.renderer.dispatchEvent({ type: 'dispose-model', tile: f.a.children[0] });
  assert.equal(f.coordinator.snapshot().historicalOwnerCount, 0);
  assert.equal(f.a.children.some(tile => f.renderer.lodFallbackTiles.has(tile)), false);
  assert.equal(f.a.__ltdsRegionalCoverReady, undefined);
  assert.deepEqual(f.requests, [f.b.children[0]], 'historical cover caused a new request');
});

test('history readiness loss is pruned on update and reacquisition transfers registration ownership', () => {
  const f = fixture({ switchDelayMs: 0 });
  for (const owner of [f.a, f.b]) owner.children.forEach(tile => f.complete(tile));
  f.update();
  f.update({ candidateOwner: f.b, now: 1 });
  assert.equal(f.update({ candidateOwner: f.a, now: 2 }).phase, 'ready');
  assert.equal(f.coordinator.snapshot().historicalOwnerCount, 1);
  assert.deepEqual(f.coordinator.retainedTiles(), f.a.children);
  assert.equal(f.requests.length, 0);
  f.cacheItems.delete(f.b.children[0]);
  f.update({ now: 3 });
  assert.equal(f.coordinator.snapshot().historicalOwnerCount, 0);
  assert.equal(f.b.children.some(tile => f.renderer.lodFallbackTiles.has(tile)), false);
  f.coordinator.dispose();
  assert.deepEqual([...f.renderer.lodFallbackTiles], [f.a, f.b]);
  assert.equal(f.listeners.get('dispose-model').size, 0);
});

test('historical owner metadata is bounded and disable removes owned registrations only', () => {
  const f = fixture({ switchDelayMs: 0 });
  f.renderer.lruCache.maxBytesSize = 10_000;
  const owners = [f.a, f.b, ...Array.from({ length: 4 }, (_, index) => f.owner(`extra-${index}`))];
  f.renderer.lodFallbackTiles.add(f.a.children[0]);
  owners.forEach(owner => owner.children.forEach(tile => f.complete(tile)));
  owners.forEach((owner, index) => f.update({ candidateOwner: owner, now: index }));
  assert.equal(f.coordinator.snapshot().historicalOwnerCount, 4);
  assert.equal(f.coordinator.snapshot().historicalTileCount, 8);
  assert.equal(f.renderer.lodFallbackTiles.has(f.a.children[0]), true, 'preexisting registration was removed');
  assert.equal(f.renderer.lodFallbackTiles.has(f.a.children[1]), false, 'oldest owned registration exceeded bound');
  assert.equal(f.a.__ltdsRegionalCoverReady, undefined);
  f.update({ enabled: false, now: 10 });
  assert.equal(f.coordinator.snapshot().historicalOwnerCount, 0);
  assert.deepEqual(new Set(f.renderer.lodFallbackTiles), new Set([...owners, f.a.children[0]]));
});

test('historical tile-reference bound applies even if an adapter permits larger regional covers', () => {
  const f = fixture({ switchDelayMs: 0, maxTiles: 32 });
  f.renderer.lruCache.maxBytesSize = 10_000;
  const owners = Array.from({ length: 4 }, (_, index) => f.owner(`large-${index}`, 24));
  owners.forEach(owner => owner.children.forEach(tile => f.complete(tile, 10)));
  owners.forEach((owner, index) => f.update({ candidateOwner: owner, now: index }));
  assert.equal(f.coordinator.snapshot().historicalOwnerCount, 2);
  assert.equal(f.coordinator.snapshot().historicalTileCount, 48);
  assert.equal(owners[0].children.some(tile => f.renderer.lodFallbackTiles.has(tile)), false);
  assert.deepEqual(f.coordinator.retainedTiles(), owners[3].children);
});

test('clearly outside owner releases immediately and null candidate eventually releases', () => {
  const f = fixture();
  f.a.children.forEach(tile => f.complete(tile));
  f.update();
  f.a.traversal.inFrustum = false;
  f.update({ candidateOwner: f.b, now: 100 });
  assert.deepEqual(f.requests, [f.b.children[0]]);
  f.update({ candidateOwner: null, now: 200 });
  assert.equal(f.coordinator.snapshot().owner, 'shell-b');
  f.update({ candidateOwner: null, now: 2_200 });
  assert.deepEqual(f.coordinator.retainedTiles(), []);
});

test('queued optional cover survives prune hook without changing traversal selection', () => {
  const f = fixture();
  const tile = f.a.children[0];
  tile.traversal.used = false;
  f.update();
  f.used.clear();
  assert.equal(f.renderer.removeUnusedPendingTiles(), 'original-result');
  assert.equal(tile.internal.loadingState, QUEUED);
  assert.equal(f.cacheItems.has(tile), true);
  assert.equal(tile.traversal.used, false);
  f.coordinator.dispose();
  assert.equal(f.renderer.removeUnusedPendingTiles, f.originalRemove);
  f.used.clear();
  f.renderer.removeUnusedPendingTiles();
  assert.equal(tile.internal.loadingState, UNLOADED);
});

test('dispose removes only owned fallback registrations and does not clobber a later wrapper', () => {
  const f = fixture();
  f.a.children.forEach(tile => f.complete(tile));
  f.renderer.lodFallbackTiles.add(f.a.children[0]);
  f.update();
  const wrapper = f.renderer.removeUnusedPendingTiles;
  const later = function () { return wrapper.call(this); };
  f.renderer.removeUnusedPendingTiles = later;
  f.coordinator.dispose();
  assert.equal(f.renderer.removeUnusedPendingTiles, later);
  assert.equal(f.renderer.lodFallbackTiles.has(f.a.children[0]), true);
  assert.equal(f.renderer.lodFallbackTiles.has(f.a.children[1]), false);
  assert.equal(f.coordinator.snapshot().phase, 'disposed');
});

test('disabled, root-only, missing source, or unready base does not issue optional requests', () => {
  for (const override of [
    { enabled: false }, { baseTiles: [] }, { baseTiles: null }, { maxBytes: 0 },
  ]) {
    const f = fixture();
    assert.equal(f.update(override).phase, 'disabled');
    assert.equal(f.requests.length, 0);
  }
  const f = fixture();
  assert.equal(f.update({ baseTiles: [f.root] }).reason, 'base-shell-not-ready');
  f.b.internal.loadingState = UNLOADED;
  assert.equal(f.update().reason, 'base-shell-not-ready');
  assert.equal(f.requests.length, 0);
});

test('leaf-only, non-renderable, incomplete and virtual covers are rejected', () => {
  const cases = [
    [tile => { tile.geometricError = 0; }, 'leaf-only-cover'],
    [tile => { tile.children = []; }, 'leaf-only-cover'],
    [tile => { tile.content = null; }, 'non-renderable-cover'],
    [tile => { tile.internal.hasUnrenderableContent = true; }, 'non-renderable-cover'],
    [tile => { tile.traversal = null; }, 'incomplete-metadata'],
    [tile => { tile.engineData.boundingVolume = null; }, 'incomplete-metadata'],
    [tile => { tile.internal.virtualChildCount = 1; }, 'incomplete-metadata'],
    [tile => { tile.refine = 'ADD'; }, 'unsupported-refinement'],
  ];
  for (const [mutate, expected] of cases) {
    const f = fixture();
    mutate(f.a.children[1]);
    assert.equal(f.update().reason, expected);
    assert.equal(f.requests.length, 0);
  }
});

test('refused admission cannot spin requests and normal queued work is not duplicated', () => {
  const f = fixture();
  f.renderer.requestTileContents = tile => f.requests.push(tile);
  assert.equal(f.update().reason, 'admission-refused');
  f.update({ now: 100 });
  assert.equal(f.requests.length, 1);
  const g = fixture();
  g.renderer.requestTileContents(g.a.children[1]);
  g.update();
  assert.equal(g.requests.length, 1, 'existing renderer allocation must settle first');
  assert.deepEqual(g.coordinator.retainedTiles(), [g.a.children[1]]);
});

test('hard cache cap and known prospective allocation refuse optional admission', () => {
  const f = fixture();
  f.renderer.lruCache.maxBytesSize = 250;
  f.a.children[0].knownBytes = 100;
  assert.equal(f.update().reason, 'admission-refused');
  assert.equal(f.requests.length, 0);
});

test('parse rejection, tile failure, and timeout release incomplete cover', () => {
  for (const kind of ['rejected', 'failed', 'timeout']) {
    const f = fixture({ requestTimeoutMs: 500 });
    f.update();
    if (kind === 'rejected') {
      f.cacheItems.delete(f.a.children[0]);
      f.a.children[0].internal.loadingState = UNLOADED;
    }
    if (kind === 'failed') f.a.children[0].internal.loadingState = FAILED;
    assert.equal(f.update({ now: 501 }).phase, 'cooldown');
    assert.deepEqual(f.coordinator.retainedTiles(), []);
    assert.equal(f.a.__ltdsRegionalCoverPreparing, undefined);
    assert.equal(f.requests.length, 1);
  }
});

test('a mature visible descendant prevents acquisition from gating existing fine detail', () => {
  const f = fixture();
  const fine = f.a.children[0].children[0];
  fine.traversal.visible = true;
  assert.equal(f.update().reason, 'existing-cut');
  assert.equal(f.coordinator.snapshot().preparationGated, false);
  assert.equal(f.a.__ltdsRegionalCoverPreparing, undefined);
  assert.equal(f.requests.length, 1);
});

test('preparation gate is cleared on owner switch, disable, and disposal', () => {
  const f = fixture();
  f.update();
  f.a.traversal.inFrustum = false;
  f.update({ candidateOwner: f.b, now: 100 });
  assert.equal(f.a.__ltdsRegionalCoverPreparing, undefined);
  assert.equal(f.b.__ltdsRegionalCoverPreparing, true);
  f.update({ enabled: false, now: 101 });
  assert.equal(f.b.__ltdsRegionalCoverPreparing, undefined);
  f.update({ candidateOwner: f.b, now: 102 });
  assert.equal(f.b.__ltdsRegionalCoverPreparing, true);
  f.coordinator.dispose();
  assert.equal(f.b.__ltdsRegionalCoverPreparing, undefined);
});

test('naturally queued work also has a bounded incomplete-cover lifetime', () => {
  const f = fixture({ requestTimeoutMs: 500 });
  f.renderer.requestTileContents(f.a.children[1]);
  f.update();
  assert.equal(f.requests.length, 1);
  assert.equal(f.update({ now: 501 }).reason, 'request-timeout');
  assert.deepEqual(f.coordinator.retainedTiles(), []);
  assert.equal(f.a.__ltdsRegionalCoverPreparing, undefined);
});

test('an exact known allocation at the hard cap remains admissible', () => {
  const f = fixture();
  f.renderer.lruCache.maxBytesSize = 300;
  f.a.children[0].knownBytes = 100;
  assert.equal(f.update().phase, 'prefetch');
  assert.equal(f.requests.length, 1);
});
