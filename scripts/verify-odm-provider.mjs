#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NodeOdmProvider } from '../server/nodeOdmProvider.js';

const args=new Map();for(let index=2;index<process.argv.length;index+=1){const key=process.argv[index];if(!key.startsWith('--'))throw new Error(`unexpected argument: ${key}`);const value=process.argv[index+1];if(value&&!value.startsWith('--')){args.set(key,value);index+=1;}else args.set(key,true);}
const endpoint=args.get('--endpoint'),providerType=args.get('--provider-type')||'nodeodm',tokenEnv=args.get('--token-env')||'ODM_PROVIDER_TOKEN';
if(!endpoint)throw new Error('--endpoint is required');if(!['nodeodm','clusterodm'].includes(providerType))throw new Error('--provider-type must be nodeodm or clusterodm');
const provider=new NodeOdmProvider({endpoint,providerType,token:process.env[tokenEnv]||'',transferTimeoutMs:6*3600_000});
const capability=await provider.capabilities();
console.log(JSON.stringify({mode:'read-only',providerType,apiVersion:capability.capabilities.apiVersion,engine:capability.capabilities.engine,engineVersion:capability.capabilities.engineVersion,optionCount:capability.capabilities.options.length,maxImages:capability.capabilities.maxImages,capabilityFingerprint:capability.fingerprint},null,2));
if(!args.has('--destructive'))process.exit(0);
if(args.get('--confirm')!=='I_UNDERSTAND_PROVIDER_TASKS_WILL_BE_CREATED_AND_REMOVED')throw new Error('destructive mode requires --confirm I_UNDERSTAND_PROVIDER_TASKS_WILL_BE_CREATED_AND_REMOVED');
const corpus=args.get('--corpus');if(!corpus)throw new Error('destructive mode requires --corpus');const corpusRoot=fs.realpathSync.native(corpus),extensions=new Set(['.jpg','.jpeg','.png','.tif','.tiff']),files=[];
for(const entry of fs.readdirSync(corpusRoot,{withFileTypes:true})){if(!entry.isFile()||!extensions.has(path.extname(entry.name).toLowerCase()))continue;const absolutePath=path.join(corpusRoot,entry.name),size=fs.statSync(absolutePath).size;if(size>512*1024*1024)throw new Error('compatibility corpus contains a file over 512 MiB');files.push({absolutePath,relativePath:entry.name});}
if(!files.length||files.length>50)throw new Error('compatibility corpus must contain 1-50 image files in its top-level directory');
const uuid=crypto.randomUUID(),cancelUuid=crypto.randomUUID(),deadline=Date.now()+Number(args.get('--timeout-ms')||2*3600_000);let mainExists=false,cancelExists=false;
try{
  await provider.initialize({uuid,name:'LTDS compatibility verification',options:{'pc-ept':true,gltf:true,'3d-tiles':true},outputs:['all.zip']});mainExists=true;
  await provider.upload(uuid,files);await provider.commit(uuid);
  let finalStatus=null;for(;;){const status=await provider.status(uuid);await provider.output(uuid,0);if(['completed','failed','cancelled'].includes(status.status)){finalStatus=status;break;}if(Date.now()>=deadline)throw new Error('provider task did not reach a terminal state before timeout');await new Promise((resolve)=>setTimeout(resolve,5000));}
  if(finalStatus.status!=='completed')throw new Error(`provider compatibility task ended as ${finalStatus.status}`);
  const response=await provider.downloadAll(uuid),hash=crypto.createHash('sha256');let bytes=0;for await(const chunk of response.body){bytes+=chunk.byteLength;if(bytes>20*1024*1024*1024)throw new Error('all.zip exceeded the 20 GiB verification limit');hash.update(chunk);}if(!bytes)throw new Error('all.zip was empty');
  await provider.initialize({uuid:cancelUuid,name:'LTDS cancellation verification',options:{},outputs:[]});cancelExists=true;await provider.cancel(cancelUuid);const cancelled=await provider.status(cancelUuid);if(cancelled.status!=='cancelled')throw new Error(`provider cancellation returned ${cancelled.status}`);
  console.log(JSON.stringify({mode:'destructive',result:'compatible',taskStatus:finalStatus.status,downloadBytes:bytes,downloadSha256:hash.digest('hex'),cancelStatus:cancelled.status},null,2));
}finally{
  if(cancelExists)try{await provider.remove(cancelUuid);}catch{/* cleanup is reported by provider logs; token is never printed */}
  if(mainExists)try{await provider.remove(uuid);}catch{/* best effort after a failed compatibility gate */}
}
