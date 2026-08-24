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
  assert.match(result.errors.join('\n'), /exact v2 or controlled Obj2Tiles v3 audit evidence/);

  fs.writeFileSync(manifestPath, JSON.stringify(original));
  fs.appendFileSync(path.join(directory, 'leaf-b.glb'), 'changed');
  result = await verifyLodProvenance(manifestPath, meshPath);
  assert.equal(result.verified, false);
  assert.match(result.errors.join('\n'), /artifact size changed/);
});

test('server verifies controlled Obj2Tiles v3 evidence and rejects converter or sampled-surface forgery',async t=>{
  const [{TRIANGLE_B,writeAuditableFixture},{writeLodProvenance}]=await Promise.all([import('./helpers/lod-fixture.mjs'),import('../scripts/lib/lod-equivalence.mjs')]);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-lod-controlled-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const split=[[TRIANGLE_B[0],[1,.5,0],TRIANGLE_B[2]],[[1,.5,0],TRIANGLE_B[1],TRIANGLE_B[2]]],source=writeAuditableFixture(directory,{leafBTriangles:split,leafBTexture:Buffer.from('repacked-atlas')}),converterInput=path.join(directory,'model.obj'),converterBinary=path.join(directory,'Obj2Tiles');
  fs.writeFileSync(converterInput,'o controlled fixture\n');
  const testBinary=Buffer.from('pinned Obj2Tiles 1.6.2 fixture');
  fs.writeFileSync(converterBinary,testBinary);
  const testBinarySha256=require('node:crypto').createHash('sha256').update(testBinary).digest('hex');
  const {outputPath}=await writeLodProvenance({derivativeDir:directory,sourceGlb:source,controlledObj2Tiles:true,converterInput,converterBinary,trustedConverterBinarySha256:[testBinarySha256]});
  const generated=JSON.parse(fs.readFileSync(outputPath,'utf8'));
  fs.writeFileSync(outputPath,JSON.stringify({...generated,converter:{...generated.converter,binarySha256:'40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274'}}));
  const checked=await verifyLodProvenance(outputPath,source);
  assert.equal(checked.verified,true,checked.errors.join('\n'));
  assert.equal(checked.provenance.schemaVersion,3);
  assert.equal(checked.provenance.audit.algorithm,'ltds-obj2tiles-surface-equivalence-v3');
  const original=JSON.parse(fs.readFileSync(outputPath,'utf8'));
  fs.writeFileSync(outputPath,JSON.stringify({...original,converter:{...original.converter,version:'latest'}}));
  let rejected=await verifyLodProvenance(outputPath,source);
  assert.equal(rejected.verified,false);
  assert.match(rejected.errors.join('\n'),/pinned Obj2Tiles command contract/);
  fs.writeFileSync(outputPath,JSON.stringify({...original,audit:{...original.audit,sourceToLeaves:{...original.audit.sourceToLeaves,maximumDistance:original.audit.surfaceTolerance*2}}}));
  rejected=await verifyLodProvenance(outputPath,source);
  assert.equal(rejected.verified,false);
  assert.match(rejected.errors.join('\n'),/sourceToLeaves evidence is invalid/);
  fs.writeFileSync(outputPath,JSON.stringify({...original,converter:{...original.converter,binarySha256:'b46d5156399774c9ba728b3d3f93c8ebf8da20dcebd5f67b5cd813aba2ec81cc'}}));
  rejected=await verifyLodProvenance(outputPath,source);
  assert.equal(rejected.verified,false);
  assert.match(rejected.errors.join('\n'),/approved Obj2Tiles 1\.6\.2 executable/);
});
