import test from 'node:test';
import assert from 'node:assert/strict';
import {createMeasurementStore} from '../measurement-store.mjs';
const record={id:'0e439915-bcda-4c90-852a-9e0a7f48c7ce',name:'Private',collection:'spatial3d',kind:'distance',vertices:[[0,0,0],[1,0,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const response=measurement=>({ok:true,status:200,json:async()=>({measurement})});
test('invalidation clears data and fences an in-flight write and queued writes',async()=>{
  const wait=deferred(),started=deferred();let calls=0;
  const store=createMeasurementStore({token:()=> 'token',fetcher:async()=>{calls++;started.resolve();await wait.promise;return response({...record,revision:1});}});
  const saving=store.save(record),queued=store.save({...record,id:'other'});
  const rejected=Promise.all([assert.rejects(saving),assert.rejects(queued)]);
  await started.promise;assert.equal(store.records.size,1);store.invalidate();
  assert.equal(store.records.size,0);assert.equal(store.statuses.size,0);assert.equal(store.isInvalidated(),true);
  wait.resolve();await rejected;assert.equal(calls,1);assert.equal(store.records.size,0);assert.equal(store.statuses.size,0);
  await assert.rejects(store.save(record),/access changed/);
});
test('new explicit reload does not wait for old identity fetch and ignores late JSON',async()=>{
  const json=deferred(),started=deferred();let credential='first';
  const store=createMeasurementStore({token:()=>credential,fetcher:async(_url,options)=>{
    if(options.headers.Authorization==='Bearer first'){started.resolve();return{ok:true,status:200,json:()=>json.promise};}
    return{ok:true,status:200,json:async()=>({measurements:[],capabilities:{personalPersistence:true}})};
  }});
  const loading=store.load(),rejected=assert.rejects(loading);await started.promise;store.invalidate();credential='second';
  await store.load();assert.equal(store.isInvalidated(),false);json.resolve({measurements:[record],capabilities:{personalPersistence:true}});
  await rejected;assert.equal(store.records.size,0);
});
test('401 and 403 responses clear private data and require explicit reload',async()=>{
  for(const status of [401,403]){
    let denied=false;const store=createMeasurementStore({token:()=> 'token',fetcher:async()=>denied?{ok:false,status,json:async()=>({error:'denied'})}:response({...record,revision:1})});
    await store.save(record);denied=true;await assert.rejects(store.save({...store.records.get(record.id),name:'Other'}),/access changed/);
    assert.equal(store.records.size,0);assert.equal(store.statuses.size,0);assert.equal(store.isInvalidated(),true);
  }
});
test('lost signed-in token cannot turn persisted records into public temporary records',async()=>{
  let credential='token';const store=createMeasurementStore({token:()=>credential,fetcher:async()=>response({...record,revision:1})});
  await store.save(record);credential=null;
  await assert.rejects(store.save({...store.records.get(record.id),name:'Lost token'}),/access changed/);
  assert.equal(store.records.size,0);await assert.rejects(store.load(),/access changed/);assert.equal(store.isInvalidated(),true);
});
test('late delete completion cannot remove replacement identity record',async()=>{
  const wait=deferred(),started=deferred();let credential='first';
  const store=createMeasurementStore({token:()=>credential,fetcher:async(_url,options)=>{
    if(options.method==='DELETE'){started.resolve();await wait.promise;return{ok:true,status:204};}
    if(options.method==='GET')return{ok:true,status:200,json:async()=>({measurements:[{...record,name:'Second identity',revision:2}],capabilities:{personalPersistence:true}})};
    return response({...record,revision:1});
  }});
  await store.save(record);const removing=store.remove(record.id),rejected=assert.rejects(removing);await started.promise;
  store.invalidate();credential='second';await store.load();wait.resolve();await rejected;
  assert.equal(store.records.get(record.id).name,'Second identity');assert.equal(store.statuses.get(record.id),'Saved');
});
