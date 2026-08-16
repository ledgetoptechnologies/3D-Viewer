'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const validator = path.join(__dirname, '..', 'scripts', 'validate-lod.mjs');

function run(directory, mesh) {
  return spawnSync(process.execPath, [validator, directory, mesh], { encoding: 'utf8' });
}

test('offline validator accepts a complete certified LOD set and rejects a broken leaf', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-validator-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const mesh = path.join(directory, 'model.glb');
  fs.writeFileSync(mesh, 'full mesh');
  fs.writeFileSync(path.join(directory, 'leaf.b3dm'), 'tile bytes');
  fs.writeFileSync(path.join(directory, 'lod-provenance.json'), JSON.stringify({
    schemaVersion: 1,
    sourceAsset: 'model.glb',
    sourceSha256: crypto.createHash('sha256').update('full mesh').digest('hex'),
    geometry: 'preserved',
    textures: 'preserved',
    leafGeometricError: 0,
  }));
  const writeTileset = (geometricError) => fs.writeFileSync(
    path.join(directory, 'tileset.json'),
    JSON.stringify({
      asset: { version: '1.1' },
      root: {
        refine: 'REPLACE',
        geometricError,
        boundingVolume: { sphere: [0, 0, 0, 10] },
        content: { uri: 'leaf.b3dm' },
      },
    }),
  );

  writeTileset(0);
  let result = run(directory, mesh);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).valid, true);

  writeTileset(4);
  result = run(directory, mesh);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /terminal but declares non-zero geometricError/);
});
