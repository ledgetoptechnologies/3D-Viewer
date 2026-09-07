'use strict';
const {EphemeralMeasurementRepository}=require('./ephemeralMeasurementRepository');
const {localAccess}=require('./ephemeralMeasurementAccess');
const {sourceAuthorizationValidator}=require('./sourceAuthorization');
async function processOneEphemeralMeasurement({repository,storage,config,runCalculation,validator=sourceAuthorizationValidator},owner){
 if(config.measurementCalculationsEnabled===false)return false;
 const jobs=new EphemeralMeasurementRepository(repository.database),job=jobs.claim(owner);if(!job)return false;const request=job.request;
 let timer=null,externalLive=true,lastExternalCheck=0,checking=false;
 const access=()=>localAccess(request.ephemeralAuthority,repository);
 const current=()=>{const value=access();return Boolean(value&&jobs.live(job,owner)&&request.method==='surface-cut-fill'&&['dsm','dtm'].includes(request.source?.kind)&&request.modelId===value.model.id&&request.modelVersionId===value.model.activeVersion.id);};
 const checkExternal=async()=>{if(checking)return;checking=true;let deadline;try{const value=access();externalLive=Boolean(value&&(!value.share||await Promise.race([validator.allows(value.share),new Promise(resolve=>{deadline=setTimeout(()=>resolve(false),3500);})])));lastExternalCheck=Date.now();}catch{externalLive=false;lastExternalCheck=Date.now();}finally{clearTimeout(deadline);checking=false;}};
 try{
  await checkExternal();if(!current()||!externalLive)throw Object.assign(new Error('authorization lost'),{code:'measurement_authorization_lost'});
  const asset=access().model.activeVersion.assets.find(a=>a.id===request.source.id);
  if(!asset||['sha256','rootKey','relativePath','byteSize','kind'].some(k=>asset[k]!==request.source[k])||(request.ephemeralAuthority.kind!=='viewer'&&!asset.published))throw Object.assign(new Error('source changed'),{code:'measurement_source_changed'});
  timer=setInterval(()=>{void checkExternal();},1000);
  const result=await runCalculation(storage.resolve(asset.rootKey,asset.relativePath,{mustExist:true}),request,{config,isLive:()=>current()&&externalLive&&Date.now()-lastExternalCheck<6000&&jobs.heartbeat(job,owner)});
  // Do not accept a result under a stale positive source-authorization cache.
  clearInterval(timer);timer=null;
  while(checking)await new Promise(resolve=>setTimeout(resolve,10));await checkExternal();
  if(!current()||!externalLive)throw Object.assign(new Error('authorization lost'),{code:'measurement_authorization_lost'});
  jobs.finish(job,owner,result);
 }catch(e){jobs.finish(job,owner,null,/^[a-z][a-z0-9_]{0,79}$/.test(e.code||'')?e.code:'measurement_calculation_failed');}
 finally{clearInterval(timer);}return true;
}
module.exports={processOneEphemeralMeasurement};
