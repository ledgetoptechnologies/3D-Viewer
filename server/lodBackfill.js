'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {lodDerivativeSpecs}=require('./lodDerivativePolicy');
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
module.exports={reconcileMissingLodDerivatives,reconcileMissingPointCloudAssets};
