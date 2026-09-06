import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as geometry from '../measurement-document.mjs';
import {createMeasurementStore} from '../measurement-store.mjs';
import {createMeasurementListLayout} from '../measurement-list-layout.mjs';

const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

// DOM/render seams execute the actual workspace event handlers. Assertions cover
// collection identity and async lifetime, not browser pixels or native picking.
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.queries=new Map();this.handlers=new Map();this.attributes={};this.innerHTML='';this.textContent='';this.value='';this.classList={add(){},remove(){},toggle(){}};}
  append(...nodes){this.children.push(...nodes);for(const node of nodes)node.parentElement=this;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);}
  setAttribute(key,value){this.attributes[key]=value;}
  getAttribute(key){return this.attributes[key];}
  querySelector(key){if(!this.queries.has(key)){const node=new Element();node.ownerDocument=this.ownerDocument;this.queries.set(key,node);}return this.queries.get(key);}
  querySelectorAll(){return [];}
  addEventListener(key,fn){if(!this.handlers.has(key))this.handlers.set(key,[]);this.handlers.get(key).push(fn);}
  removeEventListener(key,fn){this.handlers.set(key,(this.handlers.get(key)||[]).filter(value=>value!==fn));}
  fire(key,event){return Promise.all((this.handlers.get(key)||[]).map(fn=>fn(event)));}
  closest(){return null;}
  getBoundingClientRect(){return{left:0,top:0,width:800,height:600};}
  setPointerCapture(){} releasePointerCapture(){} focus(){} click(){}
}

function fixture({resolveDisplayVertices=async record=>({vertices:record.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture DSM samples'}),viewCrs='EPSG:32616'}={}){
  const window=new Element(),document={defaultView:window,createElement(tag){const node=new Element(tag);node.ownerDocument=this;return node;},createElementNS(_ns,tag){return this.createElement(tag);}};
  document.body=document.createElement('body');document.head=document.createElement('head');
  const panel=document.createElement('section'),canvas=document.createElement('canvas'),host=document.createElement('div');
  const projected=[],downloads=[],mutations=[],calculationCalls=[],resolverCalls=[],focused=[];
  let mode='model',permission=true;
  const context=()=>({mode,element:canvas,host,viewSignature:()=>mode,pick:event=>[event.clientX,event.clientY,0],project(point){projected.push({mode,point:Array.from(point)});return point.slice(0,2);},focus(vertices){focused.push({mode,vertices:structuredClone(vertices)});}});
  const scope=vm.createContext({...geometry,createMeasurementStore,createMeasurementListLayout,document,window,crypto,structuredClone,AbortController,DOMException,console,Blob,
    URL:{createObjectURL(blob){downloads.push(blob);return'blob:fixture';},revokeObjectURL(){}},
    setInterval:()=>1,clearInterval(){},setTimeout:()=>1,performance:{now:()=>1000},
    openSurfaceDialog:options=>{calculationCalls.push(options);return{close(){}};},openAdminCalculationDialog:()=>{throw new Error('Unexpected server calculation dialog');}});
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function createMeasurementWorkspace','function createMeasurementWorkspace'),scope);
  const workspace=scope.createMeasurementWorkspace({panel,context,token:()=>null,permitted:()=>permission,toolChanged(){},coordinateReference:()=>({crs:viewCrs,verticalUnit:'m'}),toLonLat:p=>p.slice(0,2),calculateSurface:()=>{calculationCalls.push('calculate');},resolveDisplayVertices:(record,options)=>{resolverCalls.push({id:record.id,options});return resolveDisplayVertices(record,options);}});
  const controls=panel.children[0];workspace.tick();
  const action=(name,id)=>controls.fire('click',{target:{closest:selector=>selector==='[data-m]'?{dataset:{m:name}}:selector==='[data-record]'&&id?{dataset:{record:id}}:null}});
  return{workspace,controls,panel,projected,downloads,mutations,calculationCalls,resolverCalls,focused,action,
    svg:()=>host.children.find(node=>node.tagName==='svg'),list:()=>controls.querySelector('[data-m-list]').innerHTML,
    async switchTo(next){workspace.modeChanged();mode=next;workspace.tick();await flush();workspace.tick();},
    deny(){permission=false;workspace.tick();},
    exportCheck(id){return controls.fire('change',{target:{dataset:{m:'export-check'},checked:true,closest:()=>({dataset:{record:id}})}});},
    watchMutations(){for(const name of ['save','patch','remove','attachResults']){const original=workspace.store[name];workspace.store[name]=(...args)=>{mutations.push(name);return original(...args);};}},
    async exportJson(){controls.querySelector('[data-m="format"]').value='json';await action('export');return JSON.parse(await downloads.at(-1).text());}
  };
}

const document=(collection,name)=>({id:crypto.randomUUID(),name,collection,kind:'distance',vertices:collection==='map'?[[250,200,0],[390,230,0]]:[[20,40,132.123456789],[100,60,139.987654321]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},visible:true,source:{kind:collection==='map'?'ortho':'mesh'},results:{status:'geometry-only',method:'vertex-geometry',...(collection==='map'?{elevationBasis:'not-sampled'}:{})}});
async function seed(f){
  const spatial=document('spatial3d','Measured roof'),map={...document('map','Map boundary'),kind:'polygon',vertices:[[250,200,0],[390,200,0],[390,300,0],[250,300,0]],
    results:{status:'complete',method:'surface-cut-fill',cutM3:1234.567890123,fillM3:2.123456789,netM3:1232.444433334,coverage:1,sourceKind:'dsm',modelVersionId:'fixture-version',reference:{type:'custom',elevationM:140,offsetM:0},calculationOrigin:'browser',verified:false,warnings:['Fixture source vertical datum'],boundaryVertices:[[250,200,145],[390,200,145],[390,300,145],[250,300,145]]}};
  await f.workspace.store.save(spatial);await f.workspace.store.save(map);await flush();return{spatial,map};
}

test('all five views expose both original collections without duplicate records, switch writes, or calculations',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());const{spatial,map}=await seed(f);const snapshot=JSON.stringify([...f.workspace.store.records.values()]);f.watchMutations();
  for(const mode of ['model','cloud','ortho','dsm','dtm','model']){
    await f.switchTo(mode);assert.match(f.list(),/Measured roof/);assert.match(f.list(),/Map boundary/);assert.equal(f.controls.querySelector('[data-m-count]').textContent,'2');
    assert.match(f.svg().innerHTML,/Measured roof/);assert.match(f.svg().innerHTML,/Map boundary/);assert.equal(f.workspace.store.records.size,2);
  }
  assert.equal(JSON.stringify([...f.workspace.store.records.values()]),snapshot);assert.deepEqual(f.mutations,[]);assert.deepEqual(f.calculationCalls,[]);
  assert.equal(f.workspace.store.records.get(spatial.id).collection,'spatial3d');assert.equal(f.workspace.store.records.get(map.id).collection,'map');
  assert.ok(f.projected.filter(p=>['model','cloud'].includes(p.mode)).every(p=>p.point[2]!==0),'map placeholder Z must not be projected as measured elevation');
});

test('selection and export checks survive map/3D detours and JSON retains original geometry and provenance',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());const{spatial,map}=await seed(f);await f.action('select',spatial.id);await f.exportCheck(map.id);
  for(const mode of ['ortho','dsm','dtm','cloud','model']){
    await f.switchTo(mode);
    assert.match(f.list(),new RegExp(`measurement-row selected[^>]*data-record="${spatial.id}"`));
    const row=f.list().split(`data-record="${map.id}"`)[1]?.split('</article>')[0];assert.match(row,/data-m="export-check"[^>]*checked/);
  }
  const exported=await f.exportJson();assert.equal(exported.measurements.length,1);assert.equal(exported.measurements[0].id,map.id);
  for(const key of ['vertices','collection','coordinateReference','source','results'])assert.deepEqual(exported.measurements[0][key],map[key]);
});

test('cross-family editing is refused with guidance and never substitutes map pick Z for measured elevation',async t=>{
  for(const [collection,mode]of [['spatial3d','ortho'],['map','cloud']]){
    const f=fixture();t.after(()=>f.workspace.dispose());const record=document(collection,'Original geometry');await f.workspace.store.save(record);await f.switchTo(mode);await f.action('select',record.id);f.watchMutations();
    await f.action('edit');assert.equal(f.workspace.getDraft(),null);
    assert.match(f.panel.children[1].textContent,/switch|return|open|edit/i);assert.match(f.panel.children[1].textContent,/map|3D|point cloud|orthophoto/i);
    assert.deepEqual(f.workspace.store.records.get(record.id).vertices,record.vertices);assert.deepEqual(f.mutations,[]);
    await f.switchTo(collection==='map'?'ortho':'model');await f.action('edit');assert.equal(f.workspace.getDraft()?.id,record.id,'editing still works in the origin family');
  }
});

test('pending map draping is bounded and never renders placeholder elevations; completion is display-only',async t=>{
  const waiting=deferred(),f=fixture({resolveDisplayVertices:()=>waiting.promise});t.after(()=>f.workspace.dispose());const map=document('map','Pending boundary');await f.workspace.store.save(map);f.watchMutations();
  for(let i=0;i<100;i++)f.workspace.tick();await flush();
  assert.match(f.list(),/Pending boundary/);assert.equal(f.projected.length,0);assert.doesNotMatch(f.svg().innerHTML,/Pending boundary/);assert.equal(f.resolverCalls.length,1,'do not request a raster per animation frame');
  waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture DSM samples'});await flush();f.workspace.tick();
  assert.match(f.svg().innerHTML,/Pending boundary/);assert.ok(f.projected.every(p=>p.point[2]===145));assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);assert.deepEqual(f.mutations,[]);
});

test('missing map elevation keeps the record available but does not invent a zero-height 3D overlay',async t=>{
  const f=fixture({resolveDisplayVertices:async()=>{throw new Error('No verified elevation surface');}});t.after(()=>f.workspace.dispose());const map=document('map','No surface');await f.workspace.store.save(map);
  f.workspace.tick();await flush();for(let i=0;i<100;i++)f.workspace.tick();await flush();
  assert.match(f.list(),/No surface/);assert.equal(f.projected.length,0);assert.doesNotMatch(f.svg().innerHTML,/No surface/);assert.equal(f.resolverCalls.length,1,'failure must not cause per-frame retries');
  await f.switchTo('ortho');assert.match(f.svg().innerHTML,/No surface/);assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
});

test('late display samples cannot revive private records after access is invalidated',async t=>{
  const waiting=deferred(),f=fixture({resolveDisplayVertices:()=>waiting.promise});t.after(()=>f.workspace.dispose());const map=document('map','Private boundary');await f.workspace.store.save(map);f.workspace.tick();await flush();
  assert.equal(f.resolverCalls.length,1);f.deny();waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture DSM samples'});await flush();f.workspace.tick();
  assert.equal(f.workspace.store.records.size,0);assert.equal(f.controls.hidden,true);assert.equal(f.svg().innerHTML,'');assert.equal(f.projected.length,0);
  await f.action('export');assert.equal(f.downloads.length,0);
});

test('five queued map records use no more than two concurrent elevation requests and drain without per-frame retries',async t=>{
  const pending=[],settled=new Set();let active=0,peak=0;
  const f=fixture({resolveDisplayVertices:record=>{
    const waiting=deferred();active++;peak=Math.max(peak,active);pending.push({record,waiting});
    return waiting.promise.finally(()=>active--);
  }});t.after(()=>f.workspace.dispose());
  for(let i=0;i<5;i++)await f.workspace.store.save(document('map',`Boundary ${i}`));
  for(let i=0;i<100;i++)f.workspace.tick();await flush();assert.equal(pending.length,2);assert.equal(active,2);
  for(let round=0;round<3;round++){
    for(const item of [...pending])if(!settled.has(item)){settled.add(item);item.waiting.resolve({vertices:item.record.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture samples'});}
    await flush();f.workspace.tick();assert.ok(active<=2);assert.ok(peak<=2);
  }
  assert.equal(pending.length,5);assert.equal(active,0);assert.equal(f.resolverCalls.length,5);
  for(let i=0;i<100;i++)f.workspace.tick();await flush();assert.equal(f.resolverCalls.length,5);assert.equal(f.workspace.store.records.size,5);
});

test('mode changes abort pending placement and late source replies cannot replace the destination geometry',async t=>{
  const requests=[],f=fixture({resolveDisplayVertices:(record,{signal})=>{const waiting=deferred();requests.push({record,signal,waiting});return waiting.promise;}});t.after(()=>f.workspace.dispose());
  const map=document('map','Across views');await f.workspace.store.save(map);f.workspace.tick();await flush();assert.equal(requests.length,1);
  await f.switchTo('ortho');assert.equal(requests[0].signal.aborted,true);assert.match(f.svg().innerHTML,/Across views/);
  const mapMarkup=f.svg().innerHTML;f.projected.length=0;
  requests[0].waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,999]),basis:'Obsolete source'});await flush();f.workspace.tick();
  assert.equal(f.svg().innerHTML,mapMarkup);assert.ok(f.projected.every(p=>p.mode==='ortho'&&p.point[2]===0));
  await f.switchTo('model');assert.equal(requests.length,2);await f.switchTo('cloud');assert.equal(requests[1].signal.aborted,true);assert.equal(requests.length,3);
  requests[2].waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,180]),basis:'Destination source'});await flush();f.workspace.tick();assert.match(f.svg().innerHTML,/Across views/);
  f.projected.length=0;requests[1].waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,888]),basis:'Obsolete second source'});await flush();f.workspace.tick({force:true});
  assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.mode==='cloud'&&p.point[2]===180));assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
});

test('malformed or horizontally shifted elevation results are rejected instead of projecting false geometry',async t=>{
  const cases=[
    vertices=>vertices.slice(1),
    vertices=>vertices.map(([e,n])=>[e,n]),
    vertices=>vertices.map(([e,n])=>[e,n,NaN]),
    vertices=>vertices.map(([e,n])=>[e,n,Infinity]),
    vertices=>vertices.map(([e,n])=>[e,n,'145']),
    vertices=>vertices.map(([e,n])=>[e+.001,n,145]),
    vertices=>vertices.map(([e,n])=>[e,n+.001,145]),
    vertices=>vertices.map(([e,n])=>[e,n,1e10]),
  ];
  for(const result of cases){
    const f=fixture({resolveDisplayVertices:async record=>({vertices:result(record.vertices),basis:'Invalid fixture'})});t.after(()=>f.workspace.dispose());
    const map=document('map','Rejected placement');await f.workspace.store.save(map);f.workspace.tick();await flush();f.workspace.tick();
    assert.equal(f.projected.length,0);assert.doesNotMatch(f.svg().innerHTML,/Rejected placement/);assert.match(f.list(),/unavailable|finite|matching/i);
    assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
  }
});

test('focus waits for valid display elevations and never centers a map record at placeholder Z in 3D',async t=>{
  const waiting=deferred(),f=fixture({resolveDisplayVertices:()=>waiting.promise});t.after(()=>f.workspace.dispose());const map=document('map','Focus boundary');await f.workspace.store.save(map);await f.action('select',map.id);
  await f.action('focus');assert.equal(f.focused.length,0);await flush();
  const vertices=map.vertices.map(([e,n])=>[e,n,145]);waiting.resolve({vertices,basis:'Verified fixture'});await flush();f.workspace.tick();await f.action('focus');
  assert.equal(f.focused.length,1);assert.deepEqual(f.focused[0].vertices,vertices);assert.equal(f.focused[0].mode,'model');assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
});

test('missing and mismatched coordinate references retain records without unsafe projection or focus',async t=>{
  for(const [viewCrs,recordCrs]of [['EPSG:32616','EPSG:32617'],['EPSG:32616',undefined],[undefined,'EPSG:32616'],['','EPSG:32616']]){
    // Explicit undefined must reach the fixture rather than its default parameter.
    const f=fixture({viewCrs:viewCrs??null});t.after(()=>f.workspace.dispose());
    for(const collection of ['spatial3d','map']){
      const record={...document(collection,`Unaligned ${collection}`),coordinateReference:{crs:recordCrs,verticalUnit:'m'}};await f.workspace.store.save(record);await f.action('select',record.id);await f.action('focus');
    }
    for(const mode of ['model','cloud','ortho','dsm','dtm'])await f.switchTo(mode);
    assert.equal(f.workspace.store.records.size,2);assert.equal(f.projected.length,0);assert.equal(f.focused.length,0);assert.equal(f.resolverCalls.length,0);assert.equal(f.svg().innerHTML,'');
    assert.match(f.list(),/Unaligned spatial3d/);assert.match(f.list(),/Unaligned map/);assert.match(f.list(),/coordinate|reference|alignment/i);
  }
});
