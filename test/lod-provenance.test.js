'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { assertLodArtifactsMatchSnapshot } = require('../server/derivativeWorker');
const { verifyLodProvenance } = require('../server/lodProvenance');
const { hashTree } = require('../server/storageManager');

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
  assert.equal(result.artifacts.length, 3);
});

test('registration rejects a tree snapshot that differs from the audited artifacts', async (t) => {
  const { directory, meshPath, manifestPath } = await auditedFixture(t);
  const checked = await verifyLodProvenance(manifestPath, meshPath);
  const before = await hashTree(directory);
  assert.equal(assertLodArtifactsMatchSnapshot(checked.artifacts, before).relativePath, 'tileset.json');

  const changed = {
    ...before,
    files: before.files.map((file) => file.relativePath === 'leaf-b.glb'
      ? { ...file, sha256: 'f'.repeat(64) }
      : file),
  };
  assert.throws(
    () => assertLodArtifactsMatchSnapshot(checked.artifacts, changed),
    (error) => error.code === 'lod_provenance_invalid' && /changed before registration/.test(error.message),
  );
});

test('v2 audit proves required Draco geometry with CESIUM_RTC and unlit materials', async (t) => {
  const [{ makeB3dm, makeDracoGlb, makeGlb, TRIANGLE_A, TRIANGLE_B, writeAuditableFixture }, { writeLodProvenance }] = await Promise.all([
    import('./helpers/lod-fixture.mjs'),
    import('../scripts/lib/lod-equivalence.mjs'),
  ]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-draco-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = writeAuditableFixture(directory);
  fs.writeFileSync(source, await makeDracoGlb([TRIANGLE_A, TRIANGLE_B], Buffer.from('fixture-texture'), {
    unlit: true,
    cesiumRtc: [0, 0, 0],
  }));
  fs.writeFileSync(path.join(directory, 'leaf-a.b3dm'), makeB3dm(makeGlb([TRIANGLE_A], Buffer.from('fixture-texture'), { unlit: true })));
  fs.writeFileSync(path.join(directory, 'leaf-b.glb'), makeGlb([TRIANGLE_B], Buffer.from('fixture-texture'), { unlit: true }));

  const { provenance, outputPath } = await writeLodProvenance({ derivativeDir: directory, sourceGlb: source });
  assert.equal(provenance.audit.algorithm, 'ltds-glb-leaf-equivalence-v2');
  assert.equal(provenance.audit.triangleCount, 2);
  assert.equal((await verifyLodProvenance(outputPath, source)).verified, true);
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
