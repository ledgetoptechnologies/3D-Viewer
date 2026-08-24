import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const sharedNode='new Potree.PointCloudCopcGeometryNode(geometry)';
const nonexistentNode='new Potree.PointCloudEptGeometryNode(geometry)';

export function patchPotreeEptSource(source){
  const start=source.indexOf('class EptLoader');
  const end=source.indexOf('class CopcLoader',start+1);
  if(start<0||end<=start)throw new Error('pinned Potree EPT/COPC loader boundaries changed');
  const block=source.slice(start,end),copcBlock=source.slice(end);
  const sharedCount=block.split(sharedNode).length-1,nonexistentCount=block.split(nonexistentNode).length-1;
  if(!copcBlock.includes(sharedNode))throw new Error('pinned Potree COPC loader signature changed');
  // Potree 1.8.2 deliberately shares PointCloudCopcGeometryNode between COPC
  // and EPT. PointCloudEptGeometryNode is not exported by this release; using
  // it crashes in the iframe before EPT metadata can finish loading.
  if(sharedCount===1&&nonexistentCount===0)return source;
  if(sharedCount===0&&nonexistentCount===1){
    return source.slice(0,start)+block.replace(nonexistentNode,sharedNode)+source.slice(end);
  }
  throw new Error('pinned Potree EPT loader signature changed');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const file=process.argv[2];
  if(!file)throw new Error('Potree bundle path is required');
  const source=fs.readFileSync(file,'utf8'),patched=patchPotreeEptSource(source);
  if(patched!==source){
    const temporary=`${file}.patched-${process.pid}`;
    fs.writeFileSync(temporary,patched,{mode:fs.statSync(file).mode});
    fs.renameSync(temporary,file);
  }
}
