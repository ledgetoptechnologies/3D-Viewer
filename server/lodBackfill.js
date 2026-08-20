'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {lodDerivativeSpecs}=require('./lodDerivativePolicy');

function reconcileMissingLodDerivatives(processing,storage,{meshDerivativesEnabled=false,limit=20}={}){
  let queued=0,scanned=0,lastProcessed=null,conflict=false;
  const candidates=processing.listLodBackfillCandidates(limit);
  for(const candidate of candidates){
    scanned+=1;
    try{
      const assets=processing.modelAssetsForVersion(candidate.versionId);
      if(!assets.some((asset)=>asset.kind==='tiles')&&candidate.outputRootKey==='models'){
        const relative=path.posix.join(candidate.outputRelativePath||`${candidate.taskId}/${candidate.attemptId}`,'3d_tiles/model/tileset.json');
        try{if(fs.statSync(storage.resolve('models',relative,{mustExist:true})).isFile())assets.push({kind:'nativeTiles',rootKey:'models',relativePath:relative});}catch{}
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
module.exports={reconcileMissingLodDerivatives};
