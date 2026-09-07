'use strict';
const express=require('express');
const auth=require('./auth');
const {validateMeasurement}=require('./measurementRepository');
const {validateCalculationRequest}=require('./measurementCalculationApi');
const {resolveEphemeralAccess}=require('./ephemeralMeasurementAccess');
const {EphemeralMeasurementRepository}=require('./ephemeralMeasurementRepository');
const {StorageManager}=require('./storageManager');
const {validateTransectRequest,sameTransectEvidence}=require('./measurementTransectRequest');
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
function createEphemeralMeasurementApi(repository,{config={},preflightRaster,validator}={}){
  const router=express.Router(),jobs=new EphemeralMeasurementRepository(repository.database);
  const resolve=async req=>{const access=await resolveEphemeralAccess(String(req.get('authorization')||'').match(/^Bearer\s+(\S+)$/i)?.[1],repository,{validator});if(req.get('X-Measurement-Model-Version')!==access.authority.modelVersionId)fail('temporary_measurement_access_unavailable',403);return access;};
  const page=req=>{const handle=req.get('X-Measurement-Page');if(!/^[A-Za-z0-9_-]{43}$/.test(handle||''))fail('temporary_measurement_page_required',403);return auth.hashToken(handle);};
  const sourceVersion=access=>({...access.model.activeVersion,assets:access.model.activeVersion.assets.filter(a=>access.authority.kind==='viewer'||a.published===true)});
  const preflight=preflightRaster||async function(request){const storage=new StorageManager(config),file=storage.resolve(request.source.rootKey,request.source.relativePath,{mustExist:true});const{preflightNativeRaster}=await import('./measurementRasterCalculation.mjs');return preflightNativeRaster(file,request,{maxBlockBytes:Math.min(256,(config.measurementMemoryMiB||4096)/8)*1024*1024});};
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get('/capabilities',async(req,res,next)=>{try{const access=await resolve(req),enabled=config.measurementCalculationsEnabled!==false,sources=enabled?sourceVersion(access).assets.filter(a=>['dsm','dtm'].includes(a.kind)&&/^(tif|tiff|geotiff)$/i.test(a.format||'')&&a.sha256).map(a=>({assetId:a.id,kind:a.kind,format:a.format,byteSize:a.byteSize,methods:['surface-cut-fill','surface-transect']})):[];
    res.json({capabilities:{personalPersistence:false,rasterCalculations:enabled,transectCalculations:enabled,temporaryCalculations:true,serverCalculations:false},modelVersionId:access.model.activeVersion.id,calculationSources:sources,calculationMethods:sources.length?['surface-cut-fill','surface-transect']:[]});}catch(e){next(e);}});
  router.post('/calculations',async(req,res,next)=>{try{
    const access=await resolve(req),pageHash=page(req);if(config.measurementCalculationsEnabled===false)fail('measurement_calculations_disabled',503);
    if(repository.rateLimited(`temporary-measurement:${access.scopeKey}`,20,60_000)||repository.rateLimited(`temporary-measurement-ip:${req.ip}`,30,60_000))fail('measurement_rate_limited',429);
    if(!req.body||Array.isArray(req.body)||Object.keys(req.body).some(k=>!['measurement','request'].includes(k)))fail('measurement_calculation_invalid');
    const document=validateMeasurement(req.body.measurement),measurement={...document,modelId:access.model.id,modelVersionId:access.model.activeVersion.id,revision:1};
    if(!['surface-cut-fill','surface-transect'].includes(req.body.request?.method))fail('measurement_method_unavailable',403);
    const transect=req.body.request.method==='surface-transect',parent=transect?jobs.parent(access.scopeKey,pageHash,req.body.request.parentCalculationId):null;
    const request=transect?validateTransectRequest(req.body.request,measurement,sourceVersion(access),parent,{temporary:true}):validateCalculationRequest(req.body.request,measurement,sourceVersion(access));
    try{await preflight(request);}catch(e){fail(/^measurement_(source_|pixel_|rotated_|raster_)/.test(e.code||'')?e.code:'measurement_source_preflight_unavailable',422);}
    const current=await resolve(req);if(current.scopeKey!==access.scopeKey)fail('temporary_measurement_access_unavailable',403);
    if(transect){const rebuilt=validateTransectRequest(req.body.request,measurement,sourceVersion(current),jobs.parent(current.scopeKey,pageHash,req.body.request.parentCalculationId),{temporary:true});if(!sameTransectEvidence(request,rebuilt))fail('measurement_transect_parent_stale',409);}
    res.status(202).json({calculation:jobs.enqueue(transect?{...access,expiresAt:Math.min(access.expiresAt,Date.parse(parent.job.expiresAt))}:access,pageHash,measurement,request)});
  }catch(e){next(e);}});
  router.get('/calculations',async(req,res,next)=>{try{const access=await resolve(req),measurementId=req.query.measurementId;if(measurementId!==undefined&&(typeof measurementId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(measurementId)))fail('measurement_calculation_invalid');jobs.prune();res.json({calculations:jobs.list(access.scopeKey,page(req),measurementId)});}catch(e){next(e);}});
  router.get('/calculations/:jobId',async(req,res,next)=>{try{const access=await resolve(req),calculation=jobs.get(access.scopeKey,page(req),req.params.jobId);if(!calculation)fail('measurement_calculation_not_found',404);res.json({calculation});}catch(e){next(e);}});
  router.delete('/calculations/:jobId',async(req,res,next)=>{try{const access=await resolve(req),pageHash=page(req);if(!jobs.get(access.scopeKey,pageHash,req.params.jobId))fail('measurement_calculation_not_found',404);jobs.cancel(access.scopeKey,pageHash,req.params.jobId);res.status(204).end();}catch(e){next(e);}});
  return router;
}
module.exports={createEphemeralMeasurementApi};
