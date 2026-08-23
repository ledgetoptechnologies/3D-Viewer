import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { auditFailureExitCode, auditLodEquivalence } from '../scripts/lib/lod-equivalence.mjs';
import { TRIANGLE_A, TRIANGLE_B, writeAuditableFixture } from './helpers/lod-fixture.mjs';

const cli = path.join(import.meta.dirname, '..', 'scripts', 'audit-lod-equivalence.mjs');

test('filesystem and operating-system audit failures are retryable rather than semantic invalidity', () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'ENODEV', 'EACCES', 'EBUSY', 'ENOMEM']) {
    assert.equal(auditFailureExitCode(Object.assign(new Error(code), { code })), 4, code);
  }
  assert.equal(auditFailureExitCode(new Error('triangle count differs')), 3);
});

function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-audit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, source: writeAuditableFixture(directory, options) };
}

test('audits split GLB/B3DM leaves and emits deterministic, artifact-bound evidence', async (t) => {
  const { directory, source } = fixture(t);
  const first = await auditLodEquivalence({ derivativeDir: directory, sourceGlb: source });
  const second = await auditLodEquivalence({ derivativeDir: directory, sourceGlb: source });
  assert.deepEqual(second, first);
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.audit.triangleCount, 2);
  assert.equal(first.audit.maxNumericDelta, 0);
  assert.deepEqual(first.audit.artifacts.map((entry) => entry.uri), ['leaf-a.b3dm', 'leaf-b.glb', 'tileset.json']);

  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(directory, 'lod-provenance.json'), 'utf8'));
  assert.deepEqual(written, first);
});

test('external source auditing is explicit and keeps provenance artifacts contained', async (t) => {
  const { directory, source } = fixture(t);
  const externalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-lod-source-'));
  t.after(() => fs.rmSync(externalDirectory, { recursive: true, force: true }));
  const externalSource = path.join(externalDirectory, 'source.glb');
  fs.copyFileSync(source, externalSource);
  fs.rmSync(source);

  await assert.rejects(
    auditLodEquivalence({ derivativeDir: directory, sourceGlb: externalSource }),
    /source GLB must be inside the derivative directory/,
  );
  const rejected = spawnSync(process.execPath, [cli, directory, externalSource], { encoding: 'utf8' });
  assert.equal(rejected.status, 3);
  assert.match(rejected.stderr, /source GLB must be inside the derivative directory/);

  const accepted = spawnSync(process.execPath, [cli, directory, externalSource, '--external-source'], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  const provenance = JSON.parse(fs.readFileSync(path.join(directory, 'lod-provenance.json'), 'utf8'));
  assert.ok(provenance.audit.artifacts.length > 0);
  assert.equal(provenance.audit.artifacts.some((artifact) => artifact.uri.includes('..') || path.isAbsolute(artifact.uri)), false);

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { verifyLodProvenance } = require('../server/lodProvenance');
  const verification = await verifyLodProvenance(path.join(directory, 'lod-provenance.json'), externalSource);
  assert.equal(verification.verified, true, verification.errors?.join('\n'));
});

test('does not emit provenance for arbitrary or nonmatching leaf geometry', (t) => {
  const { directory, source } = fixture(t, { leafABytes: Buffer.from('arbitrary tile bytes') });
  const output = path.join(directory, 'lod-provenance.json');
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /B3DM header is missing/);
  assert.equal(fs.existsSync(output), false);

  writeAuditableFixture(directory, { leafBTriangles: [[[1, 0, 0], [2, 1, 0], [0, 1, 0]]] });
  const mismatch = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(mismatch.status, 3);
  assert.match(mismatch.stderr, /delta .* exceeds tolerance/);
  assert.equal(fs.existsSync(output), false);
});

test('rejects reduced or re-encoded textures even when triangle geometry matches', (t) => {
  const { directory, source } = fixture(t, { leafBTexture: Buffer.from('different-texture') });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /material\/texture evidence differs/);
  assert.equal(fs.existsSync(path.join(directory, 'lod-provenance.json')), false);
});

test('applies tile transforms and accepts small bounded floating-point deltas', (t) => {
  const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
  const translated = TRIANGLE_B.map(([x, y, z]) => [x - 5 + 1e-7, y, z]);
  const { directory, source } = fixture(t, {
    leafBTriangles: [translated],
    leafBTransform: transform,
    leafBTexcoordTransform: (x, y) => [x + 5 - 1e-7, y],
  });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'lod-provenance.json'), 'utf8'));
  assert.ok(evidence.audit.maxNumericDelta > 0);
  assert.ok(evidence.audit.maxNumericDelta <= evidence.audit.coordinateTolerance);
});

test('treats an explicit null tile transform as inherited', (t) => {
  const { directory, source } = fixture(t);
  const manifestPath = path.join(directory, 'tileset.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.root.children[0].transform = null;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));

  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('binds external texture payloads so post-audit changes invalidate provenance', async (t) => {
  const { directory, source } = fixture(t, { externalTexture: true });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'lod-provenance.json'), 'utf8'));
  assert.ok(evidence.audit.artifacts.some((artifact) => artifact.uri === 'texture.png'));

  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { verifyLodProvenance } = require('../server/lodProvenance');
  fs.writeFileSync(path.join(directory, 'texture.png'), 'changed-external-texture');
  const verification = await verifyLodProvenance(path.join(directory, 'lod-provenance.json'), source);
  assert.equal(verification.verified, false);
  assert.match(verification.errors.join('\n'), /artifact size changed \(texture\.png\)/);
});

test('applies a JSON B3DM RTC_CENTER to the audited leaf coordinate frame', (t) => {
  const translated = TRIANGLE_A.map(([x, y, z]) => [x - 2, y, z]);
  const { directory, source } = fixture(t, {
    leafATriangles: [translated],
    leafARtc: [2, 0, 0],
    leafATexcoordTransform: (x, y) => [x + 2, y],
  });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('accepts bounded space padding after an embedded B3DM GLB', (t) => {
  const { directory, source } = fixture(t);
  const leafPath = path.join(directory, 'leaf-a.b3dm');
  const leaf = fs.readFileSync(leafPath);
  const padded = Buffer.concat([leaf, Buffer.alloc(4, 0x20)]);
  padded.writeUInt32LE(padded.length, 8);
  fs.writeFileSync(leafPath, padded);

  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('fails when spatial splitting retriangulates the full-quality frontier', async (t) => {
  const splitHalf = [[TRIANGLE_B[0], [1, 0.5, 0], TRIANGLE_B[2]], [[1, 0.5, 0], TRIANGLE_B[1], TRIANGLE_B[2]]];
  const { directory, source } = fixture(t, { leafBTriangles: splitHalf });
  await assert.rejects(
    auditLodEquivalence({ derivativeDir: directory, sourceGlb: source }),
    /triangle count differs/,
  );
});
