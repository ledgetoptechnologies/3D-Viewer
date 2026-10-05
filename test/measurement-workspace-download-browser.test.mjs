import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';

// Real shipped workspace, isolated browser profile and loopback fixture API.
// Never intercept anchors, Blob, URL.createObjectURL or browser downloads.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const record={id:'11111111-1111-4111-8111-111111111111',name:'Synthetic, "fractional" pile',revision:2,collection:'map',kind:'polygon',vertices:[[0,0,0],[10,0,0],[10,10,0],[0,10,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},materialDensity:{value:1000,unit:'kg/m3',basis:'as_fed',dryMatterPercent:35,sourceNote:'Synthetic density, not farm data',sampledOn:'2026-10-05'},results:{method:'surface-cut-fill',status:'complete',calculationJobId:'22222222-2222-4222-8222-222222222222',calculationOrigin:'server-native-raster',cutM3:0.41379557771655207,fillM3:0.0123456789,netM3:0.4014498988165521,coverage:1,source:{assetId:'fixture-dsm',kind:'dsm',sha256:'a'.repeat(64),modelVersionId:'fixture-version',crs:'EPSG:32616',verticalUnit:'m',verticalUnitBasis:'gdal-band-unit'},reference:{type:'custom',elevationM:100.125},warnings:[]}};
const page=`<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{background:#10151b;color:white;font:14px sans-serif}#panel{width:350px}</style><script type="importmap">{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/examples/jsm/"}}</script></head><body><aside id="panel"></aside><script type="module">
import {createMeasurementWorkspace} from '/measurement-workspace.mjs';
const view=document.createElement('div');document.body.append(view);const context={mode:'dsm',element:view,host:view,project:p=>[p[0],p[1]],pick:()=>null,viewSignature:()=>'synthetic-static-map'};
const handle=createMeasurementWorkspace({panel:document.querySelector('#panel'),context:()=>context,token:()=> 'synthetic-fixture-only',permitted:()=>true,toolChanged:()=>{},coordinateReference:()=>({crs:'EPSG:32616',verticalUnit:'m'})});
window.fixture={dispose:()=>handle.dispose()};document.body.dataset.ready='true';
</script></body></html>`;

class Cdp {
  constructor(socket){this.socket=socket;this.next=0;this.pending=new Map();this.errors=[];socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')this.errors.push(m.params.exceptionDetails);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const r=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Fixture closed'));}this.pending.clear();this.socket.close();}
}
async function waitUntil(condition,label){const end=Date.now()+10000;while(Date.now()<end){if(await condition())return;await delay(30);}throw new Error(`Timed out: ${label}`);}
async function click(client,selector){const {x,y}=await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});}
function csvRow(line){const values=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){values.push(value);value='';}else value+=c;}assert.equal(quoted,false);values.push(value);return values;}

test('workspace export button downloads real CSV and JSON with canonical quantities and density provenance',{timeout:90000},async t=>{
  const binary=[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
  if(!binary){t.skip('Chromium-family browser required');return;}
  const unlock=await acquireBrowserHarnessLock({root});let server,browser,client,temporary;const requests=[];
  try{
    temporary=mkdtempSync(path.join(tmpdir(),'ltds-workspace-download-test-'));const downloads=path.join(temporary,'downloads'),profile=path.join(temporary,'profile');mkdirSync(downloads);mkdirSync(profile);
    server=createServer((req,res)=>{
      const url=new URL(req.url,'http://fixture.invalid'),pathname=url.pathname;
      if(pathname==='/api/v1/measurements'){
        requests.push({method:req.method,collection:url.searchParams.get('collection')});
        if(req.method!=='GET'){res.statusCode=405;return res.end();}
        res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({measurements:url.searchParams.get('collection')==='map'?[record]:[],capabilities:{personalPersistence:true}}));
      }
      if(pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(page);}
      let file;if(/^\/[a-z0-9-]+\.(mjs|css)$/.test(pathname))file=path.join(root,pathname.slice(1));
      if(pathname.startsWith('/vendor/')&&/^\/[a-zA-Z0-9_./-]+$/.test(pathname)){const base=path.join(root,'node_modules','three'),candidate=path.resolve(base,pathname.slice('/vendor/'.length));if(candidate.startsWith(base+path.sep))file=candidate;}
      if(!file||!existsSync(file)){res.statusCode=404;return res.end();}
      // Match Vite side-effect CSS loading without changing shipped JS.
      if(file.endsWith('.css')&&req.headers['sec-fetch-dest']==='script'){res.setHeader('Content-Type','application/javascript');return res.end(`const style=document.createElement('style');style.textContent=${JSON.stringify(readFileSync(file,'utf8'))};document.head.append(style);`);}
      res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(file));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort');await waitUntil(()=>existsSync(active),'browser startup');
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');await client.command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await client.command('Emulation.setDeviceMetricsOverride',{width:1200,height:1100,deviceScaleFactor:1,mobile:false});
    await client.command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await waitUntil(()=>client.evaluate("document.body?.dataset.ready==='true' && document.querySelectorAll('[data-record]').length===1"),'saved measurement loaded');
    assert.equal(await client.evaluate("document.querySelector('[data-m=units]').value"),'imperial');
    await click(client,'[data-m="export"]');const csvFile=path.join(downloads,'measurements.csv');await waitUntil(()=>existsSync(csvFile)&&!readdirSync(downloads).some(f=>f.endsWith('.crdownload')),'CSV actual download');
    const csv=readFileSync(csvFile,'utf8'),lines=csv.split('\r\n');assert.equal(lines.length,2);const headers=csvRow(lines[0]),values=csvRow(lines[1]);assert.equal(values.length,headers.length);const row=Object.fromEntries(headers.map((h,i)=>[h,values[i]]));
    assert.equal(row.name,record.name);assert.equal(row.display_volume_unit,'yd³');assert.equal(Number(row.cut_m3),record.results.cutM3);assert.equal(Number(row.fill_m3),record.results.fillM3);assert.equal(Number(row.net_m3),record.results.netM3);
    for(const [display,canonical]of [['cut_display_volume','cutM3'],['fill_display_volume','fillM3'],['net_display_volume','netM3']])assert.ok(Math.abs(Number(row[display])-record.results[canonical]/(0.9144**3))<1e-12);
    assert.deepEqual(JSON.parse(row.source_json),record.results.source);assert.deepEqual(JSON.parse(row.reference_json),record.results.reference);assert.equal(JSON.parse(row.provenance_json).calculationJobId,record.results.calculationJobId);
    assert.equal(row.density_unit,'kg/m3');assert.equal(row.density_basis,'as_fed');assert.equal(Number(row.density_value),1000);assert.equal(row.density_source_note,record.materialDensity.sourceNote);assert.equal(row.density_sampled_on,'2026-10-05');assert.equal(row.inventory_volume_basis,'cut_above_base');assert.equal(Number(row.inventory_volume_m3),record.results.cutM3);assert.equal(Number(row.estimated_as_fed_kg),record.results.cutM3*1000);assert.equal(Number(row.estimated_dry_matter_kg),record.results.cutM3*1000*.35);
    await client.evaluate("const format=document.querySelector('[data-m=format]');format.value='json';format.dispatchEvent(new Event('change',{bubbles:true}));");await click(client,'[data-m="export"]');const jsonFile=path.join(downloads,'measurements.json');await waitUntil(()=>existsSync(jsonFile)&&!readdirSync(downloads).some(f=>f.endsWith('.crdownload')),'JSON actual download');
    const json=JSON.parse(readFileSync(jsonFile,'utf8'));assert.equal(json.schemaVersion,1);assert.equal(json.coordinateUnits,'metres');assert.equal(json.displayUnits,'imperial');assert.equal(json.measurements.length,1);const saved=json.measurements[0];assert.deepEqual(saved.vertices,record.vertices);assert.deepEqual(saved.coordinateReference,record.coordinateReference);assert.deepEqual(saved.results,record.results);assert.deepEqual(saved.materialDensity,record.materialDensity);assert.equal(saved.materialMassEstimate.asFed.kilograms,record.results.cutM3*1000);
    assert.deepEqual(readdirSync(downloads).sort(),['measurements.csv','measurements.json']);assert.deepEqual(requests,[{method:'GET',collection:'spatial3d'},{method:'GET',collection:'map'}]);assert.deepEqual(client.errors,[]);await client.evaluate('fixture.dispose()');
    t.diagnostic(`Actual workspace downloads: CSV ${Buffer.byteLength(csv)} bytes; JSON ${readFileSync(jsonFile).length} bytes. No persistence writes or download interception.`);
  }finally{
    client?.close();if(browser){const exited=new Promise(r=>browser.once('exit',r));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(r=>server.close(r));}unlock();
    if(temporary){const absolute=path.resolve(temporary);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-workspace-download-test-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Isolated browser temporary lock retained: ${absolute}`);}}
  }
});
