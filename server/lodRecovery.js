'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {buildMeshRecoveryManifest}=require('./retainedManifest');
const {copyRetainedClosure}=require('./webodmTaskImport');
const {fsyncDirectory}=require('./durableFs');
const {LOD_DERIVATIVE_RECOVERY_REVISION}=require('./lodRecoveryPolicy');

function publicManifest(manifest){return{manifestSha256:manifest.manifestSha256,files:manifest.files.map(({relativePath,sourceRelativePath,role,byteSize,sha256})=>({relativePath,sourceRelativePath,role,byteSize,sha256}))};}
function sameManifest(left,right){return left?.manifestSha256===right?.manifestSha256&&JSON.stringify(left?.files||[])===JSON.stringify(right?.files||[]);}

async function inspectLodRecoverySource(outputId,{processing,storage,config},signal=null){
  const candidate=processing.lodRecoveryCandidate(outputId,{meshDerivativesEnabled:Boolean(config.meshDerivativesEnabled)});
  if(!candidate)throw Object.assign(new Error('the output does not have an eligible immutable OBJ and GLB source'),{code:'lod_recovery_not_eligible'});
  const root=storage.resolve(candidate.sourceRootKey,candidate.sourceRelativePath,{mustExist:true}),manifest=await buildMeshRecoveryManifest(root,{signal}),publicValue=publicManifest(manifest);
  const obj=publicValue.files.find(file=>file.role==='mesh_obj'),glb=publicValue.files.find(file=>file.role==='mesh_glb');
  if(!obj||!glb||obj.relativePath!==candidate.objRelativePath||glb.relativePath!==candidate.glbRelativePath||obj.sha256!==candidate.obj.sha256||glb.sha256!==candidate.glb.sha256||obj.byteSize!==Number(candidate.obj.byte_size)||glb.byteSize!==Number(candidate.glb.byte_size))throw Object.assign(new Error('the retained mesh closure no longer matches the registered source hashes'),{code:'lod_recovery_source_changed'});
  return{candidate,manifest,publicManifest:publicValue};
}

async function processLodRecovery(operation,{processing,repository,storage,config},progress=async()=>{},signal=null){
  const payload=JSON.parse(operation.payload_json||'{}'),ids=payload.ids||{};
  if(!payload.lodRecovery||payload.recoveryRevision!==LOD_DERIVATIVE_RECOVERY_REVISION)throw Object.assign(new Error('LOD recovery operation revision is unsupported'),{code:'lod_recovery_revision_mismatch'});
  const inspected=await inspectLodRecoverySource(payload.sourceOutputId,{processing,storage,config},signal),persisted={manifestSha256:payload.sourceManifestSha256,files:payload.sourceFiles};
  if(inspected.candidate.versionId!==payload.sourceVersionId||inspected.candidate.modelId!==payload.sourceModelId||inspected.candidate.task.id!==ids.taskId||inspected.candidate.dataset.id!==ids.datasetId||inspected.candidate.sourceRootKey!==payload.sourceRootKey||inspected.candidate.sourceRelativePath!==payload.sourceRelativePath||!sameManifest(inspected.publicManifest,persisted))throw Object.assign(new Error('the immutable LOD recovery source changed after authorization'),{code:'lod_recovery_source_changed'});
  if(inspected.candidate.task.activeAttemptId!==payload.sourceAttemptId)throw Object.assign(new Error('the recovery task has a newer active attempt'),{code:'lod_recovery_source_superseded'});
  await progress(0.35);
  const destination=storage.resolve('models',payload.targetRelativePath),incomplete=storage.resolve('models',`${payload.targetRelativePath}.recovery-${operation.id}.incomplete`);
  if(fs.existsSync(destination)){
    const existing=publicManifest(await buildMeshRecoveryManifest(destination,{signal}));
    if(!sameManifest(existing,persisted))throw Object.assign(new Error('the recovery destination conflicts with its authorized source manifest'),{code:'lod_recovery_destination_conflict'});
  }else{
    if(fs.existsSync(incomplete))fs.rmSync(incomplete,{recursive:true,force:true});
    try{
      await copyRetainedClosure(inspected.manifest.sourceRootPath,incomplete,inspected.manifest,{signal,progress:value=>progress(0.35+value*0.35)});
      fs.mkdirSync(path.dirname(destination),{recursive:true});
      if(fs.statSync(incomplete).dev!==fs.statSync(path.dirname(destination)).dev)throw Object.assign(new Error('LOD recovery materialization crossed filesystems'),{code:'invalid_storage_location'});
      fs.renameSync(incomplete,destination);fsyncDirectory(path.dirname(destination),{code:'lod_recovery_materialization_failed'});
    }catch(error){if(fs.existsSync(incomplete))fs.rmSync(incomplete,{recursive:true,force:true});throw error;}
  }
  await progress(0.75);
  const sourceModel=repository.getModelVersion(ids.modelId,payload.sourceVersionId),source=sourceModel?.activeVersion;
  if(!source||source.id!==payload.sourceVersionId||sourceModel.id!==payload.sourceModelId)throw Object.assign(new Error('the source model version is unavailable'),{code:'lod_recovery_source_changed'});
  const task=processing.getTask(ids.taskId),project=task&&processing.getProject(task.projectId),dataset=processing.getDataset(ids.datasetId,true);
  if(!task||!project||!dataset||dataset.status!=='finalized')throw Object.assign(new Error('the recovery task source is unavailable'),{code:'lod_recovery_source_changed'});
  const attempt=processing.createImportedAttempt({id:ids.attemptId,taskId:task.id,datasetId:dataset.id,providerTaskId:`lod-recovery:${operation.id}`,createdBy:operation.subject,displayName:task.displayName,metadata:{lodRecoveryOperationId:operation.id,lodRecoverySourceVersionId:payload.sourceVersionId},staged:true,expectedActiveAttemptId:payload.sourceAttemptId});
  const manifestByRole=new Map(inspected.publicManifest.files.map(file=>[file.role,file])),glb=manifestByRole.get('mesh_glb'),obj=manifestByRole.get('mesh_obj'),assets=[{kind:'glb',rootKey:'models',relativePath:`${payload.targetRelativePath}/${glb.relativePath}`,format:'glb',contentType:'model/gltf-binary',byteSize:glb.byteSize,sha256:glb.sha256,storageMode:'managed',published:false,sourceAttemptId:attempt.id},{kind:'obj',rootKey:'models',relativePath:`${payload.targetRelativePath}/${obj.relativePath}`,format:'obj',contentType:'text/plain',byteSize:obj.byteSize,sha256:obj.sha256,storageMode:'managed',published:false,sourceAttemptId:attempt.id}];
  const versionMetadata={...(source.metadata||{}),lodRecovery:{schemaVersion:1,recoveryRevision:payload.recoveryRevision,operationId:operation.id,sourceOutputId:payload.sourceOutputId,sourceVersionId:payload.sourceVersionId,sourceManifestSha256:payload.sourceManifestSha256}};
  const model=repository.upsertModelVersion({modelId:ids.modelId,versionId:ids.versionId,provider:sourceModel.provider,providerModelId:sourceModel.providerModelId,providerVersionId:`lod-recovery:${operation.id}`,displayName:task.displayName,status:'importing',metadata:sourceModel.metadata||{},versionMetadata,georef:source.georef||{},pointCount:source.pointCount??null,sourceLocator:{lodRecovery:true,operationId:operation.id,sourceVersionId:payload.sourceVersionId},assets,makeActive:false});
  processing.setAttemptResult(attempt.id,model.id,ids.versionId);
  const totalBytes=inspected.publicManifest.files.reduce((sum,file)=>sum+file.byteSize,0);
  processing.registerModelOutput({versionId:ids.versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,rootKey:'models',relativePath:payload.targetRelativePath,storageMode:'managed',status:'staged',byteSize:totalBytes,assetCount:assets.length});
  processing.recordProcessingEvent({attemptId:attempt.id,operationId:operation.id,eventType:'lod_recovery.materialized',phase:'registering',details:{recoveryRevision:payload.recoveryRevision,sourceOutputId:payload.sourceOutputId,sourceVersionId:payload.sourceVersionId,targetVersionId:ids.versionId,manifestSha256:payload.sourceManifestSha256}});
  await progress(0.98);
  return{project,task:processing.getTask(task.id),attempt:processing.getAttempt(attempt.id),model:repository.getModelVersion(model.id,ids.versionId),recovery:{operationId:operation.id,recoveryRevision:payload.recoveryRevision,sourceOutputId:payload.sourceOutputId,sourceVersionId:payload.sourceVersionId,targetVersionId:ids.versionId,manifestSha256:payload.sourceManifestSha256},requiredDerivatives:[{type:'mesh_tiles',request:{optional:false}}]};
}

function cleanupLodRecoveryMaterialization(operation,{processing,storage}){const payload=JSON.parse(operation.payload_json||'{}'),ids=payload.ids||{};if(!payload.lodRecovery||processing.getModelOutput(ids.versionId))return false;for(const relative of[`${payload.targetRelativePath}.recovery-${operation.id}.incomplete`,payload.targetRelativePath]){const absolute=storage.resolve('models',relative);if(fs.existsSync(absolute))fs.rmSync(absolute,{recursive:true,force:true});}return true;}

module.exports={cleanupLodRecoveryMaterialization,inspectLodRecoverySource,processLodRecovery,publicManifest,sameManifest};
