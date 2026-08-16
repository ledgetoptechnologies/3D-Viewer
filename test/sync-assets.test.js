'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-sync-assets-'));
const mediaRoot = path.join(fixtureRoot, 'media');
const derivativesRoot = path.join(fixtureRoot, 'derivatives');
process.env.WEBODM_MEDIA_MOUNT = mediaRoot;
process.env.DERIVATIVES_MOUNT = derivativesRoot;

const { buildRecord } = require('../server/sync');

test.after(() => {
  const resolved = path.resolve(fixtureRoot);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('sync discovers native EPT and uncompressed LAS under the mounted WebODM media tree', async () => {
  const assets = path.join(mediaRoot, 'project', '17', 'task', '41', 'assets');
  fs.mkdirSync(path.join(assets, 'entwine_pointcloud'), { recursive: true });
  fs.mkdirSync(path.join(assets, 'odm_georeferencing'), { recursive: true });
  fs.writeFileSync(path.join(assets, 'entwine_pointcloud', 'ept.json'), '{"dataType":"laszip"}');
  fs.writeFileSync(path.join(assets, 'odm_georeferencing', 'odm_georeferenced_model.las'), 'las bytes');
  fs.writeFileSync(path.join(assets, 'odm_georeferencing', 'coords.txt'), 'WGS84 UTM 16N\n367257 4759982 200\n');

  const record = await buildRecord({ id: 17, name: 'Project' }, { id: 41, name: 'Task', status: 40 });

  assert.deepEqual(record.relAssets.ept, {
    root: 'webodm',
    rel: path.join('entwine_pointcloud', 'ept.json'),
  });
  assert.deepEqual(record.relAssets.pointCloud, {
    root: 'webodm',
    rel: path.join('odm_georeferencing', 'odm_georeferenced_model.las'),
    format: 'las',
  });
  assert.deepEqual(record.georef.rtc, { e: 367257, n: 4759982, z: 200 });
  assert.equal(record.georef.utmZoneLon0Deg, -87);
});
