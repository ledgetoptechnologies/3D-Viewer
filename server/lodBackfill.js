'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {lodDerivativeSpecs}=require('./lodDerivativePolicy');
const {LOD_DERIVATIVE_RECOVERY_REVISION}=require('./lodRecoveryPolicy');
const {hashFileChunks,hashTree}=require('./storageManager');

function reconcileMissingLodDerivatives(processing,storage,{meshDerivativesEnabled=false,limit=20}={}){
  let queued=0,scanned=0,lastProcessed=null,conflict=false;
  let candidates=processing.listLodBackfillCandidates(limit);
  // A persisted cursor can point beyond every remaining candidate after an
  // upgrade changes eligibility. Wrap once in the same maintenance pass so a
  // single legacy model is not deferred until the next hourly run.
  if(!candidates.length&&processing.lodBackfillCursor?.()){
    processing.advanceLodBackfillCursor(null,false);
    candidates=processing.listLodBackfillCandidates(limit);
  }
  for(const candidate of candidates){
    scanned+=1;
    try{
      const assets=processing.modelAssetsForVersion(candidate.versionId);
      if(!assets.some((asset)=>asset.kind==='tiles')){
        const relative=path.posix.join(candidate.outputRelativePath||`${candidate.taskId}/${candidate.attemptId}`,'3d_tiles/model/tileset.json');
        try{if(fs.statSync(storage.resolve(candidate.outputRootKey,relative,{mustExist:true})).isFile())assets.push({kind:'nativeTiles',rootKey:candidate.outputRootKey,relativePath:relative});}catch{}
      }
      const specs=lodDerivativeSpecs(assets,{meshDerivativesEnabled});
      if(specs.length){if(!processing.enqueueOptionalDerivatives(candidate.attemptId,specs))throw Object.assign(new Error('LOD backfill candidate changed'),{code:'derivative_activation_conflict'});queued+=1;}
      lastProcessed=candidate.attemptId;
    }catch(error){if(error.code!=='derivative_activation_conflict')throw error;conflict=true;break;}
  }
  if(lastProcessed)processing.advanceLodBackfillCursor(lastProcessed,conflict||candidates.length>=limit);
  else if(!conflict)processing.advanceLodBackfillCursor(null,false);
  return{scanned,queued,conflict};
}

function reconcileLodMaintenance(processing,storage,{meshDerivativesEnabled=false,limit=20,recoveryRevision=LOD_DERIVATIVE_RECOVERY_REVISION}={}){
  const recovery=processing.recoverStaleLodDerivatives({revision:recoveryRevision,meshDerivativesEnabled,limit});
  const discovery=reconcileMissingLodDerivatives(processing,storage,{meshDerivativesEnabled,limit});
  return{revision:recovery.revision,recovery,discovery};
}

function lodReconciliationSummary(result){
  const recovery=result?.recovery||{},discovery=result?.discovery||{};
  return`LOD reconciliation: revision=${Math.max(0,Number(result?.revision)||0)} recoveryScanned=${Math.max(0,Number(recovery.scanned)||0)} requeued=${Math.max(0,Number(recovery.requeued)||0)} conflicts=${Math.max(0,Number(recovery.conflicts)||0)} discoveryScanned=${Math.max(0,Number(discovery.scanned)||0)} queued=${Math.max(0,Number(discovery.queued)||0)} discoveryConflict=${discovery.conflict?'yes':'no'}`;
}

function lodReconciliationFailure(error){
  const raw=String(error?.code||error?.name||''),code=/^[a-z0-9_-]{1,80}$/i.test(raw)?raw:'maintenance_error';
  return`LOD reconciliation failed: revision=${LOD_DERIVATIVE_RECOVERY_REVISION} code=${code} retry=next-maintenance`;
}

async function reconcileMissingPointCloudAssets(processing,storage,{limit=5}={}){
  let scanned=0,registered=0,lastProcessed=null;
  let candidates=processing.listPointCloudBackfillCandidates(limit);
  if(!candidates.length&&processing.pointCloudBackfillCursor?.()){
    processing.advancePointCloudBackfillCursor(null,false);
    candidates=processing.listPointCloudBackfillCandidates(limit);
  }
  for(const candidate of candidates){
    scanned+=1;
    const prefix=candidate.outputRelativePath||'';
    const eptChoices=['assets/entwine_pointcloud/ept.json','entwine_pointcloud/ept.json'];
    const pointChoices=['assets/odm_georeferencing/odm_georeferenced_model.laz','odm_georeferencing/odm_georeferenced_model.laz'];
    let discovered=null;
    for(const suffix of eptChoices){
      const relativePath=path.posix.join(prefix,suffix);
      let absolute;try{absolute=storage.resolve(candidate.outputRootKey,relativePath,{mustExist:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(!fs.statSync(absolute).isFile())continue;
      const tree=await hashTree(path.dirname(absolute));
      const entry=tree.files.find((file)=>file.relativePath==='ept.json');
      if(entry)discovered={kind:'ept',rootKey:candidate.outputRootKey,relativePath,format:'ept',contentType:'application/json',byteSize:entry.byteSize,sha256:entry.sha256,manifestSha256:tree.manifestSha256,manifestFiles:tree.files};
      if(discovered)break;
    }
    if(!discovered&&!candidate.hasPointCloud){for(const suffix of pointChoices){
      const relativePath=path.posix.join(prefix,suffix);
      let absolute;try{absolute=storage.resolve(candidate.outputRootKey,relativePath,{mustExist:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
      const stat=fs.statSync(absolute);if(!stat.isFile())continue;
      const integrity=await hashFileChunks(absolute);
      discovered={kind:'pointCloud',rootKey:candidate.outputRootKey,relativePath,format:'laz',contentType:'application/vnd.laszip',byteSize:stat.size,sha256:integrity.sha256,chunks:integrity.chunks};
      if(discovered)break;
    }}
    // EPT is the scalable viewer source and is reconciled independently of a
    // direct LAZ/PLY fallback. Upsert repairs incomplete, stale, or unpublished
    // legacy EPT metadata while retaining the original pointCloud asset.
    if(discovered){processing.addModelAsset({versionId:candidate.versionId,attemptId:candidate.attemptId,published:candidate.published,...discovered});registered+=1;}
    lastProcessed=candidate.attemptId;
  }
  if(lastProcessed)processing.advancePointCloudBackfillCursor(lastProcessed,candidates.length>=limit);
  else processing.advancePointCloudBackfillCursor(null,false);
  return{scanned,registered};
}
module.exports={lodReconciliationFailure,lodReconciliationSummary,reconcileLodMaintenance,reconcileMissingLodDerivatives,reconcileMissingPointCloudAssets};
