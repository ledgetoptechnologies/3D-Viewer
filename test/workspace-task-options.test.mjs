import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskOptionsModel, parseTaskOption, taskOptionDomain, taskOptionRestriction, mountTaskOptions } from '../workspace-task-options.mjs';
const specs = [{name:'dtm',type:'bool',value:false},{name:'count',type:'int',value:5,domain:{min:0,max:10}},{name:'resolution',type:'float',value:1},{name:'quality',type:'string',value:'high',domain:'["high","low"]'},{name:'label',type:'string',value:''}];
const provider = {id:'one',capabilityFingerprint:'version1',capabilities:{options:specs}};
test('typed overrides preserve false and zero, omit defaults and clear back to inherited preset values',()=>{
  const model=createTaskOptionsModel({provider,presetOptions:{dtm:true,count:7}});
  assert.deepEqual(model.getOptions(),{});assert.equal(model.entries()[0].inherited,true);
  model.setOverride('dtm','false');model.setOverride('count','0');model.setOverride('resolution','0');
  assert.deepEqual(model.getOptions(),{dtm:false,count:0,resolution:0});
  model.setOverride('dtm',undefined);assert.deepEqual(model.getOptions(),{count:0,resolution:0});assert.equal(model.entries()[0].inherited,true);
});
test('validation rejects malformed numeric, enum and unsupported settings instead of coercing',()=>{
  for(const value of ['', 'NaN','Infinity','1.2','11',true])assert.throws(()=>parseTaskOption(specs[1],value));
  assert.throws(()=>parseTaskOption(specs[0],'yes'));assert.throws(()=>parseTaskOption(specs[3],'other'));
  assert.throws(()=>parseTaskOption(specs[4],'x'.repeat(4001)));
  assert.deepEqual(taskOptionDomain({domain:'positive integer'}),{min:0,minExclusive:true});
  const model=createTaskOptionsModel({provider});model.setOverride('count','invalid');assert.equal(model.validate().valid,false);assert.throws(()=>model.getOptions());
  assert.throws(()=>model.setOverride('unknown',2));
});
test('provider/preset changes clear stale overrides while unchanged refresh preserves them',()=>{
  const model=createTaskOptionsModel({provider,presetOptions:{dtm:true}});model.setOverride('dtm',false);
  assert.equal(model.update({provider:{...provider},presetOptions:{dtm:true}}),false);assert.deepEqual(model.getOptions(),{dtm:false});
  assert.equal(model.update({provider:{...provider,capabilityFingerprint:'version2'},presetOptions:{dtm:true}}),true);assert.deepEqual(model.getOptions(),{});
  model.setOverride('count',0);model.update({provider,presetOptions:{count:3}});assert.deepEqual(model.getOptions(),{});
});
test('file/path inputs and required outputs cannot be edited as arbitrary strings or disabled',()=>{
  for(const name of ['align','cameras','boundary','gcp','geo','pc-ept','gltf','3d-tiles'])assert.ok(taskOptionRestriction({name,type:'string'}));
  assert.ok(taskOptionRestriction({name:'custom-file',type:'string',help:'Path to an input file'}));
  const model=createTaskOptionsModel({provider:{capabilities:{options:[{name:'gltf',type:'bool',value:false},{name:'align',type:'string'}]}}});
  assert.equal(model.entries()[0].inherited,true);assert.throws(()=>model.setOverride('gltf',false));assert.throws(()=>model.setOverride('align','/etc/source'));
});
class Element {
  constructor(tag,ownerDocument){this.tag=tag;this.ownerDocument=ownerDocument;this.children=[];this.listeners={};this.value='';}
  append(child){this.children.push(child);}setAttribute(name,value){this[name]=value;}addEventListener(name,fn){this.listeners[name]=fn;}replaceChildren(){this.children=[];}remove(){this.removed=true;}
}
test('mounted editor renders inherited values as text, searches help, collects edits and disposes',()=>{
  const document={createElement(tag){return new Element(tag,this);}},container=new Element('div',document);
  const editor=mountTaskOptions({container,provider,presetOptions:{count:7}}),root=container.children[0],search=root.children[1],list=root.children[3];
  const row=list.children[0],mode=row.children[2],control=row.children[3];assert.equal(control.disabled,true);
  mode.value='override';control.value='false';mode.listeners.change();assert.deepEqual(editor.getOptions(),{dtm:false});
  search.value='quality';search.listeners.input();assert.equal(row.hidden,true);assert.equal(list.children[3].hidden,false);
  editor.update({provider,presetOptions:{count:7}});assert.deepEqual(editor.getOptions(),{dtm:false});
  editor.setDisabled(true);assert.equal(list.children[0].children[2].disabled,true);assert.equal(list.children[0].children[3].disabled,true);
  editor.setDisabled(false);assert.equal(list.children[0].children[2].disabled,false);assert.equal(list.children[0].children[3].disabled,false);assert.equal(list.children[1].children[3].disabled,true);
  editor.dispose();assert.equal(root.removed,true);
});

test('known descriptive numeric domains are validated without executing arbitrary domain text',()=>{
  for(const domain of ['positive integer','positive float','float > 0.0'])assert.throws(()=>parseTaskOption({name:'numeric',type:'float',domain},0));
  assert.equal(parseTaskOption({name:'numeric',type:'float',domain:'non-negative float'},0),0);
  for(const value of [-1,11])assert.throws(()=>parseTaskOption({name:'numeric',type:'float',domain:'0 <= x <= 10'},value));
  assert.equal(parseTaskOption({name:'numeric',type:'float',domain:'0 <= x <= 10'},10),10);
  assert.equal(taskOptionDomain({domain:'process.exit()'}),null);
});
