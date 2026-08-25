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

test('viewer streams root backdrop without preloading stale branches', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /enableRootLodBackdrop,/);
  assert.match(main, /releaseStaleLodDetails,/);
  const rootStart = main.indexOf("tilesRenderer.addEventListener('load-root-tileset'");
  const tilesetStart = main.indexOf("tilesRenderer.addEventListener('load-tileset'");
  const modelStart = main.indexOf("tilesRenderer.addEventListener('load-model'");
  assert.ok(rootStart >= 0 && tilesetStart > rootStart && modelStart > tilesetStart, 'LOD event handlers are present in order');
  const rootHandler = main.slice(rootStart, tilesetStart);
  const tilesetHandler = main.slice(tilesetStart, modelStart);
  assert.match(rootHandler, /const decision = decideLodStartup\(/);
  assert.match(rootHandler, /if \(decision\.action !== 'stream-lod'\)\s*\{[\s\S]*?return;\s*\}[\s\S]*?enableRootLodBackdrop\(tilesRenderer\);/);
  assert.doesNotMatch(tilesetHandler, /enableRootLodBackdrop\(tilesRenderer\)/);
  assert.match(main, /const isCoarseBackdrop = ev\.tile === tilesRenderer\.root;/);
  assert.match(main, /material\.depthWrite = false;/);
  assert.match(main, /material\.polygonOffset = true;/);
  assert.match(main, /c\.renderOrder = -100;/);
  assert.match(main, /tilesRenderer\.update\(\);\s*releaseStaleLodDetails\(tilesRenderer\);/);
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
