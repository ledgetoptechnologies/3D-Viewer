import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSurfaceAccumulator } from '../measurement-volume.mjs';
import { insideSelection } from './measurementSelection.mjs';
const require = createRequire(import.meta.url), fail = code => { throw Object.assign(new Error(code), { code }); };
let decoderReady;
async function lazModule() {
  if (!decoderReady) decoderReady = (async () => {
    const root = path.dirname(require.resolve('@loaders.gl/las'));
    const wasm = await import(pathToFileURL(path.join(root,'libs/laz-rs-wasm/laz_rs_wasm.js')).href);
    wasm.initSync({module:await fs.promises.readFile(path.join(root,'libs/laz-rs-wasm/laz_rs_wasm_bg.wasm'))});
    return (await import('@loaders.gl/las')).LAZRsLoader;
  })();
  return decoderReady;
}
export function pointSurfaceGrid(vertices,cellSizeM,maxCells=2_000_000) {
  if(!Number.isFinite(cellSizeM)||cellSizeM<.001||cellSizeM>100)fail('measurement_point_cell_size_required');
  const minE=Math.floor(Math.min(...vertices.map(p=>p[0]))/cellSizeM)*cellSizeM,minN=Math.floor(Math.min(...vertices.map(p=>p[1]))/cellSizeM)*cellSizeM;
  const width=Math.ceil((Math.max(...vertices.map(p=>p[0]))-minE)/cellSizeM),height=Math.ceil((Math.max(...vertices.map(p=>p[1]))-minN)/cellSizeM);
  if(width<1||height<1||width*height>maxCells)fail('measurement_limit');
  return {width,height,bounds:{minE,minN,maxE:minE+width*cellSizeM,maxN:minN+height*cellSizeM},values:new Float64Array(width*height).fill(NaN)};
}
function boundsForKey(key,bounds) {
  const numbers=key.split('-').map(Number);if(numbers.length!==4||numbers.some(n=>!Number.isSafeInteger(n)||n<0)||numbers[0]>30)fail('measurement_ept_hierarchy_invalid');
  const[d,x,y,z]=numbers,divisor=2**d;if([x,y,z].some(n=>n>=divisor))fail('measurement_ept_hierarchy_invalid');
  const lo=[x,y,z].map((n,i)=>bounds[i]+n*(bounds[i+3]-bounds[i])/divisor),hi=lo.map((n,i)=>n+(bounds[i+3]-bounds[i])/divisor);return [...lo,...hi];
}
function intersects(a,b){return a[0]<=b.maxE&&a[3]>=b.minE&&a[1]<=b.maxN&&a[4]>=b.minN;}
async function readVerified(root,relative,files,{maxBytes=64*1024*1024,signal}={}) {
  if(!/^(?:ept\.json|ept-(?:hierarchy|data)\/[0-9]+-[0-9]+-[0-9]+-[0-9]+\.(?:json|laz|bin))$/.test(relative))fail('measurement_ept_path_invalid');
  const expected=files.get(relative);if(!expected||!Number.isSafeInteger(expected.byteSize)||expected.byteSize>maxBytes||!expected.sha256)fail('measurement_ept_file_unavailable');
  const candidate=path.resolve(root,...relative.split('/')),real=await fs.promises.realpath(candidate);
  if(!real.startsWith(root+path.sep))fail('measurement_ept_path_invalid');
  const before=await fs.promises.stat(real);if(!before.isFile()||before.size!==expected.byteSize)fail('measurement_source_changed');
  const bytes=await fs.promises.readFile(real,{signal});if(crypto.createHash('sha256').update(bytes).digest('hex')!==expected.sha256)fail('measurement_source_changed');
  return bytes;
}
function lasPointCount(bytes) {
  if(bytes.length<227||bytes.toString('ascii',0,4)!=='LASF')fail('measurement_point_node_invalid');
  const count=bytes.length>=375&&bytes.readUInt16LE(94)>=375?Number(bytes.readBigUInt64LE(247))||bytes.readUInt32LE(107):bytes.readUInt32LE(107);
  if(!Number.isSafeInteger(count)||count<0||count>2_000_000)fail('measurement_point_node_limit');return count;
}
function binaryRead(view,offset,field) {
  const method={signed:{1:'getInt8',2:'getInt16',4:'getInt32',8:'getBigInt64'},unsigned:{1:'getUint8',2:'getUint16',4:'getUint32',8:'getBigUint64'},floating:{4:'getFloat32',8:'getFloat64'}}[field.type]?.[field.size];
  if(!method)fail('measurement_ept_schema_unsupported');return Number(view[method](offset,true))*(field.scale??1)+(field.offset??0);
}
export async function calculatePointSurface(absolutePath,request,{maxCells=2_000_000,signal,sourceFiles=[],collectOnly=false}={}) {
  const root=await fs.promises.realpath(path.dirname(absolutePath)),files=new Map(sourceFiles.map(f=>[f.relativePath,f]));
  files.set('ept.json',{byteSize:request.source.byteSize,sha256:request.source.sha256});
  const ept=JSON.parse((await readVerified(root,'ept.json',files,{maxBytes:1024*1024,signal})).toString('utf8'));
  const code=Number(ept.srs?.horizontal||ept.srs?.code),expected=Number(request.coordinateReference.crs.replace(/^EPSG:/i,''));
  if(code!==expected||!((expected>=32601&&expected<=32660)||(expected>=32701&&expected<=32760)))fail('measurement_source_crs_mismatch');
  if(request.sourceVerticalUnit!=='m')fail('measurement_source_vertical_units_required');
  if(!Array.isArray(ept.bounds)||ept.bounds.length!==6||!ept.bounds.every(Number.isFinite)||!['laszip','binary'].includes(ept.dataType)||!Array.isArray(ept.schema))fail('measurement_ept_schema_unsupported');
  const classify=ept.schema.find(s=>s.name==='Classification');if(request.classFilter==='ground'&&!classify)fail('measurement_point_classification_unavailable');
  const grid=collectOnly?{bounds:{minE:Math.min(...request.vertices.map(p=>p[0])),maxE:Math.max(...request.vertices.map(p=>p[0])),minN:Math.min(...request.vertices.map(p=>p[1])),maxN:Math.max(...request.vertices.map(p=>p[1]))}}:pointSurfaceGrid(request.vertices,request.cellSizeM,maxCells),hierarchies=['0-0-0-0'],seenHierarchies=new Set(),nodes=new Map(),collected=[];
  while(hierarchies.length){if(signal?.aborted)fail('measurement_cancelled');const key=hierarchies.pop();if(seenHierarchies.has(key))continue;seenHierarchies.add(key);if(seenHierarchies.size>10_000)fail('measurement_ept_selection_limit');
    const values=JSON.parse((await readVerified(root,`ept-hierarchy/${key}.json`,files,{maxBytes:16*1024*1024,signal})).toString('utf8'));
    if(!values||Array.isArray(values)||typeof values!=='object')fail('measurement_ept_hierarchy_invalid');
    for(const[key,count]of Object.entries(values)){const bounds=boundsForKey(key,ept.bounds);if(!Number.isSafeInteger(count)||count< -1)fail('measurement_ept_hierarchy_invalid');if(!intersects(bounds,grid.bounds))continue;if(count===-1)hierarchies.push(key);else if(count>0)nodes.set(key,count);if(nodes.size>20_000)fail('measurement_ept_selection_limit');}
  }
  let pointsRead=0,pointsUsed=0,nodesRead=0;
  const add=(x,y,z,classification)=>{
    if(![x,y,z].every(Number.isFinite))fail('measurement_point_node_invalid');
    if(request.classFilter==='ground'&&classification!==2)return;
    if(collectOnly){if(insideSelection(x,y,request.vertices)&&z>=request.selection.minElevationM&&z<=request.selection.maxElevationM){if(collected.length>=100_000)fail('measurement_reconstruction_input_limit');collected.push([x,y,z]);}return;}
    const col=Math.floor((x-grid.bounds.minE)/request.cellSizeM),row=Math.floor((grid.bounds.maxN-y)/request.cellSizeM);
    if(col<0||row<0||col>=grid.width||row>=grid.height)return;
    const at=row*grid.width+col;if(!Number.isFinite(grid.values[at])||z>grid.values[at])grid.values[at]=z;pointsUsed++;
  };
  for(const[key,count]of nodes){if(signal?.aborted)fail('measurement_cancelled');if(pointsRead+count>20_000_000)fail('measurement_point_selection_limit');
    if(count>2_000_000)fail('measurement_point_node_limit');
    const bytes=await readVerified(root,`ept-data/${key}.${ept.dataType==='laszip'?'laz':'bin'}`,files,{signal});
    if(ept.dataType==='laszip'){
      if(lasPointCount(bytes)!==count)fail('measurement_point_node_invalid');
      const loader=await lazModule(),buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),decoded=await loader.parse(buffer,{las:{shape:'mesh',fp64:true,skip:1,colorDepth:8}}),positions=decoded?.attributes?.POSITION?.value,classes=decoded?.attributes?.classification?.value;
      if(!positions||positions.length!==count*3||(request.classFilter==='ground'&&!classes))fail('measurement_point_node_invalid');
      for(let i=0;i<count;i++)add(positions[i*3],positions[i*3+1],positions[i*3+2],classes?.[i]);
    }else{
      let stride=0;const schema=ept.schema.map(field=>{if(!Number.isSafeInteger(field.size)||field.size<1||field.size>8)fail('measurement_ept_schema_unsupported');const entry={...field,byteOffset:stride};stride+=field.size;return entry;}),xyz=['X','Y','Z'].map(name=>schema.find(f=>f.name===name)),classification=schema.find(f=>f.name==='Classification');
      if(xyz.some(f=>!f)||stride<12||bytes.length!==stride*count)fail('measurement_point_node_invalid');const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
      for(let i=0;i<count;i++){const values=xyz.map(f=>binaryRead(view,i*stride+f.byteOffset,f));add(...values,classification?binaryRead(view,i*stride+classification.byteOffset,classification):undefined);}
    }
    pointsRead+=count;nodesRead++;await new Promise(resolve=>setImmediate(resolve));
  }
  if(collectOnly)return{points:collected,pointsRead,nodesRead};
  let vertices=request.vertices;
  if(request.collection==='map'&&request.reference?.type!=='custom')vertices=request.vertices.map(([e,n])=>{
    const col=Math.min(grid.width-1,Math.floor((e-grid.bounds.minE)/request.cellSizeM)),row=Math.min(grid.height-1,Math.floor((grid.bounds.maxN-n)/request.cellSizeM));
    const z=grid.values[row*grid.width+col];if(col<0||row<0||!Number.isFinite(z))fail('measurement_boundary_elevation_unavailable');return[e,n,z];
  });
  const accumulator=createSurfaceAccumulator({vertices,reference:request.reference,maxCells});
  for(let row=0;row<grid.height;row+=64){const height=Math.min(64,grid.height-row);accumulator.addGrid({values:grid.values.subarray(row*grid.width,(row+height)*grid.width),width:grid.width,height,bounds:{...grid.bounds,maxN:grid.bounds.maxN-row*request.cellSizeM,minN:grid.bounds.maxN-(row+height)*request.cellSizeM}});await new Promise(resolve=>setImmediate(resolve));if(signal?.aborted)fail('measurement_cancelled');}
  const samples=[],stride=Math.max(1,Math.ceil(grid.values.length/4096));for(let i=0;i<grid.values.length;i+=stride){const z=grid.values[i],e=grid.bounds.minE+(i%grid.width+.5)*request.cellSizeM,n=grid.bounds.maxN-(Math.floor(i/grid.width)+.5)*request.cellSizeM,base=accumulator.reference.sample(e,n);if(Number.isFinite(z)&&Number.isFinite(base)&&insideSelection(e,n,vertices))samples.push([e,n,z,base]);}
  const result=accumulator.result();return{...result,calculationOrigin:'server-original-point-surface',preview:{previewOnly:true,samples,referencePatches:accumulator.reference.patches.map(patch=>patch.polygon.map(p=>[p[0],p[1],patch.sample(p[0],p[1])]))},source:{assetId:request.source.id,sha256:request.source.sha256,manifestSha256:request.source.manifestSha256,modelVersionId:request.modelVersionId,crs:`EPSG:${expected}`,cellSizeM:request.cellSizeM,verticalUnitBasis:'administrator-declared',classFilter:request.classFilter||'all',pointsRead,pointsUsed,nodesRead,allIntersectingHierarchyLevels:true},warnings:[...result.warnings,'This is a 2.5D topmost-point grid at the requested cell size, not enclosed-object volume. Empty cells remain missing; no interpolation or hidden point-budget subsampling is used.','Point-cloud vertical units were declared as metres by the requesting administrator.']};
}
