export const MIN_LOD_DETAIL = 2;
export const MAX_LOD_DETAIL = 24;
const CONTROLLED_CONVERTER_BINARY_SHA256 = new Set(['40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274','c54dbcbe953640f2aa0e7c2568709108a97063dac492781c9560a5042e46d9b1']);

export function detailToErrorTarget(value) {
  const parsed = Number.parseInt(value, 10);
  const detail = Number.isFinite(parsed)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsed))
    : MAX_LOD_DETAIL;
  const coarseFraction = (MAX_LOD_DETAIL - detail) / (MAX_LOD_DETAIL - MIN_LOD_DETAIL);
  return Number((2 * Math.pow(256, coarseFraction)).toFixed(3));
}

// PriorityQueue callbacks return 1 when `a` should be processed first. Keep
// optimized traversal (no ancestor/sibling overfetch), but prefer the currently
// visible tile with the greatest screen-space error before camera distance.
export function screenSpaceErrorPriority(a, b) {
  const aPriority = a?.priority ?? 0;
  const bPriority = b?.priority ?? 0;
  if (aPriority !== bPriority) return aPriority > bPriority ? 1 : -1;

  const at = a?.traversal;
  const bt = b?.traversal;
  if (!at || !bt) return 0;
  if (at.used !== bt.used) return at.used ? 1 : -1;
  if (at.inFrustum !== bt.inFrustum) return at.inFrustum ? 1 : -1;

  const aError = Number.isFinite(at.error) ? at.error : -Infinity;
  const bError = Number.isFinite(bt.error) ? bt.error : -Infinity;
  if (aError !== bError) return aError > bError ? 1 : -1;

  const aDistance = Number.isFinite(at.distanceFromCamera) ? at.distanceFromCamera : Infinity;
  const bDistance = Number.isFinite(bt.distanceFromCamera) ? bt.distanceFromCamera : Infinity;
  if (aDistance !== bDistance) return aDistance > bDistance ? -1 : 1;

  const aDepth = a?.internal?.depthFromRenderedParent ?? 0;
  const bDepth = b?.internal?.depthFromRenderedParent ?? 0;
  if (aDepth !== bDepth) return aDepth > bDepth ? -1 : 1;
  return 0;
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
  detail = MAX_LOD_DETAIL,
  deviceMemoryGiB,
} = {}) {
  tilesRenderer.setCamera(camera);
  tilesRenderer.setResolutionFromRenderer(camera, renderer);
  tilesRenderer.errorTarget = detailToErrorTarget(detail);
  tilesRenderer.loadAncestors = false;
  tilesRenderer.loadSiblings = false;
  tilesRenderer.maxDepth = Infinity;
  if (tilesRenderer.downloadQueue) {
    tilesRenderer.downloadQueue.priorityCallback = screenSpaceErrorPriority;
    const current = Number(tilesRenderer.downloadQueue.maxJobs);
    tilesRenderer.downloadQueue.maxJobs = Number.isFinite(current) && current > 0 ? Math.min(current, 6) : 6;
  }
  if (tilesRenderer.parseQueue) {
    tilesRenderer.parseQueue.priorityCallback = screenSpaceErrorPriority;
    const current = Number(tilesRenderer.parseQueue.maxJobs);
    tilesRenderer.parseQueue.maxJobs = Number.isFinite(current) && current > 0 ? Math.min(current, 2) : 2;
  }

  const budget = lodCacheBudget(deviceMemoryGiB);
  Object.assign(tilesRenderer.lruCache, budget);
  return budget;
}

export function refreshLodResolution(tilesRenderer, camera, renderer) {
  if (!tilesRenderer) return false;
  tilesRenderer.setResolutionFromRenderer(camera, renderer);
  return true;
}

export function lodQueuesSettled(tilesRenderer) {
  return !tilesRenderer?.downloadQueue?.running
    && !tilesRenderer?.parseQueue?.running
    && !tilesRenderer?.processNodeQueue?.running;
}

function contentUri(tile) {
  return tile?.content?.uri || tile?.content?.url || '';
}

function isExternalTileset(uri) {
  return /\.json(?:[?#].*)?$/i.test(uri);
}

export function enableTransientRootLodBackdrop(tilesRenderer) {
  const root = tilesRenderer?.root;
  const uri = contentUri(root);
  if (!root || !uri || isExternalTileset(uri)) return false;
  const materializeRefinement = (tile, inherited) => {
    const effective = tile?.refine || inherited || 'REPLACE';
    if (tile) tile.refine = effective;
    for (const child of (Array.isArray(tile?.children) ? tile.children : [])) {
      materializeRefinement(child, effective);
    }
  };
  const inherited = root.refine || 'REPLACE';
  for (const child of (Array.isArray(root.children) ? root.children : [])) {
    materializeRefinement(child, inherited);
  }
  root.refine = 'ADD';
  return true;
}

export function syncTransientRootLodBackdrop(tilesRenderer) {
  const root = tilesRenderer?.root;
  const groupChildren = tilesRenderer?.group?.children;
  let requiredLeaves = 0;
  let attachedLeaves = 0;
  const visit = (tile) => {
    const children = Array.isArray(tile?.children) ? tile.children : [];
    for (const child of children) visit(child);
    if (children.length || Number(tile?.geometricError) !== 0
      || tile?.traversal?.used !== true || tile?.traversal?.inFrustum !== true) return;
    requiredLeaves += 1;
    if (tile?.engineData?.scene && groupChildren?.includes?.(tile.engineData.scene)) attachedLeaves += 1;
  };
  visit(root);
  const complete = requiredLeaves > 0 && attachedLeaves === requiredLeaves;
  const backdropVisible = !complete;
  root?.engineData?.scene?.traverse?.((object) => {
    if (!object?.isMesh || !object.material) return;
    for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
      material.visible = backdropVisible;
    }
  });
  return { complete, requiredLeaves, attachedLeaves, backdropVisible };
}

export function releaseStaleLodDetails(tilesRenderer) {
  const root = tilesRenderer?.root;
  if (!root || root.refine !== 'ADD') return 0;
  const groupChildren = tilesRenderer?.group?.children;
  const errorTarget = Number(tilesRenderer?.errorTarget);
  let released = 0;
  const visit = (tile, parent = null) => {
    const children = Array.isArray(tile?.children) ? tile.children : [];
    for (const child of children) visit(child, tile);
    if (children.length || Number(tile?.geometricError) !== 0 || !parent) return;
    const scene = tile?.engineData?.scene;
    const attached = Boolean(scene && groupChildren?.includes?.(scene));
    if (!attached && tile?.traversal?.active !== true && tile?.traversal?.visible !== true) return;

    const leafIsStale = tile?.traversal?.used === false || tile?.traversal?.inFrustum === false;
    const parentMeetsTarget = parent?.traversal?.inFrustum === true
      && Number.isFinite(parent?.traversal?.error)
      && Number.isFinite(errorTarget)
      && parent.traversal.error <= errorTarget;
    if (!leafIsStale && !parentMeetsTarget) return;

    tilesRenderer.setTileVisible?.(tile, false);
    tilesRenderer.setTileActive?.(tile, false);
    if (tile.traversal) {
      tile.traversal.visible = false;
      tile.traversal.active = false;
    }
    tilesRenderer.lruCache?.markUnused?.(tile);
    released += 1;
  };
  visit(root);
  if (released) tilesRenderer.lruCache?.scheduleUnload?.();
  return released;
}

export function inspectLodProvenance(provenance, fullMeshUrl) {
  const errors = [];
  if (!provenance || typeof provenance !== 'object') {
    return { verified: false, errors: ['lod-provenance.json is required'] };
  }

  const exactV2 = provenance.schemaVersion === 2 && provenance.audit?.algorithm === 'ltds-glb-leaf-equivalence-v2';
  const controlledV3 = provenance.schemaVersion === 3 && provenance.audit?.algorithm === 'ltds-obj2tiles-surface-equivalence-v3';
  if (!exactV2 && !controlledV3) errors.push('recognized exact v2 or controlled Obj2Tiles v3 audit evidence is required');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.sourceSha256 || ''))) {
    errors.push('sourceSha256 must be a SHA-256 digest');
  }
  const expectedGeometry = controlledV3 ? 'controlled-bidirectional-surface-equivalence' : 'bounded-triangle-equivalence';
  const expectedTextures = controlledV3 ? 'controlled-atlas-material-equivalence' : 'byte-identical-material-equivalence';
  if (provenance.geometry !== expectedGeometry) errors.push(`geometry must be ${expectedGeometry}`);
  if (provenance.textures !== expectedTextures) errors.push(`textures must be ${expectedTextures}`);
  if (provenance.leafGeometricError !== 0) errors.push('leafGeometricError must be 0');
  if (exactV2 && (!Number.isInteger(provenance.audit?.triangleCount) || provenance.audit.triangleCount < 1)) errors.push('audit triangleCount must be a positive integer');
  if (controlledV3 && (!Number.isInteger(provenance.audit?.sourceTriangleCount) || provenance.audit.sourceTriangleCount < 1 || !Number.isInteger(provenance.audit?.leafTriangleCount) || provenance.audit.leafTriangleCount < 1)) errors.push('controlled audit triangle counts must be positive integers');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.audit?.equivalenceSha256 || ''))) {
    errors.push('audit equivalenceSha256 must be a SHA-256 digest');
  }
  if (exactV2) {
    const tolerance = provenance.audit?.coordinateTolerance;
    const maxDelta = provenance.audit?.maxNumericDelta;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1e-3) errors.push('audit coordinateTolerance must be between 0 and 0.001');
    if (!Number.isFinite(maxDelta) || maxDelta < 0 || maxDelta > tolerance) errors.push('audit maxNumericDelta must not exceed coordinateTolerance');
  }
  if (controlledV3) {
    if (provenance.converter?.name !== 'OpenDroneMap/Obj2Tiles' || provenance.converter?.version !== '1.6.2' || provenance.converter?.commandSha256 !== '7d82c354b3d65985e602454c0bcc204fe8e75d8efc1826b76a5681d85c34f681' || !CONTROLLED_CONVERTER_BINARY_SHA256.has(String(provenance.converter?.binarySha256||'').toLowerCase())) errors.push('controlled audit converter contract is invalid');
    if (!Number.isFinite(provenance.audit?.surfaceTolerance) || provenance.audit.surfaceTolerance <= 0 || !Number.isFinite(provenance.audit?.maximumSurfaceDistance) || provenance.audit.maximumSurfaceDistance < 0 || provenance.audit.maximumSurfaceDistance > provenance.audit.surfaceTolerance || !Number.isFinite(provenance.audit?.minimumNormalDot) || !Number.isFinite(provenance.audit?.maximumReversedNormalFraction) || provenance.audit.maximumReversedNormalFraction < 0 || provenance.audit.maximumReversedNormalFraction > 0.01) errors.push('controlled audit surface evidence is invalid');
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
