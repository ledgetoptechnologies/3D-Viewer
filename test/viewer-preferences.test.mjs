import test from 'node:test';
import assert from 'node:assert/strict';
import {createViewerPreferences} from '../viewer-preferences.mjs';

test('public preferences are page-only and always start at default',async()=>{
  let calls=0;const applied=[];
  const prefs=createViewerPreferences({token:()=>null,fetcher:()=>{calls++;},apply:value=>applied.push(value)});
  assert.equal(prefs.snapshot().mouseProfile,'default');
  await prefs.load();await prefs.change({mouseProfile:'alternate'});
  assert.equal(calls,0);assert.equal(applied.at(-1).mouseProfile,'alternate');
  assert.equal(createViewerPreferences({token:()=>null,apply:()=>{}}).snapshot().mouseProfile,'default');
});

test('account preferences load without overwriting initial responsive collapse if unset',async()=>{
  const prefs=createViewerPreferences({token:()=> 'tab-bearer',apply:()=>{},fetcher:async(_url,opts)=>{
    assert.equal(opts.credentials,'omit');assert.equal(opts.headers.Authorization,'Bearer tab-bearer');
    return {ok:true,json:async()=>({preferences:{mouseProfile:'alternate',sidebarCollapsed:null}})};
  }});
  prefs.change({sidebarCollapsed:true},{save:false});await prefs.load();
  assert.deepEqual(prefs.snapshot(),{mouseProfile:'alternate',sidebarCollapsed:true});
});

test('read race preserves user choice and ordered saves use fresh bearer',async()=>{
  let resolveRead,bearer='first';const saves=[];
  const prefs=createViewerPreferences({token:()=>bearer,apply:()=>{},fetcher:async(_url,opts)=>{
    if(opts.method==='GET')return new Promise(resolve=>{resolveRead=resolve;});
    saves.push({body:JSON.parse(opts.body),bearer:opts.headers.Authorization});return {ok:true,json:async()=>({preferences:JSON.parse(opts.body)})};
  }});
  const loading=prefs.load();prefs.change({mouseProfile:'alternate'});
  resolveRead({ok:true,json:async()=>({preferences:{mouseProfile:'default',sidebarCollapsed:false}})});
  await loading;bearer='renewed';await prefs.change({sidebarCollapsed:true});
  assert.equal(prefs.snapshot().mouseProfile,'alternate');
  assert.deepEqual(saves.at(-1).body,{mouseProfile:'alternate',sidebarCollapsed:true});
  assert.equal(saves.at(-1).bearer,'Bearer renewed');
});

test('failed save does not reset current controls or leak persistence claim',async()=>{
  const notices=[];
  const prefs=createViewerPreferences({token:()=> 'token',apply:()=>{},notice:value=>notices.push(value),fetcher:async(_url,opts)=>opts.method==='GET'?{ok:true,json:async()=>({preferences:{mouseProfile:'default',sidebarCollapsed:false}})}:{ok:false}});
  await prefs.load();await prefs.change({mouseProfile:'alternate'});
  assert.equal(prefs.snapshot().mouseProfile,'alternate');assert.match(notices.at(-1),/page only/);
});

test('initial read race waits for save acknowledgement and preserves a failed-save notice',async()=>{
  let resolveRead,resolveWrite;const notices=[];
  const prefs=createViewerPreferences({token:()=> 'token',apply:()=>{},notice:value=>notices.push(value),fetcher:async(_url,opts)=>new Promise(resolve=>{
    if(opts.method==='GET')resolveRead=resolve;else resolveWrite=resolve;
  })});
  const loading=prefs.load();prefs.change({mouseProfile:'alternate'});
  resolveRead({ok:true,json:async()=>({preferences:{mouseProfile:'default',sidebarCollapsed:false}})});
  while(!resolveWrite)await Promise.resolve();
  assert.equal(notices.length,0);
  resolveWrite({ok:false});await loading;
  assert.match(notices.at(-1),/page only/);
  assert.equal(prefs.snapshot().mouseProfile,'alternate');
});
