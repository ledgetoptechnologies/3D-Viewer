import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const sharedNode='new Potree.PointCloudCopcGeometryNode(geometry)';
const nonexistentNode='new Potree.PointCloudEptGeometryNode(geometry)';
const releasedEptWorkerRoute="let workerPath = Potree.scriptPath +\n\t\t\t\t'/workers/EptLaszipDecoderWorker.js';";
const patchedEptWorkerRoute="let workerPath = Potree.scriptPath +\n\t\t\t\t(isFullFile ? '/workers/EptLazRsDecoderWorker.js' : '/workers/EptLaszipDecoderWorker.js');";
const releasedWorkerFactory='let worker = new Worker(url);';
const patchedWorkerFactory='let worker = new Worker(url, url.endsWith("/EptLazRsDecoderWorker.js") ? {type: "module"} : undefined);';
const releasedDecodedPointCount='\t\t\t\t\tpointCount,\n\t\t\t\t\tnew Vector3(...e.data.mean));';
const patchedDecodedPointCount='\t\t\t\t\tNumber.isSafeInteger(e.data.pointCount) && e.data.pointCount > 0 ? e.data.pointCount : pointCount,\n\t\t\t\t\tnew Vector3(...e.data.mean));';

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

export function patchPotreeEptWorkerRoute(source){
  const releasedCount=source.split(releasedEptWorkerRoute).length-1;
  const patchedCount=source.split(patchedEptWorkerRoute).length-1;
  if(releasedCount===0&&patchedCount===1)return source;
  if(releasedCount===1&&patchedCount===0)return source.replace(releasedEptWorkerRoute,patchedEptWorkerRoute);
  throw new Error('pinned Potree EPT worker route signature changed');
}

export function patchPotreeEptWorkerFactory(source){
  const releasedCount=source.split(releasedWorkerFactory).length-1;
  const patchedCount=source.split(patchedWorkerFactory).length-1;
  if(releasedCount===0&&patchedCount===1)return source;
  if(releasedCount===1&&patchedCount===0)return source.replace(releasedWorkerFactory,patchedWorkerFactory);
  throw new Error('pinned Potree worker factory signature changed');
}

export function patchPotreeEptDecodedPointCount(source){
  const releasedCount=source.split(releasedDecodedPointCount).length-1;
  const patchedCount=source.split(patchedDecodedPointCount).length-1;
  if(releasedCount===0&&patchedCount===1)return source;
  if(releasedCount===1&&patchedCount===0)return source.replace(releasedDecodedPointCount,patchedDecodedPointCount);
  throw new Error('pinned Potree EPT decoded point-count signature changed');
}

function replaceFile(file,patcher){
  const source=fs.readFileSync(file,'utf8'),patched=patcher(source);
  if(patched===source)return;
  const temporary=`${file}.patched-${process.pid}`;
  fs.writeFileSync(temporary,patched,{mode:fs.statSync(file).mode});
  fs.renameSync(temporary,file);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const bundleFile=process.argv[2];
  if(!bundleFile)throw new Error('Potree bundle path is required');
  replaceFile(bundleFile,(source)=>patchPotreeEptDecodedPointCount(patchPotreeEptWorkerFactory(patchPotreeEptWorkerRoute(patchPotreeEptSource(source)))));
}
