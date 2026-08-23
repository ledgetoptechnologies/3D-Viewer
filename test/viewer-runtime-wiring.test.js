'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('viewer wires cancel/retry/LOD recovery without exposing capability asset URLs', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(main, /signal: attempt\.controller\.signal/);
  assert.match(main, /maxBytes: fullMeshByteLimit\(navigator\.deviceMemory, performance\.memory\?\.jsHeapSizeLimit\)/);
  assert.match(main, /withDecodeWatchdog\(decode/);
  assert.match(main, /fullMeshFailureDisposition\(activeGlbLoad, attempt/);
  assert.match(main, /if \(!disposition\.recover\) return/);
  assert.match(main, /frameObjectHome\(gltf\.scene\)/);
  assert.match(main, /dom\.loadingCancel\.addEventListener\('click'/);
  assert.match(main, /returnToLod: TILES_URL \? selectStreamingLod : null/);
  assert.doesNotMatch(main, /showError\(`[^`]*\$\{GLB_URL\}/);
  assert.match(html, /id="loading-cancel"/);
  assert.match(html, /id="error-retry"/);
  assert.match(html, /id="error-lod"/);
});

test('orthophoto nodata uses the supported GeoTIFF image API', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /parseFiniteGdalNoData\(image\.getGDALNoData\(\)\)/);
  assert.doesNotMatch(main, /fileDirectory\?\.GDAL_NODATA/);
});

test('point-cloud parent accepts health messages only from its same-origin iframe', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(main, /event\.origin !== location\.origin \|\| event\.source !== iframe\.contentWindow/);
  assert.match(main, /message\.source !== 'ltds-pointcloud'/);
  assert.match(main, /message\.type === 'ready' && message\.code === 'points_visible'/);
  assert.match(main, /dom\.cloudStatus\.textContent = 'Cloud: unavailable'/);
  assert.doesNotMatch(main, /cloudStatus\.textContent\s*=\s*message\.(?:code|error|detail)/);
});
