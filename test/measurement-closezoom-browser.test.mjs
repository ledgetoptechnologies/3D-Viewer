import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';

// Fresh hidden browser/profile and loopback synthetic source only. Never attach
// to the user's browser. The real workspace emits SVG using shipped projection.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const record={id:'11111111-1111-4111-8111-111111111111',name:'Close-zoom boundary',revision:7,modelId:'fixture-model',modelVersionId:'fixture-version',collection:'spatial3d',kind:'polygon',vertices:[[-.5,-.5,-4],[.5,-.5,-4],[.5,-.5,2],[-.5,-.5,2]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},visible:true};
const token='synthetic_closezoom_viewer_token_1234567890';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const browserPath=()=>[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
class Cdp{
  constructor(socket){this.socket=socket;this.sequence=0;this.pending=new Map();this.errors=[];socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')this.errors.push(m.params.exceptionDetails);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const value=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result?.value;}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Fixture closed'));}this.pending.clear();this.socket.close();}
}
async function waitFor(client,expression){const until=Date.now()+8000;while(Date.now()<until){if(await client.evaluate(expression))return;await delay(30);}throw new Error(`Overlay fixture not ready: ${JSON.stringify(client.errors)}`);}
function page(){return `<!doctype html><html><head><style>body{background:#121820;color:white;font:14px system-ui}#panel{position:absolute;left:830px;top:0;width:290px}#view{position:relative;width:800px;height:600px;background:#1a2634;overflow:hidden}.fixture-actions{margin-top:12px}</style><script type="importmap">{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/examples/jsm/"}}</script></head><body><div id="view"></div><div class="fixture-actions"><button data-camera="8">Zoom out</button><button data-camera="0">Behind-camera corners</button><button data-camera="2.05">Near-plane corners</button><button data-camera="-5">All behind</button></div><aside id="panel"></aside><script type="module">
import * as THREE from 'three';
import {createMeasurementWorkspace} from '/measurement-workspace.mjs';
import {projectMeasurementBoundary} from '/measurement-projection.mjs';
const view=document.querySelector('#view'),camera=new THREE.PerspectiveCamera(60,800/600,.1,100),vp=new THREE.Matrix4();
const clip=point=>new THREE.Vector4(...point,1).applyMatrix4(vp).toArray();
const context={mode:'model',element:view,host:view,pick:()=>null,project:(point,viewport)=>projectMeasurementBoundary([clip(point)],viewport).positions[0],projectBoundary:(points,viewport,options)=>projectMeasurementBoundary(points.map(clip),viewport,options),viewSignature:()=>String(camera.position.z)};
const workspace=createMeasurementWorkspace({panel:document.querySelector('#panel'),context:()=>context,token:()=>${JSON.stringify(token)},permitted:()=>true,toolChanged:()=>{},coordinateReference:()=>(${JSON.stringify(record.coordinateReference)}),toLonLat:p=>p});
function cameraAt(z){camera.position.z=z;camera.updateMatrixWorld(true);vp.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);workspace.tick({force:true});document.body.dataset.camera=String(z);}
for(const button of document.querySelectorAll('[data-camera]'))button.onclick=()=>cameraAt(Number(button.dataset.camera));
// Read-only test oracle over the real store, not the immutable fixture constant.
window.fixtureSnapshot=()=>JSON.stringify([...workspace.store.records.values()]);
cameraAt(8);document.body.dataset.ready='true';
</script></body></html>`;}
async function fixture(){
  const requests=[];
  const server=createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://fixture.invalid');
    if(url.pathname.startsWith('/api/')){requests.push({method:req.method,path:url.pathname});res.setHeader('Content-Type','application/json');if(req.method!=='GET'||req.headers.authorization!==`Bearer ${token}`){res.statusCode=403;return res.end('{}');}return res.end(JSON.stringify({measurements:url.searchParams.get('collection')==='spatial3d'?[record]:[],capabilities:{personalPersistence:true}}));}
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(page());}
    let file;if(/^\/[a-z0-9-]+\.(mjs|css)$/.test(url.pathname))file=path.join(root,url.pathname.slice(1));
    if(url.pathname.startsWith('/vendor/')&&/^\/[a-zA-Z0-9_./-]+$/.test(url.pathname)){const base=path.join(root,'node_modules','three'),candidate=path.resolve(base,url.pathname.slice(8));if(candidate.startsWith(base+path.sep))file=candidate;}
    if(!file||!existsSync(file)){res.statusCode=404;return res.end();}
    if(file.endsWith('.css')&&req.headers['sec-fetch-dest']==='script'){res.setHeader('Content-Type','application/javascript');return res.end(`const style=document.createElement('style');style.textContent=${JSON.stringify(readFileSync(file,'utf8'))};document.head.append(style);`);}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(file));
  }catch(error){res.statusCode=500;res.end(String(error));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{server,requests,origin:`http://127.0.0.1:${server.address().port}/`};
}
const overlay=client=>client.evaluate(`(()=>{const svg=document.querySelector('#view .measurement-overlay');return{markup:svg?.innerHTML||'',lines:[...svg.querySelectorAll('line')].map(line=>['x1','y1','x2','y2'].map(a=>Number(line.getAttribute(a)))),circles:[...svg.querySelectorAll('circle')].map(c=>['cx','cy','r'].map(a=>Number(c.getAttribute(a)))),fills:[...svg.querySelectorAll('polygon')].map(p=>({stroke:p.getAttribute('stroke'),points:p.getAttribute('points')}))};})()`);
const assertFinite=geometry=>{assert.doesNotMatch(geometry.markup,/NaN|Infinity|undefined/);for(const line of geometry.lines){assert.ok(line.every(Number.isFinite));for(let i=0;i<4;i++)assert.ok(line[i]>=-.001&&line[i]<=(i%2?600:800)+.001,`clipped SVG coordinate ${line[i]} is bounded`);}for(const circle of geometry.circles)assert.ok(circle.every(Number.isFinite));};
test('real measurement overlay preserves original visible edges across close zoom without a false closing edge',{timeout:60000},async t=>{
  const binary=browserPath();if(!binary){t.skip('Chromium-family browser required for isolated overlay regression.');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,server;
  try{
    const f=await fixture();server=f.server;profile=mkdtempSync(path.join(tmpdir(),'ltds-measurement-closezoom-browser-'));
    browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;while(!existsSync(active)&&Date.now()<until)await delay(50);assert.ok(existsSync(active));
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');await client.command('Emulation.setDeviceMetricsOverride',{width:1150,height:750,deviceScaleFactor:1,mobile:false});await client.command('Page.navigate',{url:f.origin});
    await waitFor(client,`location.href===${JSON.stringify(f.origin)}&&document.body?.dataset.ready==='true'&&document.querySelectorAll('#view .measurement-overlay line').length===4`);
    const original=await client.evaluate('fixtureSnapshot()');assert.deepEqual(JSON.parse(original),[record]);
    let geometry=await overlay(client);assertFinite(geometry);assert.equal(geometry.lines.length,4);assert.equal(geometry.circles.length,4);
    for(const z of [0,2.05]){
      await client.evaluate(`document.querySelector('[data-camera="${z}"]').click()`);
      await waitFor(client,`document.body?.dataset.camera==='${z}'&&document.querySelectorAll('#view .measurement-overlay line').length===3`);
      geometry=await overlay(client);assertFinite(geometry);assert.equal(geometry.lines.length,3,'only three original boundary edges intersect the viewport');assert.equal(geometry.circles.length,2,'clipped endpoints are not fabricated original handles');
      assert.ok(geometry.fills.every(fill=>fill.stroke==='none'),'clipped fill does not stroke an artificial boundary cap');
      assert.ok(!geometry.lines.some(line=>Math.abs(line[1]-600)<.001&&Math.abs(line[3]-600)<.001),'no false bottom viewport closing edge');
      // Analytic pinhole projection independent of the shipped clipping helper:
      // front edge endpoints are x=400±f*.5/depth, y=300+f*.5/depth.
      const projected=600/(2*Math.tan(Math.PI/6))*.5/(z+4),front=[400-projected,300+projected,400+projected,300+projected];
      assert.ok(geometry.lines.some(line=>line.every((value,index)=>Math.abs(value-front[index])<.01)||line.every((value,index)=>Math.abs(value-front[(index+2)%4])<.01)),'visible original front edge remains at its projected location');
      assert.equal(await client.evaluate('fixtureSnapshot()'),original,'camera-only navigation preserves canonical records');
      if(process.env.LTDS_CLOSEZOOM_BROWSER_SCREENSHOT&&z===0){const shot=await client.command('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.LTDS_CLOSEZOOM_BROWSER_SCREENSHOT,Buffer.from(shot.data,'base64'));}
    }
    await client.evaluate("document.querySelector('[data-camera=\"-5\"]').click()");await waitFor(client,"document.body?.dataset.camera==='-5'&&document.querySelectorAll('#view .measurement-overlay line').length===0");assertFinite(await overlay(client));
    await client.evaluate("document.querySelector('[data-camera=\"8\"]').click()");await waitFor(client,"document.querySelectorAll('#view .measurement-overlay line').length===4");assert.equal(await client.evaluate('fixtureSnapshot()'),original);
    assert.ok(f.requests.every(request=>request.method==='GET'),'zoom never mutates source records');assert.deepEqual(client.errors,[]);
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}unlock();
    if(profile){const absolute=path.resolve(profile);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-measurement-closezoom-browser-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Browser retained an isolated temporary profile lock: ${absolute}`);}}
  }
});
