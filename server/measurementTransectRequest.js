'use strict';
const crypto=require('node:crypto');
const fail=(code,status=422)=>{throw Object.assign(new Error(code),{code,status});};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const geometry=value=>JSON.stringify([value.collection,value.vertices,[value.coordinateReference?.crs,value.coordinateReference?.verticalUnit]]);
const reference=value=>JSON.stringify([value?.type,value?.offsetM??0,value?.type==='custom'?value.elevationM:null]);
const vector=(value,length)=>Array.isArray(value)&&value.length===length&&value.every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9);
const hashBase=patches=>crypto.createHash('sha256').update(JSON.stringify(patches)).digest('hex');

// Parent is obtained through the caller's already-authorized measurement/page
// repository scope. Neither a browser result nor a supplied source/base is proof.
function validateTransectRequest(input,measurement,version,parent,{temporary=false}={}){
  if(!plain(input)||Object.keys(input).some(k=>!['revision','method','parentCalculationId','line'].includes(k))||input.method!=='surface-transect'||input.revision!==measurement.revision||!uuid.test(input.parentCalculationId||''))fail('measurement_transect_invalid',400);
  const line=input.line;
  if(!plain(line)||Object.keys(line).some(k=>!['start','end'].includes(k))||!vector(line.start,2)||!vector(line.end,2))fail('measurement_transect_invalid',400);
  const length=Math.hypot(line.end[0]-line.start[0],line.end[1]-line.start[1]);
  if(length<1e-8||length>1_000_000)fail('measurement_transect_limit');
  const job=parent?.job,sourceRequest=parent?.request;
  if(!job||!sourceRequest||job.id!==input.parentCalculationId||job.measurementId!==measurement.id||job.status!=='complete'||job.method!=='surface-cut-fill'||sourceRequest.method!=='surface-cut-fill')fail('measurement_transect_parent_unavailable');
  const attached=!temporary&&job.attachmentRevision===measurement.revision&&measurement.results?.calculationJobId===job.id&&job.revision<measurement.revision;
  if(job.revision!==measurement.revision&&!attached)fail('measurement_transect_parent_stale',409);
  if(measurement.kind!=='polygon'||measurement.vertices.length>256||geometry(measurement)!==geometry(sourceRequest)||measurement.coordinateReference?.verticalUnit!=='m'||sourceRequest.modelId!==measurement.modelId||sourceRequest.modelVersionId!==measurement.modelVersionId||version?.id!==measurement.modelVersionId)fail('measurement_transect_parent_stale',409);
  const asset=version.assets?.find(a=>a.id===sourceRequest.source?.id),result=job.result;
  if(!asset||!['dsm','dtm'].includes(asset.kind)||!['sha256','rootKey','relativePath','byteSize','kind'].every(k=>asset[k]===sourceRequest.source[k])||result?.method!=='surface-cut-fill'||result.calculationOrigin!=='server-native-raster'||result.source?.assetId!==asset.id||result.source.sha256!==asset.sha256||result.source.kind!==asset.kind||result.source.modelVersionId!==measurement.modelVersionId||reference(result.reference)!==reference(sourceRequest.reference))fail('measurement_transect_parent_unavailable');
  const patches=result.preview?.referencePatches;
  if(!Array.isArray(patches)||patches.length<1||patches.length>254||!patches.every(p=>Array.isArray(p)&&p.length===3&&p.every(v=>vector(v,3))))fail('measurement_transect_base_unavailable');
  return {schemaVersion:1,method:'surface-transect',modelId:measurement.modelId,modelVersionId:measurement.modelVersionId,collection:measurement.collection,vertices:structuredClone(measurement.vertices),coordinateReference:structuredClone(measurement.coordinateReference),source:structuredClone(sourceRequest.source),sourceVerticalUnit:sourceRequest.sourceVerticalUnit||null,reference:structuredClone(sourceRequest.reference),referencePatches:structuredClone(patches),baseHash:hashBase(patches),parentCalculationId:job.id,parentRevision:job.revision,line:structuredClone(line)};
}
function sameTransectEvidence(request,rebuilt){
  return request.parentCalculationId===rebuilt.parentCalculationId&&request.parentRevision===rebuilt.parentRevision&&request.baseHash===rebuilt.baseHash&&hashBase(request.referencePatches)===rebuilt.baseHash&&geometry(request)===geometry(rebuilt)&&JSON.stringify(request.source)===JSON.stringify(rebuilt.source)&&reference(request.reference)===reference(rebuilt.reference)&&request.sourceVerticalUnit===rebuilt.sourceVerticalUnit;
}
module.exports={validateTransectRequest,sameTransectEvidence};
