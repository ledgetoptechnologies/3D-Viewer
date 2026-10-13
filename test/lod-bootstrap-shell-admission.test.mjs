import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { TilesRenderer } from '3d-tiles-renderer';
import { LOADED, UNLOADED, QUEUED, FAILED } from '3d-tiles-renderer/src/core/renderer/constants.js';
import { runTraversal } from '3d-tiles-renderer/src/core/renderer/tiles/traverseFunctions.js';
import { installLodLoadingBudget } from '../lod-loading-budget.mjs';
import { lodBootstrapRootErrorTarget, lodBootstrapCoverageErrorTarget, lodFallbackShellPlan,
  retainLodOverviewTiles, LOD_PREFETCH_MAX_DEPTH } from '../lod-policy.mjs';

const main=fs.readFileSync(new URL('../main.js',import.meta.url),'utf8');
function source(name,next){const a=main.indexOf(`function ${name}(`),b=main.indexOf(`\nfunction ${next}(`,a);assert.ok(a>=0&&b>a);return main.slice(a,b);}
const demand=source('installLodBootstrapShellDemand','captureLodPrefetchShell');
const coordinator=source('maybeAdvanceLodBootstrap','maybeAdvanceLodWarmup');
function tile(depth,loaded=false){return {children:[],parent:null,refine:'REPLACE',geometricError:depth?0:1,
  content:{uri:depth?'shell.glb':'root.glb'},traversal:{lastFrameVisited:-1},engineData:loaded?{scene:{}}:{},
  internal:{depth,loadingState:loaded?LOADED:UNLOADED,hasContent:true,hasRenderableContent:true,
    hasUnrenderableContent:false,virtualChildCount:0}};}
function fixture({rootSse=130,offscreen=false,full=false,children=1,shellBudget=1024}={}){
  const root=tile(0,true),shell=Array.from({length:children},()=>tile(1));root.children=shell;
  for(const child of shell)child.parent=root;
  const used=new Set(),cached=new Set([root]),jobs=[],removed=[];
  let clock=0,prepareCount=0,promotions=0,rootOnly=0;
  const cache={maxBytesSize:1024*1024*1024,cachedBytes:0,isFull:()=>full,
    has:t=>cached.has(t),isUsed:t=>used.has(t),markUsed:t=>used.add(t),
    remove(t){removed.push(t);cached.delete(t);renderer.loadingTiles.delete(t);t.internal.loadingState=UNLOADED;}};
  const renderer={root,maxDepth:2,errorTarget:4096,frameCount:0,loadAncestors:false,loadSiblings:false,
    displayActiveTiles:false,group:{children:[root.engineData.scene]},stats:{used:0,inFrustum:0,active:0,visible:0},
    lruCache:cache,queuedTiles:[],loadingTiles:new Set(),downloadQueue:{maxJobs:1},parseQueue:{maxJobs:1},
    prepareForTraversal(){prepareCount++;},ensureChildrenArePreprocessed(){},getBytesUsed:()=>1,
    markTileUsed:TilesRenderer.prototype.markTileUsed,usedSet:used,
    queueTileForDownload:TilesRenderer.prototype.queueTileForDownload,
    removeUnusedPendingTiles:TilesRenderer.prototype.removeUnusedPendingTiles,
    calculateTileViewErrorWithPlugin(t,out){out.inView=t===root||!offscreen;out.error=t===root?rootSse:0;out.distanceFromCamera=10;},
    invokeOnePlugin(cb){cb({setTileActive(){},setTileVisible(){},setEmptyTileVisible(){}});},
    requestTileContents(t){if(t.internal.loadingState!==UNLOADED)return;
      t.internal.loadingState=QUEUED;cached.add(t);renderer.loadingTiles.add(t);
      return new Promise((resolve,reject)=>jobs.push({tile:t,resolve,reject}));},dispatchEvent(){}};
  const loading=installLodLoadingBudget(renderer,{maxInFlight:1,maxReservedBytes:128});
  const ctx={tilesRenderer:renderer,lodRuntimeProfileState:{reduced:false},lodBootstrapPhase:'root',
    lodBootstrapRootTarget:4096,lodBootstrapCoverageTarget:1024,lodPrefetchStartedAt:0,lodPrefetchReadyFrames:0,
    lodPrefetchSoftBudgetReported:false,lodPrefetchExitReason:null,state:{},dom:{lodStatus:{}},
    performance:{now:()=>clock},LOD_PREFETCH_MAX_DEPTH,LOD_PREFETCH_MAX_MS:3000,LOD_FALLBACK_MIN_DETAIL_BYTES:0,
    lodBootstrapRootErrorTarget,lodBootstrapCoverageErrorTarget,retainLodOverviewTiles,
    lodTileSceneAttached:t=>renderer.group.children.includes(t.engineData.scene),
    captureLodPrefetchShell:t=>lodFallbackShellPlan(t,{isReady:x=>Boolean(x.engineData.scene),getBytes:()=>1,maxBytes:shellBudget}),
    lodShellRetentionMaxBytes:()=>1024,lodShellBudgetBytes:()=>1024,emitLodDebugSnapshot(){},
    enterLodRootOnly(){rootOnly++;ctx.lodBootstrapPhase='root-only';},
    finishLodPrefetch(){promotions++;ctx.lodBootstrapPhase='complete';},lodRecentFrontier:new Map(),recoverLodCacheAdmission(){}};
  const originalPrepare=renderer.prepareForTraversal;
  vm.createContext(ctx);vm.runInContext(demand+'\n'+coordinator,ctx);const restore=ctx.installLodBootstrapShellDemand(renderer);
  function frame(){clock+=1000;renderer.frameCount++;used.clear();renderer.prepareForTraversal();
    runTraversal(root,renderer);renderer.removeUnusedPendingTiles();
    for(const t of renderer.queuedTiles)if(!cache.isFull())renderer.requestTileContents(t);
    renderer.queuedTiles.length=0;ctx.maybeAdvanceLodBootstrap();}
  return {root,shell,renderer,ctx,jobs,removed,loading,frame,restore,originalPrepare,setSse:v=>{rootSse=v;},setFull:v=>{full=v;},
    get promotions(){return promotions;},get rootOnly(){return rootOnly;},get prepareCount(){return prepareCount;}};
}

test('camera widening cannot strand a cold direct shell behind frozen bootstrap SSE',()=>{
  const f=fixture();f.frame();assert.equal(f.ctx.lodBootstrapCoverageTarget,65);
  f.setSse(40);f.frame();assert.equal(f.jobs.length,1);assert.equal(f.jobs[0].tile,f.shell[0]);
  assert.equal(f.promotions,0,'cold shell cannot promote');assert.equal(f.renderer.maxDepth,LOD_PREFETCH_MAX_DEPTH);
  assert.equal(f.prepareCount,2,'original renderer preparation is preserved');f.loading.dispose();
});
test('tiny root SSE and off-frustum shell use structural demand without attaching or descending',()=>{
  const f=fixture({rootSse:.4,offscreen:true});f.frame();f.frame();
  assert.equal(f.jobs.length,1);assert.equal(f.shell[0].traversal.inFrustum,false);
  f.frame();assert.equal(f.removed.length,0,'queued offscreen shell stays used across renderer reset');
  assert.equal(f.promotions,0);assert.equal(f.renderer.group.children.length,1);f.loading.dispose();
});
test('cache refusal retries; loading reservation admits one shell at a time; complete shell promotes only after two frames',async()=>{
  const f=fixture({full:true,children:2,offscreen:true});f.frame();f.frame();assert.equal(f.jobs.length,0);
  f.setFull(false);f.frame();assert.equal(f.jobs.length,1);assert.equal(f.loading.snapshot().inFlight,1);
  f.shell[0].engineData.scene={};f.shell[0].internal.loadingState=LOADED;f.jobs[0].resolve();await Promise.resolve();
  f.frame();assert.equal(f.jobs.length,2);assert.equal(f.promotions,0);
  f.shell[1].engineData.scene={};f.shell[1].internal.loadingState=LOADED;f.jobs[1].resolve();await Promise.resolve();
  f.frame();assert.equal(f.promotions,0);f.frame();assert.equal(f.promotions,1);f.loading.dispose();
});
test('failed or unsupported shell is not silently promoted or recursively downloaded',async()=>{
  const f=fixture();f.frame();f.frame();f.shell[0].internal.loadingState=FAILED;
  f.jobs[0].reject(new Error('controlled fetch failure'));await Promise.resolve();
  for(let i=0;i<5;i++)f.frame();assert.equal(f.promotions,0);assert.equal(f.jobs.length,1);
  assert.equal(f.loading.snapshot().inFlight,0);f.loading.dispose();
  const g=fixture();g.frame();g.setSse(40);g.shell[0].internal.hasUnrenderableContent=true;g.frame();
  assert.equal(g.jobs.length,0);assert.equal(g.rootOnly,1);g.loading.dispose();
});
test('shell hook restores its preparation method without replacing a later owner',()=>{
  const f=fixture();assert.equal(f.restore(),true);assert.equal(f.renderer.prepareForTraversal,f.originalPrepare);
  assert.equal(f.restore(),false);f.loading.dispose();
  const g=fixture(),later=()=>{};g.renderer.prepareForTraversal=later;g.restore();
  assert.equal(g.renderer.prepareForTraversal,later);g.loading.dispose();
});
test('over-budget shell is refused and explicit scheduling never descends below direct children',()=>{
  const f=fixture({shellBudget:0});f.frame();f.setSse(40);f.frame();
  assert.equal(f.jobs.length,0);assert.equal(f.rootOnly,1);f.loading.dispose();
  const g=fixture({offscreen:true}),grandchild=tile(2);g.shell[0].children=[grandchild];grandchild.parent=g.shell[0];
  g.frame();g.frame();assert.equal(g.jobs.length,1);assert.equal(g.jobs[0].tile,g.shell[0]);
  assert.equal(grandchild.internal.loadingState,UNLOADED);g.loading.dispose();
});
