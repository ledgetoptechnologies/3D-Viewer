'use strict';

const crypto = require('node:crypto');
const { sanitizeLogMessage } = require('./processingSecurity');
const { mapCatalogCandidate, scanCatalog } = require('./catalogImport');

function reconcileCatalogSourceCleanups(processing,storage,limit=20){let cleaned=0;for(const item of processing.pendingCatalogSourceCleanups(limit)){try{let absolute=null;try{absolute=storage.resolve(item.rootKey,item.relativePath,{mustExist:true});}catch(error){if(error.code!=='ENOENT'&&!/ENOENT/.test(error.message))throw error;}if(absolute)storage.removeAdoptedSource(absolute);processing.clearCatalogSourceCleanup(item.id);cleaned+=1;}catch{/* durable journal retries during maintenance */}}return cleaned;}

function manifestHash(files) {
  const canonical = files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 }));
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function finalizeUpload(operation, { processing, storage }, owner, updateProgress) {
  const upload = processing.getUpload(operation.upload_id);
  if (!upload) throw Object.assign(new Error('upload session is unavailable'), { code: 'upload_unavailable' });
  const existing = processing.getDataset(upload.datasetId, true);
  if (existing?.status === 'finalized') {
    processing.completeUpload(upload.id);
    storage.cleanupUpload(upload.id);
    return { dataset: existing };
  }
  if (!existing || upload.status !== 'finalizing') throw Object.assign(new Error('upload is not finalizing'), { code: 'upload_not_finalizing' });
  storage.requireSpace('datasets', upload.files.reduce((sum, file) => sum + file.byteSize, 0));
  const files = [];
  for (let index = 0; index < upload.files.length; index += 1) {
    const file = upload.files[index];
    const chunks = processing.listChunks(upload.id, file.id);
    const expected = Math.ceil(file.byteSize / upload.chunkSize) || 1;
    if (chunks.length !== expected || chunks.some((chunk, chunkIndex) => chunk.chunk_index !== chunkIndex))
      throw Object.assign(new Error('upload is incomplete'), { code: 'upload_incomplete' });
    files.push(await storage.assembleFile(upload, file, chunks, existing.relativePath));
    await updateProgress(0.05 + 0.9 * (index + 1) / Math.max(1, upload.files.length));
  }
  const dataset = processing.finalizeDataset(existing.id, files, manifestHash(files));
  processing.completeUpload(upload.id);
  storage.cleanupUpload(upload.id);
  return { dataset };
}

async function adoptImport(operation, { processing, storage }, owner, updateProgress) {
  const payload = JSON.parse(operation.payload_json || '{}');
  const existing = processing.getDataset(operation.dataset_id, true);
  const finishAuthorizationAndSource = () => {
    if (payload.storageMode === 'adopted' && ['dataset_import', 'terra_import'].includes(payload.rootKey)) {
      try {
        const source = storage.resolve(payload.rootKey, payload.relativePath, { mustExist: true });
        storage.removeAdoptedSource(source);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!processing.consumeOperationImportPreview(operation.id, payload.previewId))
      throw Object.assign(new Error('import authorization was lost'), { code: 'preview_claim_lost' });
  };
  if (existing?.status === 'finalized') {
    finishAuthorizationAndSource();
    return { dataset: existing };
  }
  if (!existing || existing.status !== 'finalizing') throw Object.assign(new Error('import dataset is unavailable'), { code: 'dataset_unavailable' });
  const externalReference = payload.storageMode === 'external_reference';
  const adopted = await storage.adoptImport(payload.rootKey, payload.relativePath, existing.relativePath, {
    externalReference,
    expectedFingerprint: payload.treeFingerprint,
    onProgress: updateProgress,
  });
  const files = adopted.scan.files.map((file) => ({
    id: crypto.randomUUID(),
    relativePath: file.relativePath,
    byteSize: file.byteSize,
    sha256: file.sha256,
    metadata: file.metadata || {},
  }));
  const dataset = processing.finalizeDataset(existing.id, files, manifestHash(files));
  finishAuthorizationAndSource();
  return { dataset };
}

function publicImportPreview(preview) {
  const value = preview.destinationSpace;
  return {...preview,destinationSpace:{availableBytes:Number(value.available),totalBytes:Number(value.total),reserveBytes:Number(value.reserve),requiredBytes:Number(value.required),sufficient:Boolean(value.ok)}};
}

async function previewImport(operation, { storage, config }, updateProgress, signal) {
  const payload = JSON.parse(operation.payload_json || '{}');
  const preview = await storage.previewImport(payload.rootKey, payload.relativePath, {
    maxFiles: config?.uploadMaxFiles || 100000,
    signal,
    onProgress: updateProgress,
  });
  return { request: { rootKey: payload.rootKey, relativePath: payload.relativePath }, preview, publicPreview: publicImportPreview(preview) };
}

async function processOneDatasetOperation(deps, owner) {
  const operation = deps.processing.claimDatasetOperation(owner);
  if (!operation) return false;
  let progress = Number(operation.progress) || 0;
  let lostLease = false;
  const controller = new AbortController();
  const heartbeat = () => {
    if (!deps.processing.heartbeatDatasetOperation(operation.id, owner, progress)) { lostLease = true; controller.abort(); }
  };
  const timer = setInterval(heartbeat, 2_000);
  timer.unref?.();
  const updateProgress = async (value) => {
    progress = Math.max(progress, Math.min(0.99, Number(value) || 0));
    heartbeat();
    if (lostLease) throw Object.assign(new Error('dataset operation lease was lost'), { code: 'operation_lease_lost' });
  };
  try {
    let result;
    if (operation.operation_type === 'upload_finalize') result = await finalizeUpload(operation, deps, owner, updateProgress);
    else if (operation.operation_type === 'import_preview') {
      const completed = await previewImport(operation, deps, updateProgress, controller.signal);
      if (lostLease || !deps.processing.completeImportPreviewOperation(operation.id, owner, completed))
        throw Object.assign(new Error('dataset operation lease was lost'), { code: 'operation_lease_lost' });
      return true;
    }
    else if (operation.operation_type === 'import_adopt') result = await adoptImport(operation, deps, owner, updateProgress);
    else if (operation.operation_type === 'catalog_scan') {
      const payload=JSON.parse(operation.payload_json||'{}'),candidates=await scanCatalog(payload.provider,deps.config,updateProgress);
      result=deps.processing.upsertCatalogScanCandidates({scanId:payload.scanId,provider:payload.provider,generation:payload.generation,candidates});
      deps.processing.classifyCatalogStaleness(payload.provider,payload.generation);
      deps.repository.audit({actorType:'admin',actorId:operation.subject,action:'catalog_import.scan_completed',entityType:'catalog_import_scan',entityId:payload.scanId,details:{provider:payload.provider,candidateCount:candidates.length}});
    }
    else if (operation.operation_type === 'catalog_map') {
      result=await mapCatalogCandidate(operation,deps,updateProgress);
      deps.repository.audit({actorType:'admin',actorId:operation.subject,action:'catalog_import.mapped',entityType:'catalog_import_candidate',entityId:result.candidate.id,details:{projectId:result.project.id,taskId:result.task.id,modelId:result.model.id}});
    }
    else throw Object.assign(new Error('dataset operation type is unsupported'), { code: 'unsupported_operation' });
    if (lostLease || !deps.processing.completeDatasetOperation(operation.id, owner, result))
      throw Object.assign(new Error('dataset operation lease was lost'), { code: 'operation_lease_lost' });
    if(operation.operation_type==='catalog_map')reconcileCatalogSourceCleanups(deps.processing,deps.storage,1);
  } catch (error) {
    if(operation.operation_type==='catalog_map'){
      try{deps.processing.rollbackCatalogMapProvisional(operation.id,owner);}catch{/* the operation remains failed and retryable with the same stable IDs */}
    }
    deps.processing.failDatasetOperation(operation.id, owner, error.code || 'dataset_operation_failed', sanitizeLogMessage(error.message));
  } finally {
    clearInterval(timer);
  }
  return true;
}

module.exports = { manifestHash, processOneDatasetOperation, reconcileCatalogSourceCleanups };
