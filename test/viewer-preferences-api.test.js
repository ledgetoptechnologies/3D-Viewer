'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const {openDatabase}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {createViewerPreferencesApi}=require('../server/viewerPreferencesApi');
const auth=require('../server/auth');

async function fixture(t){
  const database=openDatabase(':memory:'),repository=new ViewerRepository(database);
  const model=repository.upsertModelVersion({provider:'webodm',providerModelId:'one',providerVersionId:'v1',displayName:'Preferences test',sourceLocator:{},status:'ready',assets:[]});
  function token(overrides={}){
    const value=crypto.randomBytes(32).toString('base64url');
    repository.createViewerSession({tokenHash:auth.hashToken(value),modelId:model.id,modelVersionId:model.activeVersion.id,audience:'ops',subject:'person-one',permissions:{view:true,personalMeasurements:true},expiresAt:new Date(Date.now()+3600000).toISOString(),...overrides});return value;
  }
  const app=express();app.use(express.json());app.use('/api/v1/viewer/preferences',createViewerPreferencesApi(repository));
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({code:'invalid_json'}));
  const server=await new Promise(resolve=>{const candidate=app.listen(0,'127.0.0.1',()=>resolve(candidate));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));database.close();});
  const request=(bearer,method='GET',body,headers={})=>fetch(`http://127.0.0.1:${server.address().port}/api/v1/viewer/preferences`,{method,headers:{'Content-Type':'application/json',...(bearer?{Authorization:`Bearer ${bearer}`}:{ }),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{database,repository,model,token,request};
}
const defaults={mouseProfile:'default',sidebarCollapsed:null};
const custom={mouseProfile:'alternate',sidebarCollapsed:true};

test('signed-in ops and client preferences persist by subject and audience across sessions and models',async t=>{
  const f=await fixture(t),ops=f.token(),client=f.token({audience:'client'}),other=f.token({subject:'person-two'});
  for(const token of [ops,client,other])assert.deepEqual((await(await f.request(token)).json()).preferences,defaults);
  const response=await f.request(ops,'PUT',custom);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{preferences:custom});
  const second=f.repository.upsertModelVersion({provider:'webodm',providerModelId:'two',providerVersionId:'v1',displayName:'Other model',sourceLocator:{},status:'ready',assets:[]});
  const renewed=f.token({modelId:second.id,modelVersionId:second.activeVersion.id});
  const saved=await f.request(renewed);assert.equal(saved.headers.get('cache-control'),'no-store');assert.deepEqual(await saved.json(),{preferences:custom});
  for(const token of [client,other])assert.deepEqual((await(await f.request(token)).json()).preferences,defaults);
  const clientSettings={mouseProfile:'default',sidebarCollapsed:false};assert.equal((await f.request(client,'PUT',clientSettings)).status,200);
  assert.deepEqual((await(await f.request(f.token({audience:'client'}))).json()).preferences,clientSettings);
  assert.deepEqual((await(await f.request(ops)).json()).preferences,custom);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM viewer_user_preferences').get().n,2);
});

test('public, cookie-only, unknown, expired, revoked and non-view sessions cannot read or write preferences',async t=>{
  const f=await fixture(t),live=f.token(),revoked=f.token();
  const publicToken=auth.newShareToken();f.repository.createPublicShare({modelId:f.model.id,publicIdHash:publicToken.tokenHash,permissions:{view:true,measure:true}});
  f.database.prepare('UPDATE viewer_sessions SET revoked_at=? WHERE token_hash=?').run(new Date().toISOString(),auth.hashToken(revoked));
  // A public share capability is not a row in viewer_sessions.
  const invalid=[null,publicToken.token,crypto.randomBytes(32).toString('base64url'),f.token({expiresAt:new Date(0).toISOString()}),revoked,f.token({permissions:{view:false}}),f.token({subject:''}),f.token({audience:'client',subject:'shared-client',permissions:{view:true}}),f.token({audience:'client',permissions:{view:true,personalMeasurements:false}})];
  for(const bearer of invalid)for(const method of ['GET','PUT']){
    const response=await f.request(bearer,method,method==='PUT'?custom:undefined);assert.equal(response.status,403);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{code:'viewer_preferences_identity_required'});
  }
  for(const method of ['GET','PUT'])assert.equal((await f.request(null,method,method==='PUT'?custom:undefined,{Cookie:`ltds_viewer=${live}`})).status,403);
  assert.equal(f.database.prepare('SELECT COUNT(*) n FROM viewer_user_preferences').get().n,0);
});

test('preferences reject forged identity, unknown fields, unsupported profiles and nonboolean sidebar values',async t=>{
  const f=await fixture(t),bearer=f.token();
  for(const body of [[],{},{...custom,subject:'other'},{...custom,audience:'client'},{...custom,modelId:f.model.id},{...custom,unknown:true},{...custom,mouseProfile:'custom'},{...custom,mouseProfile:'Default'},{...custom,sidebarCollapsed:1},{mouseProfile:'default'},{sidebarCollapsed:false}]){
    const response=await f.request(bearer,'PUT',body);assert.equal(response.status,400);assert.deepEqual(await response.json(),{code:'invalid_viewer_preferences'});
  }
  for(const body of [null,custom.mouseProfile])assert.equal((await f.request(bearer,'PUT',body)).status,400);
  assert.deepEqual((await(await f.request(bearer)).json()).preferences,defaults);assert.equal(f.database.prepare('SELECT COUNT(*) n FROM viewer_user_preferences').get().n,0);
});

test('rate-limited preference writes do not overwrite an existing profile',async t=>{
  const f=await fixture(t),bearer=f.token();assert.equal((await f.request(bearer,'PUT',custom)).status,200);
  let key;f.repository.rateLimited=value=>{key=value;return true;};
  const response=await f.request(bearer,'PUT',{mouseProfile:'default',sidebarCollapsed:false});assert.equal(response.status,429);assert.equal(key,'viewer-preferences:ops:person-one');assert.deepEqual((await(await f.request(bearer)).json()).preferences,custom);
});
