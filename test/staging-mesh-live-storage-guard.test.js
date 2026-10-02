'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const test = require('node:test');
const gib = 1024 ** 3;
const identified = {
  deploymentId: 'staging-192.168.50.90',
  expectedHost: 'viewer-staging.ledgetopdroneservices.com',
  publicBaseUrl: 'https://viewer-staging.ledgetopdroneservices.com',
  stagingSmbAllowUnavailableInodes: true,
};

// Exercise generateMeshTiles itself, including its interval closure. No real
// converter is started, and no registry, mount, or provenance is fabricated.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-live-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
  const modulePath = require.resolve('../server/derivativeWorker');
  delete require.cache[modulePath];
  const { generateMeshTiles } = require(modulePath);
  t.after(() => { delete require.cache[modulePath]; });
  let tick;
  t.mock.method(global, 'setInterval', (callback) => { tick = callback; return {}; });
  t.mock.method(global, 'clearInterval', () => {});
  const storage = {
    config: { ...identified },
    roots: { models: root },
    resolve: (_key, relative) => path.join(root, relative),
    requireDerivativeSpace: () => ({ inodeReserve: null }),
    space: () => ({ available: 100 * gib, reserve: 20 * gib,
      filesystemType: 0xfe534d42, files: 0, ffree: 0 }),
  };
  const controller = new AbortController();
  const phases = [];
  const args = {
    storage, processing: { derivativeStorageReservation: () => null,
      activeDerivativeReservationBytes: () => 0, activeProcessingReservationBytes: () => [] },
    config: { meshDerivativesEnabled: true, obj2TilesBin: 'not-executed' },
    task: { id: 'test-task' }, attempt: { id: 'test-attempt' },
    job: { id: 'a'.repeat(32), lease_token: 'b'.repeat(32),
      deadline_at: new Date(Date.now() + 60_000).toISOString() },
    obj: { root_key: 'models', relative_path: 'model.obj' },
    glb: { root_key: 'models', relative_path: 'model.glb' },
    inputSnapshot: { totalByteSize: 100 }, signal: controller.signal,
    onPhase: (phase) => phases.push(phase),
  };
  return { storage, args, phases, controller, run: () => generateMeshTiles(args), tick: () => tick() };
}

test('live mesh guard rejects low byte headroom despite staging SMB inode exception', async (t) => {
  const f = fixture(t);
  f.storage.space = () => ({ available: 25 * gib, reserve: 20 * gib,
    filesystemType: 0xfe534d42, files: 0, ffree: 0 });
  await assert.rejects(f.run(), { code: 'insufficient_storage' });
  assert.deepEqual(f.phases, []);
});

for (const [name, change] of [
  ['mount changes away from SMB', (f) => { f.storage.space = () => ({
    available: 100 * gib, reserve: 20 * gib, filesystemType: 0xef53, files: 0, ffree: 0 }); }],
  ['exception flag disabled', (f) => { f.storage.config.stagingSmbAllowUnavailableInodes = false; }],
  ['deployment becomes production', (f) => { f.storage.config.deploymentId = 'production'; }],
  ['real inode metrics fall to reserve', (f) => { f.storage.space = () => ({
    available: 100 * gib, reserve: 20 * gib, filesystemType: 0xfe534d42,
    files: 1000000, ffree: 50000 }); }],
]) {
  test(`live mesh guard rechecks conversion tick when ${name}`, async (t) => {
    const f = fixture(t);
    f.args.onPhase = (phase) => {
      f.phases.push(phase);
      if (phase === 'generating') { change(f); f.tick(); }
    };
    await assert.rejects(f.run(), { code: 'insufficient_storage' });
    assert.deepEqual(f.phases, ['generating']);
  });
}

test('live mesh guard permits current identified SMB then preserves independent cancellation', async (t) => {
  const f = fixture(t);
  const stopped = Object.assign(new Error('test cancellation'), { code: 'lease_lost' });
  f.args.onPhase = (phase) => {
    f.phases.push(phase);
    if (phase === 'generating') { f.tick(); f.controller.abort(stopped); }
  };
  await assert.rejects(f.run(), (error) => error === stopped);
  assert.deepEqual(f.phases, ['generating']);
});
