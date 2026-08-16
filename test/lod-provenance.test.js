'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyLodProvenance } = require('../server/lodProvenance');

async function auditedFixture(t) {
  const [{ writeAuditableFixture }, { writeLodProvenance }] = await Promise.all([
    import('./helpers/lod-fixture.mjs'),
    import('../scripts/lib/lod-equivalence.mjs'),
  ]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-provenance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const meshPath = writeAuditableFixture(directory);
  const { outputPath } = await writeLodProvenance({ derivativeDir: directory, sourceGlb: meshPath });
  return { directory, meshPath, manifestPath: outputPath };
}

test('server verifies generated provenance and every bound leaf artifact', async (t) => {
  const { meshPath, manifestPath } = await auditedFixture(t);
  const result = await verifyLodProvenance(manifestPath, meshPath);
  assert.equal(result.verified, true, result.errors.join('\n'));
  assert.equal(result.provenance.schemaVersion, 2);
  assert.equal(result.provenance.sourceAsset, 'model.glb');
  assert.equal(result.provenance.audit.triangleCount, 2);
  assert.equal(result.provenance.audit.artifactCount, 3);
});

test('server rejects stale source, renamed source, legacy assertions, and changed leaves', async (t) => {
  const { directory, meshPath, manifestPath } = await auditedFixture(t);
  const original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  fs.writeFileSync(manifestPath, JSON.stringify({ ...original, sourceSha256: 'b'.repeat(64) }));
  let result = await verifyLodProvenance(manifestPath, meshPath);
  assert.equal(result.verified, false);
  assert.match(result.errors.join('\n'), /does not match/);

  fs.writeFileSync(manifestPath, JSON.stringify({ ...original, sourceAsset: 'other.glb' }));
  result = await verifyLodProvenance(manifestPath, meshPath);
  assert.equal(result.verified, false);
  assert.match(result.errors.join('\n'), /selected full-resolution mesh/);

  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    sourceAsset: 'model.glb',
    sourceSha256: original.sourceSha256,
    geometry: 'preserved',
    textures: 'preserved',
    leafGeometricError: 0,
  }));
  result = await verifyLodProvenance(manifestPath, meshPath);
  assert.equal(result.verified, false);
  assert.match(result.errors.join('\n'), /audited leaf equivalence/);

  fs.writeFileSync(manifestPath, JSON.stringify(original));
  fs.appendFileSync(path.join(directory, 'leaf-b.glb'), 'changed');
  result = await verifyLodProvenance(manifestPath, meshPath);
  assert.equal(result.verified, false);
  assert.match(result.errors.join('\n'), /artifact size changed/);
});
