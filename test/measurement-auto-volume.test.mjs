import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {measurementMetrics,validateMeasurementGeometry} from '../measurement-document.mjs';

const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const shipped=source.slice(source.indexOf('  function showSurface('),source.indexOf('  function setTool('));
function fixture({kind='polygon',saveWait=Promise.resolve(),saveError=null}={}){
  const record={id:'auto-volume-fixture',name:'Test boundary',kind,collection:'spatial3d',vertices:kind==='polygon'?[[0,0,0],[10,0,0],[10,10,0],[0,10,0]]:[[0,0,0],[10,0,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
  const opened=[],messages=[],records=new Map(),attachments=[];
  const scope=vm.createContext({draft:record,selected:null,units:'metric',savedUnits:{metric:'m'},viewGeneration:0,dialogGeneration:0,disposed:false,permitted:true,mode:'model',activeDialog:null,structuredClone,
    measurementMetrics,validateMeasurementGeometry,
    store:{records,persistent:()=>false,async save(r){await saveWait;if(saveError)throw saveError;records.set(r.id,structuredClone(r));},async attachResults(r,results){attachments.push({r,results});}},
    openSurfaceDialog:options=>{opened.push(options);return{close(){}};},
    calculateSurface:async()=>({cutM3:10,fillM3:0}),
    tell:text=>messages.push(text)});
  vm.runInContext('function allowed(){return permitted;} function context(){return {mode};} function draftRecord(){return structuredClone(draft);} function disarm(){draft=null;} function closeDialogs(){dialogGeneration++;activeDialog?.close();activeDialog=null;}'+shipped,scope);
  return{scope,opened,messages,records,attachments,finish:options=>scope.finish(options)};
}
test('finishing a polygon saves geometry first and opens automatic local surface calculation once',async()=>{
  const f=fixture();await f.finish();assert.equal(f.records.size,1);assert.equal(f.opened.length,1);assert.equal(f.opened[0].autoCalculate,true);
  assert.equal(f.opened[0].record.results.status,'geometry-only');assert.equal(f.opened[0].record.results.horizontalAreaM2,100);
  await f.finish();assert.equal(f.opened.length,1);
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
