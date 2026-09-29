import test from 'node:test';
import assert from 'node:assert/strict';
import {requestWorkspaceRenewalGrant} from '../workspace-renewal-transport.mjs';
import {WorkspaceSessionRenewal} from '../workspace-renewal.mjs';
const OPS='https://ops.example.test',VIEWER='https://viewer.example.test',ID='a7e240dc-985d-4bda-a7b8-17ad766a4438',GRANT='g'.repeat(40),TOKEN='t'.repeat(40),CSRF='c'.repeat(43);
const endpoint=OPS+'/api/viewer/workspace/session-renewal';
function response(url,body,status=200,overrides={}){const result=new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});Object.defineProperty(result,'url',{value:url});for(const[key,value]of Object.entries(overrides))Object.defineProperty(result,key,{value});return result;}
const challenge=()=>({protocolVersion:1,challenge:CSRF,expiresAt:Math.floor(Date.now()/1000)+120});
const grant=()=>({protocolVersion:1,requestId:ID,grant:GRANT,grantExpiresAt:new Date(Date.now()+60000).toISOString(),sessionTtlSeconds:1800,redeemUrl:VIEWER+'/api/v1/admin-sessions/redeem'});
const options={controllerOrigin:OPS,viewerOrigin:VIEWER,subject:'ops:staff',requestId:ID};
test('exact Ops protocol is credentialed CORS and never includes Viewer bearer/session ID',async()=>{
  const calls=[];const result=await requestWorkspaceRenewalGrant({...options,fetchImpl:async(url,init)=>{calls.push({url,init});return response(url,calls.length===1?challenge():grant(),calls.length===1?200:201);}});
  assert.equal(result,GRANT);assert.equal(calls[0].url,endpoint+'/challenge');assert.equal(calls[1].url,endpoint);
  for(const call of calls){assert.equal(call.init.credentials,'include');assert.equal(call.init.mode,'cors');assert.equal(call.init.redirect,'error');assert.equal(call.init.cache,'no-store');assert.equal(call.init.headers?.Authorization,undefined);}
  assert.deepEqual(JSON.parse(calls[1].init.body),{protocolVersion:1,requestId:ID,subject:'ops:staff'});
  assert.equal(calls[1].init.headers['X-CSRF-Token'],CSRF);assert.equal(calls[1].init.headers['Idempotency-Key'],ID);
});
test('untrusted origin, response URL, redirects, HTML, oversize and wrong correlation/target fail transiently',async()=>{
  for(const origin of [OPS+'/path','http://ops.example.test',OPS+'/',OPS+'?x=1'])await assert.rejects(requestWorkspaceRenewalGrant({...options,controllerOrigin:origin,fetchImpl:()=>assert.fail('must not fetch')}));
  for(const bad of [response('https://evil.test',challenge()),response(endpoint+'/challenge',challenge(),200,{redirected:true}),response(endpoint+'/challenge',challenge(),200,{headers:new Headers({'Content-Type':'text/html'})}),response(endpoint+'/challenge',{padding:'x'.repeat(17000)})])await assert.rejects(requestWorkspaceRenewalGrant({...options,fetchImpl:async()=>bad}),error=>error.renewalAuthenticationRequired!==true);
  for(const change of [{requestId:'other'},{redeemUrl:'https://evil.test/api/v1/admin-sessions/redeem'},{redeemUrl:VIEWER+'/api/v1/admin-sessions/redeem?redirect=evil'},{sessionTtlSeconds:0}])await assert.rejects(requestWorkspaceRenewalGrant({...options,fetchImpl:async url=>response(url,url.endsWith('/challenge')?challenge():{...grant(),...change})}));
});
test('only validated exact Ops auth errors are terminal; challenge expiry/default-off/network are transient',async()=>{
  for(const[status,error,terminal]of [[401,'Cloudflare Access authentication required',true],[403,'Global viewer.view permission required',true],[403,'Renewal CSRF challenge is invalid or expired',false],[403,'unknown',false],[404,'Not found',false],[503,'Workspace renewal is temporarily unavailable',false]]){
    await assert.rejects(requestWorkspaceRenewalGrant({...options,fetchImpl:async url=>response(url,{error},status)}),failure=>Boolean(failure.renewalAuthenticationRequired)===terminal);
  }
  await assert.rejects(requestWorkspaceRenewalGrant({...options,fetchImpl:async()=>{throw new TypeError('Failed to fetch');}}),failure=>failure.renewalAuthenticationRequired!==true);
});
function harness(fetchImpl){
  const timers=[],listeners=new Map(),sessions=[],expired=[];
  const envelope={accessToken:TOKEN,controllerOrigin:OPS,session:{id:'session',subject:'ops:staff',expiresAt:new Date(Date.now()+120000).toISOString()}};
  const windowRef={location:{origin:VIEWER},addEventListener:(key,value)=>listeners.set(key,value),removeEventListener:key=>listeners.delete(key)};
  const renewal=new WorkspaceSessionRenewal({controllerWindow:null,envelope,accessToken:TOKEN,fetchImpl,windowRef,documentRef:{visibilityState:'visible',addEventListener(){},removeEventListener(){}},randomUUID:()=>ID,setTimer:(handler,delay)=>{const timer={handler,delay};timers.push(timer);return timer;},clearTimer:timer=>{timer.cleared=true;},onSession:value=>sessions.push(value),onExpired:reason=>expired.push(reason)});
  renewal.start();return{renewal,envelope,timers,listeners,sessions,expired};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('no-opener timers/focus/401 waiters coalesce through grant and stable session redemption',async()=>{
  const calls=[];let context;
  context=harness(async(url,init)=>{calls.push({url,init});return response(url.startsWith('/')?VIEWER+url:url,url.endsWith('/challenge')?challenge():url===endpoint?grant():{...context.envelope,session:{...context.envelope.session,expiresAt:new Date(Date.now()+1800000).toISOString()}});});
  const one=context.renewal.waitForRenewal(),two=context.renewal.waitForRenewal();context.listeners.get('focus')();
  assert.deepEqual(await Promise.all([one,two]),[true,true]);assert.equal(calls.length,3);assert.equal(context.sessions.length,1);assert.equal(context.expired.length,0);
  assert.equal(calls[2].url,'/api/v1/admin-sessions/redeem');assert.equal(calls[2].init.headers.Authorization,'Bearer '+TOKEN);
  assert.ok(!JSON.stringify(calls.slice(0,2)).includes(TOKEN));context.renewal.dispose();
});
test('disposal and bounded abort watchdog discard late CORS responses',async()=>{
  for(const action of ['dispose','timeout']){
    let resolveFetch,signal;const context=harness(async(_url,init)=>{signal=init.signal;return new Promise(resolve=>{resolveFetch=resolve;});});
    context.renewal.requestRenewal('timer');
    if(action==='dispose')context.renewal.dispose();else context.timers.findLast(timer=>timer.delay===10000&&!timer.cleared).handler();
    assert.equal(signal.aborted,true);resolveFetch(response(endpoint+'/challenge',challenge()));await tick();
    assert.equal(context.sessions.length,0);assert.equal(context.renewal.pendingRequestId,null);context.renewal.dispose();
  }
});
test('signed-out recovery preserves work and unavailable endpoint retries without declaring revocation',async()=>{
  for(const signedOut of [false,true]){
    const context=harness(async url=>response(url,{error:signedOut?'Cloudflare Access authentication required':'Not found'},signedOut?401:404));
    context.renewal.requestRenewal('timer');await tick();
    assert.deepEqual(context.expired,signedOut?['expired']:[]);assert.equal(context.sessions.length,0);assert.equal(context.renewal.accessToken,TOKEN);
    if(!signedOut)assert.ok(context.timers.some(timer=>timer.delay===2000&&!timer.cleared));context.renewal.dispose();
  }
});
test('CORS redemption validates exact URL and stable identity before installing a session',async()=>{
  for(const changed of ['redirect','subject','token']){
    let context;context=harness(async url=>{
      if(url.endsWith('/challenge'))return response(url,challenge());if(url===endpoint)return response(url,grant());
      const body={...context.envelope,session:{...context.envelope.session}};if(changed==='subject')body.session.subject='ops:other';if(changed==='token')body.accessToken='x'.repeat(40);
      return response(changed==='redirect'?'https://evil.test':VIEWER+url,body);
    });context.renewal.requestRenewal('timer');await tick();assert.equal(context.sessions.length,0);assert.equal(context.expired.length,0);context.renewal.dispose();
  }
});

test('opener timeout falls back to CORS without parallel renewal or page navigation',async()=>{
  const calls=[];let context;context=harness(async url=>{calls.push(url);return response(url.startsWith('/')?VIEWER+url:url,url.endsWith('/challenge')?challenge():url===endpoint?grant():context.envelope);});
  const posted=[];context.renewal.controllerWindow={closed:false,postMessage:value=>posted.push(value)};
  context.renewal.requestRenewal('timer');assert.equal(posted[0].type,'ltds-viewer:workspace-session-expiring');assert.equal(calls.length,0);
  context.timers.findLast(timer=>timer.delay===10000&&!timer.cleared).handler();
  context.timers.findLast(timer=>timer.delay===2000&&!timer.cleared).handler();await tick();
  assert.equal(calls.length,3);assert.equal(context.sessions.length,1);assert.equal(context.expired.length,0);context.renewal.dispose();
});

test('an aborted waiter does not cancel another waiter and late transport retries are bounded',async()=>{
  const context=harness(async url=>response(url,{error:'Not found'},404));
  const abort=new AbortController(),one=context.renewal.waitForRenewal({signal:abort.signal}),two=context.renewal.waitForRenewal();abort.abort();assert.equal(await one,false);assert.equal(context.renewal.renewalWaiters.size,1);
  await tick();
  for(let index=1;index<5;index++){assert.equal(context.renewal.requestRenewal('retry'),true);await tick();}
  assert.equal(context.renewal.requestRenewal('retry'),false);assert.equal(context.expired.length,0);
  context.renewal.now=()=>Date.parse(context.envelope.session.expiresAt)+1;
  assert.equal(context.renewal.requestRenewal('expiry'),false);assert.deepEqual(context.expired,['expired']);assert.equal(await two,false);
});
