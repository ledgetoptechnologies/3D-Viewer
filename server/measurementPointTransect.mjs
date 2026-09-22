import crypto from 'node:crypto';
import {calculatePointSurface} from './measurementPointSurface.mjs';
import {traceRasterCells,frozenReferenceIntervals,NATIVE_TRANSECT_LIMIT} from './measurementRasterTransect.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const at=(line,t)=>line.start.map((v,i)=>v+(line.end[i]-v)*t);

// Called with the completed parent's immutable grid policy and frozen base.
// This repeats the verified all-node grid construction; it never profiles the
// viewer's loaded points or the deliberately reduced volume-preview samples.
export async function calculatePointSurfaceTransect(absolutePath,request,options={}) {
  if(options.signal?.aborted)fail('measurement_cancelled');
  if(request.method!=='surface-transect'||request.source?.kind!=='ept')fail('measurement_transect_invalid');
  const policy=request.samplingGrid;
  if(!policy||policy.version!==1||policy.reduction!=='maximum-z'||policy.emptyCells!=='missing'||policy.rowOrder!=='north-to-south'||policy.cellSizeM!==request.cellSizeM)fail('measurement_transect_source_mismatch');
  const baseHash=crypto.createHash('sha256').update(JSON.stringify(request.referencePatches)).digest('hex');
  if(baseHash!==request.baseHash)fail('measurement_transect_reference_invalid');
  const patches=frozenReferenceIntervals(request.line,request.referencePatches);
  const {grid,pointsRead,nodesRead,vertical}=await calculatePointSurface(absolutePath,request,{...options,collectOnly:false,gridOnly:true});
  if(grid.width!==policy.width||grid.height!==policy.height||['minE','minN','maxE','maxN'].some(k=>grid.bounds[k]!==policy.bounds?.[k]))fail('measurement_transect_source_mismatch');
  const line=request.line,lengthM=Math.hypot(...line.end.map((v,i)=>v-line.start[i]));
  const cells=traceRasterCells(line,{ox:grid.bounds.minE,oy:grid.bounds.maxN,dx:request.cellSizeM,dy:-request.cellSizeM,width:grid.width,height:grid.height});
  const breaks=[...new Set([0,1,...cells.flatMap(c=>[c.startT,c.endT]),...patches.flatMap(p=>[p.startT,p.endT])])].sort((a,b)=>a-b);
  if(breaks.length-1>NATIVE_TRANSECT_LIMIT)fail('measurement_transect_limit');
  const segments=[];let cellIndex=0;
  for(let i=0;i<breaks.length-1;i++){
    if(options.signal?.aborted)fail('measurement_cancelled');
    const startT=breaks[i],endT=breaks[i+1],mid=(startT+endT)/2;
    while(cellIndex<cells.length-1&&mid>=cells[cellIndex].endT)cellIndex++;
    const cell=cells[cellIndex],patch=patches.find(p=>mid>=p.startT&&mid<=p.endT),start=at(line,startT),end=at(line,endT);
    const segment={startM:startT*lengthM,endM:endT*lengthM,start,end,status:'outside-selection'};
    if(cell.col!==null)segment.cell=[cell.col,cell.row];
    if(patch){
      segment.baseStartM=patch.sample(start);segment.baseEndM=patch.sample(end);
      if(!Number.isFinite(segment.baseStartM)||!Number.isFinite(segment.baseEndM))fail('measurement_transect_reference_invalid');
      const z=cell.col===null?NaN:grid.values[cell.row*grid.width+cell.col];
      segment.status=cell.col===null?'outside-surface':Number.isFinite(z)?'sample':'nodata';
      if(segment.status==='sample')segment.surfaceM=z;
    }
    segments.push(segment);
    if(i%128===0)await new Promise(resolve=>setImmediate(resolve));
  }
  if(options.signal?.aborted)fail('measurement_cancelled');
  return{schemaVersion:1,status:'calculated',method:'surface-transect',calculationOrigin:'server-original-point-surface',sampling:'point-grid-step',parentCalculationId:request.parentCalculationId,baseHash,reference:request.reference,line,lengthM,segments,cellCount:cells.filter(c=>c.col!==null).length,
    source:{assetId:request.source.id,kind:'ept',sha256:request.source.sha256,manifestSha256:request.source.manifestSha256,modelVersionId:request.modelVersionId,samplingGrid:policy,crs:request.coordinateReference.crs,...vertical,classFilter:request.classFilter||'all',pointsRead,nodesRead},
    warnings:['This section uses the volume’s maximum-height point grid and frozen reference base, not native raster cells. Empty cells remain gaps. Vertical datum is unverified.',...(vertical.verticalUnitBasis==='administrator-declared'?['Source height units were administrator-declared.']:[])]};
}
