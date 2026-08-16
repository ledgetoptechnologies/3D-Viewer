'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {NodeOdmProvider}=require('./nodeOdmProvider');
const {extractZipStream}=require('./safeZip');
const {hashFile,hashTree}=require('./storageManager');
const {sanitizeLogMessage}=require('./processingSecurity');

function adapterFor(provider,config){return new NodeOdmProvider({endpoint:provider.endpoint,token:String(config.processingProviderTokens[provider.id]||''),providerType:provider.type,transferTimeoutMs:config.processingProviderTransferTimeoutMs});}
function transition(processing,job,status,fields){const attempt=processing.transitionAttemptForJob(job.id,job.lease_owner,status,fields);if(!attempt)throw Object.assign(new Error('processing lease was lost or attempt was cancelled'),{code:'lease_lost'});return attempt;}
function discoverOutputs(root){const candidates={glb:['odm_texturing/odm_textured_model_geo.glb','odm_texturing/textured_model.glb','textured_model.glb'],obj:['odm_texturing/odm_textured_model_geo.obj','odm_texturing/odm_textured_model.obj'],ortho:['odm_orthophoto/odm_orthophoto.tif'],dsm:['odm_dem/dsm.tif'],dtm:['odm_dem/dtm.tif'],pointCloud:['odm_georeferencing/odm_georeferenced_model.laz','odm_georeferencing/odm_georeferenced_model.ply'],ept:['entwine_pointcloud/ept.json'],nativeTiles:['3d_tiles/model/tileset.json']};const assets=[];for(const[kind,choices]of Object.entries(candidates)){const rel=choices.find((p)=>fs.existsSync(path.join(root,...p.split('/'))));if(!rel)continue;const absolute=path.join(root,...rel.split('/'));assets.push({kind,relativePath:rel,absolutePath:absolute,format:kind==='nativeTiles'?'3dtiles':kind==='ept'?'ept':path.extname(rel).slice(1).toLowerCase(),byteSize:fs.statSync(absolute).size});}return assets;}

async function processSubmit(job,{processing,storage,config,signal}){
  const attempt=processing.getAttempt(job.attempt_id),task=processing.getTask(attempt.taskId),dataset=processing.getDataset(task.datasetId,true),provider=processing.getProvider(attempt.providerId),adapter=adapterFor(provider,config);
  const basenames=new Set(),allowed=/\.(?:jpe?g|png|tiff?|dng|raw|heic|txt|geojson|json|zip|las|laz)$/i;for(const file of dataset.files){const name=path.basename(file.relativePath).toLowerCase();if(basenames.has(name))throw Object.assign(new Error('dataset contains duplicate source basenames'),{code:'duplicate_source_basename'});if(!allowed.test(name))throw Object.assign(new Error('dataset contains a file type NodeODM does not accept'),{code:'unsupported_source_file'});basenames.add(name);const absolute=storage.resolve(dataset.rootKey,`${dataset.relativePath}/${file.relativePath}`,{mustExist:true}),stat=fs.statSync(absolute);if(stat.size!==file.byteSize||await hashFile(absolute,{signal})!==file.sha256)throw Object.assign(new Error('dataset source changed after finalization'),{code:'dataset_source_changed'});}
  let known=null;try{known=await adapter.status(attempt.providerTaskId,{signal});}catch(error){if(error.code!=='provider_task_not_found')throw error;}
  if(!known){
    transition(processing,job,'initializing');
    await adapter.initialize({uuid:attempt.providerTaskId,name:task.displayName,options:attempt.options},{signal});
    transition(processing,job,'uploading');
    const files=dataset.files.map((file)=>({relativePath:file.relativePath,absolutePath:storage.resolve(dataset.rootKey,`${dataset.relativePath}/${file.relativePath}`,{mustExist:true})}));
    for(let index=0;index<files.length;index+=20)await adapter.upload(attempt.providerTaskId,files.slice(index,index+20),{signal});
    transition(processing,job,'committed');await adapter.commit(attempt.providerTaskId,{signal});
  }
  transition(processing,job,known?.status==='running'?'running':'queued_upstream',{progress:known?.progress||0});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'reconcile',new Date(Date.now()+5000).toISOString()))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
}

async function processReconcile(job,{processing,config,signal}){
  const attempt=processing.getAttempt(job.attempt_id),provider=processing.getProvider(attempt.providerId),adapter=adapterFor(provider,config);
  const status=await adapter.status(attempt.providerTaskId,{signal}),output=await adapter.output(attempt.providerTaskId,attempt.providerOutputCursor,{signal});
  for(const line of output.lines)processing.appendLog(attempt.id,'provider',line);processing.setOutputCursor(attempt.id,output.nextLine);
  if(status.status==='completed'){transition(processing,job,'ingesting',{progress:1,upstreamCompletedAt:new Date().toISOString()});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'ingest'))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
  else if(status.status==='failed'||status.status==='cancelled'){transition(processing,job,status.status,{progress:status.progress,errorCode:`provider_${status.status}`,errorMessage:`ODM processing ${status.status}`,completedAt:new Date().toISOString()});if(!processing.completeJob(job.id,job.lease_owner))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
  else{transition(processing,job,status.status,{progress:status.progress});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'reconcile',new Date(Date.now()+15000).toISOString()))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
}

async function processIngest(job,{processing,repository,storage,config,signal}){
  const attempt=processing.getAttempt(job.attempt_id),task=processing.getTask(attempt.taskId),project=processing.getProject(task.projectId),provider=processing.getProvider(attempt.providerId),adapter=adapterFor(provider,config);
  const headroom=storage.space('models'),maximumExpansion=Math.max(0,headroom.available-headroom.reserve);
  if(maximumExpansion<1024*1024*1024)throw Object.assign(new Error('insufficient storage for result ingestion'),{code:'insufficient_storage'});
  const relative=`${task.id}/${attempt.id}`,destination=storage.resolve('models',relative);
  if(!fs.existsSync(destination)){const response=await adapter.downloadAll(attempt.providerTaskId,{signal}),declared=Number(response.headers.get('content-length')||0);if(declared>maximumExpansion)throw Object.assign(new Error('provider result exceeds available storage'),{code:'insufficient_storage'});await extractZipStream(Readable.fromWeb(response.body),destination,{maxEntries:100000,maxBytes:maximumExpansion,workId:job.id,signal});}
  const found=discoverOutputs(destination);if(!found.some((asset)=>['glb','obj','pointCloud','ortho','ept'].includes(asset.kind)))throw Object.assign(new Error('provider archive has no supported outputs'),{code:'missing_required_output'});
  const nativeTiles=found.find((asset)=>asset.kind==='nativeTiles'),candidateAssets=found.filter((asset)=>asset.kind!=='nativeTiles');
  const assets=[];for(const asset of candidateAssets){const integrity=asset.kind==='ept'?await hashTree(path.dirname(asset.absolutePath),{signal}):{sha256:await hashFile(asset.absolutePath,{signal})};assets.push({...asset,rootKey:'models',relativePath:`${relative}/${asset.relativePath}`,storageMode:'managed',published:false,sourceAttemptId:attempt.id,...integrity});}
  const model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:task.displayName,sourceLocator:{taskId:task.id,attemptId:attempt.id},metadata:{projectId:project.id,projectName:project.displayName},versionMetadata:{sourceDatasetId:task.datasetId},status:'ready',assets,makeActive:false});
  const version=repository.database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id,attempt.id);
  if(!processing.setAttemptResultForJob(job.id,job.lease_owner,model.id,version.id))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  const needsEpt=assets.some((asset)=>asset.kind==='pointCloud')&&!assets.some((asset)=>asset.kind==='ept'),hasFullMesh=assets.some((asset)=>asset.kind==='glb'||asset.kind==='obj');
  if(needsEpt&&config.localDerivativesEnabled)processing.enqueueDerivative(attempt.id,'ept');
  if(nativeTiles&&hasFullMesh)processing.enqueueDerivative(attempt.id,'lod_audit',{tilesRelativePath:`${relative}/${path.posix.dirname(nativeTiles.relativePath)}`});
  else if(hasFullMesh&&config.localDerivativesEnabled)processing.enqueueDerivative(attempt.id,'mesh_tiles');
  if(needsEpt&&!config.localDerivativesEnabled&&!hasFullMesh)throw Object.assign(new Error('provider did not generate required EPT output'),{code:'missing_required_output'});
  const pending=processing.derivativeSummary(attempt.id).some((row)=>row.status==='pending'||row.status==='leased');
  if(pending)transition(processing,job,'derivatives',{progress:1,ingestedAt:new Date().toISOString()});
  else{const ready=transition(processing,job,'ready_for_review',{progress:1,ingestedAt:new Date().toISOString(),completedAt:new Date().toISOString()});processing.enqueueEvent('processing.ready_for_review',{eventId:`processing-ready-${attempt.id}`,schemaVersion:1,type:'processing.ready_for_review',occurredAt:ready.completedAt,projectId:project.id,taskId:task.id,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'ready_for_review',reviewUrl:`${config.opsBaseUrl}/operations/processing?attemptId=${encodeURIComponent(attempt.id)}`});}
  if(!processing.completeJob(job.id,job.lease_owner))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
}

async function processOne(deps,owner=crypto.randomUUID()){
  const job=deps.processing.claimJob(owner);if(!job)return false;
  const controller=new AbortController();const heartbeat=setInterval(()=>{const attempt=deps.processing.getAttempt(job.attempt_id);if(!deps.processing.heartbeatJob(job.id,owner)||attempt?.status==='cancelled')controller.abort();},20000);heartbeat.unref?.();
  try{const work={...deps,signal:controller.signal};if(job.job_type==='submit')await processSubmit(job,work);else if(job.job_type==='reconcile')await processReconcile(job,work);else if(job.job_type==='ingest')await processIngest(job,work);else throw new Error('unsupported processing job');return true;}
  catch(error){const safe=sanitizeLogMessage(error.message).slice(0,1000);deps.processing.appendLog(job.attempt_id,'error',safe);const permanent=new Set(['duplicate_source_basename','missing_required_output','invalid_storage_location']).has(error.code);const retry=!permanent&&job.attempt_count<5?new Date(Date.now()+Math.min(300000,5000*2**job.attempt_count)).toISOString():null;const owned=deps.processing.failJob(job.id,job.lease_owner,error.code||'processing_failed',safe,retry);if(owned&&!retry){const attempt=deps.processing.transitionAttempt(job.attempt_id,'failed',{errorCode:error.code||'processing_failed',errorMessage:safe,completedAt:new Date().toISOString()}),task=deps.processing.getTask(attempt.taskId);deps.processing.enqueueEvent('processing.failed',{eventId:`processing-failed-${attempt.id}`,schemaVersion:1,type:'processing.failed',occurredAt:attempt.completedAt,projectId:task.projectId,taskId:task.id,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed',error:{code:error.code||'processing_failed',message:safe}});}return true;}
  finally{clearInterval(heartbeat);}
}
module.exports={adapterFor,discoverOutputs,processIngest,processOne,processReconcile,processSubmit};
