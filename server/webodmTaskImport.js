'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { extractZipDescriptor } = require('./safeZip');
const { matchesSourceSnapshot, openImportFolderSource, openImportZipSource } = require('./importSourceSnapshot');
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

async function copyTree(sourceFd, destination, { maxFiles, maxBytes, signal, progress = async () => {} }) {
  const same=(left,right)=>left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&left.size===right.size&&left.ctimeNs===right.ctimeNs&&left.mtimeNs===right.mtimeNs;
  let files=0,bytes=0;
  fs.mkdirSync(destination,{recursive:true});
  const walk=async(directoryFd,relative='')=>{
    if(signal?.aborted)throw Object.assign(new Error('task import cancelled'),{code:'lease_lost'});
    const beforeDirectory=fs.fstatSync(directoryFd,{bigint:true}),directoryPath=`/proc/self/fd/${directoryFd}`;
    for(const entry of fs.readdirSync(directoryPath,{withFileTypes:true})){
      if(signal?.aborted)throw Object.assign(new Error('task import cancelled'),{code:'lease_lost'});
      const rel=relative?`${relative}/${entry.name}`:entry.name,childPath=`${directoryPath}/${entry.name}`,before=fs.lstatSync(childPath,{bigint:true});
      if(before.isSymbolicLink()||(!before.isDirectory()&&!before.isFile()))throw Object.assign(new Error('task import contains an unsupported file'),{code:'invalid_asset_tree'});
      if(before.isDirectory()){
        let childFd;try{childFd=fs.openSync(childPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}catch{throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});}
        try{const opened=fs.fstatSync(childFd,{bigint:true});if(!opened.isDirectory()||!same(before,opened))throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});fs.mkdirSync(path.join(destination,...rel.split('/')),{recursive:true});await walk(childFd,rel);}finally{fs.closeSync(childFd);}
        continue;
      }
      let fileFd;try{fileFd=fs.openSync(childPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}catch{throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});}
      try{
        const opened=fs.fstatSync(fileFd,{bigint:true});if(!opened.isFile()||!same(before,opened)||opened.size>BigInt(Number.MAX_SAFE_INTEGER))throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});
        files+=1;bytes+=Number(opened.size);if(files>maxFiles)throw Object.assign(new Error('task import contains too many files'),{code:'too_many_files'});if(!Number.isSafeInteger(bytes)||bytes>maxBytes)throw Object.assign(new Error('task import exceeds the configured size limit'),{code:'import_too_large'});
        const target=path.join(destination,...rel.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});const duplicate=fs.openSync(`/proc/self/fd/${fileFd}`,fs.constants.O_RDONLY|fs.constants.O_CLOEXEC),streams=[fs.createReadStream(null,{fd:duplicate,autoClose:true,start:0}),fs.createWriteStream(target,{flags:'wx',mode:0o600})];if(signal)await pipeline(...streams,{signal});else await pipeline(...streams);
        if(!same(opened,fs.fstatSync(fileFd,{bigint:true})))throw Object.assign(new Error('task import source changed while copying'),{code:'source_changed'});
      }finally{fs.closeSync(fileFd);}
      await progress(files/(files+1));
    }
    if(!same(beforeDirectory,fs.fstatSync(directoryFd,{bigint:true})))throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});
  };
  await walk(sourceFd);await progress(1);
}

async function stageSource(operation, { processing, storage, config }, signal, progress) {
  const payload = JSON.parse(operation.payload_json || '{}'), request = payload.request || {};
  const expectedKind=payload.importSource?.kind==='server_zip'?'zip':payload.importSource?.kind==='server_folder'?'folder':null,selected=validateImportSelection(storage, request.sourceRelativePath,{expectedKind});
  const source = storage.resolve('dataset_import', request.sourceRelativePath, { mustExist: true });
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Object.assign(new Error('WebODM task source must be a folder or ZIP archive'), { code: 'invalid_import_source' });
  const stagingRelative = `webodm-task-imports/${operation.id}`, staging = storage.resolve('cache', stagingRelative);
  const maxFiles = config.uploadMaxFiles || 100000;
  const available = storage.space('datasets', 0), cacheSpace = storage.space('cache', stat.isFile() ? stat.size : 0);
  if (!cacheSpace.ok) throw Object.assign(new Error('insufficient cache headroom for WebODM task staging'), { code: 'insufficient_storage' });
  const maxBytes = Math.max(0, Math.min(available.available - available.reserve, cacheSpace.available - cacheSpace.reserve));
  if(selected.kind==='folder'){
    const opened=openImportFolderSource(storage,request.sourceRelativePath);
    try{if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});await copyTree(opened.fd,staging,{maxFiles,maxBytes,signal,progress:(value)=>progress(value*0.25)});}finally{opened.close();}
  }
  else {
    const opened=openImportZipSource(storage,request.sourceRelativePath);
    try{
      const snapshot=await opened.snapshot({signal}),persisted=payload.sourceSnapshot;
      if(persisted&&!matchesSourceSnapshot(persisted,snapshot))throw Object.assign(new Error('WebODM task source changed before extraction'),{code:'source_changed'});
      if(!persisted&&!processing.setWebodmImportSourceSnapshot(operation.id,operation.lease_owner,snapshot))throw Object.assign(new Error('task import lease was lost before source snapshot was persisted'),{code:'operation_lease_lost'});
      if(!fs.existsSync(staging))await extractZipDescriptor(opened.fd,snapshot.byteSize,staging,{maxEntries:maxFiles,maxBytes,workId:operation.id,signal,onProgress:(value)=>progress(value*0.25)});
      else{const stagedStat=fs.lstatSync(staging);if(stagedStat.isSymbolicLink()||!stagedStat.isDirectory())throw Object.assign(new Error('WebODM extraction staging changed'),{code:'invalid_asset_tree'});await progress(0.25);}
      if(await opened.hash({signal})!==snapshot.sha256)throw Object.assign(new Error('WebODM task source changed during extraction'),{code:'source_changed'});
    }finally{opened.close();}
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
  const { payload, request, staging, stagingRelative } = await stageSource(operation, { processing, storage, config }, signal, progress);
  const ids = payload.ids || {}, discovered = await discoverAssets(staging), summary = capabilitySummary(discovered.assets);
  const discoveredCameraPhotos = discoverCameraPhotoLinks(staging, discovered);
  if (!summary.assetKinds.length) throw Object.assign(new Error('No supported WebODM task artifacts were found'), { code: 'no_supported_assets' });
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
