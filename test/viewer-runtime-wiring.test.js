'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('viewer 3D mode is streaming-only and keeps original mesh access outside layer UI', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(main, /state\.meshSource = TILES_URL \? 'tiles' : \(GLB_URL \|\| OBJ_URL \? 'lod-required' : 'none'\)/);
  assert.match(main, /Streaming LOD unavailable/);
  assert.match(main, /full-resolution source remains available for authenticated download in Operations/);
  assert.doesNotMatch(main, /function loadGLB|loadGLB\(|function loadObjDirect|loadObjDirect\(/);
  assert.doesNotMatch(main, /GLTFLoader|DRACOLoader|OBJLoader|MTLLoader|fetchAssetArrayBufferByRange/);
  assert.doesNotMatch(main, /data-layer=['"]glb|layer-glb/);
  assert.doesNotMatch(html, /data-layer="glb"|id="layer-glb"|Full-Res Mesh/);
  assert.match(main, /if \(state\.meshSource !== 'tiles'\) return/);
  assert.match(main, /if \(state\.meshSource === 'tiles'\) \{\s*tilesParent\.visible = true;\s*loadTiles\(\)/);
  assert.match(main, /scheduleLodAvailabilityRefresh/);
  assert.match(main, /await currentViewerSession\(\)/);
  assert.match(main, /previousMeshSource === 'lod-required' && state\.meshSource === 'tiles'/);
  assert.match(main, /hideLoading\(\);\s*scheduleLodAvailabilityRefresh\(\);/);
});

test('viewer keeps gap-free REPLACE traversal and stages desktop detail through complete frontiers', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const materials = fs.readFileSync(path.join(__dirname, '..', 'lod-materials.mjs'), 'utf8');
  const lodPolicy = fs.readFileSync(path.join(__dirname, '..', 'lod-policy.mjs'), 'utf8');
  assert.doesNotMatch(main, /enableTransientRootLodBackdrop|syncTransientRootLodBackdrop|releaseStaleLodDetails|transientRootBackdropEnabled/);
  assert.doesNotMatch(lodPolicy, /root\.refine\s*=\s*['"]ADD['"]/);
  assert.match(lodPolicy, /tilesRenderer\.loadAncestors = false/);
  assert.match(lodPolicy, /tilesRenderer\.loadSiblings = false/);
  assert.match(lodPolicy, /tilesRenderer\.loadAncestorSiblings = false/);
  const rootStart = main.indexOf("rendererInstance.addEventListener('load-root-tileset'");
  const tilesetStart = main.indexOf("rendererInstance.addEventListener('load-tileset'");
  const modelStart = main.indexOf("rendererInstance.addEventListener('load-model'");
  assert.ok(rootStart >= 0 && tilesetStart > rootStart && modelStart > tilesetStart, 'LOD event handlers are present in order');
  const rootHandler = main.slice(rootStart, tilesetStart);
  assert.match(rootHandler, /const decision = decideLodStartup\(/);
  assert.match(rootHandler, /if \(decision\.action !== 'stream-lod'\)\s*\{[\s\S]*?return;\s*\}/);
  assert.doesNotMatch(rootHandler, /root\.refine\s*=/);
  assert.match(rootHandler, /rendererInstance\.root\?\.internal\?\.hasRenderableContent/);
  assert.match(rootHandler, /rendererInstance\.requestTileContents\(rendererInstance\.root\)/);
  assert.match(rootHandler, /const bounds = tilesetWorldBounds/);
  assert.match(rootHandler, /frameBoundsHome\(bounds, \{ apply: !preserveIncomingModelView \}\)/);
  assert.doesNotMatch(rootHandler, /if \(!homeView\)/);
  assert.match(main, /if \(tilesRenderer !== rendererInstance\) return;/);
  assert.match(main, /import \{ homeViewForBounds, tilesetWorldBounds \} from '\.\/viewer-framing\.mjs'/);
  assert.match(main, /import \{ preserveLodMaterials \} from '\.\/lod-materials\.mjs'/);
  assert.match(materials, /function preserveLodMaterials\(source\)/);
  assert.match(materials, /const originals = Array\.isArray\(source\) \? source : \[source\]/);
  assert.match(materials, /const replacements = originals\.map\(\(material\) => unlitLodMaterial\(material\)\)/);
  assert.match(materials, /map,\s*lightMap: source\?\.lightMap/);
  assert.match(materials, /vertexColors: Boolean\(source\?\.vertexColors\)/);
  assert.match(main, /c\.material = preserveLodMaterials\(c\.material\)/);
  assert.doesNotMatch(main, /updateLodReplacementFallbacks/);
  assert.match(main, /addEventListener\('load-model',[\s\S]*?hideLoading\(\)/);
  assert.match(main, /function maybeAdvanceLodWarmup\(\)/);
  assert.match(main, /lodLastSettledDetail = lodRuntimeProfileState\.activeDetail/);
  assert.match(main, /if \(!lodDetailRequestPending\(lodRuntimeProfileState\)\) return false;\s*const advance/);
  assert.match(main, /visibleLodTargetSatisfied\(tilesRenderer\.root, tilesRenderer\.errorTarget\)/);
  assert.match(main, /const advance = resolveLodWarmupAdvance\(lodRuntimeProfileState\)/);
  assert.match(main, /Object\.assign\(lodRuntimeProfileState, advance\)/);
  assert.match(main, /tilesRenderer\.errorTarget = lodTargetForDetail\(targetDetail\)/);
  assert.match(main, /function maybeAdvanceLodBootstrap\(\)/);
  assert.match(main, /lodBootstrapRootTarget = lodBootstrapRootErrorTarget\(root\?\.traversal\?\.error\)/);
  assert.match(main, /lodBootstrapCoverageTarget = lodBootstrapCoverageErrorTarget\(/);
  assert.match(main, /if \(lodRuntimeProfileState\.reduced\) \{/);
  assert.match(main, /lodOverviewTiles = \[root\]/);
  assert.match(main, /emitLodDebugSnapshot\('reduced-overview-ready', true\)/);
  assert.match(main, /root\?\.traversal\?\.visible === true && lodTileSceneAttached\(root\)/);
  assert.match(main, /visibleLodTargetSatisfied\(root, lodBootstrapCoverageTarget\)/);
  assert.match(main, /lodErrorScale = lodErrorScaleForCoverage\(lodBootstrapCoverageTarget\)/);
  assert.match(main, /lodOverviewTiles = captureLodOverviewTiles\(root\)/);
  assert.match(main, /lodCacheMaxBytesForOverview\(/);
  assert.match(main, /tilesRenderer\.lruCache\.maxBytesSize = expandedMaxBytes/);
  assert.match(main, /restoreLodOverviewRetention = installLodOverviewRetention\(/);
  assert.match(main, /if \(restoreLodOverviewRetention\) restoreLodOverviewRetention\(\);\s*restoreLodOverviewRetention = null;/);
  assert.doesNotMatch(main, /rendererInstance\.lruCache\.scheduleUnload =/);
  assert.match(main, /lodRuntimeProfileState\.activeDetail = Math\.min\(\s*lodRuntimeProfileState\.maximumDetail,\s*lodRuntimeProfileState\.requestedDetail/);
  assert.match(main, /lodWarmupComplete = lodRuntimeProfileState\.reduced/);
  assert.match(main, /LOD: reduced-memory/);
  assert.doesNotMatch(main, /engineData\.scene\.visible\s*=/);
  assert.match(main, /tilesRenderer\.update\(\);\s*if \(!maybeAdvanceLodBootstrap\(\)\) maybeAdvanceLodWarmup\(\)/);
  assert.match(main, /preserveIncomingModelView = !tilesRenderer\?\.root;\s*controls\.setView\(camW, tgtW\)/);
});

test('orthophoto nodata uses the supported GeoTIFF image API', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /parseFiniteGdalNoData\(image\.getGDALNoData\(\)\)/);
  assert.doesNotMatch(main, /fileDirectory\?\.GDAL_NODATA/);
});

test('map modes expose projected distance and area tools with deeper native-detail zoom', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(main, /function setMapTool\(tool\)/);
  assert.match(main, /function mapDistanceMeters\(points\)/);
  assert.match(main, /function mapAreaSquareMeters\(points\)/);
  assert.match(main, /maxZoom: 28/);
  assert.match(main, /panel-measure'\)\.style\.display = SHARE_PERMISSIONS\.measure/);
  assert.match(main, /async function ensureVolumeDataset/);
  assert.match(main, /await ensureVolumeDataset\(modeAbortController\?\.signal\)/);
  assert.match(main, /This task has no published DSM or DTM/);
  assert.match(main, /The selected DSM\/DTM loads automatically when Volume is chosen/);
  assert.match(main, /integrateElevationVolume/);
  assert.match(html, /Auto \(prefer DSM\)/);
  assert.match(html, /Lowest sampled point/);
  assert.match(html, /Average surface/);
  assert.match(html, /Custom elevation/);
  assert.match(html, /Use Measurements for map distance and area/);
});

test('point-cloud parent accepts health messages only from its same-origin iframe', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /event\.origin !== location\.origin \|\| event\.source !== iframe\.contentWindow/);
  assert.match(main, /message\.source !== 'ltds-pointcloud'/);
  assert.match(main, /message\.type === 'ready' && message\.code === 'points_visible'/);
  assert.match(main, /POINT_CLOUD_FAILURE_CODES\.has\(message\.code\)/);
  assert.match(main, /Cloud: unavailable \(\$\{code\}; ref \$\{DIAGNOSTIC_CORRELATION_ID\.slice\(0, 8\)\}\)/);
  assert.doesNotMatch(main, /cloudStatus\.textContent\s*=\s*message\.(?:code|error|detail)/);
});

test('viewer mode lifecycle cancels stale initializers and persists history', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /viewerModeFromUrl\(location\.href\)/);
  assert.match(main, /history\[historyMode === 'replace' \? 'replaceState' : 'pushState'\]/);
  assert.match(main, /window\.addEventListener\('popstate'/);
  assert.match(main, /modeEpoch \+= 1/);
  assert.match(main, /modeAbortController\?\.abort\(\)/);
  assert.match(main, /modeAbortController = new AbortController\(\)/);
  assert.match(main, /stopPointCloudIframe\('superseded'\)/);
  assert.match(main, /stopDirectPointCloud\('superseded'\)/);
  assert.match(main, /directPointCloudLoad\.controller\.abort\(\)/);
  assert.match(main, /iframe\.src = 'about:blank'/);
  assert.match(main, /disposeTiles\(\)/);
  assert.match(main, /epoch !== modeEpoch \|\| state\.activeMode !== 'ortho'/);
  assert.match(main, /epoch !== modeEpoch \|\| state\.activeMode !== type/);
  assert.match(main, /openGeoTiff\(url, \{ allowFullFile: false, blockSize: 262144, cacheSize: 128 \}, signal\)/);
  assert.match(main, /smallest\.readRasters\(\{ pool: geoPool, signal \}\)/);
  assert.match(main, /im\.readRasters\(\{ pool: geoPool, interleave: false, signal \}\)/);
  assert.match(main, /image\.readRasters\(\{ window: \[x0, y0, x1, y1\], width, height, resampleMethod: 'bilinear', pool: geoPool, signal \}\)/);
  assert.match(main, /setAbortSignal: function \(signal\)/);
  assert.match(main, /err\?\.name === 'AbortError'/);
});

test('mesh and Potree modes exchange one immutable camera snapshot before teardown', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /function captureMeshView\(\) \{[\s\S]*position: camera\.position\.clone\(\),[\s\S]*quaternion: camera\.quaternion\.clone\(\),[\s\S]*target: getViewTargetWorld\(\)/);
  const capture = main.indexOf('pendingPointCloudView = captureMeshView()');
  const dispose = main.indexOf('disposeTiles()', capture);
  assert.ok(capture >= 0 && dispose > capture, 'mesh view is captured before streamed tiles are disposed');
  assert.match(main, /setTimeout\(\(\) => pushViewToPointCloud\(snapshot, retries - 1\), 250\)/);
  assert.match(main, /w\.__setViewUTM\(camU\.e, camU\.n, camU\.alt, tgtU\.e, tgtU\.n, tgtU\.alt\)/);
  assert.match(main, /typeof w\.__getViewUTM === 'function' \? w\.__getViewUTM\(\) : null/);
  assert.match(main, /controls\.setView\(camW, tgtW\)/);
});

test('viewer diagnostics are bounded and never include asset URLs or exception details', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /const DIAGNOSTIC_EVENTS = new Set/);
  assert.match(main, /const POINT_CLOUD_FAILURE_CODES = new Set/);
  assert.match(main, /Never include asset URLs, project titles,[\s\S]*bearer\/session credentials, or exception objects/);
  assert.match(main, /correlationId: DIAGNOSTIC_CORRELATION_ID, revision: VIEWER_BUILD_REVISION/);
  assert.match(main, /const DIAGNOSTIC_STAGES = new Set/);
  assert.match(main, /x-ltds-viewer-revision/);
  assert.match(main, /params\.set\('correlation', DIAGNOSTIC_CORRELATION_ID\)/);
  assert.match(main, /params\.set\('revision', VIEWER_BUILD_REVISION\)/);
  assert.match(main, /message\.correlationId !== iframe\.dataset\.correlationId/);
  assert.doesNotMatch(main, /showError\(`Failed to load point cloud from \$\{POINT_CLOUD_URL\}/);
});

test('LOD starts close-responsive, stages explicit high-detail requests, and caps reduced-memory clients honestly', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="lod-detail"[^>]*min="2"[^>]*max="24"[^>]*value="16"/);
  assert.match(html, /Starts with balanced view-local refinement\. Raise Detail only when you need finer coverage\./);
  assert.match(main, /lodRuntimeProfileState = configureLodRenderer/);
  assert.match(main, /const next = resolveLodDetailRequest\(lodRuntimeProfileState, lodWarmupComplete, e\.target\.value\)/);
  assert.match(main, /lodRuntimeProfileState\.requestedDetail = next\.requestedDetail/);
  assert.match(main, /lodRuntimeProfileState\.activeDetail = next\.activeDetail/);
  assert.match(main, /const detailPending = lodDetailRequestPending\(lodRuntimeProfileState\)/);
  assert.match(main, /tilesRenderer\.errorTarget = lodTargetForDetail\(next\.activeDetail\)/);
  assert.match(main, /visibleLodTargetSatisfied\(tilesRenderer\.root, tilesRenderer\.errorTarget\)/);
  assert.match(main, /!lodDetailRequestPending\(lodRuntimeProfileState\)\) return false/);
  assert.match(main, /const queuesSettled = lodQueuesSettled\(tilesRenderer\)/);
  assert.match(main, /reduced-memory Detail \$\{lodRuntimeProfileState\.activeDetail\}/);
  assert.match(main, /queuesSettled \? `Detail \$\{lodRuntimeProfileState\?\.activeDetail \?\? 2\}` : `streaming Detail/);
  assert.doesNotMatch(main, /releaseStaleLodDetails|transientRootBackdropEnabled|syncTransientRootLodBackdrop/);
});

test('production installs the exact renderer and applies the scoped ancestor patch in both image stages', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  assert.equal(packageJson.dependencies['3d-tiles-renderer'], '0.5.1');
  assert.equal(packageJson.scripts.postinstall, 'node scripts/patch-3d-tiles-renderer.mjs');
  assert.equal(
    [...dockerfile.matchAll(/COPY scripts\/patch-3d-tiles-renderer\.mjs \.\/scripts\/patch-3d-tiles-renderer\.mjs\s+RUN npm ci/g)].length,
    2,
    'build and runtime installs must both receive the postinstall patch before npm ci',
  );
});

test('LOD memory pressure preserves camera-driven quality and resets on explicit lifecycle boundaries', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const loadBlock = main.slice(main.indexOf('function loadTiles()'), main.indexOf('function disposeTiles()'));
  const disposeBlock = main.slice(main.indexOf('function disposeTiles()'), main.indexOf('let sessionRenewalTimer'));
  const sliderStart = main.indexOf("document.getElementById('lod-detail').addEventListener('input'");
  const sliderBlock = main.slice(sliderStart, main.indexOf("document.querySelectorAll('#panel-measure", sliderStart));
  const statsBlock = main.slice(main.indexOf('function updateStats()'), main.indexOf('// expose for debugging/verification'));

  assert.match(main, /advanceLodMemoryPressure/);
  assert.match(main, /let lodStarvationSamples = 0;\s*let lodStarvedAtDetail = null;\s*let lodCacheRecoveryActive = false;\s*let lodLastSettledDetail = null;\s*let lodPressureView = null;/);
  for (const [label, block] of [['load', loadBlock], ['dispose', disposeBlock], ['slider', sliderBlock]]) {
    assert.match(block, /lodStarvationSamples = 0;\s*lodStarvedAtDetail = null;\s*lodCacheRecoveryActive = false;/, `${label} must reset memory-pressure state`);
  }
  assert.match(sliderBlock, /if \(Number\.isFinite\(lodLastSettledDetail\)\) \{\s*lodLastSettledDetail = Math\.min\(lodLastSettledDetail, next\.activeDetail\)/);
  assert.match(statsBlock, /advanceLodMemoryPressure\(pressureSnapshot, lodRuntimeProfileState/);
  assert.match(statsBlock, /consecutiveSamples: lodStarvationSamples/);
  assert.match(statsBlock, /starvedAtDetail: lodStarvedAtDetail/);
  assert.match(statsBlock, /lastSettledDetail: lodLastSettledDetail/);
  assert.match(statsBlock, /lodStarvationSamples = pressure\.consecutiveSamples/);
  assert.match(statsBlock, /lodStarvedAtDetail = pressure\.starvedAtDetail/);
  assert.match(statsBlock, /if \(pressure\.recoveryRequired\)/);
  assert.match(statsBlock, /lodCacheRecoveryActive = true/);
  assert.match(statsBlock, /lodCacheRetentionMinBytes\(\s*lodRuntimeProfileState\.budget,\s*true,\s*tilesRenderer\.lruCache/);
  assert.match(statsBlock, /const cacheRecoverySettled = lodCacheRecoveryActive/);
  assert.match(statsBlock, /pressureSnapshot\.pendingRequiredTiles === 0/);
  assert.match(statsBlock, /lodCacheRecoveryActive = false/);
  assert.match(statsBlock, /tilesRenderer\.lruCache\.minBytesSize = lodCacheRetentionMinBytes\(lodRuntimeProfileState\.budget, false\)/);
  assert.match(statsBlock, /lodRuntimeProfileState\.activeDetail = pressure\.profile\.activeDetail/);
  assert.match(statsBlock, /tilesRenderer\.errorTarget = lodTargetForDetail\(pressure\.profile\.activeDetail\)/);
  assert.match(statsBlock, /memory-limited Detail \$\{lodRuntimeProfileState\.activeDetail\}/);
  assert.match(main, /function retryLodForChangedView\(\)/);
  assert.match(main, /lodViewChangeRequiresRetry\(lodPressureView, currentView\)/);
  const loadModelStart = loadBlock.indexOf("addEventListener('load-model'");
  const loadModelBlock = loadBlock.slice(loadModelStart, loadBlock.indexOf("addEventListener('load-error'", loadModelStart));
  assert.doesNotMatch(loadModelBlock, /recoverLodCacheAdmission\(/,
    'load-model fires after renderer 0.5.1 has already discarded an unadmitted parse');
  assert.match(loadBlock, /addEventListener\('tile-memory-pressure',[\s\S]*?recoverLodCacheAdmission\(rendererInstance\.lruCache, lodRuntimeProfileState\.budget\)/,
    'pre-discard recovery must run from the exact-pinned synchronous renderer event');
  assert.match(main, /if \(lodStarvedAtDetail !== null\) return false;\s*lodLastSettledDetail = lodRuntimeProfileState\.activeDetail/,
    'a memory-limited fallback must never overwrite the last genuinely settled detail');
  assert.match(main, /emitLodDebugSnapshot\('view-change-retry', true\)/);
  assert.doesNotMatch(main, /lodCacheRetentionMinBytes\([^)]*, true\)\s*;\/\/.*zero/i);
});

test('LOD console telemetry is deduplicated sanitized and manually callable', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /lodDebugSnapshot/);
  assert.match(main, /function emitLodDebugSnapshot\(reason = 'status', force = false\)/);
  assert.match(main, /console\.info\('\[LTDS LOD\]', reason, snapshot\)/);
  assert.match(main, /emitLodDebugSnapshot\('status'\)/);
  assert.match(main, /lodDiagnostics: \(\) => emitLodDebugSnapshot\('manual', true\)/);
  assert.match(main, /tile load failed; run window\.__ltds\.lodDiagnostics\(\)/);
  assert.doesNotMatch(main, /console\.error\('Tiles load error', ev\)/);
});

test('Top View starts just inside the stable polar range instead of at the singular pole', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /import \{ EarthLikeControls, safeTopViewPosition \} from '\.\/earth-controls\.js'/);
  assert.match(main, /function topDownView\(\) \{\s*const target = new THREE\.Vector3\(0, 18, 0\);\s*controls\.setView\(safeTopViewPosition\(target, 542, controls\.minPolar\), target\);\s*\}/);
});
