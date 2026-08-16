'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyLodProvenance } = require('../server/lodProvenance');

function writeManifest(directory, overrides = {}) {
  const manifest = {
    schemaVersion: 1,
    sourceAsset: 'model.glb',
    sourceSha256: crypto.createHash('sha256').update('full mesh bytes').digest('hex'),
    geometry: 'preserved',
    textures: 'preserved',
    leafGeometricError: 0,
    ...overrides,
  };
  const manifestPath = path.join(directory, 'lod-provenance.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

test('server verifies provenance digest against the actual full mesh', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-provenance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const meshPath = path.join(directory, 'model.glb');
  fs.writeFileSync(meshPath, 'full mesh bytes');

  const result = await verifyLodProvenance(writeManifest(directory), meshPath);
  assert.equal(result.verified, true);
  assert.equal(result.provenance.sourceAsset, 'model.glb');
  assert.equal(result.provenance.sourceSha256.length, 64);
});

test('server rejects stale, renamed, or decimated provenance', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-provenance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const meshPath = path.join(directory, 'model.glb');
  fs.writeFileSync(meshPath, 'full mesh bytes');

  let result = await verifyLodProvenance(writeManifest(directory, { sourceSha256: 'b'.repeat(64) }), meshPath);
  assert.equal(result.verified, false);
  assert.match(result.errors.join('\n'), /does not match/);

  result = await verifyLodProvenance(writeManifest(directory, { sourceAsset: 'other.glb' }), meshPath);
  assert.equal(result.verified, false);
  assert.match(result.errors.join('\n'), /selected full-resolution mesh/);

  result = await verifyLodProvenance(writeManifest(directory, { geometry: 'decimated' }), meshPath);
  assert.equal(result.verified, false);
  assert.match(result.errors.join('\n'), /geometry must be preserved/);
});
