import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const start=source.indexOf('  async function screenshot()'),end=source.indexOf('  async function report()',start);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function fixture(){
  const capture=deferred(),decode=deferred(),decodeStarted=deferred(),state={draws:0,urls:[],revoked:[],serializations:0};
  const ctx={drawImage(){state.draws++;},fillRect(){},fillText(){}},canvas={width:400,height:300,getContext:()=>ctx};
  const scope=vm.createContext({bound:{element:{},mode:'model',capture:()=>capture.promise},viewGeneration:1,units:'imperial',disposed:false,allowed:()=>true,draw(){},coordinateReference:()=>({crs:'EPSG:32616'}),svg:{text:'original'},XMLSerializer:class{serializeToString(svg){state.serializations++;return svg.text;}},Image:class{decode(){decodeStarted.resolve();return decode.promise;}},Blob,URL:{createObjectURL(blob){state.urls.push(blob);return'blob:test';},revokeObjectURL(url){state.revoked.push(url);}}});
  vm.runInContext(source.slice(start,end),scope);return{scope,state,canvas,capture,decode,decodeStarted};
}
test('screenshot captures the overlay snapshot before asynchronous renderer capture',async()=>{
  const f=fixture(),pending=f.scope.screenshot();assert.equal(f.state.serializations,1);f.scope.svg.text='changed';f.capture.resolve(f.canvas);
  await Promise.resolve();f.decode.resolve();await pending;assert.equal(await f.state.urls[0].text(),'original');assert.equal(f.state.draws,1);assert.deepEqual(f.state.revoked,['blob:test']);
});
test('view mode, generation, unit and permission changes reject delayed screenshot before overlay export',async()=>{
  for(const change of [f=>{f.scope.viewGeneration++;},f=>{f.scope.bound={...f.scope.bound,mode:'ortho'};},f=>{f.scope.units='metric';},f=>{f.scope.allowed=()=>false;},f=>{f.scope.disposed=true;}]){
    const f=fixture(),pending=f.scope.screenshot(),rejected=assert.rejects(pending,/view changed/);change(f);f.capture.resolve(f.canvas);await rejected;
    assert.equal(f.state.draws,0);assert.equal(f.state.urls.length,0);
  }
});
test('late overlay decode cannot export private data after access loss and releases its URL',async()=>{
  const f=fixture(),pending=f.scope.screenshot(),rejected=assert.rejects(pending,/view changed/);f.capture.resolve(f.canvas);await f.decodeStarted.promise;
  f.scope.allowed=()=>false;f.decode.resolve();await rejected;assert.equal(f.state.draws,0);assert.deepEqual(f.state.revoked,['blob:test']);
});

test('PNG encoding cannot download after a late access or view change',async()=>{
  const action=source.slice(source.indexOf("      if(action==='screenshot')"),source.indexOf("      if(action==='report')"));
  for(const change of [s=>{s.allowed=()=>false;},s=>{s.viewGeneration++;},s=>{s.units='metric';},s=>{s.disposed=true;}]){
    let encode;const started=deferred();let downloads=0;
    const scope=vm.createContext({action:'screenshot',viewGeneration:1,units:'imperial',disposed:false,allowed:()=>true,screenshot:async()=>({toBlob(callback){encode=callback;started.resolve();}}),download(){downloads++;}});
    const pending=vm.runInContext(`(async()=>{${action}})()`,scope),rejected=assert.rejects(pending,/view changed/);
    await started.promise;change(scope);encode(new Blob(['image']));await rejected;assert.equal(downloads,0);
  }
});

function reportFixture(){
  const reports=new Set(),body={children:[],append(node){this.children.push(node);}};let printed=0;
  const document={body,createElement(){const nodes=new Map();return{innerHTML:'',showModal(){},querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{removeAttribute(key){delete this[key];}});return nodes.get(selector);},remove(){body.children=body.children.filter(n=>n!==this);}};}};
  const scope=vm.createContext({document,reportDialogs:reports,viewGeneration:1,disposed:false,allowed:()=>true,units:'imperial',structuredClone,exportRecords:()=>[],screenshot:async()=>({toDataURL:()=> 'data:image/png;private'}),coordinateReference:()=>({crs:'EPSG:32616'}),escape:String,window:{print(){printed++;}}});
  vm.runInContext(source.slice(source.indexOf('  async function report()'),source.indexOf("  controls.addEventListener('change'")),scope);
  vm.runInContext(source.slice(source.indexOf('  function closeReports()'),source.indexOf('  function closeDialogs()')),scope);
  return{scope,reports,body,printed:()=>printed};
}

test('open report cleanup clears private image and markup, and is idempotent',async()=>{
  const f=reportFixture();await f.scope.report();const dialog=f.body.children[0],img=dialog.querySelector('img');
  assert.match(img.src,/private/);f.scope.closeReports();assert.equal(img.src,undefined);assert.equal(dialog.innerHTML,'');assert.equal(f.body.children.length,0);assert.equal(f.reports.size,0);dialog.onclose();
  const close=source.slice(source.indexOf('  function closeDialogs()'),source.indexOf('  function invalidate('));assert.match(close,/closeReports\(\)/);
  assert.match(source.slice(source.indexOf('  function invalidate('),source.indexOf('  async function finish()')),/closeDialogs\(\)/);
  assert.match(source.slice(source.indexOf('  return {setTool,store')),/dispose\(\).*closeDialogs\(\)/);
});

test('report print fails closed and clears the report after access or view change',async()=>{
  for(const change of [s=>{s.allowed=()=>false;},s=>{s.disposed=true;},s=>{s.viewGeneration++;}]){
    const f=reportFixture();await f.scope.report();const print=f.body.children[0].querySelector('[data-print]').onclick;change(f.scope);print();assert.equal(f.printed(),0);assert.equal(f.body.children.length,0);
  }
});
