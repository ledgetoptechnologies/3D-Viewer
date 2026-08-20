'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {NodeOdmProvider}=require('./nodeOdmProvider');
const {extractZipStream}=require('./safeZip');
const {hashFile,hashFileChunks,hashTree}=require('./storageManager');
const {sanitizeLogMessage}=require('./processingSecurity');
const {readOdmTaskMetadata}=require('./odmTaskMetadata');
const {lodDerivativeSpecs}=require('./lodDerivativePolicy');

function adapterFor(provider,config,providerCredentials){return new NodeOdmProvider({endpoint:provider.endpoint,token:providerCredentials.resolve(provider.id),providerType:provider.type,transferTimeoutMs:config.processingProviderTransferTimeoutMs});}
function transition(processing,job,status,fields){const attempt=processing.transitionAttemptForJob(job.id,job.lease_owner,status,fields);if(!attempt)throw Object.assign(new Error('processing lease was lost or attempt was cancelled'),{code:'lease_lost'});return attempt;}
function discoverOutputs(root){const candidates={glb:['odm_texturing/odm_textured_model_geo.glb','odm_texturing/textured_model.glb','textured_model.glb'],obj:['odm_texturing/odm_textured_model_geo.obj','odm_texturing/odm_textured_model.obj'],ortho:['odm_orthophoto/odm_orthophoto.tif'],dsm:['odm_dem/dsm.tif'],dtm:['odm_dem/dtm.tif'],report:['odm_report/report.pdf','odm_report/odm_report.pdf'],pointCloud:['odm_georeferencing/odm_georeferenced_model.laz','odm_georeferencing/odm_georeferenced_model.ply'],ept:['entwine_pointcloud/ept.json'],nativeTiles:['3d_tiles/model/tileset.json']};const assets=[];for(const[kind,choices]of Object.entries(candidates)){const rel=choices.find((p)=>fs.existsSync(path.join(root,...p.split('/'))));if(!rel)continue;const absolute=path.join(root,...rel.split('/'));assets.push({kind,relativePath:rel,absolutePath:absolute,format:kind==='nativeTiles'?'3dtiles':kind==='ept'?'ept':path.extname(rel).slice(1).toLowerCase(),contentType:kind==='report'?'application/pdf':undefined,byteSize:fs.statSync(absolute).size});}return assets;}

async function processSubmit(job,{processing,storage,config,providerCredentials,signal,adapterFactory=adapterFor}){
  let attempt={...processing.getAttempt(job.attempt_id),...processing.getAttemptSubmission(job.attempt_id)};const task=processing.getTask(attempt.taskId),dataset=processing.getDataset(attempt.datasetId||task.datasetId,true),provider=processing.getProvider(attempt.providerId),adapter=adapterFactory(provider,config,providerCredentials);
  const photo=/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i,auxiliary=/\.(?:txt|geojson|json|zip|las|laz)$/i,mapped=[];for(const file of dataset.files){const absolute=storage.resolve(dataset.rootKey,`${dataset.relativePath}/${file.relativePath}`,{mustExist:true}),stat=fs.statSync(absolute);if(stat.size!==file.byteSize||await hashFile(absolute,{signal})!==file.sha256)throw Object.assign(new Error('dataset source changed after finalization'),{code:'dataset_source_changed'});const role=file.processingRole||'auto',isPhoto=photo.test(file.relativePath),isAux=auxiliary.test(file.relativePath);if(role==='gcp_source'||role==='administrative'||(role==='auto'&&!isPhoto))continue;if(role==='image'&&!isPhoto)throw Object.assign(new Error('a dataset image role references an unsupported image type'),{code:'unsupported_source_file'});if(role==='provider_input'&&!isAux)throw Object.assign(new Error('a provider input role references an unsupported source type'),{code:'unsupported_source_file'});mapped.push({relativePath:file.relativePath,absolutePath:absolute,processingRole:role});}
  storage.requireProcessingHeadroom(dataset.byteSize,processing.activeProcessingReservationBytes(attempt.id));
  const gcpSnapshot=processing.getAttemptGcpSnapshot?.(attempt.id)||null;
  if(gcpSnapshot&&crypto.createHash('sha256').update(gcpSnapshot.content).digest('hex')!==gcpSnapshot.sha256)
    throw Object.assign(new Error('attempt GCP snapshot failed its integrity check'),{code:'gcp_snapshot_changed'});
  if(gcpSnapshot)for(let i=mapped.length-1;i>=0;i--)if(path.basename(mapped[i].relativePath).toLowerCase()==='gcp_list.txt')mapped.splice(i,1);
  if(gcpSnapshot)mapped.push({relativePath:'gcp_list.txt',buffer:Buffer.from(gcpSnapshot.content,'utf8')});
  const basenames=new Set();for(const file of mapped){const name=path.basename(file.relativePath).toLowerCase();if(basenames.has(name))throw Object.assign(new Error('dataset contains duplicate submitted basenames'),{code:'duplicate_source_basename'});basenames.add(name);}const photoFiles=mapped.filter((file)=>photo.test(file.relativePath)),auxiliaryFiles=mapped.filter((file)=>!photo.test(file.relativePath)),files=[...photoFiles,...auxiliaryFiles];if(!photoFiles.length)throw Object.assign(new Error('dataset has no processable images'),{code:'unsupported_source_file'});const maxImages=Number(provider.capabilities?.maxImages);if(Number.isSafeInteger(maxImages)&&maxImages>0&&photoFiles.length>maxImages)throw Object.assign(new Error('dataset exceeds the provider image limit'),{code:'provider_image_limit_exceeded'});
  let known=null;try{known=await adapter.status(attempt.providerTaskId,{signal});}catch(error){if(error.code!=='provider_task_not_found')throw error;}
  const save=(phase,count=attempt.uploadedFileCount)=>{if(!processing.setSubmissionStateForJob(job.id,job.lease_owner,phase,count))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});attempt={...attempt,submissionPhase:phase,uploadedFileCount:count};};
  const restart=async()=>{if(known){await adapter.remove(attempt.providerTaskId,{signal});known=null;}save('new',0);};
  if(known&&attempt.submissionPhase==='new')await restart();
  if(known&&attempt.submissionPhase==='initializing')save('initialized',0);
  if(known&&attempt.submissionPhase==='uploading'){
    const providerCount=Number(known.imagesCount);
    if(!Number.isSafeInteger(providerCount)||providerCount<attempt.uploadedFileCount||providerCount>photoFiles.length)await restart();else save('uploading',providerCount);
  }
  if(known&&attempt.submissionPhase==='uploading_auxiliary')await restart();
  if(known&&attempt.submissionPhase==='committing'){if(['running','completed'].includes(known.status))save('committed',files.length);else await restart();}
  if(!known&&attempt.submissionPhase!=='new')save('new',0);
  if(!known){
    transition(processing,job,'initializing');save('initializing',0);
    await adapter.initialize({uuid:attempt.providerTaskId,name:task.displayName,options:attempt.options},{signal});save('initialized',0);
  }
  if(attempt.uploadedFileCount<photoFiles.length){transition(processing,job,'uploading');for(let index=attempt.uploadedFileCount;index<photoFiles.length;index+=20){save('uploading',index);const batch=photoFiles.slice(index,index+20);await adapter.upload(attempt.providerTaskId,batch,{signal});save('uploading',index+batch.length);}}
  if(auxiliaryFiles.length&&attempt.uploadedFileCount<files.length){transition(processing,job,'uploading');for(let index=Math.max(0,attempt.uploadedFileCount-photoFiles.length);index<auxiliaryFiles.length;index+=20){save('uploading_auxiliary',photoFiles.length+index);const batch=auxiliaryFiles.slice(index,index+20);await adapter.upload(attempt.providerTaskId,batch,{signal});save('uploading_auxiliary',photoFiles.length+index+batch.length);}}
  if(attempt.submissionPhase!=='committed'){save('uploaded',files.length);transition(processing,job,'committed');save('committing',files.length);await adapter.commit(attempt.providerTaskId,{signal});save('committed',files.length);}
  known=known&&['running','completed'].includes(known.status)?known:null;
  transition(processing,job,known?.status==='running'?'running':'queued_upstream',{progress:known?.progress||0});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'reconcile',new Date(Date.now()+5000).toISOString()))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
}

async function processReconcile(job,{processing,config,providerCredentials,signal}){
  const attempt=processing.getAttempt(job.attempt_id),provider=processing.getProvider(attempt.providerId),adapter=adapterFor(provider,config,providerCredentials);
  const status=await adapter.status(attempt.providerTaskId,{signal}),output=await adapter.output(attempt.providerTaskId,attempt.providerOutputCursor,{signal});
  for(const line of output.lines)processing.appendLog(attempt.id,'provider',line);processing.setOutputCursor(attempt.id,output.nextLine);
  if(status.status==='completed'){transition(processing,job,'ingesting',{progress:1,upstreamCompletedAt:new Date().toISOString()});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'ingest'))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
  else if(status.status==='failed'||status.status==='cancelled'){const task=processing.getTask(attempt.taskId),project=processing.getProject(task.projectId),code=`provider_${status.status}`,message=`ODM processing ${status.status}`,terminal=processing.failJobTerminal(job.id,job.lease_owner,code,message,{eventId:`processing-failed-${attempt.id}`,schemaVersion:1,type:'processing.failed',projectId:project.id,projectDisplayName:project.displayName,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed'});if(!terminal)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
  else{transition(processing,job,status.status,{progress:status.progress});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'reconcile',new Date(Date.now()+15000).toISOString()))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
}

async function processIngest(job,{processing,repository,storage,config,providerCredentials,signal}){
  const attempt=processing.getAttempt(job.attempt_id),task=processing.getTask(attempt.taskId),project=processing.getProject(task.projectId),provider=processing.getProvider(attempt.providerId),adapter=adapterFor(provider,config,providerCredentials);
  const headroom=storage.space('models'),maximumExpansion=Math.max(0,headroom.available-headroom.reserve);
  if(maximumExpansion<1024*1024*1024)throw Object.assign(new Error('insufficient storage for result ingestion'),{code:'insufficient_storage'});
  const relative=`${task.id}/${attempt.id}`,destination=storage.resolve('models',relative);
  if(!fs.existsSync(destination)){const response=await adapter.downloadAll(attempt.providerTaskId,{signal}),declared=Number(response.headers.get('content-length')||0);if(declared>maximumExpansion)throw Object.assign(new Error('provider result exceeds available storage'),{code:'insufficient_storage'});await extractZipStream(Readable.fromWeb(response.body),destination,{maxEntries:100000,maxBytes:maximumExpansion,workId:job.id,signal});}
  const found=discoverOutputs(destination);if(!found.some((asset)=>['glb','obj','pointCloud','ortho','ept'].includes(asset.kind)))throw Object.assign(new Error('provider archive has no supported outputs'),{code:'missing_required_output'});
  const nativeTiles=found.find((asset)=>asset.kind==='nativeTiles'),candidateAssets=found.filter((asset)=>asset.kind!=='nativeTiles');
  const assets=[];for(const asset of candidateAssets){const integrity=asset.kind==='ept'?await hashTree(path.dirname(asset.absolutePath),{signal}):await hashFileChunks(asset.absolutePath,{signal});assets.push({...asset,rootKey:'models',relativePath:`${relative}/${asset.relativePath}`,storageMode:'managed',published:false,sourceAttemptId:attempt.id,...integrity});}
  const needsEpt=assets.some((asset)=>asset.kind==='pointCloud')&&!assets.some((asset)=>asset.kind==='ept'),hasFullMesh=assets.some((asset)=>asset.kind==='glb'||asset.kind==='obj');
  if(needsEpt&&!config.localDerivativesEnabled&&!hasFullMesh)throw Object.assign(new Error('provider did not generate required EPT output'),{code:'missing_required_output'});
  const odmMetadata=readOdmTaskMetadata(destination);
  const model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:task.displayName,sourceLocator:{taskId:task.id,attemptId:attempt.id},metadata:{projectId:project.id,projectName:project.displayName},versionMetadata:{sourceDatasetId:attempt.datasetId||task.datasetId,processingMetrics:odmMetadata.processingMetrics},georef:odmMetadata.georef,pointCount:odmMetadata.pointCount,status:'importing',assets,makeActive:false});
  const version=repository.database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id,attempt.id);
  if(!processing.setAttemptResultForJob(job.id,job.lease_owner,model.id,version.id))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  const tree=storage.scanAbsolute(destination);processing.registerModelOutput({versionId:version.id,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:relative,status:'staged',byteSize:tree.byteSize,assetCount:assets.length});
  const derivatives=[];
  if(needsEpt&&config.localDerivativesEnabled)derivatives.push({type:'ept'});
  derivatives.push(...lodDerivativeSpecs([
    ...assets,
    ...(nativeTiles?[{...nativeTiles,rootKey:'models',relativePath:`${relative}/${nativeTiles.relativePath}`}]:[]),
  ],{meshDerivativesEnabled:config.meshDerivativesEnabled}));
  const readyEvent={eventId:`processing-ready-${attempt.id}`,schemaVersion:1,type:'processing.ready_for_review',projectId:project.id,projectDisplayName:project.displayName,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'ready_for_review',reviewUrl:`${config.opsBaseUrl}/operations/processing?attemptId=${encodeURIComponent(attempt.id)}`};
  if(derivatives.length&&derivatives.some((spec)=>!spec.request?.optional)){const activated=processing.completeIngestAndEnqueueDerivatives(job.id,job.lease_owner,attempt.id,derivatives,{ingestedAt:new Date().toISOString()});if(!activated)throw Object.assign(new Error('processing lease was lost or ingest state changed'),{code:'lease_lost'});}
  else{const ready=processing.completeOutputForReview(attempt.id,{jobId:job.id,owner:job.lease_owner,ingestedAt:new Date().toISOString(),event:readyEvent});if(!ready)throw Object.assign(new Error('processing lease was lost or staged output changed'),{code:'lease_lost'});if(derivatives.length&&!processing.enqueueOptionalDerivatives(attempt.id,derivatives))throw Object.assign(new Error('optional derivatives could not be queued'),{code:'derivative_activation_conflict'});}
}

async function processOne(deps,owner=crypto.randomUUID()){
  const job=deps.processing.claimJob(owner);if(!job)return false;
  const controller=new AbortController();const heartbeat=setInterval(()=>{const attempt=deps.processing.getAttempt(job.attempt_id);if(!deps.processing.heartbeatJob(job.id,owner)||attempt?.status==='cancelled')controller.abort();},20000);heartbeat.unref?.();
  try{const work={...deps,signal:controller.signal};if(job.job_type==='submit')await processSubmit(job,work);else if(job.job_type==='reconcile')await processReconcile(job,work);else if(job.job_type==='ingest')await processIngest(job,work);else throw new Error('unsupported processing job');return true;}
  catch(error){const safe=sanitizeLogMessage(error.message).slice(0,1000);if(error.code==='insufficient_storage'&&job.job_type==='submit'){deps.processing.deferSubmitAdmission(job.id,job.lease_owner);return true;}deps.processing.appendLog(job.attempt_id,'error',safe);const permanent=new Set(['duplicate_source_basename','missing_required_output','invalid_storage_location','unsupported_source_file','dataset_source_changed','gcp_snapshot_changed','invalid_asset_tree','provider_image_limit_exceeded']).has(error.code),retry=!permanent&&job.attempt_count<5?new Date(Date.now()+Math.min(300000,5000*2**job.attempt_count)).toISOString():null;if(retry)deps.processing.failJob(job.id,job.lease_owner,error.code||'processing_failed',safe,retry);else{const attempt=deps.processing.getAttempt(job.attempt_id),task=attempt&&deps.processing.getTask(attempt.taskId),project=task&&deps.processing.getProject(task.projectId);deps.processing.failJobTerminal(job.id,job.lease_owner,error.code||'processing_failed',safe,{eventId:`processing-failed-${attempt.id}`,schemaVersion:1,type:'processing.failed',projectId:task.projectId,projectDisplayName:project?.displayName||undefined,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed'});}return true;}
  finally{clearInterval(heartbeat);}
}
module.exports={adapterFor,discoverOutputs,processIngest,processOne,processReconcile,processSubmit};
