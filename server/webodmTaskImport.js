'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { extractZipFile } = require('./safeZip');
const { discoverAssets } = require('./catalogImport');
const { validateImportSelection } = require('./importBrowser');
const { hashFile, hashTree } = require('./storageManager');
const { readOdmTaskMetadata } = require('./odmTaskMetadata');
const { discoverCameraPhotoLinks } = require('./cameraPhotos');
const { lodDerivativeSpecs } = require('./lodDerivativePolicy');

const CAPABILITIES = Object.freeze({
  glb: '3d_model', obj: '3d_model', tiles: '3d_model',
  ept: 'point_cloud', pointCloud: 'point_cloud', ortho: 'orthophoto',
  dsm: 'dsm', dtm: 'dtm', shots: 'camera_positions',
});

function capabilitySummary(assets) {
  const assetKinds = [...new Set(assets.map((asset) => asset.kind))].sort();
  return { assetKinds, capabilities: [...new Set(assetKinds.map((kind) => CAPABILITIES[kind]).filter(Boolean))].sort() };
}

async function copyTree(source, destination, { maxFiles, maxBytes, signal, progress = async () => {} }) {
  const files = [];
  const walk = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (signal?.aborted) throw Object.assign(new Error('task import cancelled'), { code: 'lease_lost' });
      const absolute = path.join(directory, entry.name), rel = relative ? `${relative}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw Object.assign(new Error('task import contains an unsupported file'), { code: 'invalid_asset_tree' });
      if (entry.isDirectory()) walk(absolute, rel);
      else files.push({ absolute, rel, bytes: stat.size });
      if (files.length > maxFiles) throw Object.assign(new Error('task import contains too many files'), { code: 'too_many_files' });
    }
  };
  walk(source);
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (bytes > maxBytes) throw Object.assign(new Error('task import exceeds the configured size limit'), { code: 'import_too_large' });
  fs.mkdirSync(destination, { recursive: true });
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index], target = path.join(destination, ...file.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await pipeline(fs.createReadStream(file.absolute), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal });
    await progress((index + 1) / Math.max(1, files.length));
  }
}

async function stageSource(operation, { storage, config }, signal, progress) {
  const payload = JSON.parse(operation.payload_json || '{}'), request = payload.request || {};
  validateImportSelection(storage, request.sourceRelativePath);
  const source = storage.resolve('dataset_import', request.sourceRelativePath, { mustExist: true });
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Object.assign(new Error('WebODM task source must be a folder or ZIP archive'), { code: 'invalid_import_source' });
  const stagingRelative = `webodm-task-imports/${operation.id}`, staging = storage.resolve('cache', stagingRelative);
  const maxFiles = config.uploadMaxFiles || 100000;
  const available = storage.space('datasets', 0), cacheSpace = storage.space('cache', stat.isFile() ? stat.size : 0);
  if (!cacheSpace.ok) throw Object.assign(new Error('insufficient cache headroom for WebODM task staging'), { code: 'insufficient_storage' });
  const maxBytes = Math.max(0, Math.min(available.available - available.reserve, cacheSpace.available - cacheSpace.reserve));
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  if (stat.isDirectory()) await copyTree(source, staging, { maxFiles, maxBytes, signal, progress: (value) => progress(value * 0.25) });
  else {
    if (path.extname(source).toLowerCase() !== '.zip') throw Object.assign(new Error('WebODM task archive must use .zip'), { code: 'invalid_archive_type' });
    await extractZipFile(source, staging, {
      maxEntries: maxFiles, maxBytes, workId: operation.id, signal,
      onProgress: (value) => progress(value * 0.25),
    });
  }
  return { payload, request, source, staging, stagingRelative };
}

function manifestHash(files) { return crypto.createHash('sha256').update(JSON.stringify(files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })))).digest('hex'); }

async function importWebodmTask(operation, { processing, repository, storage, config }, progress = async () => {}, signal = null) {
  const replay=processing.getWebodmTaskImport(operation.id);
  if(replay){
    const payload=JSON.parse(operation.payload_json||'{}'),ids=payload.ids||{},project=processing.getProject(replay.projectId),task=processing.getTask(replay.taskId),attempt=processing.getAttempt(replay.attemptId),dataset=processing.getDataset(replay.datasetId,true),model=repository.getModelVersion(replay.modelId,replay.modelVersionId);
    if(!project||!task||!attempt||!dataset||dataset.status!=='finalized'||!model||replay.sourceRelativePath!==payload.request?.sourceRelativePath||replay.projectId!==payload.request?.projectId||replay.taskId!==ids.taskId||replay.datasetId!==ids.datasetId||replay.attemptId!==ids.attemptId||replay.modelId!==ids.modelId||replay.modelVersionId!==ids.versionId||attempt.status!=='ingesting')throw Object.assign(new Error('WebODM import replay state changed'),{code:'webodm_import_replay_conflict'});
    const datasetRoot=storage.resolve('datasets',dataset.relativePath,{mustExist:true}),rediscovered=await discoverAssets(datasetRoot);
    if(rediscovered.sourceFingerprint!==replay.sourceFingerprint)throw Object.assign(new Error('WebODM import replay source changed'),{code:'webodm_import_replay_conflict'});
    const assets=rediscovered.assets.map((asset)=>({...asset,rootKey:'datasets',relativePath:`${dataset.relativePath}/${asset.relativePath}`,storageMode:'adopted',published:false,sourceAttemptId:attempt.id})),summary=capabilitySummary(assets);
    if(JSON.stringify(summary.assetKinds)!==JSON.stringify(replay.assetKinds))throw Object.assign(new Error('WebODM import replay assets changed'),{code:'webodm_import_replay_conflict'});
    const requiredDerivatives=lodDerivativeSpecs(assets,{meshDerivativesEnabled:config.meshDerivativesEnabled,required:true});
    return{project,task,attempt,model,import:replay,requiredDerivatives,...summary};
  }
  const { payload, request, staging, stagingRelative } = await stageSource(operation, { storage, config }, signal, progress);
  const ids = payload.ids || {}, discovered = await discoverAssets(staging), summary = capabilitySummary(discovered.assets);
  const discoveredCameraPhotos = discoverCameraPhotoLinks(staging, discovered);
  if (!summary.assetKinds.length) { fs.rmSync(staging, { recursive: true, force: true }); throw Object.assign(new Error('No supported WebODM task artifacts were found'), { code: 'no_supported_assets' }); }
  await progress(0.35);

  if(!processing.setCatalogAdoptionIntent(operation.id,operation.lease_owner,{rootKey:'cache',relativePath:stagingRelative,datasetRelative:ids.datasetId}))throw Object.assign(new Error('task import lease was lost before adoption was journaled'),{code:'operation_lease_lost'});

  let dataset = processing.getDataset(ids.datasetId, true);
  if (!dataset) dataset = processing.createDataset({ id: ids.datasetId, projectId: request.projectId, displayName: `${request.taskDisplayName} source`, sourceType: 'webodm', storageMode: 'adopted', rootKey: 'datasets', relativePath: ids.datasetId, status: 'finalizing', createdBy: operation.subject, metadata: { catalogImportOperationId: operation.id, webodmTaskImportOperationId: operation.id, sourceRelativePath: request.sourceRelativePath, assetKinds: summary.assetKinds } });
  if (dataset.status !== 'finalized') {
    const adopted = await storage.adoptImport('cache', stagingRelative, ids.datasetId, { expectedFingerprint: discovered.sourceFingerprint, maxFiles: config.uploadMaxFiles || 100000, onProgress: (value) => progress(0.35 + value * 0.35) });
    dataset = processing.finalizeDataset(dataset.id, adopted.scan.files.map((file) => ({ relativePath: file.relativePath, byteSize: file.byteSize, sha256: file.sha256, metadata: file.metadata || {} })), manifestHash(adopted.scan.files));
  }
  let task = processing.getTask(ids.taskId);
  if (!task) task = processing.createTask({ id: ids.taskId, projectId: request.projectId, datasetId: dataset.id, displayName: request.taskDisplayName, createdBy: operation.subject, metadata: { catalogImportOperationId: operation.id, webodmTaskImportOperationId: operation.id, assetKinds: summary.assetKinds } });
  const attempt = processing.createImportedAttempt({ id: ids.attemptId, taskId: task.id, datasetId: dataset.id, providerTaskId: request.externalTaskId ? `webodm:${request.externalTaskId}` : `webodm-import:${discovered.sourceFingerprint}`, createdBy: operation.subject, displayName: request.taskDisplayName, metadata: { webodmTaskImport: true }, staged: true });
  const datasetRoot = storage.resolve('datasets', dataset.relativePath, { mustExist: true }), assets = [];
  for (const asset of discovered.assets) {
    const entry = { ...asset, rootKey: 'datasets', relativePath: `${dataset.relativePath}/${asset.relativePath}`, storageMode: 'adopted', published: false, sourceAttemptId: attempt.id };
    if (['ept', 'tiles'].includes(asset.kind)) { const tree = await hashTree(path.dirname(path.join(datasetRoot, ...asset.relativePath.split('/')))); entry.manifestSha256 = tree.manifestSha256; entry.manifestFiles = tree.files; }
    assets.push(entry);
  }
  const odmMetadata = readOdmTaskMetadata(datasetRoot);
  const cameraPhotos = discoveredCameraPhotos.map((photo) => ({ ...photo, rootKey: 'datasets', relativePath: `${dataset.relativePath}/${photo.relativePath}` }));
  const registeredAssets = assets.filter((asset) => asset.kind !== 'tiles');
  const model = repository.upsertModelVersion({ modelId: ids.modelId, versionId: ids.versionId, provider: 'webodm', providerModelId: `task-import:${operation.id}`, providerVersionId: discovered.sourceFingerprint, displayName: request.taskDisplayName, status: 'importing', metadata: { projectName: processing.getProject(request.projectId).displayName, taskName: request.taskDisplayName, webodmTaskImportOperationId: operation.id }, versionMetadata: { webodmTaskImport: true, assetKinds: summary.assetKinds, processingMetrics: odmMetadata.processingMetrics }, georef: odmMetadata.georef, pointCount: odmMetadata.pointCount, sourceLocator: { webodmTaskImport: true, sourceRelativePath: request.sourceRelativePath }, assets: registeredAssets, cameraPhotos, makeActive: false });
  processing.setAttemptResult(attempt.id, model.id, ids.versionId);
  // Existing accounting assigns adopted/reference trees to the output and
  // excludes their source dataset from the project dataset subtotal.
  processing.registerModelOutput({ versionId: ids.versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: request.projectId, rootKey: 'datasets', relativePath: dataset.relativePath, storageMode: 'adopted', status: 'staged', byteSize: dataset.byteSize, assetCount: registeredAssets.length });
  const lodDerivatives = lodDerivativeSpecs(assets, {
    meshDerivativesEnabled: config.meshDerivativesEnabled,
    required: true,
  });
  const imported = processing.recordWebodmTaskImport({ id: operation.id, sourceFingerprint: discovered.sourceFingerprint, sourceRelativePath: request.sourceRelativePath, projectId: request.projectId, taskId: task.id, datasetId: dataset.id, attemptId: attempt.id, modelId: model.id, modelVersionId: ids.versionId, assetKinds: summary.assetKinds, createdBy: operation.subject });
  await progress(0.98);
  return { project: processing.getProject(request.projectId), task: processing.getTask(task.id), attempt: processing.getAttempt(attempt.id), model: repository.getModelVersion(model.id, ids.versionId), import: imported, requiredDerivatives: lodDerivatives, ...summary };
}

module.exports = { CAPABILITIES, capabilitySummary, copyTree, importWebodmTask, stageSource };
