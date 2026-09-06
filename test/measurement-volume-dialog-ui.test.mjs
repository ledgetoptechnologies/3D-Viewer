import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {measurementValue} from '../measurement-document.mjs';

const source=readFileSync(new URL('../measurement-volume-dialog.mjs',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(calculate){
  const nodes=new Map();let disposed=0,saved=0;
  const element=()=>({dataset:{},hidden:false,disabled:false,value:'0',checked:false,textContent:'',width:850,height:380,attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},getContext:()=>new Proxy({},{get:()=>()=>{},set:()=>true})});
  const dialog={...element(),querySelector(s){if(!nodes.has(s))nodes.set(s,element());return nodes.get(s);},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},remove(){this.removed=true;}};
  const scope=vm.createContext({document:{createElement:()=>dialog,body:{append(){}}},AbortController,measurementValue,mountMeasurementRegionPreview:()=>({dispose(){disposed++;}})});
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function openSurfaceDialog','function openSurfaceDialog'),scope);
  const handle=scope.openSurfaceDialog({record:{name:'Pile A'},units:'metric',calculate,save:async()=>{saved++;}});
  dialog.querySelector('[name=reference]').value='boundary-triangulated';dialog.querySelector('[name=source]').value='dsm';
  return{dialog,handle,saved:()=>saved,disposed:()=>disposed,calculate:()=>dialog.querySelector('[data-calculate]').onclick()};
}
const result={status:'calculated',cutM3:12345.678912,fillM3:0,netM3:12345.678912,coverage:1,preview:{samples:[[0,0,2,0],[1,1,2,0]]}};

test('surface dialog explains initial empty state and centers responsively without showing a blank preview',()=>{
  const f=fixture(()=>result);assert.match(f.dialog.innerHTML,/No volume has been calculated yet/);assert.match(f.dialog.innerHTML,/data-preview-content hidden/);assert.match(f.dialog.innerHTML,/Confirm meters only if you have verified/);
  const css=readFileSync(new URL('../measurement-workspace.css',import.meta.url),'utf8');assert.match(css,/position:fixed;inset:0;margin:auto/);assert.match(css,/max-height:calc\(100dvh - 24px\)/);f.handle.close();
});

test('calculation disables duplicate submission, then shows grouped quantities and valid preview',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.calculate();assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'loading');assert.equal(f.dialog.querySelector('[data-calculate]').disabled,true);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);
  wait.resolve(result);await pending;assert.equal(f.saved(),1);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'success');assert.match(f.dialog.querySelector('[data-status]').textContent,/12,345\.679 m³/);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,false);assert.equal(f.dialog.querySelector('[data-calculate]').disabled,false);f.handle.close();assert.equal(f.disposed(),1);
});

test('source rejection clears an earlier preview and never presents a stale result as the new volume',async()=>{
  let calls=0;const f=fixture(async()=>{if(calls++)throw new Error('Source vertical units required.');return result;});await f.calculate();await f.calculate();
  assert.equal(f.saved(),1);assert.equal(f.disposed(),1);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'error');assert.match(f.dialog.querySelector('[data-status]').textContent,/No new volume was saved.*Source vertical units required/);assert.match(f.dialog.querySelector('[data-preview-empty]').textContent,/Preview unavailable/);f.handle.close();
});

test('closing during calculation aborts and cannot save or show a delayed private result',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.calculate();f.handle.close();wait.resolve(result);await pending;assert.equal(f.saved(),0);assert.equal(f.dialog.removed,true);
});
