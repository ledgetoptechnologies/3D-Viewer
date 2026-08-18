'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const test=require('node:test');
const {createClientGrantProxy,LOCAL_PATH,REMOTE_PATH}=require('../server/clientGrantProxy');
const {canonicalViewerEvent}=require('../server/viewerEvents');

test('client grant proxy signs an exact POST envelope and never forwards browser credentials',async t=>{
  const secret='s'.repeat(32),calls=[];
  const fetchImpl=async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify({grants:[],projects:[],associations:[]}),{status:200,headers:{'content-type':'application/json'}})};
  const app=express();app.use(express.json());
  const authorize=permission=>(req,res,next)=>{assert.equal(permission,'viewer.client_grants.manage');if(req.get('authorization')!=='Bearer valid')return res.sendStatus(401);req.adminPrincipal={subject:'ops:staff-one'};next()};
  createClientGrantProxy({config:{clientViewerSharesEnabled:true,opsAutomationBaseUrl:'https://incoming.ledgetopdroneservices.com',viewerEventSecret:secret,viewerEventKeyId:'viewer-v1'},authorize,fetchImpl}).mount(app);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`,{headers:{authorization:'Bearer valid',cookie:'admin=secret',origin:'https://evil.example'}});
  assert.equal(response.status,200);assert.equal(calls.length,1);assert.equal(calls[0].url,`https://incoming.ledgetopdroneservices.com${REMOTE_PATH}`);assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.credentials,undefined);assert.equal(calls[0].init.headers.Cookie,undefined);
  const body=calls[0].init.body,envelope=JSON.parse(body);assert.deepEqual(envelope,{subject:'ops:staff-one',action:'list'});
  const h=calls[0].init.headers,hash=crypto.createHash('sha256').update(body).digest('hex'),canonical=canonicalViewerEvent({method:'POST',path:REMOTE_PATH,timestamp:h['X-LTDS-Viewer-Timestamp'],nonce:h['X-LTDS-Viewer-Nonce'],bodySha256:hash}),expected=crypto.createHmac('sha256',secret).update(canonical).digest('base64url');assert.equal(h['X-LTDS-Viewer-Signature'],expected);
});

test('client grant proxy rejects absent permission before making an Ops request',async t=>{let called=false;const app=express();app.use(express.json());const authorize=()=> (_req,res)=>res.sendStatus(403);createClientGrantProxy({config:{},authorize,fetchImpl:async()=>{called=true}}).mount(app);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));const response=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`);assert.equal(response.status,403);assert.equal(called,false)});

for(const [name,response] of [['redirect',new Response('',{status:302,headers:{location:'https://evil.example'}})],['oversize',new Response('{}',{status:200,headers:{'content-length':String(1024*1024+1)}})],['malformed',new Response('{',{status:200})]])test(`client grant proxy fails closed on ${name} Ops responses`,async t=>{const app=express();const authorize=()=> (req,_res,next)=>{req.adminPrincipal={subject:'ops:staff-one'};next()};createClientGrantProxy({config:{opsAutomationBaseUrl:'https://incoming.ledgetopdroneservices.com',viewerEventSecret:'s'.repeat(32),viewerEventKeyId:'viewer-v1'},authorize,fetchImpl:async(_url,init)=>{if(name==='redirect'&&init.redirect==='error')throw new TypeError('redirect');return response.clone()}}).mount(app);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));const result=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`);assert.equal(result.status,502);assert.equal((await result.json()).code,'operations_unavailable')});
