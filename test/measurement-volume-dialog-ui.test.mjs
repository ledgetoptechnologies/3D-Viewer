import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {measurementValue} from '../measurement-document.mjs';
import {buildSampledCrossSection,nearestSectionSample,initialSectionOffsetPercent} from '../measurement-cross-section.mjs';

const source=readFileSync(new URL('../measurement-volume-dialog.mjs',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(calculate,{autoCalculate=false,record={name:'Pile A'}}={}){
  const nodes=new Map();let disposed=0,saved=0;
  const element=()=>({dataset:{},hidden:false,disabled:false,value:'0',checked:false,textContent:'',width:850,height:380,attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},getContext:()=>new Proxy({},{get:()=>()=>{},set:()=>true})});
  const dialog={...element(),querySelector(s){if(!nodes.has(s)){const node=element();if(s==='[name=sectionWidth]')node.value='10';nodes.set(s,node);}return nodes.get(s);},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},remove(){this.removed=true;}};
  const scope=vm.createContext({document:{createElement:()=>dialog,body:{append(){}}},AbortController,measurementValue,buildSampledCrossSection,nearestSectionSample,initialSectionOffsetPercent,mountMeasurementRegionPreview:()=>({dispose(){disposed++;}})});
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function openSurfaceDialog','function openSurfaceDialog'),scope);
  const handle=scope.openSurfaceDialog({record,units:'metric',calculate,save:async()=>{saved++;},autoCalculate});
  if(!record.results){dialog.querySelector('[name=reference]').value='boundary-triangulated';dialog.querySelector('[name=source]').value='dsm';}
  return{dialog,handle,saved:()=>saved,disposed:()=>disposed,calculate:()=>dialog.querySelector('[data-calculate]').onclick()};
}
const result={status:'calculated',cutM3:12345.678912,fillM3:0,netM3:12345.678912,coverage:1,preview:{samples:[[0,0,2,0],[1,1,2,0]]}};

test('surface dialog explains initial empty state and centers responsively without showing a blank preview',()=>{
  const f=fixture(()=>result);assert.match(f.dialog.innerHTML,/No volume has been calculated yet/);assert.match(f.dialog.innerHTML,/data-preview-content hidden/);assert.match(f.dialog.innerHTML,/Confirm meters only if you have verified/);
  const css=readFileSync(new URL('../measurement-workspace.css',import.meta.url),'utf8');assert.match(css,/position:fixed;inset:0;margin:auto/);assert.match(css,/max-height:calc\(100dvh - 24px\)/);f.handle.close();
});

test('calculation disables duplicate submission, then shows grouped quantities and valid preview',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.calculate();assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'loading');assert.equal(f.dialog.querySelector('[data-calculate]').disabled,true);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);
  wait.resolve(result);await pending;assert.equal(f.saved(),1);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'success');assert.match(f.dialog.querySelector('[data-status]').textContent,/12,345\.679 m³/);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,false);assert.equal(f.dialog.querySelector('[data-calculate]').disabled,false);
  assert.equal(f.disposed(),0);const disclosure=f.dialog.querySelector('.region-disclosure');disclosure.open=true;disclosure.ontoggle();f.handle.close();assert.equal(f.disposed(),1);
});

test('source rejection clears an earlier preview and never presents a stale result as the new volume',async()=>{
  let calls=0;const f=fixture(async()=>{if(calls++)throw new Error('Source vertical units required.');return result;});await f.calculate();const disclosure=f.dialog.querySelector('.region-disclosure');disclosure.open=true;disclosure.ontoggle();await f.calculate();
  assert.equal(f.saved(),1);assert.equal(f.disposed(),1);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'error');assert.match(f.dialog.querySelector('[data-status]').textContent,/No new volume was saved.*Source vertical units required/);assert.match(f.dialog.querySelector('[data-preview-empty]').textContent,/Preview unavailable/);f.handle.close();
});

test('automatic calculation preserves unchecked unit confirmation and surfaces required metadata',async()=>{
  let settings;const f=fixture(async(_record,options)=>{settings=options;throw new Error('Source vertical units required.');},{autoCalculate:true});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settings.confirmMeters,false);assert.equal(f.saved(),0);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'error');assert.equal(f.dialog.querySelector('.surface-settings').open,true);f.handle.close();
});

test('sample corridor stays explicit and keyboard inspection reports observed sample and base',async()=>{
  const f=fixture(async()=>({...result,preview:{samples:[[0,0,2,0],[1,0,3,0],[2,0,4,0]]}}));await f.calculate();
  assert.match(f.dialog.querySelector('[data-provenance]').textContent,/Points are not joined/);const chart=f.dialog.querySelector('[data-section-chart]');chart.onkeydown({key:'Home',preventDefault(){}});assert.match(f.dialog.querySelector('[data-readout]').textContent,/Surface 2\.000 m.*Base 0\.000 m/);chart.onkeydown({key:'End',preventDefault(){}});assert.match(f.dialog.querySelector('[data-readout]').textContent,/Surface 4\.000 m/);f.handle.close();
});

test('closing during calculation aborts and cannot save or show a delayed private result',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.calculate();f.handle.close();wait.resolve(result);await pending;assert.equal(f.saved(),0);assert.equal(f.dialog.removed,true);
});

test('changing calculation settings aborts pending work and never displays a stale preview',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.calculate();f.dialog.querySelector('[name=source]').onchange();wait.resolve(result);await pending;assert.equal(f.saved(),0);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'idle');assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);assert.match(f.dialog.querySelector('[data-preview-empty]').textContent,/Settings changed/);f.handle.close();
});

test('auto mode starts exactly once and closing aborts the guarded attempt',async()=>{
  const wait=deferred();let calls=0,signal;const f=fixture((_record,options)=>{calls++;signal=options.signal;return wait.promise;},{autoCalculate:true});assert.equal(calls,1);f.handle.close();assert.equal(signal.aborted,true);wait.resolve(result);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(f.saved(),0);
});

test('queued native close event cannot leave a window to save a completed calculation',async()=>{
  for(const action of ['handle','button','escape']){
    const wait=deferred(),f=fixture(()=>wait.promise);let queued;
    f.dialog.close=function(){this.open=false;queued=()=>this.onclose?.();};
    const pending=f.calculate();
    if(action==='handle')f.handle.close();
    else if(action==='button')f.dialog.querySelector('[data-close]').onclick();
    else {f.dialog.oncancel();f.dialog.close();}
    assert.equal(f.dialog.removed,undefined);
    wait.resolve(result);await pending;
    assert.equal(f.saved(),0,`${action}: no save while native close is queued`);
    queued();assert.equal(f.dialog.removed,true);queued();
  }
});

test('reopening an existing surface result shows saved totals honestly without another calculation or fake preview',()=>{
  let calculated=0;const saved={...result,preview:undefined,reference:{type:'custom',elevationM:100,offsetM:.5},sourceKind:'dtm',warnings:['Missing cells remain excluded.']};
  const f=fixture(()=>{calculated++;return result;},{record:{name:'Saved pile',results:saved}});
  assert.equal(calculated,0);assert.equal(f.saved(),0);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'saved');assert.match(f.dialog.querySelector('[data-status]').textContent,/Previously saved.*not been recalculated/);assert.match(f.dialog.querySelector('[data-status]').textContent,/Missing cells/);
  assert.equal(f.dialog.querySelector('[data-results]').hidden,false);assert.equal(f.dialog.querySelector('[data-result=cut]').textContent,'12,345.679 m³');assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);assert.match(f.dialog.querySelector('[data-preview-empty]').textContent,/Recalculate to rebuild the preview/);
  assert.equal(f.dialog.querySelector('[name=reference]').value,'custom');assert.equal(f.dialog.querySelector('[name=elevation]').value,'100');assert.equal(f.dialog.querySelector('[name=offset]').value,'0.5');assert.equal(f.dialog.querySelector('[name=source]').value,'dtm');assert.equal(f.dialog.querySelector('[name=metres]').checked,false);
  f.handle.close();
});

test('saved incomplete or object calculations are not presented as a new complete surface calculation',()=>{
  const partial=fixture(()=>result,{record:{name:'Incomplete',results:{cutM3:2,coverage:.5,status:'incomplete'}}});
  assert.equal(partial.dialog.querySelector('[data-result=fill]').textContent,'Unavailable');assert.equal(partial.dialog.querySelector('[data-result=coverage]').textContent,'50.000%');assert.match(partial.dialog.querySelector('[data-status]').textContent,/Previously saved incomplete/);partial.handle.close();
  const object=fixture(()=>result,{record:{name:'Object',results:{volumeM3:3,status:'estimate'}}});assert.match(object.dialog.querySelector('[data-status]').textContent,/Previously saved object volume.*different calculation/);object.handle.close();
});
