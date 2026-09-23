'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {NodeOdmProvider}=require('../server/nodeOdmProvider');
const adapter=(value,observe=()=>{})=>new NodeOdmProvider({endpoint:'https://provider.example.test',fetchImpl:async(url,init)=>{observe(url,init);return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});}});

test('ODX output preserves array record boundaries, blank lines and exact cursor',async()=>{
  let requested;const output=await adapter(['stage, setting','', 'next\nembedded'],url=>requested=new URL(url)).output('task',17);
  assert.deepEqual(output,{lines:['stage, setting','','next\nembedded'],nextLine:20});assert.equal(requested.searchParams.get('line'),'17');
  assert.deepEqual(await adapter([]).output('task',20),{lines:[],nextLine:20});
});
test('legacy string output preserves interior empty lines and excludes trailing delimiter',async()=>{
  assert.deepEqual(await adapter('a\r\n\r\nb\n').output('task',2),{lines:['a','','b'],nextLine:5});
  assert.deepEqual(await adapter('').output('task',3),{lines:[],nextLine:3});
});
test('output rejects provider errors and malformed records without a cursor result',async()=>{
  for(const value of [{error:'task unavailable'},{},null,3,['valid',{}]])await assert.rejects(adapter(value).output('task'),{code:'provider_request_failed'});
  await assert.rejects(adapter([]).output('task',-1),/cursor/);
});
test('HTTP200 semantic rejection is not an acknowledged initialize/upload/commit/cancel/remove',async()=>{
  for(const action of ['initialize','upload','commit','cancel','remove']){
    const invoke=p=>action==='initialize'?p.initialize({uuid:'task',options:{}}):action==='upload'?p.upload('task',[{relativePath:'image.jpg',buffer:Buffer.from('image')}]):p[action]('task');
    await assert.rejects(invoke(adapter({error:'Cannot create task token=secret-value Bearer hidden-token'})),error=>error.code==='provider_request_failed'&&error.message.includes('Cannot create task')&&!error.message.includes('secret-value')&&!error.message.includes('hidden-token'));
    await assert.rejects(invoke(adapter({success:false})),{code:'provider_request_failed'});
  }
});
test('provider action success compatibility and task identity are retained',async()=>{
  assert.deepEqual(await adapter({uuid:'task'}).initialize({uuid:'task',options:{}}),{uuid:'task'});
  assert.deepEqual(await adapter({success:true}).upload('task',[]),{success:true});
  for(const action of ['commit','cancel','remove'])assert.deepEqual(await adapter({success:true})[action]('task'),{success:true});
  assert.deepEqual(await adapter({}).commit('task'),{});
  await assert.rejects(adapter({uuid:'other'}).commit('task'),/different task UUID/);
});
test('oversized output fails without returning a partial or invented cursor',async()=>{
  await assert.rejects(adapter(['x'.repeat(4*1024*1024)]).output('task',5),/size limit/);
});
