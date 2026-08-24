export const MIN_LOD_DETAIL = 2;
export const MAX_LOD_DETAIL = 24;

export function detailToErrorTarget(value) {
  const parsed = Number.parseInt(value, 10);
  const detail = Number.isFinite(parsed)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsed))
    : 20;
  return 26 - detail;
}

// The active close-up REPLACE frontier needs room to finish loading before an
// eviction pass begins. Once it is no longer in the view, keep only a bounded
// warm cache so a pan can refine a new area instead of pinning the whole model.
export function lodCacheBudget(deviceMemoryGiB) {
  const memory = Number(deviceMemoryGiB);
  if (Number.isFinite(memory) && memory <= 4) {
    return {
      minBytesSize: 384 * 1024 * 1024,
      maxBytesSize: 768 * 1024 * 1024,
      minSize: 8,
      maxSize: 24,
      unloadPercent: 0.20,
    };
  }

  return {
    minBytesSize: 0.4 * 1024 * 1024 * 1024,
    maxBytesSize: 1.75 * 1024 * 1024 * 1024,
    minSize: 8,
    maxSize: 48,
    unloadPercent: 0.20,
  };
}

export function configureLodRenderer(tilesRenderer, {
  camera,
  renderer,
  detail = 20,
  deviceMemoryGiB,
} = {}) {
  tilesRenderer.setCamera(camera);
  tilesRenderer.setResolutionFromRenderer(camera, renderer);
  tilesRenderer.errorTarget = detailToErrorTarget(detail);
  tilesRenderer.loadAncestors = false;
  tilesRenderer.loadSiblings = false;
  tilesRenderer.maxDepth = Infinity;

  const budget = lodCacheBudget(deviceMemoryGiB);
  Object.assign(tilesRenderer.lruCache, budget);
  return budget;
}

export function refreshLodResolution(tilesRenderer, camera, renderer) {
  if (!tilesRenderer) return false;
  tilesRenderer.setResolutionFromRenderer(camera, renderer);
  return true;
}

function contentUri(tile) {
  return tile?.content?.uri || tile?.content?.url || '';
}

function isExternalTileset(uri) {
  return /\.json(?:[?#].*)?$/i.test(uri);
}

// The manifest is validated as REPLACE before this runs. A root B3DM can then
// remain as a coarse visual underlay at runtime while its child branches retain
// normal REPLACE selection. Roots that only delegate to another tileset cannot
// provide that coverage and are deliberately left alone.
export function enableRootLodBackdrop(tilesRenderer) {
  const root = tilesRenderer?.root;
  const uri = contentUri(root);
  if (!root || !uri || isExternalTileset(uri)) return false;
  root.refine = 'ADD';
  return true;
}

// `3d-tiles-renderer` keeps a REPLACE leaf visible while its replacement
// transition settles. With the root backdrop present, a zero-error leaf can be
// released once its parent is outside the frustum or already meets the current
// error target. That lets an old close-up frontier make room for the next one.
export function releaseStaleLodDetails(tilesRenderer) {
  const root = tilesRenderer?.root;
  if (!root || String(root.refine || '').toUpperCase() !== 'ADD') return 0;

  const { errorTarget, lruCache } = tilesRenderer;
  let released = 0;
  const visit = (tile, parent = null) => {
    const children = Array.isArray(tile?.children) ? tile.children : [];
    for (const child of children) visit(child, tile);

    const isFineLeaf = tile?.geometricError === 0 && children.length === 0;
    const parentTraversal = parent?.traversal;
    if (!isFineLeaf || !parentTraversal) return;

    const parentIsOutOfView = parentTraversal.inFrustum === false;
    const parentIsCoarseEnough = Number.isFinite(parentTraversal.error)
      && parentTraversal.error <= errorTarget;
    if (!parentIsOutOfView && !parentIsCoarseEnough) return;

    const wasVisible = Boolean(tile?.traversal?.visible);
    const wasActive = Boolean(tile?.traversal?.active);
    if (!wasVisible && !wasActive) return;

    // 3d-tiles-renderer caches scene objects. Its visibility API detaches and
    // reattaches those objects, so changing scene.visible here would leave a
    // cached leaf permanently hidden when the camera returns.
    if (wasVisible) tilesRenderer.setTileVisible?.(tile, false);
    if (wasActive) tilesRenderer.setTileActive?.(tile, false);
    if (tile.traversal) {
      tile.traversal.visible = false;
      tile.traversal.active = false;
    }
    lruCache?.markUnused?.(tile);
    if (wasVisible && Number.isFinite(tilesRenderer.stats?.visible)) {
      tilesRenderer.stats.visible = Math.max(0, tilesRenderer.stats.visible - 1);
    }
    if (wasActive && Number.isFinite(tilesRenderer.stats?.active)) {
      tilesRenderer.stats.active = Math.max(0, tilesRenderer.stats.active - 1);
    }
    released += 1;
  };

  visit(root);
  if (released) lruCache?.scheduleUnload?.();
  return released;
}

export function inspectLodProvenance(provenance, fullMeshUrl) {
  const errors = [];
  if (!provenance || typeof provenance !== 'object') {
    return { verified: false, errors: ['lod-provenance.json is required'] };
  }

  if (provenance.schemaVersion !== 2) errors.push('schemaVersion must be 2 (audited leaf equivalence)');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.sourceSha256 || ''))) {
    errors.push('sourceSha256 must be a SHA-256 digest');
  }
  if (provenance.geometry !== 'bounded-triangle-equivalence') {
    errors.push('geometry must be bounded-triangle-equivalence');
  }
  if (provenance.textures !== 'byte-identical-material-equivalence') {
    errors.push('textures must be byte-identical-material-equivalence');
  }
  if (provenance.leafGeometricError !== 0) errors.push('leafGeometricError must be 0');
  if (provenance.audit?.algorithm !== 'ltds-glb-leaf-equivalence-v2') {
    errors.push('recognized LOD equivalence audit evidence is required');
  }
  if (!Number.isInteger(provenance.audit?.triangleCount) || provenance.audit.triangleCount < 1) {
    errors.push('audit triangleCount must be a positive integer');
  }
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.audit?.equivalenceSha256 || ''))) {
    errors.push('audit equivalenceSha256 must be a SHA-256 digest');
  }
  const tolerance = provenance.audit?.coordinateTolerance;
  const maxDelta = provenance.audit?.maxNumericDelta;
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1e-3) {
    errors.push('audit coordinateTolerance must be between 0 and 0.001');
  }
  if (!Number.isFinite(maxDelta) || maxDelta < 0 || maxDelta > tolerance) {
    errors.push('audit maxNumericDelta must not exceed coordinateTolerance');
  }
  if (!Number.isInteger(provenance.audit?.artifactCount) || provenance.audit.artifactCount < 2) {
    errors.push('audit artifactCount must bind the tileset and leaf artifacts');
  }

  let expectedSource = '';
  try {
    expectedSource = decodeURIComponent(new URL(fullMeshUrl, 'https://viewer.invalid').pathname.split('/').pop() || '');
  } catch {
    expectedSource = '';
  }
  if (!expectedSource || provenance.sourceAsset !== expectedSource) {
    errors.push('sourceAsset must name the active full-resolution mesh');
  }
  if (!/\.glb$/i.test(String(provenance.sourceAsset || ''))) {
    errors.push('audited sourceAsset must be a GLB');
  }

  return { verified: errors.length === 0, errors };
}

export function decideLodStartup(tilesetReport, provenanceReport, hasFullMesh) {
  if (!tilesetReport?.valid) {
    return {
      action: hasFullMesh ? 'fallback-full-mesh' : 'disable-lod',
      reason: `LOD manifest cannot reach a valid full-detail frontier: ${tilesetReport?.errors?.[0] || 'invalid manifest'}`,
    };
  }
  if (!provenanceReport?.verified) {
    return {
      action: hasFullMesh ? 'fallback-full-mesh' : 'disable-lod',
      reason: `LOD full-resolution provenance is not verified: ${provenanceReport?.errors?.[0] || 'missing provenance'}`,
    };
  }
  return { action: 'stream-lod', reason: null };
}

// This verifies that selection can reach a zero-geometric-error REPLACE
// frontier. It cannot prove that an external converter preserved the source
// mesh's triangles and textures; that requires derivative provenance.
export function inspectLodTileset(tileset) {
  const errors = [];
  const warnings = [];
  let nodeCount = 0;
  let terminalLeafCount = 0;
  let externalTilesetCount = 0;
  let maxDepth = 0;

  if (!tileset || !tileset.root || typeof tileset.root !== 'object') {
    return {
      valid: false,
      canConvergeToZeroError: false,
      nodeCount,
      terminalLeafCount,
      externalTilesetCount,
      maxDepth,
      errors: ['tileset.root is required'],
      warnings,
    };
  }

  function walk(tile, parentError, inheritedRefine, depth, path) {
    nodeCount += 1;
    maxDepth = Math.max(maxDepth, depth);

    const error = tile.geometricError;
    if (typeof error !== 'number' || !Number.isFinite(error) || error < 0) {
      errors.push(`${path}.geometricError must be a finite non-negative number`);
    } else if (Number.isFinite(parentError) && error > parentError) {
      errors.push(`${path}.geometricError must not exceed its parent's error`);
    }

    const refine = String(tile.refine || inheritedRefine || 'ADD').toUpperCase();
    const children = Array.isArray(tile.children) ? tile.children : [];
    const uri = contentUri(tile);
    const external = Boolean(uri) && isExternalTileset(uri);

    if (children.length > 0 && refine !== 'REPLACE') {
      errors.push(`${path} must use REPLACE refinement for full-resolution substitution`);
    }
    // A zero-error internal node already satisfies every possible screen-space
    // error target, so a conforming renderer has no reason to select its
    // children. Calling such a hierarchy convergent would be false even when
    // those unreachable terminal children themselves declare zero error.
    if (children.length > 0 && error === 0) {
      errors.push(`${path}.geometricError must be greater than zero while the tile has children`);
    }

    if (external) {
      externalTilesetCount += 1;
      warnings.push(`${path} references an external tileset; validate that manifest separately`);
    }

    if (children.length === 0 && !external) {
      terminalLeafCount += 1;
      if (!uri) errors.push(`${path} is a terminal leaf without renderable content`);
      if (typeof error === 'number' && Number.isFinite(error) && error !== 0) {
        errors.push(`${path} is terminal but declares non-zero geometricError (${error})`);
      }
    }

    children.forEach((child, index) => {
      walk(child, error, refine, depth + 1, `${path}.children[${index}]`);
    });
  }

  walk(tileset.root, Infinity, null, 0, 'root');
  const canConvergeToZeroError = errors.length === 0 && terminalLeafCount > 0 && externalTilesetCount === 0;
  return {
    valid: errors.length === 0,
    canConvergeToZeroError,
    nodeCount,
    terminalLeafCount,
    externalTilesetCount,
    maxDepth,
    errors,
    warnings,
  };
}

export function visibleLodFrontier(root) {
  const visible = [];
  if (!root) return { visibleCount: 0, fullDetail: false, maximumGeometricError: null };

  const stack = [root];
  while (stack.length) {
    const tile = stack.pop();
    if (tile?.traversal?.visible) visible.push(tile);
    if (Array.isArray(tile?.children)) stack.push(...tile.children);
  }

  // A runtime-only ADD root is a coarse backdrop, not part of the currently
  // selected REPLACE frontier. Count it by itself when it is all that is
  // visible, but ignore it whenever a more detailed descendant is rendering.
  const hasBackdropRoot = String(root.refine || '').toUpperCase() === 'ADD';
  const visibleDescendants = hasBackdropRoot ? visible.filter((tile) => tile !== root) : [];
  const frontier = visibleDescendants.length ? visibleDescendants : visible;

  let maximumGeometricError = 0;
  for (const tile of frontier) {
    const error = tile.geometricError;
    if (typeof error !== 'number' || !Number.isFinite(error)) return {
      visibleCount: frontier.length,
      fullDetail: false,
      maximumGeometricError: null,
    };
    maximumGeometricError = Math.max(maximumGeometricError, error);
  }

  return {
    visibleCount: frontier.length,
    fullDetail: frontier.length > 0 && maximumGeometricError === 0,
    maximumGeometricError: frontier.length ? maximumGeometricError : null,
  };
}
