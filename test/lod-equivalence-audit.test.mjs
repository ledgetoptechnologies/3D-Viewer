import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { auditLodEquivalence } from '../scripts/lib/lod-equivalence.mjs';
import { TRIANGLE_A, TRIANGLE_B, writeAuditableFixture } from './helpers/lod-fixture.mjs';

const cli = path.join(import.meta.dirname, '..', 'scripts', 'audit-lod-equivalence.mjs');

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

test('does not emit provenance for arbitrary or nonmatching leaf geometry', (t) => {
  const { directory, source } = fixture(t, { leafABytes: Buffer.from('arbitrary tile bytes') });
  const output = path.join(directory, 'lod-provenance.json');
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /B3DM header is missing/);
  assert.equal(fs.existsSync(output), false);

  writeAuditableFixture(directory, { leafBTriangles: [[[1, 0, 0], [2, 1, 0], [0, 1, 0]]] });
  const mismatch = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /delta .* exceeds tolerance/);
  assert.equal(fs.existsSync(output), false);
});

test('rejects reduced or re-encoded textures even when triangle geometry matches', (t) => {
  const { directory, source } = fixture(t, { leafBTexture: Buffer.from('different-texture') });
  const result = spawnSync(process.execPath, [cli, directory, source], { encoding: 'utf8' });
  assert.equal(result.status, 1);
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

test('fails when spatial splitting retriangulates the full-quality frontier', async (t) => {
  const splitHalf = [[TRIANGLE_B[0], [1, 0.5, 0], TRIANGLE_B[2]], [[1, 0.5, 0], TRIANGLE_B[1], TRIANGLE_B[2]]];
  const { directory, source } = fixture(t, { leafBTriangles: splitHalf });
  await assert.rejects(
    auditLodEquivalence({ derivativeDir: directory, sourceGlb: source }),
    /triangle count differs/,
  );
});
