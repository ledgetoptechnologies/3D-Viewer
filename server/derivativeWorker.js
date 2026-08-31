'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sanitizeLogMessage } = require('./processingSecurity');
const { hashFile, hashTree } = require('./storageManager');
const { verifyLodProvenance } = require('./lodProvenance');
const {
  CONTROLLED_CONVERTER_COMMAND_SHA256,
  obj2TilesArguments,
} = require('../lod-converter-policy.cjs');

function stopProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function run(bin, args, { timeoutMs = 24 * 3600_000, signal, killGraceMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let stderr = '';
    let settled = false;
    let terminationError = null;
    let timer = null;
    let hardKillTimer = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve();
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      stopProcessTree(child, 'SIGTERM');
      hardKillTimer = setTimeout(
        () => stopProcessTree(child, 'SIGKILL'),
        Math.max(0, Math.min(Number(killGraceMs) || 0, 60_000)),
      );
    };
    const abort = () => {
      const reason = signal?.reason;
      terminate(reason instanceof Error ? reason : Object.assign(new Error('derivative operation cancelled'), { code: 'lease_lost' }));
    };
    timer = setTimeout(() => {
      terminate(Object.assign(new Error('derivative command timed out'), { code: 'derivative_timeout' }));
    }, Math.max(1, Number(timeoutMs) || 1));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-64000); });
    child.once('error', finish);
    child.once('exit', (code) => finish(terminationError || (code === 0 ? null : Object.assign(
      new Error(`derivative command failed (${code}): ${sanitizeLogMessage(stderr).slice(-1000)}`),
      { code: 'derivative_failed', exitCode: code },
    ))));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function derivativePhase(processing, job, owner, phase) {
  if (!processing.updateDerivativeProgress(job.id, owner, phase, job.lease_token)) {
    throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
  }
  const type = ['lod_audit', 'mesh_tiles', 'ept'].includes(job.derivative_type)
    ? job.derivative_type
    : 'unsupported';
  console.info(`[derivative] type=${type} phase=${phase}`);
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
  const completed = processing.completeDerivativeAndMaybeReady(job.id, owner, result, { event: readyEvent(processing, config, attempt), leaseToken: job.lease_token });
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

function manifestTreeBytes(files) {
  return (files || []).reduce((sum, file) => sum + Math.max(0, Number(file.byteSize) || 0), 0);
}

function previousManagedTilesDirectory(storage, base, asset) {
  if (!asset || asset.root_key !== 'models' || !asset.relative_path) return null;
  try {
    const manifest = storage.resolve('models', asset.relative_path, { mustExist: true });
    const directory = path.dirname(manifest);
    const relative = path.relative(base, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return directory;
  } catch {
    return null;
  }
}

async function generateMeshTiles({ processing, storage, config, attempt, job, owner, task, obj, glb, previousTiles = null, audit, signal, onPhase = () => {} }) {
  if (!config.meshDerivativesEnabled) throw Object.assign(new Error('mesh derivative fallback is disabled'), { code: 'derivative_unavailable' });
  if (!obj || !glb) throw Object.assign(new Error('verified Obj2Tiles generation requires both OBJ and GLB mesh sources'), { code: 'unsupported_mesh_derivative_source' });
  const workId = String(job.id || ''), leaseToken = String(job.lease_token || '');
  if (!/^[a-f0-9-]{16,64}$/i.test(workId) || !/^[a-f0-9]{32}$/.test(leaseToken)) throw Object.assign(new Error('derivative job identity is invalid'), { code: 'invalid_storage_location' });
  const relativeBase = `${task.id}/${attempt.id}`;
  const baseCandidate = storage.resolve('models', relativeBase);
  fs.mkdirSync(baseCandidate, { recursive: true });
  const base = storage.resolve('models', relativeBase, { mustExist: true });
  if (base !== baseCandidate || fs.statSync(base).dev !== fs.statSync(storage.roots.models).dev) {
    throw Object.assign(new Error('derivative activation must use an unaliased path on one filesystem'), { code: 'invalid_storage_location' });
  }
  const outputName = `tiles-ktx2-etc1s-${job.id}`;
  const outputRelative = `${task.id}/${attempt.id}/${outputName}`;
  const output = path.join(base, outputName);
  const incomplete = `${output}.${leaseToken}.incomplete`;
  const complete = `${output}.${leaseToken}.complete`;
  const previousBytes = previousTiles?.id
    ? Number(processing.database.prepare('SELECT COALESCE(SUM(byte_size),0) AS n FROM model_asset_files WHERE asset_id=?').get(previousTiles.id)?.n || 0)
    : 0;
  const source = storage.resolve(obj.root_key, obj.relative_path, { mustExist: true });
  const auditSource = storage.resolve(glb.root_key, glb.relative_path, { mustExist: true });
  const outputRecord = processing.getModelOutput(attempt.resultModelVersionId);
  const sourceBytes = Math.max(Number(outputRecord?.byteSize) || 0, (Number(obj.byte_size) || 0) + (Number(glb.byte_size) || 0));
  const admission = storage.requireDerivativeSpace('models', { sourceBytes, expectedFiles: 10_000 });
  const assetInput = (directory) => ({
    versionId: attempt.resultModelVersionId,
    rootKey: 'models',
    relativePath: `${outputRelative}/tileset.json`,
    format: '3dtiles',
    contentType: 'application/json',
    byteSize: fs.statSync(path.join(directory, 'tileset.json')).size,
    attemptId: attempt.id,
  });
  const register = (verified, promote = null) => processing.registerVerifiedLodAsset(
    job.id, owner, verified.asset, verified.provenance, { leaseToken, promote },
  );

  if (fs.existsSync(output)) {
    onPhase('verifying');
    let existing;
    try { existing = await verifiedLodAsset(assetInput(output), output, auditSource); }
    catch (error) {
      const previousDirectory = previousManagedTilesDirectory(storage, base, previousTiles);
      if (previousDirectory === output) throw Object.assign(new Error('a referenced derivative final failed re-verification'), { code: 'lod_referenced_asset_invalid', cause: error });
      const quarantine = `${output}.${Date.now()}.quarantine`;
      fs.renameSync(output, quarantine);
      throw Object.assign(new Error('an unreferenced derivative final failed re-verification'), { code: 'lod_provenance_invalid', cause: error });
    }
    if (existing.provenance?.converter?.commandSha256 !== CONTROLLED_CONVERTER_COMMAND_SHA256) {
      throw Object.assign(new Error('existing derivative does not use the current KTX2 policy'), { code: 'lod_provenance_invalid' });
    }
    onPhase('registering');
    if (!register(existing)) throw Object.assign(new Error('derivative lease was lost before verified tile registration'), { code: 'lease_lost' });
    return {
      retainedBytes: manifestTreeBytes(existing.asset.manifestFiles),
      fileCount: existing.asset.manifestFiles.length,
      priorTreeBytes: previousBytes,
      replacedBytes: 0,
      resumed: true,
    };
  }

  fs.rmSync(incomplete, { recursive: true, force: true });
  fs.rmSync(complete, { recursive: true, force: true });
  const pressure = new AbortController();
  const combinedSignal = AbortSignal.any([signal, pressure.signal]);
  const guard = () => {
    try {
      const current = storage.space('models', 0);
      if (current.available <= current.reserve + 5 * 1024 ** 3
        || !Number.isFinite(current.ffree) || current.ffree <= admission.inodeReserve) {
        pressure.abort(Object.assign(new Error('derivative storage headroom fell below the safety reserve'), { code: 'insufficient_storage' }));
      }
    } catch (error) {
      pressure.abort(Object.assign(new Error('derivative storage headroom could not be verified'), { code: 'insufficient_storage', cause: error }));
    }
  };
  guard();
  if (pressure.signal.aborted) throw pressure.signal.reason;
  const guardTimer = setInterval(guard, 1000);
  const remainingMs = Date.parse(job.deadline_at || '') - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    clearInterval(guardTimer);
    throw Object.assign(new Error('derivative wall-clock deadline expired'), { code: 'derivative_timeout' });
  }

  try {
    onPhase('generating');
    await run(config.obj2TilesBin, obj2TilesArguments(source, incomplete), { timeoutMs: remainingMs, signal: combinedSignal });
    if (pressure.signal.aborted) throw pressure.signal.reason;
    onPhase('auditing');
    await run(process.execPath, [
      audit,
      incomplete,
      auditSource,
      '--external-source',
      '--controlled-obj2tiles',
      source,
      config.obj2TilesBin,
    ], { timeoutMs: Math.max(1, Date.parse(job.deadline_at) - Date.now()), signal: combinedSignal });
    if (pressure.signal.aborted) throw pressure.signal.reason;
    onPhase('verifying');
    const verified = await verifiedLodAsset(assetInput(incomplete), incomplete, auditSource);
    if (verified.asset.manifestFiles.length > 100_000) throw Object.assign(new Error('derivative contains too many files'), { code: 'invalid_asset_tree' });
    fs.renameSync(incomplete, complete);
    onPhase('registering');
    const registered = register(verified, () => {
      if (fs.existsSync(output)) throw Object.assign(new Error('derivative final appeared during activation'), { code: 'derivative_activation_conflict' });
      if (fs.statSync(complete).dev !== fs.statSync(base).dev) throw Object.assign(new Error('derivative activation crossed filesystems'), { code: 'invalid_storage_location' });
      fs.renameSync(complete, output);
    });
    if (!registered) throw Object.assign(new Error('derivative lease was lost before verified tile registration'), { code: 'lease_lost' });
    return {
      retainedBytes: manifestTreeBytes(verified.asset.manifestFiles),
      fileCount: verified.asset.manifestFiles.length,
      priorTreeBytes: previousBytes,
      replacedBytes: 0,
      resumed: false,
    };
  } catch (error) {
    fs.rmSync(incomplete, { recursive: true, force: true });
    fs.rmSync(complete, { recursive: true, force: true });
    throw error;
  } finally {
    clearInterval(guardTimer);
  }
}

async function processOneDerivative({ processing, storage, config, lodAuditScript = null, generateMeshTilesImpl = generateMeshTiles }, owner) {
  const job = processing.claimDerivative(owner);
  if (!job) return false;
  const startedAt = Date.now();
  const attempt = processing.getAttempt(job.attempt_id);
  const controller = new AbortController();
  let lost = false;
  let request = {};
  const heartbeat = setInterval(() => {
    if (!processing.heartbeatDerivative(job.id, owner, job.lease_token)) {
      lost = true;
      controller.abort(Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' }));
    }
  }, 20000);
  heartbeat.unref?.();
  try {
    derivativePhase(processing, job, owner, 'claimed');
    if (['cancelled', 'failed'].includes(attempt.status)) throw Object.assign(new Error('attempt is no longer active'), { code: 'lease_lost' });
    request = JSON.parse(job.request_json || '{}');
    if (request.optional && ['lod_audit', 'mesh_tiles'].includes(job.derivative_type)
      && ['ready_for_review', 'published'].includes(attempt.status)) {
      throw Object.assign(new Error('ready and published model versions are immutable; create a new processing attempt'), { code: 'derivative_in_place_disabled' });
    }
    const assets = processing.database.prepare('SELECT * FROM model_assets WHERE version_id=?').all(attempt.resultModelVersionId);
    const task = processing.getTask(attempt.taskId);
    const obj = assets.find((asset) => asset.kind === 'obj');
    const glb = assets.find((asset) => asset.kind === 'glb');
    const previousTiles = assets.find((asset) => asset.kind === 'tiles') || null;
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
          derivativePhase(processing, job, owner, 'auditing');
          await run(process.execPath, [audit, tiles, source, '--external-source'], { signal: controller.signal });
          derivativePhase(processing, job, owner, 'verifying');
          const verified = await verifiedLodAsset({
            versionId: attempt.resultModelVersionId,
            rootKey: tilesRootKey,
            relativePath: path.posix.join(request.tilesRelativePath, 'tileset.json'),
            format: '3dtiles',
            contentType: 'application/json',
            byteSize: fs.statSync(path.join(tiles, 'tileset.json')).size,
            attemptId: attempt.id,
          }, tiles, source);
          derivativePhase(processing, job, owner, 'registering');
          if (!processing.registerVerifiedLodAsset(job.id, owner, verified.asset, verified.provenance, { leaseToken: job.lease_token })) {
            throw Object.assign(new Error('derivative lease was lost before verified tile registration'), { code: 'lease_lost' });
          }
          derivativeResult = { verified: true, reused: true };
        } catch (error) {
          if (error.code === 'lease_lost') throw error;
          if (error.exitCode !== 3) throw error;
          if (!request.optional) {
            throw Object.assign(new Error('required native tiles failed equivalence verification'), { code: 'lod_audit_failed', cause: error });
          }
          derivativeResult = { verified: false, fallback: 'glb', reason: sanitizeLogMessage(error.message).slice(0, 500) };
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
        derivativePhase(processing, job, owner, 'indexing');
        await run(config.entwineBin, ['build', '-i', storage.resolve(point.root_key, point.relative_path, { mustExist: true }), '-o', incomplete], { signal: controller.signal });
        if (!fs.existsSync(path.join(incomplete, 'ept.json'))) throw new Error('Entwine did not produce ept.json');
        fs.rmSync(output, { recursive: true, force: true });
        fs.renameSync(incomplete, output);
        derivativePhase(processing, job, owner, 'registering');
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
      const generation = await generateMeshTilesImpl({ processing, storage, config, attempt, job, owner, task, obj, glb, previousTiles, audit, signal: controller.signal, onPhase: (phase) => derivativePhase(processing, job, owner, phase) });
      derivativeResult = { verified: true, reused: false, ...generation };
    } else throw new Error('unsupported derivative type');

    if (lost) throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
    const completedResult = {
      ...derivativeResult,
      phase: 'complete',
      summary: derivativeResult.verified === false
        ? 'Existing streaming artifacts were rejected; no derivative was registered.'
        : 'Verified derivative registered and ready for the Viewer.',
      durationMs: Math.max(0, Date.now() - startedAt),
    };
    if (request.optional && ['ready_for_review', 'published'].includes(attempt.status)) {
      if (!processing.completeOptionalDerivative(job.id, owner, completedResult, job.lease_token)) throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
    } else emitReady(processing, config, attempt, job, owner, completedResult);
    console.info(`[derivative] type=${job.derivative_type} outcome=complete durationMs=${completedResult.durationMs}`);
    return true;
  } catch (error) {
    const safe = sanitizeLogMessage(error.message).slice(0, 1000);
    const errorCode = String(error.code || 'derivative_failed').replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || 'derivative_failed';
    console.error(`[derivative] type=${['lod_audit','mesh_tiles','ept'].includes(job.derivative_type)?job.derivative_type:'unsupported'} outcome=failed durationMs=${Math.max(0,Date.now()-startedAt)} code=${errorCode}`);
    if (error.code !== 'lease_lost') {
      if (request.optional && ['ready_for_review', 'published'].includes(attempt.status)) processing.failOptionalDerivative(job.id, owner, safe, errorCode, job.lease_token);
      else processing.failDerivative(job.id, owner, safe, errorCode, job.lease_token);
    }
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}

module.exports = { assertLodArtifactsMatchSnapshot, generateMeshTiles, processOneDerivative, run, stopProcessTree };
