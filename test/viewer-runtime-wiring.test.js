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
  assert.match(main, /Orthophoto pixels alone contain no height/);
  assert.match(main, /integrateElevationVolume/);
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
  assert.match(main, /dom\.cloudStatus\.textContent = 'Cloud: unavailable'/);
  assert.doesNotMatch(main, /cloudStatus\.textContent\s*=\s*message\.(?:code|error|detail)/);
});
