import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {measurementMetrics,validateMeasurementGeometry} from '../measurement-document.mjs';
import {createServerProfileCalculator} from '../measurement-server-profile.mjs';

const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const shipped=source.slice(source.indexOf('  function showSurface('),source.indexOf('  function setTool('));
function fixture({kind='polygon',saveWait=Promise.resolve(),attachmentWait=Promise.resolve(),saveError=null,adminAllowed=false,specialistAllowed=false,serverError=null,preferServer=false}={}){
  const record={id:'auto-volume-fixture',name:'Test boundary',kind,collection:'spatial3d',vertices:kind==='polygon'?[[0,0,0],[10,0,0],[10,10,0],[0,10,0]]:[[0,0,0],[10,0,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
  const opened=[],messages=[],records=new Map(),attachments=[],serverCalls=[],specialistOpened=[];
  const scope=vm.createContext({draft:record,selected:null,units:'metric',savedUnits:{metric:'m'},viewGeneration:0,dialogGeneration:0,disposed:false,permitted:true,mode:'model',activeDialog:null,structuredClone,
    measurementMetrics,validateMeasurementGeometry,createServerProfileCalculator,
    adminAllowed,specialistAllowed,surfaceRequest:undefined,preferServerSurface:()=>preferServer,adminRequest:async()=>({}),createServerSurfaceCalculator:options=>async(...args)=>{serverCalls.push({options,args,snapshot:options.getRecord()});if(serverError)throw serverError;return{cutM3:20,fillM3:0,calculationJobId:'server-job'};},
    openAdminCalculationDialog:async options=>{if(!options.isCurrent())throw new Error('Measurement access changed.');specialistOpened.push(options);return{close(){}};},
    store:{records,persistent:()=>false,async save(r){await saveWait;if(saveError)throw saveError;records.set(r.id,{...structuredClone(r),revision:1});},async attachResults(r,results){attachments.push({r,results});await attachmentWait;records.set(r.id,{...structuredClone(r),results,revision:r.revision+1});}},
    openSurfaceDialog:options=>{opened.push(options);return{close(){}};},
    calculateSurface:async()=>({cutM3:10,fillM3:0}),
    tell:text=>messages.push(text)});
  vm.runInContext('function allowed(){return permitted;} function context(){return {mode};} function draftRecord(){return structuredClone(draft);} function disarm(){draft=null;} function closeDialogs(){dialogGeneration++;activeDialog?.close();activeDialog=null;}'+shipped,scope);
  return{scope,opened,messages,records,attachments,serverCalls,specialistOpened,finish:(options={openVolume:true})=>scope.finish(options)};
}

test('one inspector exposes specialist methods only with verified staff and registered-method capability',async()=>{
  for(const [adminAllowed,specialistAllowed]of [[false,false],[false,true],[true,false],[true,true]]){
    const f=fixture({adminAllowed,specialistAllowed});await f.finish();
    assert.equal(typeof f.opened[0].openSpecialist==='function',adminAllowed&&specialistAllowed);
    assert.equal(f.specialistOpened.length,0,'auto-on-finish never opens specialist methods');
  }
  assert.doesNotMatch(source,/data-m="admin-volume"/);assert.match(source,/data-m="volume">Calculate volume<\/button>/);
});

test('surface and specialist attachments share the freshest saved revision in either direction',async()=>{
  const f=fixture({adminAllowed:true,specialistAllowed:true});await f.finish();const inspector=f.opened[0];
  await inspector.save({...inspector.record,results:{cutM3:1}});
  await inspector.openSpecialist({host:{},isCurrent:()=>true});const specialist=f.specialistOpened[0];
  assert.equal(specialist.record.revision,2);
  await specialist.onResult({calculation:{id:'mesh-job',result:{method:'closed-mesh',volumeM3:2}}});
  await inspector.calculate(inspector.record,{});assert.equal(f.serverCalls[0].snapshot.revision,3);
  assert.equal(inspector.getRecord().results.calculationJobId,'mesh-job');
});

test('closed specialist panel or revoked view cannot attach a late specialist result',async()=>{
  for(const revoke of ['panel','view','staff']){
    const f=fixture({adminAllowed:true,specialistAllowed:true});await f.finish();let panel=true;
    await f.opened[0].openSpecialist({host:{},isCurrent:()=>panel});
    if(revoke==='panel')panel=false;else if(revoke==='view')f.scope.viewGeneration++;else f.scope.adminAllowed=false;
    await assert.rejects(f.specialistOpened[0].onResult({calculation:{id:'late',result:{volumeM3:8}}}),/access changed/);
    assert.equal(f.attachments.length,0);
  }
});

test('specialist attachment finishing after collapse updates parent revision before native calculation resumes',async()=>{
  let release;const f=fixture({adminAllowed:true,specialistAllowed:true,attachmentWait:new Promise(resolve=>{release=resolve;})});await f.finish();let panel=true;
  const inspector=f.opened[0];await inspector.openSpecialist({host:{},isCurrent:()=>panel});
  const attachment=f.specialistOpened[0].onResult({calculation:{id:'mesh-job',result:{method:'closed-mesh',volumeM3:2}}});
  const rejected=assert.rejects(attachment,/access changed/);panel=false;
  const resumed=inspector.calculate(inspector.record,{});assert.equal(f.serverCalls.length,0,'native calculation waits for outstanding attachment');
  release();await rejected;await resumed;
  assert.equal(inspector.getRecord().revision,2);assert.equal(f.serverCalls[0].snapshot.revision,2);
});

test('authorized staff use the server calculator in the normal polygon inspector',async()=>{
  const f=fixture({adminAllowed:true});await f.finish();const dialog=f.opened[0];
  assert.equal(dialog.execution,'server');assert.equal(dialog.autoCalculate,false);
  const result=await dialog.calculate(dialog.record,{});
  assert.equal(result.calculationJobId,'server-job');assert.equal(f.serverCalls.length,1);
  assert.equal(f.serverCalls[0].snapshot.id,dialog.record.id);
});

test('isolated fixture may inject browser calculation, but a selected server never falls back',async()=>{
  const ordinary=fixture();await ordinary.finish();assert.equal(ordinary.opened[0].execution,'browser');
  await ordinary.opened[0].calculate(ordinary.opened[0].record,{});assert.equal(ordinary.serverCalls.length,0);
  const staff=fixture({adminAllowed:true,serverError:new Error('Server units unavailable')});await staff.finish();
  await assert.rejects(staff.opened[0].calculate(staff.opened[0].record,{}),/Server units unavailable/);
});

test('staff intent cannot silently fall back while capabilities are pending or failed',async()=>{
  const f=fixture({preferServer:true,adminAllowed:false,serverError:new Error('Server permission unavailable')});await f.finish();
  assert.equal(f.opened[0].execution,'server');
  await assert.rejects(f.opened[0].calculate(f.opened[0].record,{}),/Server permission unavailable/);
});

test('client personal surface transport uses server without advanced staff capability',async()=>{
  const f=fixture();f.scope.surfaceRequest=async()=>({});await f.finish();
  assert.equal(f.opened[0].execution,'server');await f.opened[0].calculate(f.opened[0].record,{});
  assert.equal(f.serverCalls[0].options.request,f.scope.surfaceRequest);
});
test('explicit inspector request saves geometry first without automatically calculating',async()=>{
  const f=fixture();await f.finish();assert.equal(f.records.size,1);assert.equal(f.opened.length,1);assert.equal(f.opened[0].autoCalculate,false);
  assert.equal(f.opened[0].record.results.status,'geometry-only');assert.equal(f.opened[0].record.results.horizontalAreaM2,100);
  await f.finish();assert.equal(f.opened.length,1);
});
test('default polygon finish saves area immediately without opening or starting volume',async()=>{
  const f=fixture();await f.scope.finish();
  assert.equal(f.records.size,1);assert.equal(f.opened.length,0);assert.equal(f.serverCalls.length,0);
  assert.equal(f.records.values().next().value.results.horizontalAreaM2,100);
  assert.equal(f.records.values().next().value.results.status,'geometry-only');
});

test('distance and mode-switch completion never open automatic volume',async()=>{
  for(const f of [fixture({kind:'distance'}),fixture()]){await f.finish({openVolume:false});assert.equal(f.records.size,1);assert.equal(f.opened.length,0);}
  const distance=fixture({kind:'distance'});await distance.finish();assert.equal(distance.opened.length,0);
});
test('failed geometry save never calculates or claims the polygon was saved',async()=>{
  const f=fixture({saveError:new Error('Save conflict')});await f.finish();assert.equal(f.opened.length,0);assert.equal(f.records.size,0);assert.deepEqual(f.messages,['Save conflict']);
});
test('late geometry save cannot open a dialog after view, permission, intent or lifecycle changes',async()=>{
  for(const change of [s=>s.viewGeneration++,s=>s.dialogGeneration++,s=>s.permitted=false,s=>s.disposed=true,s=>s.mode='ortho',s=>s.selected='different',s=>s.draft={}]){
    let release;const f=fixture({saveWait:new Promise(resolve=>{release=resolve;})});const pending=f.finish();change(f.scope);release();await pending;assert.equal(f.opened.length,0);
  }
});
test('access loss before finish does not save geometry',async()=>{
  const f=fixture();f.scope.permitted=false;await f.finish();assert.equal(f.records.size,0);assert.equal(f.opened.length,0);
});
test('dialog callbacks are fenced against closing, view switches and revoked access',async()=>{
  for(const change of [s=>s.viewGeneration++,s=>s.dialogGeneration++,s=>s.permitted=false,s=>s.disposed=true]){
    const f=fixture();await f.finish();const dialog=f.opened[0];change(f.scope);
    await assert.rejects(dialog.calculate(dialog.record,{}),/access or view changed/);
    await assert.rejects(dialog.save({...dialog.record,results:{cutM3:1}}),/access or view changed/);
    assert.equal(f.attachments.length,0);
  }
});
