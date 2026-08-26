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

test('viewer uses a transient root underlay without ancestor or sibling overfetch', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const materials = fs.readFileSync(path.join(__dirname, '..', 'lod-materials.mjs'), 'utf8');
  const lodPolicy = fs.readFileSync(path.join(__dirname, '..', 'lod-policy.mjs'), 'utf8');
  assert.match(main, /enableTransientRootLodBackdrop/);
  assert.match(main, /syncTransientRootLodBackdrop/);
  assert.match(main, /releaseStaleLodDetails/);
  assert.match(lodPolicy, /tilesRenderer\.loadAncestors = false/);
  assert.match(lodPolicy, /tilesRenderer\.loadSiblings = false/);
  const rootStart = main.indexOf("rendererInstance.addEventListener('load-root-tileset'");
  const tilesetStart = main.indexOf("rendererInstance.addEventListener('load-tileset'");
  const modelStart = main.indexOf("rendererInstance.addEventListener('load-model'");
  assert.ok(rootStart >= 0 && tilesetStart > rootStart && modelStart > tilesetStart, 'LOD event handlers are present in order');
  const rootHandler = main.slice(rootStart, tilesetStart);
  assert.match(rootHandler, /const decision = decideLodStartup\(/);
  assert.match(rootHandler, /if \(decision\.action !== 'stream-lod'\)\s*\{[\s\S]*?return;\s*\}/);
  assert.doesNotMatch(rootHandler, /root\.refine\s*=/);
  assert.match(rootHandler, /transientRootBackdropEnabled = enableTransientRootLodBackdrop\(rendererInstance\)/);
  assert.match(rootHandler, /transientRootBackdropEnabled && rendererInstance\.root\?\.internal\?\.hasRenderableContent/);
  assert.match(rootHandler, /rendererInstance\.requestTileContents\(rendererInstance\.root\)/);
  assert.match(rootHandler, /if \(!transientRootBackdropEnabled\) hideLoading\(\)/);
  assert.match(rootHandler, /const bounds = tilesetWorldBounds/);
  assert.match(rootHandler, /frameBoundsHome\(bounds, \{ apply: !preserveIncomingModelView \}\)/);
  assert.doesNotMatch(rootHandler, /if \(!homeView\)/);
  assert.match(main, /if \(tilesRenderer !== rendererInstance\) return;/);
  assert.match(main, /import \{ homeViewForBounds, tilesetWorldBounds \} from '\.\/viewer-framing\.mjs'/);
  assert.match(main, /import \{ preserveLodMaterials \} from '\.\/lod-materials\.mjs'/);
  assert.match(materials, /function preserveLodMaterials\(source, options\)/);
  assert.match(materials, /const originals = Array\.isArray\(source\) \? source : \[source\]/);
  assert.match(materials, /const replacements = originals\.map\(\(material\) => unlitLodMaterial\(material, options\)\)/);
  assert.match(materials, /map,\s*lightMap: source\?\.lightMap/);
  assert.match(materials, /vertexColors: Boolean\(source\?\.vertexColors\)/);
  assert.match(main, /const isTransientBackdrop = transientRootBackdropEnabled && ev\.tile === rendererInstance\.root/);
  assert.match(main, /c\.material = preserveLodMaterials\(c\.material, \{ transientBackdrop: isTransientBackdrop \}\)/);
  assert.match(main, /if \(isTransientBackdrop\) c\.renderOrder = -100/);
  assert.match(main, /if \(isTransientBackdrop\) \{[\s\S]*?syncTransientRootLodBackdrop\(rendererInstance\);[\s\S]*?hideLoading\(\);[\s\S]*?\}/);
  assert.match(main, /preserveIncomingModelView = !tilesRenderer\?\.root;\s*controls\.setView\(camW, tgtW\)/);
  assert.doesNotMatch(main, /engineData\.scene\.visible\s*=/);
  assert.match(main, /tilesRenderer\.update\(\);\s*releaseStaleLodDetails\(tilesRenderer\);\s*state\.lodRootBackdrop = transientRootBackdropEnabled\s*\? syncTransientRootLodBackdrop\(tilesRenderer\)/);
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

test('LOD detail starts at maximum and applies every slider change to the active renderer', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="lod-detail"[^>]*max="24"[^>]*value="24"/);
  assert.match(main, /tilesRenderer\.errorTarget = detailToErrorTarget\(e\.target\.value\)/);
  assert.match(main, /releaseStaleLodDetails\(tilesRenderer\)/);
  assert.match(main, /const queuesSettled = lodQueuesSettled\(tilesRenderer\)/);
  assert.match(main, /const backdropComplete = !transientRootBackdropEnabled \|\| state\.lodRootBackdrop\?\.complete === true/);
  assert.match(main, /frontier\.fullDetail && queuesSettled && backdropComplete \? 'full-detail' : 'streaming'/);
});

test('Top View starts just inside the stable polar range instead of at the singular pole', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /import \{ EarthLikeControls, safeTopViewPosition \} from '\.\/earth-controls\.js'/);
  assert.match(main, /function topDownView\(\) \{\s*const target = new THREE\.Vector3\(0, 18, 0\);\s*controls\.setView\(safeTopViewPosition\(target, 542, controls\.minPolar\), target\);\s*\}/);
});
