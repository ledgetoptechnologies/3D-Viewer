const abortError=()=>Object.assign(new Error('Stopped loading this saved preview.'),{name:'AbortError'});

// Pure read-only attachment validation shared with runtime API regressions.
// Missing previews must never enqueue heavy work or rewrite saved quantities.
export function createSavedSurfacePreviewLoader({request,isCurrent=()=>true,getRecord,normalizeError=error=>error}){
  return async function load(record,{signal}={}){
    const current=()=>{if(signal?.aborted)throw abortError();if(!isCurrent())throw new Error('Measurement access or view changed.');};
    current();const snapshot=structuredClone(getRecord?.()||record),saved=snapshot.results;
    if(typeof request!=='function'||!saved?.calculationJobId||!['surface-cut-fill','point-surface-cut-fill'].includes(saved.method)||saved.volumeInvalidated)throw new Error('The saved surface preview is unavailable.');
    let response;try{response=await request('status',{measurementId:snapshot.id,jobId:saved.calculationJobId},snapshot);}catch(error){throw normalizeError(error);}
    current();
    if(JSON.stringify(getRecord?.()||record)!==JSON.stringify(snapshot))throw new Error('The measurement changed while its preview was loading.');
    const job=response?.calculation,result=job?.result;
    const source=value=>JSON.stringify(['assetId','kind','modelVersionId','sha256','manifestSha256'].map(key=>value?.[key]??null));
    const reference=value=>JSON.stringify([value?.type,value?.offsetM??0,value?.elevationM??null]);
    if(job?.id!==saved.calculationJobId||job.measurementId!==snapshot.id||job.status!=='complete'||job.method!==saved.method||job.attachmentRevision!==snapshot.revision||!Number.isSafeInteger(job.revision)||job.revision>=snapshot.revision||result?.method!==saved.method||result.source?.modelVersionId!==snapshot.modelVersionId||source(result.source)!==source(saved.source)||reference(result.reference)!==reference(saved.reference)||!['cutM3','fillM3','netM3','coverage'].every(key=>Number.isFinite(result[key])&&result[key]===saved[key]))throw new Error('The saved preview no longer matches this outline, source, or reference base.');
    if(!result.preview?.samples?.length)throw new Error('No retained preview samples are available for this saved calculation.');
    return result.preview;
  };
}
