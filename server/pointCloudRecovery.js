'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { verifyRetainedClosure } = require('./retainedManifest');
const { copyRetainedClosure } = require('./webodmTaskImport');
const { companionCopyManifests, ownedRecoveryCompanions,
  verifyRecoveryCompanionDestination, verifyRecoveryCompanionPlan } = require('./lodRecoveryCompanions');
const { recordImportedSourceUnits } = require('./importSourceUnitEvidence');
const { fsyncDirectory, fsyncDirectoryTree } = require('./durableFs');
const { LOD_DERIVATIVE_RECOVERY_REVISION } = require('./lodRecoveryPolicy');
const { recoveryScratchRelative, withRecoveryMaterializationLease } = require('./recoveryMaterializationLease');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

async function inspectPointCloudRecoverySource(outputId, { processing, storage, config }, signal = null) {
  if (!config.localDerivativesEnabled) fail('point_cloud_indexing_unavailable', 'Enable the verified Entwine converter before preparing a point-cloud index.');
  const candidate = processing.pointCloudRecoveryCandidate(outputId, config);
  if (!candidate) fail('point_cloud_recovery_not_eligible', 'No eligible private raw-cloud source is available.');
  const root = storage.resolve(candidate.sourceRootKey, candidate.sourceRelativePath, { mustExist: true });
  const files = [{ relativePath: candidate.pointRelativePath, sourceRelativePath: candidate.pointRelativePath,
    role: 'point_cloud_source', byteSize: Number(candidate.point.byte_size), sha256: candidate.point.sha256 }];
  await verifyRetainedClosure(root, files, { signal });
  return { candidate, publicManifest: { files,
    manifestSha256: crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex') } };
}

async function processPointCloudRecovery(operation, deps, progress = async () => {}, signal = null) {
  const { processing, repository, storage } = deps;
  const payload = JSON.parse(operation.payload_json || '{}'), ids = payload.ids || {};
  if (!payload.lodRecovery || !payload.pointCloudRecovery || payload.recoveryRevision !== LOD_DERIVATIVE_RECOVERY_REVISION)
    fail('lod_recovery_revision_mismatch', 'The cloud recovery revision is unsupported.');
  const inspected = await inspectPointCloudRecoverySource(payload.sourceOutputId, deps, signal), { candidate } = inspected;
  if (candidate.versionId !== payload.sourceVersionId || candidate.modelId !== payload.sourceModelId
    || candidate.task.id !== ids.taskId || candidate.dataset.id !== ids.datasetId
    || candidate.sourceRootKey !== payload.sourceRootKey || candidate.sourceRelativePath !== payload.sourceRelativePath
    || inspected.publicManifest.manifestSha256 !== payload.sourceManifestSha256
    || JSON.stringify(inspected.publicManifest.files) !== JSON.stringify(payload.sourceFiles)
    || ![payload.sourceAttemptId, ids.attemptId].includes(candidate.task.activeAttemptId))
    fail('lod_recovery_source_changed', 'The cloud source or active attempt changed after authorization.');
  const plan = verifyRecoveryCompanionPlan(processing.database, payload.sourceVersionId, payload.companions);
  const requiredBytes = plan.byteSize + processing.activeDerivativeReservationBytes(null, operation.id);
  if (!Number.isSafeInteger(requiredBytes)) fail('insufficient_storage', 'The cloud recovery storage estimate overflowed.');
  const destination = storage.resolve('models', payload.targetRelativePath);
  const incomplete = storage.resolve('models', recoveryScratchRelative(operation, payload.targetRelativePath));
  await progress(0.35);
  if (fs.existsSync(destination)) await verifyRecoveryCompanionDestination(plan, destination, { signal });
  else {
    storage.requireSpace('models', requiredBytes);
    if (fs.existsSync(incomplete)) fs.rmSync(incomplete, { recursive: true, force: true });
    try {
      for (const manifest of companionCopyManifests(plan, storage))
        await copyRetainedClosure(manifest.sourceRootPath, incomplete, manifest, { signal, syncDirectoryTree: false });
      verifyRecoveryCompanionPlan(processing.database, payload.sourceVersionId, plan);
      fsyncDirectoryTree(incomplete, { code: 'retained_materialization_failed' });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.statSync(incomplete).dev !== fs.statSync(path.dirname(destination)).dev)
        fail('invalid_storage_location', 'Cloud recovery materialization crossed filesystems.');
      withRecoveryMaterializationLease(operation, processing, () => {
        fs.renameSync(incomplete, destination);
        fsyncDirectory(path.dirname(destination), { code: 'retained_materialization_failed' });
      });
    } catch (error) {
      if (fs.existsSync(incomplete)) fs.rmSync(incomplete, { recursive: true, force: true });
      throw error;
    }
  }
  await progress(0.75);
  const sourceModel = repository.getModelVersion(candidate.modelId, payload.sourceVersionId), source = sourceModel?.activeVersion;
  if (!source) fail('lod_recovery_source_changed', 'The source version is no longer available.');
  const {attempt,model,owned} = withRecoveryMaterializationLease(operation, processing, () => {
  const attempt = processing.createImportedAttempt({ id: ids.attemptId, taskId: candidate.task.id,
    datasetId: candidate.dataset.id, providerTaskId: `point-cloud-recovery:${operation.id}`, createdBy: operation.subject,
    staged: true, expectedActiveAttemptId: payload.sourceAttemptId });
  const owned = ownedRecoveryCompanions(plan, payload.targetRelativePath, attempt.id);
  const model = repository.upsertModelVersion({ modelId: ids.modelId, versionId: ids.versionId,
    provider: sourceModel.provider, providerModelId: sourceModel.providerModelId,
    providerVersionId: `point-cloud-recovery:${operation.id}`, displayName: candidate.task.displayName,
    status: 'importing', metadata: sourceModel.metadata || {},
    versionMetadata: { ...source.metadata, pointCloudRecovery: { operationId: operation.id, sourceVersionId: source.id,
      sourceManifestSha256: payload.sourceManifestSha256, companionManifestSha256: plan.manifestSha256 } },
    georef: source.georef || {}, pointCount: source.pointCount ?? null,
    sourceLocator: { pointCloudRecovery: true, sourceVersionId: source.id, operationId: operation.id },
    assets: owned.assets, cameraPhotos: owned.cameraPhotos, makeActive: false });
  return {attempt,model,owned};
  });
  // Re-inspect exact copied bytes; never relabel old asset-bound unit records.
  await recordImportedSourceUnits(operation, deps, model.id, ids.versionId, { signal });
  withRecoveryMaterializationLease(operation, processing, () => {
  processing.setAttemptResult(attempt.id, model.id, ids.versionId);
  processing.registerModelOutput({ versionId: ids.versionId, modelId: model.id, taskId: candidate.task.id,
    attemptId: attempt.id, projectId: candidate.project.id, rootKey: 'models', relativePath: payload.targetRelativePath,
    storageMode: 'managed', status: 'staged', byteSize: plan.byteSize, assetCount: owned.assets.length });
  });
  await progress(0.98);
  return { project: candidate.project, task: processing.getTask(candidate.task.id), attempt: processing.getAttempt(attempt.id),
    model: repository.getModelVersion(model.id, ids.versionId),
    recovery: { operationId: operation.id, sourceOutputId: payload.sourceOutputId, sourceVersionId: source.id,
      targetVersionId: ids.versionId, pointCloud: true }, requiredDerivatives: [{ type: 'ept', request: { optional: false } }] };
}

module.exports = { inspectPointCloudRecoverySource, processPointCloudRecovery };
