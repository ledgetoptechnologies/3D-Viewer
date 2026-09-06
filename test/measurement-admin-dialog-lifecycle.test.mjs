import test from 'node:test';
import assert from 'node:assert/strict';
import {openAdminCalculationDialog} from '../measurement-admin-dialog.mjs';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const capabilities={capabilities:{serverCalculations:true},calculationSources:[]};
const record={id:'0e439915-bcda-4c90-852a-9e0a7f48c7ce',name:'Private polygon',kind:'polygon',revision:1};
function documentFixture(){
  const nodes=[];
  class Element{
    constructor(){this.children=[];this.queries=new Map();this.value='';this.open=false;this.ownerDocument=doc;nodes.push(this);}
    querySelector(selector){if(!this.queries.has(selector))this.queries.set(selector,new Element());return this.queries.get(selector);}
    append(...children){for(const child of children){this.children.push(child);child.parent=this;}}
    replaceChildren(){this.children=[];}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.removed=true;}
    showModal(){this.open=true;}
    close(){this.open=false;this.onclose?.();}
  }
  const doc={createElement:()=>new Element()};doc.body=new Element();return{doc,nodes};
}
test('late capabilities cannot create an admin dialog after view or identity invalidation',async()=>{
  const gate=deferred(),f=documentFixture();let current=true;
  const pending=openAdminCalculationDialog({record,request:()=>gate.promise,isCurrent:()=>current,documentRef:f.doc}),rejected=assert.rejects(pending,/access or view changed/);
  current=false;gate.resolve(capabilities);await rejected;assert.equal(f.doc.body.children.length,0);assert.equal(f.nodes.length,1);
});
test('invalidation during initial job load removes an already appended pending dialog without displaying private results',async()=>{
  const gate=deferred(),started=deferred(),f=documentFixture();let current=true,attached=0,closed=0;
  const pending=openAdminCalculationDialog({record,isCurrent:()=>current,documentRef:f.doc,onClose:()=>{closed++;},onResult:()=>{attached++;},request:async operation=>{
    if(operation==='capabilities')return capabilities;started.resolve();return gate.promise;
  }}),rejected=assert.rejects(pending,/access or view changed/);
  await started.promise;assert.equal(f.doc.body.children.length,1);const dialog=f.doc.body.children[0];current=false;
  gate.resolve({calculations:[{id:'job',revision:1,status:'complete',result:{volumeM3:123}}]});await rejected;
  assert.equal(f.doc.body.children.length,0);assert.equal(dialog.open,false);assert.equal(attached,0);assert.equal(closed,1);assert.equal(dialog.querySelector('[data-result]').textContent,undefined);
});

test('registered handle closes private pending dialog immediately without waiting for initial jobs',async()=>{
  const gate=deferred(),started=deferred(),f=documentFixture();let current=true,handle,closed=0;
  const pending=openAdminCalculationDialog({record,isCurrent:()=>current,documentRef:f.doc,onClose:()=>{closed++;},onOpened:value=>{assert.equal(f.doc.body.children.length,0,'ownership precedes DOM append');handle=value;},request:async operation=>{
    if(operation==='capabilities')return capabilities;started.resolve();return gate.promise;
  }}),rejected=assert.rejects(pending,/access or view changed/);
  await started.promise;assert.equal(f.doc.body.children.length,1);current=false;handle.close();
  assert.equal(f.doc.body.children.length,0,'private UI closes before the deferred request completes');assert.equal(closed,1);
  gate.resolve({calculations:[]});await rejected;assert.equal(closed,1);
});

test('ownership invalidation before append prevents private dialog from becoming visible',async()=>{
  const f=documentFixture();let lists=0;
  await assert.rejects(openAdminCalculationDialog({record,documentRef:f.doc,onOpened:handle=>handle.close(),request:async operation=>{if(operation==='list')lists++;return capabilities;}}),/access or view changed/);
  assert.equal(f.doc.body.children.length,0);assert.equal(lists,0);
});
test('revocation during later refresh closes the dialog and prevents result callbacks',async()=>{
  const gate=deferred(),started=deferred(),f=documentFixture();let current=true,loads=0,attached=0;
  const dialog=await openAdminCalculationDialog({record,isCurrent:()=>current,documentRef:f.doc,onResult:()=>{attached++;},request:async operation=>{
    if(operation==='capabilities')return capabilities;if(++loads===1)return{calculations:[]};started.resolve();return gate.promise;
  }});
  const refreshing=dialog.refresh();await started.promise;current=false;gate.resolve({calculations:[{id:'job',revision:1,status:'complete',result:{volumeM3:999}}]});await refreshing;
  assert.equal(f.doc.body.children.length,0);assert.equal(attached,0);
});

test('late create response after scope loss closes the dialog and never refreshes its private job',async()=>{
  const gate=deferred(),started=deferred(),f=documentFixture();let current=true,loads=0;
  const dialog=await openAdminCalculationDialog({record,isCurrent:()=>current,documentRef:f.doc,request:async operation=>{
    if(operation==='capabilities')return{...capabilities,calculationSources:[{assetId:'dsm',kind:'dsm',methods:['surface-cut-fill']}]};
    if(operation==='list'){loads++;return{calculations:[]};}started.resolve();return gate.promise;
  }});
  for(const [name,value]of Object.entries({method:'surface-cut-fill',source:'dsm',reference:'custom',offset:'0',elevation:'0'}))dialog.element.querySelector(`[name="${name}"]`).value=value;
  const creating=dialog.element.querySelector('[data-create]').onclick();await started.promise;current=false;gate.resolve({calculation:{id:'job',status:'queued'}});await creating;
  assert.equal(f.doc.body.children.length,0);assert.equal(loads,1);
});
