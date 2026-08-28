export const MIN_LOD_DETAIL = 2;
export const MAX_LOD_DETAIL = 24;
export const LOD_WARMUP_DETAIL = 13;
export const LOW_MEMORY_MAX_LOD_DETAIL = 13;
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
// The renderer registers decoded bytes only after concurrent downloads/parses
// complete, so several in-flight tiles can make cachedBytes overshoot the hard
// ceiling before isFull() blocks the next request. The desktop cap therefore
// needs bounded headroom above both the 2.53 GiB complete active frontier and
// the measured 2.784 GiB branch-replacement transition peak. minBytesSize
// still drives unused content back to a small warm cache.
export function lodCacheBudget(deviceMemoryGiB) {
  const memory = Number(deviceMemoryGiB);
  if (Number.isFinite(memory) && memory <= 4) {
    // Low-memory clients intentionally retain a coarse/fallback profile. The
    // measured full-detail frontier for the large Rome Dam fixture is over
    // 2.3 GiB, which is not safe to promise inside a 4 GiB browser process.
    return {
      minBytesSize: 384 * 1024 * 1024,
      maxBytesSize: 768 * 1024 * 1024,
      minSize: 24,
      maxSize: 512,
      unloadPercent: 0.20,
    };
  }

  return {
    minBytesSize: 0.4 * 1024 * 1024 * 1024,
    maxBytesSize: 3 * 1024 * 1024 * 1024,
    minSize: 24,
    maxSize: 1024,
    unloadPercent: 0.20,
  };
}

export function lodRuntimeProfile(requestedDetail, deviceMemoryGiB) {
  const parsed = Number.parseInt(requestedDetail, 10);
  const requested = Number.isFinite(parsed)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsed))
    : MAX_LOD_DETAIL;
  const memory = Number(deviceMemoryGiB);
  const reduced = Number.isFinite(memory) && memory <= 4;
  const maximumDetail = reduced ? LOW_MEMORY_MAX_LOD_DETAIL : MAX_LOD_DETAIL;
  const cappedRequest = Math.min(requested, maximumDetail);
  return {
    budget: lodCacheBudget(deviceMemoryGiB),
    requestedDetail: requested,
    activeDetail: Math.min(cappedRequest, LOD_WARMUP_DETAIL),
    maximumDetail,
    reduced,
  };
}

export function lodWarmupSatisfiedByDetail(activeDetail) {
  const parsed = Number.parseInt(activeDetail, 10);
  return Number.isFinite(parsed) && parsed >= LOD_WARMUP_DETAIL;
}

export function resolveLodDetailRequest(profile, warmupComplete, requestedDetail) {
  const parsed = Number.parseInt(requestedDetail, 10);
  const requested = Number.isFinite(parsed)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsed))
    : MAX_LOD_DETAIL;
  const maximumDetail = Number.isFinite(Number(profile?.maximumDetail))
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, Number(profile.maximumDetail)))
    : MAX_LOD_DETAIL;
  const targetDetail = Math.min(requested, maximumDetail);
  if (profile?.reduced) {
    return { requestedDetail: requested, activeDetail: targetDetail, warmupComplete: true };
  }
  if (targetDetail < LOD_WARMUP_DETAIL) {
    return { requestedDetail: requested, activeDetail: targetDetail, warmupComplete: false };
  }
  if (targetDetail === LOD_WARMUP_DETAIL) {
    return { requestedDetail: requested, activeDetail: targetDetail, warmupComplete: Boolean(warmupComplete) };
  }
  if (warmupComplete) {
    return { requestedDetail: requested, activeDetail: targetDetail, warmupComplete: true };
  }
  return { requestedDetail: requested, activeDetail: LOD_WARMUP_DETAIL, warmupComplete: false };
}

export function resolveLodWarmupAdvance(profile) {
  if (profile?.reduced || !lodWarmupSatisfiedByDetail(profile?.activeDetail)) return null;
  return resolveLodDetailRequest(profile, true, profile?.requestedDetail);
}

export function configureLodRenderer(tilesRenderer, {
  camera,
  renderer,
  detail = MAX_LOD_DETAIL,
  deviceMemoryGiB,
} = {}) {
  tilesRenderer.setCamera(camera);
  tilesRenderer.setResolutionFromRenderer(camera, renderer);
  const profile = lodRuntimeProfile(detail, deviceMemoryGiB);
  tilesRenderer.errorTarget = detailToErrorTarget(profile.activeDetail);
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

  Object.assign(tilesRenderer.lruCache, profile.budget);
  return profile;
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

export function detectLodStarvation(snapshot, consecutiveSamples = 0, threshold = 3) {
  const previousCount = Number.isInteger(consecutiveSamples) && consecutiveSamples > 0
    ? consecutiveSamples
    : 0;
  const parsedThreshold = Number.parseInt(threshold, 10);
  const requiredSamples = Number.isFinite(parsedThreshold) && parsedThreshold > 0
    ? parsedThreshold
    : 3;
  const queues = snapshot?.queues;
  const blocked = snapshot?.cache?.full === true
    && Number(snapshot?.pendingRequiredLeaves) > 0
    && queues?.download !== true
    && queues?.parse !== true
    && queues?.process !== true;
  const count = blocked ? previousCount + 1 : 0;
  return { count, starved: blocked && count >= requiredSamples };
}

export function resolveLodMemoryPressure(profile, starvedAtDetail = null) {
  const parsedActiveDetail = Number.parseInt(profile?.activeDetail, 10);
  if (!Number.isFinite(parsedActiveDetail)) return null;
  const activeDetail = Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsedActiveDetail));

  // `Number(null)` is zero, so an unset ceiling must be handled before any
  // numeric conversion. The lowest detail that has failed remains the ceiling
  // until an explicit user action clears it.
  const hasCeiling = starvedAtDetail !== null && starvedAtDetail !== undefined;
  const parsedCeiling = hasCeiling ? Number.parseInt(starvedAtDetail, 10) : null;
  const ceiling = Number.isFinite(parsedCeiling)
    ? Math.min(MAX_LOD_DETAIL, Math.max(MIN_LOD_DETAIL, parsedCeiling))
    : activeDetail;
  const effectiveCeiling = Math.min(activeDetail, ceiling);
  const nextActiveDetail = Math.max(MIN_LOD_DETAIL, effectiveCeiling - 1);
  if (nextActiveDetail >= activeDetail) return null;

  return {
    ...profile,
    activeDetail: nextActiveDetail,
    starvedAtDetail: effectiveCeiling,
  };
}

export function advanceLodMemoryPressure(snapshot, profile, {
  consecutiveSamples = 0,
  starvedAtDetail = null,
} = {}) {
  const starvation = detectLodStarvation(snapshot, consecutiveSamples);
  if (!starvation.starved) {
    return {
      changed: false,
      profile,
      consecutiveSamples: starvation.count,
      starvedAtDetail,
    };
  }

  const pressure = resolveLodMemoryPressure(profile, starvedAtDetail);
  if (!pressure) {
    return {
      changed: false,
      profile,
      consecutiveSamples: starvation.count,
      starvedAtDetail,
    };
  }

  const { starvedAtDetail: nextCeiling, ...nextProfile } = pressure;
  return {
    changed: true,
    profile: nextProfile,
    consecutiveSamples: 0,
    starvedAtDetail: nextCeiling,
  };
}

export function visibleLodTargetSatisfied(root, errorTarget) {
  const target = Number(errorTarget);
  if (!root || !Number.isFinite(target)) return false;
  let visibleCount = 0;
  let satisfied = true;
  const stack = [root];
  while (stack.length) {
    const tile = stack.pop();
    const children = Array.isArray(tile?.children) ? tile.children : [];
    if (tile?.traversal?.visible === true) {
      visibleCount += 1;
      const error = Number(tile.traversal.error);
      const terminalZeroErrorLeaf = children.length === 0 && tile?.geometricError === 0;
      if (!terminalZeroErrorLeaf && (!Number.isFinite(error) || error > target)) satisfied = false;
    }
    stack.push(...children);
  }
  return visibleCount > 0 && satisfied;
}

function contentUri(tile) {
  return tile?.content?.uri || tile?.content?.url || '';
}

function isExternalTileset(uri) {
  return /\.json(?:[?#].*)?$/i.test(uri);
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

export function lodDebugSnapshot(tilesRenderer, runtimeProfile, warmupComplete) {
  const root = tilesRenderer?.root;
  const attachedScenes = tilesRenderer?.group?.children || [];
  const visible = { root: 0, lod0: 0, lod1: 0, other: 0 };
  let requiredLeaves = 0;
  let attachedRequiredLeaves = 0;
  let pendingRequiredLeaves = 0;
  const safeLabel = (tile) => {
    const raw = String(contentUri(tile) || '').split(/[?#]/, 1)[0].replace(/\\/g, '/');
    const match = raw.match(/(?:^|\/)(LOD-\d+\/[A-Za-z0-9._-]+\.b3dm)$/i);
    return match ? match[1] : 'tile';
  };
  const visit = (tile) => {
    if (!tile) return;
    const children = Array.isArray(tile.children) ? tile.children : [];
    for (const child of children) visit(child);
    const label = safeLabel(tile);
    if (tile?.traversal?.visible === true) {
      if (tile === root) visible.root += 1;
      else if (/^LOD-0\//i.test(label)) visible.lod0 += 1;
      else if (/^LOD-1\//i.test(label)) visible.lod1 += 1;
      else visible.other += 1;
    }
    if (children.length || Number(tile.geometricError) !== 0
      || tile?.traversal?.used !== true || tile?.traversal?.inFrustum !== true) return;
    requiredLeaves += 1;
    const attached = Boolean(tile?.engineData?.scene && attachedScenes.includes?.(tile.engineData.scene));
    if (attached) attachedRequiredLeaves += 1;
    else pendingRequiredLeaves += 1;
  };
  visit(root);

  const toMiB = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value) / (1024 * 1024)) : null;
  const memoryLimited = runtimeProfile?.starvedAtDetail !== null
    && runtimeProfile?.starvedAtDetail !== undefined
    && Number(runtimeProfile?.activeDetail) < Number(runtimeProfile?.requestedDetail);
  return {
    phase: memoryLimited
      ? 'memory-limited'
      : runtimeProfile?.reduced ? 'reduced-memory' : warmupComplete ? 'requested-detail' : 'warmup',
    requestedDetail: Number(runtimeProfile?.requestedDetail) || null,
    activeDetail: Number(runtimeProfile?.activeDetail) || null,
    maximumDetail: Number(runtimeProfile?.maximumDetail) || null,
    errorTarget: Number.isFinite(Number(tilesRenderer?.errorTarget)) ? Number(tilesRenderer.errorTarget) : null,
    visible,
    requiredLeaves,
    attachedRequiredLeaves,
    pendingRequiredLeaves,
    queues: {
      download: Boolean(tilesRenderer?.downloadQueue?.running),
      parse: Boolean(tilesRenderer?.parseQueue?.running),
      process: Boolean(tilesRenderer?.processNodeQueue?.running),
    },
    cache: {
      usedMiB: toMiB(tilesRenderer?.lruCache?.cachedBytes),
      maxMiB: toMiB(tilesRenderer?.lruCache?.maxBytesSize),
      full: Boolean(tilesRenderer?.lruCache?.isFull?.()),
    },
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
