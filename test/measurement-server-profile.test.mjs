import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServerProfileCalculator} from '../measurement-server-profile.mjs';
import {measurementGeometryHash} from '../measurement-surface-client.mjs';
const source={assetId:'dsm',kind:'dsm',modelVersionId:'version',sha256:'a'.repeat(64),verticalUnit:'m',verticalUnitBasis:'raster-metadata',crs:'EPSG:32616',resolutionM:[1,1]};
const line={start:[0,0],end:[1,0]},baseHash='b'.repeat(64);
const record={id:'polygon',revision:3,modelVersionId:'version',collection:'map',kind:'polygon',vertices:[[0,0,0],[1,0,0],[0,1,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},results:{method:'surface-cut-fill',calculationJobId:'parent'}};
const parent={id:'parent',measurementId:'polygon',revision:2,attachmentRevision:3,status:'complete',result:{method:'surface-cut-fill',source}};
const result={method:'surface-transect',sampling:'native-cell-step',parentCalculationId:'parent',baseHash,source,line,lengthM:1,cellCount:1,segments:[{startM:0,endM:1,start:[0,0],end:[1,0],status:'sample',surfaceM:2,baseStartM:0,baseEndM:0,cell:[0,0]}]};
const parameters={revision:3,method:'surface-transect',parentCalculationId:'parent',line,baseHash};
const job=(status='complete',patch={})=>({id:'profile',measurementId:'polygon',revision:3,parameters,status,result,...patch});
function setup({caps={capabilities:{transectCalculations:true}},parentJob=parent,existing=[],responses=[],getRecord=()=>record,isCurrent=()=>true,wait=async()=>{}}={}){
  const calls=[],request=async(op,payload)=>{calls.push([op,payload]);if(op==='capabilities')return caps;if(op==='status'&&payload.jobId==='parent')return{calculation:parentJob};if(op==='list')return{calculations:existing};return{calculation:responses.shift()||job()};};
  return{calls,calculate:createServerProfileCalculator({request,getRecord,isCurrent,wait})};
}

test('profile controls describe the client action without infrastructure labels',()=>{
  const panel=readFileSync(new URL('../measurement-profile-panel.mjs',import.meta.url),'utf8');
  assert.match(panel,/<button data-update>Update profile<\/button>/);
  assert.doesNotMatch(panel,/\bserver\b/i);
});
test('native profile uses linked parent only, recovers active jobs, and never writes measurement results',async()=>{
  for(const existing of [[],[job('running')],[job()]]){
    const f=setup({existing,responses:existing.length?[]:[job('queued'),job('running'),job()]}),before=JSON.stringify(record),progress=[];const out=await f.calculate(record,{line,onProgress:value=>progress.push(value)});assert.equal(out.calculationJobId,'profile');assert.equal(JSON.stringify(record),before);
    assert.doesNotMatch(progress.join(' '),/\bserver\b/i);
    assert.equal(f.calls.filter(([op])=>op==='create').length,existing.length?0:1);assert.ok(f.calls.every(([op])=>['capabilities','status','list','create'].includes(op)));
    if(!existing.length)assert.deepEqual(f.calls.find(([op])=>op==='create')[1].request,{revision:3,method:'surface-transect',parentCalculationId:'parent',line});
  }
});
test('no native capability, stale parent revision/source or changed attachment never enqueue work',async()=>{
  const variants=[{caps:{capabilities:{rasterCalculations:true}}},{parentJob:{...parent,attachmentRevision:1}},{parentJob:{...parent,measurementId:'other'}},{parentJob:{...parent,result:{...parent.result,source:{...source,modelVersionId:'old'}}}}];
  for(const options of variants){const f=setup(options);await assert.rejects(f.calculate(record,{line}));assert.equal(f.calls.some(([op])=>op==='create'),false);}
});
test('different active profile or volume exposes cancel without duplicate calculation',async()=>{
  const f=setup({existing:[job('running',{parameters:{...parameters,line:{start:[0,0],end:[2,0]}}})]});let pending;
  await assert.rejects(f.calculate(record,{line,onJob:j=>{pending=j;}}),/Another calculation/);await pending.cancel();assert.equal(f.calls.at(-1)[0],'cancel');assert.equal(f.calls.some(([op])=>op==='create'),false);
});
test('stale geometry, revoked view and abort fence late profile completion',async()=>{
  for(const action of ['edit','revoke','abort']){let current=true,snapshot=structuredClone(record);const abort=new AbortController();const f=setup({responses:[job('queued')],getRecord:()=>snapshot,isCurrent:()=>current,wait:async()=>{if(action==='edit')snapshot.vertices[0][0]=.1;else if(action==='revoke')current=false;else abort.abort();}});await assert.rejects(f.calculate(record,{line,signal:abort.signal}));assert.equal(f.calls.filter(([op,p])=>op==='status'&&p.jobId==='profile').length,0);}
});
test('wrong profile request, source hash, parent, base or line are never delivered',async()=>{
  for(const patch of [{parameters:{...parameters,parentCalculationId:'wrong'}},{result:{...result,source:{...source,sha256:'c'.repeat(64)}}},{result:{...result,parentCalculationId:'wrong'}},{result:{...result,baseHash:'c'.repeat(64)}},{result:{...result,line:{start:[1,0],end:[2,0]}}}]){const f=setup({responses:[job('complete',patch)]});await assert.rejects(f.calculate(record,{line}));}
});
test('temporary profile binds public page geometry and revision one without persistence',async()=>{
  const temporary={...record,revision:undefined,modelVersionId:undefined},geometryHash=await measurementGeometryHash(temporary),caps={modelVersionId:'version',capabilities:{transectCalculations:true,temporaryCalculations:true}},parentJob={...parent,revision:1,geometryHash};
  const response=job('complete',{revision:1,geometryHash,parameters:{...parameters,revision:1}}),f=setup({caps,parentJob,responses:[response],getRecord:()=>temporary});await f.calculate(temporary,{line});assert.equal(f.calls.find(([op])=>op==='create')[1].request.revision,1);
  const wrong=setup({caps,parentJob:{...parentJob,geometryHash:'other'},getRecord:()=>temporary});await assert.rejects(wrong.calculate(temporary,{line}));assert.equal(wrong.calls.some(([op])=>op==='create'),false);
});
