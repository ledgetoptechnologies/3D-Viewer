import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const action=source.slice(source.indexOf("      if(action==='rename')"),source.indexOf("      if(action==='export')"));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(){
  const row={children:[],querySelector(){return this.children.find(child=>child.className==='measurement-rename')||null;},append(child){this.children.push(child);}};
  const messages=[],patches=[],save=deferred();let renders=0;
  const scope=vm.createContext({action:'rename',id:'one',selected:null,record:{id:'one',name:'Original'},pendingRenameSaves:new Set(),event:{target:{closest:()=>row}},
    document:{createElement(){const input={value:'',focusCount:0,selectCount:0,focus(){this.focusCount++;},select(){this.selectCount++;}},cancel={},submit={};return{querySelector:key=>key==='input'?input:key==='[data-cancel]'?cancel:submit};}},
    store:{patch(record,fields){patches.push({record,fields});return save.promise;}},tell:text=>messages.push(text),renderPanel(){renders++;row.children=[];}});
  return{row,scope,save,patches,messages,get renders(){return renders;},click:()=>vm.runInContext(`(async()=>{${action}})()`,scope)};
}

test('repeated rename clicks reuse and focus the existing editor without replacing typed input',async()=>{
  const f=fixture();await f.click();const editor=f.row.children[0],input=editor.querySelector('input');input.value='Unsaved name';
  await f.click();await f.click();assert.equal(f.row.children.length,1);assert.equal(input.value,'Unsaved name');assert.equal(input.focusCount,3);assert.equal(input.selectCount,3);assert.equal(f.patches.length,0);
});

test('pending rename has one save and cannot be cancelled or duplicated after a list redraw',async()=>{
  const f=fixture();await f.click();const editor=f.row.children[0];editor.querySelector('input').value=' New name ';
  const pending=editor.onsubmit({preventDefault(){}});await editor.onsubmit({preventDefault(){}});await f.click();
  assert.equal(f.patches.length,1);assert.equal(f.patches[0].fields.name,'New name');assert.equal(editor.querySelector('[data-cancel]').disabled,true);
  editor.querySelector('[data-cancel]').onclick();editor.onkeydown({key:'Escape',preventDefault(){}});assert.equal(f.renders,0);
  f.row.children=[];await f.click();assert.equal(f.row.children.length,0);assert.equal(f.messages.at(-1),'Saving measurement name…');
  f.save.resolve();await pending;assert.equal(f.scope.pendingRenameSaves.size,0);await f.click();assert.equal(f.row.children.length,1);
});

test('failed save keeps one editable form for retry and normal Escape cancels it',async()=>{
  const f=fixture();await f.click();const editor=f.row.children[0];editor.querySelector('input').value='Retry name';
  const pending=editor.onsubmit({preventDefault(){}});f.save.reject(new Error('Network unavailable'));await pending;
  assert.equal(f.scope.pendingRenameSaves.size,0);assert.equal(editor.querySelector('input').disabled,false);assert.equal(editor.querySelector('[type=submit]').disabled,false);assert.equal(editor.querySelector('[data-cancel]').disabled,false);
  await f.click();assert.equal(f.row.children.length,1);assert.equal(editor.querySelector('input').value,'Retry name');assert.equal(f.messages.at(-1),'Network unavailable');
  editor.onkeydown({key:'Escape',preventDefault(){}});assert.equal(f.renders,1);assert.equal(f.row.children.length,0);
});
