import {availableAdminSources,adminCalculationRequest} from './measurement-admin-dialog.mjs';
import {measurementGeometryHash} from './measurement-surface-client.mjs';

const guidance=Object.freeze({
  measurement_source_vertical_units_required:'This dataset needs its height units verified before volume can be calculated. Your outline is saved. An administrator needs to check the original elevation data; do not guess meters or feet.',
  measurement_source_vertical_units_conflict:'The elevation data contains conflicting height units. Your outline is saved; an administrator needs to correct the dataset setup.',
  measurement_source_vertical_units_unsupported:'The elevation data uses height units that need administrator review. Your outline is saved.',
  measurement_source_vertical_metadata_invalid:'The elevation data needs administrator review before volume can be calculated. Your outline is saved.',
  measurement_source_value_transform_unsupported:'The elevation data needs its height conversion set up before volume can be calculated. Your outline is saved.',
  measurement_calculation_already_active:'A calculation with different settings is already running for this outline. Wait for it to finish, or cancel it here before calculating with new settings.',
  measurement_admin_required:'Server calculation access is unavailable. Keep your Viewer workspace open and restore your authorized staff session, then try again.',
  measurement_admin_unavailable:'Open this model from your authorized Viewer workspace to calculate its volume on the server.',
  measurement_workspace_unavailable:'The Viewer workspace is not responding. Reopen the model from your workspace, then reopen this measurement to check its calculation.',
  measurement_surface_session_required:'Server volume calculation needs an active model session. Your outline remains available in this view; reopen the model from your workspace to restore access.',
  measurement_surface_access_unavailable:'Volume calculation access is unavailable for this model. Your outline has not been deleted. Restore access and try again.',
  measurement_calculation_not_found:'This calculation is no longer available. Temporary results expire. If your outline is still visible and you have access, calculate again to start a new result.',
  measurement_queue_full:'The server is busy with other work. Your outline is unchanged; try calculating again shortly.',
  measurement_rate_limited:'Too many calculations were requested recently. Your outline is unchanged; wait a moment before trying again.',
  measurement_limit:'This area exceeds the server calculation limit. Try a smaller outline around one pile.',
  measurement_boundary_elevation_unavailable:'Part of the outline has no elevation data. Move those points onto the surveyed surface and try again.',
});
export function surfaceCalculationError(error){
  const message=guidance[error?.code];
  return message?Object.assign(new Error(message),{code:error.code,status:error.status}):error;
}

const abortError=()=>Object.assign(new Error('Stopped watching this calculation. An accepted server job may still be running; inspect its status before starting another.'),{name:'AbortError'});
function pause(ms,signal){return new Promise((resolve,reject)=>{if(signal?.aborted)return reject(abortError());const abort=()=>{clearTimeout(timer);reject(abortError());};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});});}

// Uses a scoped raster client or staff broker. This is not a generic processing proxy,
// and a denied or failed server request never falls back to local calculation.
export function createServerSurfaceCalculator({request,isCurrent=()=>true,getRecord,pollMs=3000,wait=pause}){
  if(typeof request!=='function')throw new Error('Open this model from your authorized Viewer workspace to calculate on the server.');
  return async function calculate(record,{signal,reference,sourceKind='auto',confirmMeters=false,onProgress=()=>{},onJob=()=>{}}={}){
    const current=()=>{if(signal?.aborted)throw abortError();if(!isCurrent())throw new Error('Measurement access or view changed. Reopen this measurement from the current authorized view.');};
    const send=async(operation,payload)=>{current();let response;try{response=await request(operation,payload,record);}catch(error){throw surfaceCalculationError(error);}current();return response;};
    current();record=structuredClone(getRecord?.()||record);
    onProgress('Checking the elevation data for your outline…');
    const capabilities=await send('capabilities',{});
    const rasterAllowed=capabilities?.capabilities?.rasterCalculations===true||capabilities?.capabilities?.serverCalculations===true;
    if(!rasterAllowed)throw new Error('Your current access does not allow server volume calculations.');
    const temporary=capabilities.capabilities.temporaryCalculations===true;
    const geometryHash=temporary?await measurementGeometryHash(record):null;current();
    if(temporary){
      if(!capabilities.modelVersionId||(record.modelVersionId&&record.modelVersionId!==capabilities.modelVersionId))throw new Error('The server did not identify the same model version. Reopen the model before calculating.');
      record={...record,revision:1,modelVersionId:capabilities.modelVersionId};
    }
    const sources=availableAdminSources({...capabilities,capabilities:{...capabilities.capabilities,serverCalculations:rasterAllowed}}).filter(s=>['dsm','dtm'].includes(s.kind)&&s.methods.includes('surface-cut-fill'));
    if(!['auto','dsm','dtm'].includes(sourceKind))throw new Error('Choose a DSM or DTM elevation source.');
    const kind=sourceKind==='auto'?(record.source?.kind==='dtm'?'dtm':'dsm'):sourceKind;
    // Do not silently substitute bare-earth DTM for a missing stockpile DSM.
    const source=sources.find(s=>s.kind===kind);
    if(!source)throw new Error(`No registered ${kind.toUpperCase()} is available for server calculation. Choose an available elevation source; a DTM may omit the pile.`);
    const body=adminCalculationRequest(record,{method:'surface-cut-fill',sourceAssetId:source.assetId,reference:reference?.type,offsetM:reference?.offsetM??0,elevationM:reference?.elevationM,displayUnits:'metric',confirmMeters},sources);
    const matchesParameters=job=>{
      const p=job.parameters;
      return job.measurementId===record.id&&(!temporary||job.geometryHash===geometryHash)&&p?.method===body.method&&p.sourceAssetId===body.sourceAssetId&&p.reference?.type===body.reference.type&&(p.reference?.offsetM??0)===body.reference.offsetM&&(body.reference.type!=='custom'||p.reference?.elevationM===body.reference.elevationM)&&(p.sourceVerticalUnit??null)===(body.sourceVerticalUnit??null);
    };
    const matches=job=>job.revision===record.revision&&matchesParameters(job);
    const attachedMatch=job=>!temporary&&job?.status==='complete'&&job.id===record.results?.calculationJobId&&Number.isSafeInteger(job.revision)&&job.revision<record.revision&&job.attachmentRevision===record.revision&&matchesParameters(job);
    const exposeCancel=job=>onJob({cancel:()=>send('cancel',{measurementId:record.id,jobId:job.id})});
    const recover=async()=>{
      const response=await send('list',{measurementId:record.id});
      if(!Array.isArray(response?.calculations))throw new Error('Could not check existing volume calculations. No duplicate calculation was started.');
      const relevant=response.calculations.filter(j=>j.measurementId===record.id&&j.revision===record.revision);
      const active=relevant.find(j=>['queued','running'].includes(j.status));
      if(active&&!matches(active)){exposeCancel(active);throw surfaceCalculationError({code:'measurement_calculation_already_active'});}
      const existing=active||relevant.find(j=>j.status==='complete'&&matches(j))||response.calculations.find(attachedMatch);
      if(existing)return existing;
      if(!temporary&&record.results?.calculationJobId&&!response.calculations.some(j=>j.id===record.results.calculationJobId)){
        let attached;try{attached=(await send('status',{measurementId:record.id,jobId:record.results.calculationJobId}))?.calculation;}catch(error){if(error.code!=='measurement_calculation_not_found')throw error;}
        if(attachedMatch(attached))return attached;
      }
      return null;
    };
    onProgress('Checking for an existing volume calculation…');
    let job=await recover();
    if(!job){
      onProgress('Starting your volume calculation…');
      try{job=(await send('create',{measurementId:record.id,request:body}))?.calculation;}
      catch(error){if(error.code!=='measurement_calculation_already_active')throw error;job=await recover();if(!job)throw error;}
    }
    const jobId=job?.id;
    if(typeof jobId!=='string'||!jobId)throw new Error('The server did not return a calculation identifier. Check existing jobs before retrying.');
    for(;;){
      current();
      if(job?.id!==jobId||job.measurementId!==record.id||(job.revision!==record.revision&&!attachedMatch(job))||(temporary&&job.geometryHash!==geometryHash))throw new Error('The server calculation does not match this polygon revision. No result was attached.');
      if(job.status==='complete'){
        onJob(null);
        const result=job.result;
        if(result?.method!=='surface-cut-fill'||!['cutM3','fillM3','netM3','coverage'].every(key=>Number.isFinite(result[key]))||result.cutM3<0||result.fillM3<0||result.coverage<0||result.coverage>1)throw new Error('The server returned an unusable surface result. No result was attached.');
        if(result.source?.assetId!==source.assetId||result.source?.kind!==source.kind||!record.modelVersionId||result.source?.modelVersionId!==record.modelVersionId||result.reference?.type!==body.reference.type||(result.reference?.offsetM??0)!==body.reference.offsetM||(body.reference.type==='custom'&&result.reference?.elevationM!==body.reference.elevationM))throw new Error('The server result does not match the selected source, model version, or reference base. No result was attached.');
        return {...result,calculationJobId:jobId};
      }
      if(job.status==='failed'){onJob(null);throw surfaceCalculationError(Object.assign(new Error(`The volume calculation could not finish (${String(job.errorCode||'unavailable').replaceAll('_',' ')}).`),{code:job.errorCode}));}
      if(job.status==='cancelled'){onJob(null);throw new Error('Server calculation cancelled. No new volume was saved.');}
      if(!['queued','running'].includes(job.status))throw new Error('The server returned an unknown calculation state. Check existing jobs before retrying.');
      exposeCancel(job);
      onProgress(job.status==='queued'?'Waiting to calculate your volume. You can close this window; the calculation will continue on the server.':'Calculating your volume from the original elevation data. You can close this window; the calculation will continue on the server.');
      await wait(pollMs,signal);current();
      job=(await send('status',{measurementId:record.id,jobId}))?.calculation;
    }
  };
}
