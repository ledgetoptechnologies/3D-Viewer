'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sanitizeLogMessage } = require('./processingSecurity');
const { hashFile, hashTree } = require('./storageManager');
const { verifyLodProvenance } = require('./lodProvenance');

function stopProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function run(bin, args, { timeoutMs = 24 * 3600_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const abort = () => {
      stopProcessTree(child);
      finish(Object.assign(new Error('derivative operation cancelled'), { code: 'lease_lost' }));
    };
    const timer = setTimeout(() => {
      stopProcessTree(child);
      finish(Object.assign(new Error('derivative command timed out'), { code: 'derivative_timeout' }));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-64000); });
    child.once('error', finish);
    child.once('exit', (code) => finish(code === 0 ? null : Object.assign(
      new Error(`derivative command failed (${code}): ${sanitizeLogMessage(stderr).slice(-1000)}`),
      { code: 'derivative_failed', exitCode: code },
    )));
  });
}

function readyEvent(processing, config, attempt) {
  const task = processing.getTask(attempt.taskId);
  const project = processing.getProject(task.projectId);
  return {
    eventId: `processing-ready-${attempt.id}`,
    schemaVersion: 1,
    type: 'processing.ready_for_review',
    projectId: project.id,
    projectDisplayName: project.displayName,
    taskId: task.id,
    taskDisplayName: task.displayName,
    attemptId: attempt.id,
    requestedBySubject: attempt.createdBy,
    status: 'ready_for_review',
    reviewUrl: `${config.opsBaseUrl}/operations/processing?attemptId=${encodeURIComponent(attempt.id)}`,
  };
}

function emitReady(processing, config, attempt, job, owner, result) {
  const completed = processing.completeDerivativeAndMaybeReady(job.id, owner, result, { event: readyEvent(processing, config, attempt) });
  if (!completed) throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
  return completed;
}

async function registerTreeAsset(processing, input, directory, manifestName) {
  const integrity = await hashTree(directory);
  return processing.addModelAsset({
    ...input,
    sha256: await hashFile(path.join(directory, manifestName)),
    manifestSha256: integrity.manifestSha256,
    manifestFiles: integrity.files,
  });
}

function assertLodArtifactsMatchSnapshot(artifacts, integrity) {
  const snapshot = new Map(integrity.files.map((file) => [file.relativePath, file]));
  for (const artifact of artifacts) {
    const file = snapshot.get(artifact.uri);
    if (!file || file.byteSize !== artifact.byteLength || file.sha256 !== artifact.sha256) {
      throw Object.assign(new Error(`LOD artifact changed before registration (${artifact.uri})`), { code: 'lod_provenance_invalid' });
    }
  }
  const tileset = snapshot.get('tileset.json');
  if (!tileset) throw Object.assign(new Error('verified LOD tree has no tileset.json'), { code: 'lod_provenance_invalid' });
  return tileset;
}

async function verifiedLodAsset(input, directory, fullMeshPath) {
  const checked = await verifyLodProvenance(path.join(directory, 'lod-provenance.json'), fullMeshPath);
  if (!checked.verified) throw Object.assign(new Error(`LOD provenance verification failed: ${checked.errors.join('; ')}`), { code: 'lod_provenance_invalid' });
  const integrity = await hashTree(directory);
  const tileset = assertLodArtifactsMatchSnapshot(checked.artifacts, integrity);
  return {
    asset: {
      ...input,
      sha256: tileset.sha256,
      byteSize: tileset.byteSize,
      manifestSha256: integrity.manifestSha256,
      manifestFiles: integrity.files,
    },
    provenance: checked.provenance,
  };
}

async function generateMeshTiles({ processing, storage, config, attempt, job, owner, task, obj, glb, audit, signal }) {
  if (!config.meshDerivativesEnabled) throw Object.assign(new Error('mesh derivative fallback is disabled'), { code: 'derivative_unavailable' });
  if (!obj || !glb) throw Object.assign(new Error('verified Obj2Tiles generation requires both OBJ and GLB mesh sources'), { code: 'unsupported_mesh_derivative_source' });
  const base = storage.resolve('models', `${task.id}/${attempt.id}`);
  fs.mkdirSync(base, { recursive: true });
  const output = path.join(base, 'tiles');
  const incomplete = `${output}.${job.id}.incomplete`;
  fs.rmSync(incomplete, { recursive: true, force: true });
  try {
    const source = storage.resolve(obj.root_key, obj.relative_path, { mustExist: true });
    const auditSource = storage.resolve(glb.root_key, glb.relative_path, { mustExist: true });
    await run(config.obj2TilesBin, ['--octree', '--lods', '3', '--divisions', '2', '--lod-texture-scale', '0.5', '--local', source, incomplete], { signal });
    await run(process.execPath, [
      audit,
      incomplete,
      auditSource,
      '--external-source',
      '--controlled-obj2tiles',
      source,
      config.obj2TilesBin,
    ], { signal });
    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(incomplete, output);
    const verified = await verifiedLodAsset({
      versionId: attempt.resultModelVersionId,
      rootKey: 'models',
      relativePath: `${task.id}/${attempt.id}/tiles/tileset.json`,
      format: '3dtiles',
      contentType: 'application/json',
      byteSize: fs.statSync(path.join(output, 'tileset.json')).size,
      attemptId: attempt.id,
    }, output, auditSource);
    if (!processing.registerVerifiedLodAsset(job.id, owner, verified.asset, verified.provenance)) {
      throw Object.assign(new Error('derivative lease was lost before verified tile registration'), { code: 'lease_lost' });
    }
  } catch (error) {
    fs.rmSync(incomplete, { recursive: true, force: true });
    throw error;
  }
}

async function processOneDerivative({ processing, storage, config, lodAuditScript = null }, owner) {
  const job = processing.claimDerivative(owner);
  if (!job) return false;
  const attempt = processing.getAttempt(job.attempt_id);
  const controller = new AbortController();
  let lost = false;
  let request = {};
  const heartbeat = setInterval(() => {
    if (!processing.heartbeatDerivative(job.id, owner)) {
      lost = true;
      controller.abort();
    }
  }, 20000);
  heartbeat.unref?.();
  try {
    if (['cancelled', 'failed'].includes(attempt.status)) throw Object.assign(new Error('attempt is no longer active'), { code: 'lease_lost' });
    request = JSON.parse(job.request_json || '{}');
    const assets = processing.database.prepare('SELECT * FROM model_assets WHERE version_id=?').all(attempt.resultModelVersionId);
    const task = processing.getTask(attempt.taskId);
    const obj = assets.find((asset) => asset.kind === 'obj');
    const glb = assets.find((asset) => asset.kind === 'glb');
    const audit = lodAuditScript || path.join(__dirname, '..', 'scripts', 'audit-lod-equivalence.mjs');
    let derivativeResult;

    if (job.derivative_type === 'lod_audit') {
      if (!glb) {
        derivativeResult = { verified: false, fallback: obj ? 'obj' : null, reason: 'LOD equivalence requires a GLB source' };
      } else {
        const tilesRootKey = request.tilesRootKey || 'models';
        const tiles = storage.resolve(tilesRootKey, request.tilesRelativePath, { mustExist: true });
        const source = storage.resolve(glb.root_key, glb.relative_path, { mustExist: true });
        try {
          await run(process.execPath, [audit, tiles, source, '--external-source'], { signal: controller.signal });
          const verified = await verifiedLodAsset({
            versionId: attempt.resultModelVersionId,
            rootKey: tilesRootKey,
            relativePath: path.posix.join(request.tilesRelativePath, 'tileset.json'),
            format: '3dtiles',
            contentType: 'application/json',
            byteSize: fs.statSync(path.join(tiles, 'tileset.json')).size,
            attemptId: attempt.id,
          }, tiles, source);
          if (!processing.registerVerifiedLodAsset(job.id, owner, verified.asset, verified.provenance)) {
            throw Object.assign(new Error('derivative lease was lost before verified tile registration'), { code: 'lease_lost' });
          }
          derivativeResult = { verified: true, reused: true };
        } catch (error) {
          if (error.code === 'lease_lost') throw error;
          if (error.exitCode !== 3) throw error;
          if (!processing.invalidateOptionalDerivativeAssets(job.id, owner, ['tiles'])) {
            throw Object.assign(new Error('derivative lease was lost during tile quarantine'), { code: 'lease_lost' });
          }
          if (request.generateFromObjOnFailure && obj) {
            await generateMeshTiles({ processing, storage, config, attempt, job, owner, task, obj, glb, audit, signal: controller.signal });
            derivativeResult = { verified: true, reused: false, replacedInvalidTiles: true };
          } else derivativeResult = { verified: false, fallback: 'glb', reason: sanitizeLogMessage(error.message).slice(0, 500) };
        }
      }
    } else if (job.derivative_type === 'ept') {
      if (!config.localDerivativesEnabled) throw Object.assign(new Error('local point-cloud derivative fallback is disabled'), { code: 'derivative_unavailable' });
      const point = assets.find((asset) => asset.kind === 'pointCloud');
      if (!point) throw new Error('point cloud source is missing');
      const base = storage.resolve('models', `${task.id}/${attempt.id}`);
      fs.mkdirSync(base, { recursive: true });
      const output = path.join(base, 'ept');
      const incomplete = `${output}.${job.id}.incomplete`;
      fs.rmSync(incomplete, { recursive: true, force: true });
      try {
        await run(config.entwineBin, ['build', '-i', storage.resolve(point.root_key, point.relative_path, { mustExist: true }), '-o', incomplete], { signal: controller.signal });
        if (!fs.existsSync(path.join(incomplete, 'ept.json'))) throw new Error('Entwine did not produce ept.json');
        fs.rmSync(output, { recursive: true, force: true });
        fs.renameSync(incomplete, output);
        await registerTreeAsset(processing, {
          versionId: attempt.resultModelVersionId,
          kind: 'ept',
          rootKey: 'models',
          relativePath: `${task.id}/${attempt.id}/ept/ept.json`,
          format: 'ept',
          contentType: 'application/json',
          byteSize: fs.statSync(path.join(output, 'ept.json')).size,
          attemptId: attempt.id,
        }, output, 'ept.json');
      } catch (error) {
        fs.rmSync(incomplete, { recursive: true, force: true });
        throw error;
      }
      derivativeResult = { verified: true };
    } else if (job.derivative_type === 'mesh_tiles') {
      await generateMeshTiles({ processing, storage, config, attempt, job, owner, task, obj, glb, audit, signal: controller.signal });
      derivativeResult = { verified: true, reused: false };
    } else throw new Error('unsupported derivative type');

    if (lost) throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
    if (request.optional && ['ready_for_review', 'published'].includes(attempt.status)) {
      if (!processing.completeOptionalDerivative(job.id, owner, derivativeResult)) throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
    } else emitReady(processing, config, attempt, job, owner, derivativeResult);
    return true;
  } catch (error) {
    const safe = sanitizeLogMessage(error.message).slice(0, 1000);
    if (error.code !== 'lease_lost') {
      if (request.optional && ['ready_for_review', 'published'].includes(attempt.status)) processing.failOptionalDerivative(job.id, owner, safe, error.code || 'derivative_failed');
      else processing.failDerivative(job.id, owner, safe, error.code || 'derivative_failed');
    }
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}

module.exports = { assertLodArtifactsMatchSnapshot, generateMeshTiles, processOneDerivative, run, stopProcessTree };
