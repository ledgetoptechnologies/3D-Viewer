'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { toViewerConfig } = require('../server/apiV1');
const { discoverCameraPhotoLinks, validCameraFilename } = require('../server/cameraPhotos');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { extractZipFile } = require('../server/safeZip');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

test('file ZIP extraction reports bounded monotonic byte and entry progress', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-zip-progress-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const archive = path.join(root, 'task.zip'), destination = path.join(root, 'task');
  // Three stored WebODM-shaped artifacts; the fixture is tiny, but exercises
  // the same central-directory declared-byte accounting as a multi-GB backup.
  fs.writeFileSync(archive, Buffer.from('UEsDBBQAAAAAAG5SEV1oIC3YAwAAAAMAAAAoAAAAb2RtX3RleHR1cmluZy9vZG1fdGV4dHVyZWRfbW9kZWxfZ2VvLmdsYmdsYlBLAwQUAAAAAABuUhFdQ7+mowIAAAACAAAAGwAAAGVudHdpbmVfcG9pbnRjbG91ZC9lcHQuanNvbnt9UEsDBBQAAAAAAG5SEV1Dv6ajAgAAAAIAAAAbAAAAM2RfdGlsZXMvbW9kZWwvdGlsZXNldC5qc29ue31QSwECFAAUAAAAAABuUhFdaCAt2AMAAAADAAAAKAAAAAAAAAAAAAAAAAAAAAAAb2RtX3RleHR1cmluZy9vZG1fdGV4dHVyZWRfbW9kZWxfZ2VvLmdsYlBLAQIUABQAAAAAAG5SEV1Dv6ajAgAAAAIAAAAbAAAAAAAAAAAAAAAAAEkAAABlbnR3aW5lX3BvaW50Y2xvdWQvZXB0Lmpzb25QSwECFAAUAAAAAABuUhFdQ7+mowIAAAACAAAAGwAAAAAAAAAAAAAAAACEAAAAM2RfdGlsZXMvbW9kZWwvdGlsZXNldC5qc29uUEsFBgAAAAADAAMA6AAAAL8AAAAAAA==', 'base64'));
  const updates = [];
  const result = await extractZipFile(archive, destination, { onProgress: (fraction, details) => updates.push({ fraction, ...details }) });
  assert.deepEqual(result, { entries: 3, bytes: 7 });
  assert.ok(updates.length >= 3);
  assert.equal(updates[0].fraction, 0);
  assert.equal(updates.at(-1).fraction, 1);
  assert.equal(updates.at(-1).extractedBytes, updates.at(-1).declaredBytes);
  assert.equal(updates.at(-1).extractedEntries, updates.at(-1).totalEntries);
  assert.ok(updates.every((item, index) => index === 0 || item.fraction >= updates[index - 1].fraction));
  assert.ok(updates.every((item) => item.fraction >= 0 && item.fraction <= 1));
});

test('shots filenames link only to exact safe root JPEGs while missing photos preserve camera data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-camera-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets', 'odm_report'), { recursive: true });
  fs.writeFileSync(path.join(root, 'DJI_0001.JPG'), 'photo-one');
  fs.writeFileSync(path.join(root, 'nested.jpg'), 'wrong-level');
  const document = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { filename: 'DJI_0001.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 200] } },
      { type: 'Feature', properties: { filename: 'missing.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 201] } },
      { type: 'Feature', properties: { filename: '../escape.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 202] } },
      { type: 'Feature', properties: { filename: 'DJI_0001.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 203] } },
    ],
  };
  const shotsBody = JSON.stringify(document);
  fs.writeFileSync(path.join(root, 'assets', 'odm_report', 'shots.geojson'), shotsBody);
  const discovered = {
    assets: [{ kind: 'shots', relativePath: 'assets/odm_report/shots.geojson', byteSize: Buffer.byteLength(shotsBody) }],
    files: [
      { relativePath: 'DJI_0001.JPG', byteSize: 9, sha256: digest('photo-one') },
      { relativePath: 'folder/nested.jpg', byteSize: 11, sha256: digest('wrong-level') },
    ],
  };
  assert.deepEqual(discoverCameraPhotoLinks(root, discovered), [{
    filename: 'DJI_0001.JPG', relativePath: 'DJI_0001.JPG', byteSize: 9,
    sha256: digest('photo-one'), contentType: 'image/jpeg',
  }]);
  assert.equal(document.features.length, 4, 'link discovery never removes camera positions when a photo is absent');
  assert.equal(validCameraFilename('../escape.JPG'), null);
  assert.equal(validCameraFilename('folder/photo.jpg'), null);
  assert.equal(validCameraFilename('photo.png'), null);
  assert.equal(validCameraFilename('photo.jpeg'), 'photo.jpeg');

  fs.writeFileSync(path.join(root, 'assets', 'odm_report', 'shots.geojson'), '{');
  assert.deepEqual(discoverCameraPhotoLinks(root, discovered), [], 'malformed optional photo metadata fails closed');
});

test('a scoped camera capability serves an integrity-checked linked photo without exposing storage paths', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-camera-route-'));
  const oldDatasetsMount = config.datasetsMount;
  config.datasetsMount = path.join(root, 'datasets');
  const datasetId = 'imported-task';
  const directory = path.join(config.datasetsMount, datasetId);
  fs.mkdirSync(path.join(directory, 'assets', 'odm_report'), { recursive: true });
  const photo = Buffer.from('authenticated-camera-photo');
  const shots = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { filename: 'DJI_0001.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 200] } }] }));
  fs.writeFileSync(path.join(directory, 'DJI_0001.JPG'), photo);
  fs.writeFileSync(path.join(directory, 'assets', 'odm_report', 'shots.geojson'), shots);
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const model = repository.upsertModelVersion({
    modelId: 'model-camera', versionId: 'version-camera', provider: 'webodm',
    providerModelId: 'task-import:camera', providerVersionId: 'camera', displayName: 'Camera model', status: 'ready',
    sourceLocator: { webodmTaskImport: true },
    assets: [{ kind: 'shots', rootKey: 'datasets', relativePath: `${datasetId}/assets/odm_report/shots.geojson`, contentType: 'application/geo+json', byteSize: shots.length, sha256: digest(shots), published: true }],
    cameraPhotos: [{ filename: 'DJI_0001.JPG', rootKey: 'datasets', relativePath: `${datasetId}/DJI_0001.JPG`, contentType: 'image/jpeg', byteSize: photo.length, sha256: digest(photo) }],
  });
  const token = 'camera-session-token-000000000000000000';
  repository.createViewerSession({ tokenHash: auth.hashToken(token), modelId: model.id, modelVersionId: model.activeVersionId, subject: 'ops:camera', audience: 'ops', permissions: { view: true, cameras: true, download: false }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const deniedToken = 'camera-session-denied-0000000000000000';
  repository.createViewerSession({ tokenHash: auth.hashToken(deniedToken), modelId: model.id, modelVersionId: model.activeVersionId, subject: 'ops:no-camera', audience: 'ops', permissions: { view: true, cameras: false }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assets.setRepository(repository);
  const app = express();
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    config.datasetsMount = oldDatasetsMount;
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const photoPath = `/session-camera-photos/${encodeURIComponent(token)}/${model.id}/DJI_0001.JPG`;
  const response = await fetch(`${base}${photoPath}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), photo);
  assert.equal((await fetch(`${base}/session-camera-photos/${encodeURIComponent(token)}/${model.id}/missing.JPG`)).status, 404);
  assert.equal((await fetch(`${base}/session-camera-photos/${encodeURIComponent(deniedToken)}/${model.id}/DJI_0001.JPG`)).status, 403);

  const viewer = toViewerConfig(repository.getModel(model.id), { assetToken: token });
  assert.equal(viewer.assets.cameraPhotos, `/session-camera-photos/${encodeURIComponent(token)}/${model.id}`);
  assert.equal(viewer.assets.cameraPhotos.includes(root), false);

  fs.writeFileSync(path.join(directory, 'DJI_0001.JPG'), Buffer.alloc(photo.length, 88));
  assert.equal((await fetch(`${base}${photoPath}`)).status, 404, 'same-size content tampering fails the stored digest check');
});

test('camera photo persistence rejects path escapes and the viewer has an explicit missing-photo state', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(main, /PHOTO_BASE = p\.assets\.cameraPhotos \|\| null/);
  assert.match(main, /dom\.photoEmpty\.textContent = 'No photo available'/);
  assert.match(html, /id="photo-empty"[^>]*>No photo available</);
  assert.doesNotMatch(main, /if \(!PHOTO_BASE \|\| !feat\) return/);
});
