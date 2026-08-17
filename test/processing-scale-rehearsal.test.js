'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  SENTINEL_NAME,
  cleanupDisposableTarget,
  createDisposableTarget,
  runProcessingScaleRehearsal,
  validateOptions,
} = require('../scripts/processing-scale-rehearsal');

function operatorRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-scale-operator-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('small processing rehearsal exercises authoritative storage and removes only its disposable child', async (t) => {
  const root = operatorRoot(t);
  fs.writeFileSync(path.join(root, 'operator-owned.txt'), 'preserve');
  const report = await runProcessingScaleRehearsal({
    root, fileCount: 24, bytesPerFile: 257, production: false,
    image: 'ghcr.io/example/viewer@sha256:' + 'a'.repeat(64), sourceCommit: 'b'.repeat(40),
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { fileCount: 24, bytesPerFile: 257, image: 'ghcr.io/example/viewer@sha256:' + 'a'.repeat(64), sourceCommit: 'b'.repeat(40) });
  assert.deepEqual(report.counts, { generatedFiles: 24, previewFiles: 24, finalizedFiles: 24, reopenedFiles: 24 });
  assert.equal(report.totalBytes, 24 * 257);
  assert.equal(report.storageAccountingBytes, report.totalBytes);
  assert.match(report.treeFingerprint, /^[0-9a-f]{64}$/);
  assert.match(report.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal(report.lowSpaceAdmission.refused, true);
  assert.deepEqual(report.cleanup, { verified: true, removed: true });
  for (const phase of ['generate', 'scan_and_full_fingerprint', 'adopt_and_finalize', 'storage_accounting', 'restart_and_reopen', 'low_space_admission', 'cleanup']) assert.ok(report.phases[phase].elapsedMs >= 0, phase);
  assert.ok(report.elapsedMs > 0);
  assert.ok(report.peakRssBytes > 0);
  assert.match(report.filesystem.device, /^\d+$/);
  assert.equal(fs.readFileSync(path.join(root, 'operator-owned.txt'), 'utf8'), 'preserve');
  assert.deepEqual(fs.readdirSync(root), ['operator-owned.txt']);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('production rehearsal refuses a sub-100000 count before creating a target', (t) => {
  const root = operatorRoot(t);
  assert.throws(() => validateOptions({ root, fileCount: 99999, bytesPerFile: 1, production: true, image: 'viewer:sha-test', sourceCommit: 'c'.repeat(40) }), { code: 'production_file_count_too_small' });
  assert.deepEqual(fs.readdirSync(root), []);
});

test('cleanup refuses a changed sentinel and leaves the target intact', (t) => {
  const root = operatorRoot(t), context = createDisposableTarget(fs.realpathSync.native(root));
  fs.writeFileSync(path.join(context.target, SENTINEL_NAME), '{"tampered":true}\n');
  assert.throws(() => cleanupDisposableTarget(context), { code: 'cleanup_sentinel_invalid' });
  assert.equal(fs.existsSync(context.target), true);
  fs.writeFileSync(path.join(context.target, SENTINEL_NAME), context.sentinelBody);
  cleanupDisposableTarget(context);
  assert.equal(fs.existsSync(context.target), false);
});
