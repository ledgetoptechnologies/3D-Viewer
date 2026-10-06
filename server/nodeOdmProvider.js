'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeLogMessage } = require('./processingSecurity');

const STATUS = Object.freeze({ 10: 'queued_upstream', 20: 'running', 30: 'failed', 40: 'completed', 50: 'cancelled' });
function providerRetryDelay(value,now=Date.now()) {
  if(value==null)return null;
  const raw=String(value).trim();let delay=Number(raw);
  if(Number.isFinite(delay))delay*=1000;
  else{const date=Date.parse(raw);if(!Number.isFinite(date))return null;delay=date-now;}
  return Number.isFinite(delay)&&delay>0?Math.max(5_000,Math.min(5*60_000,delay)):null;
}

async function boundedText(response,maxBytes) { const reader=response.body.getReader();const chunks=[];let total=0;try{for(;;){let next;try{next=await reader.read();}catch(cause){throw Object.assign(new Error('ODM response transfer was interrupted'),{code:'provider_unreachable',cause});}const {done,value}=next;if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel('provider response exceeds size limit');throw new Error('provider response exceeds size limit');}chunks.push(value);}}finally{reader.releaseLock();}return Buffer.concat(chunks.map((c)=>Buffer.from(c))).toString('utf8'); }
async function boundedJson(response,maxBytes=1024*1024){if(!String(response.headers.get('content-type')||'').includes('json'))throw new Error('provider returned an unexpected content type');return JSON.parse(await boundedText(response,maxBytes));}

function checkedAction(value, action, uuid=null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error(`ODM ${action} returned an invalid response`), {code:'provider_request_failed'});
  if (Object.hasOwn(value,'error') || value.success === false) {
    const detail=typeof value.error==='string'?sanitizeLogMessage(value.error).slice(0,1000):'The provider rejected the request';
    const busy=/maximum number of concurrent tasks|maximum concurrent tasks/i.test(detail);
    const rateLimited=/uuh,\s*slow down|sending a lot of tasks|too many requests|rate limit/i.test(detail);
    const unavailable=/no nodes are online|no nodes available|no processing nodes/i.test(detail);
    throw Object.assign(new Error(`ODM ${action} failed: ${detail}`), {code:busy?'provider_busy':rateLimited?'provider_rate_limited':unavailable?'provider_unavailable':'provider_request_failed',...((busy||rateLimited||unavailable)?{retryAfterMs:rateLimited?300_000:30_000}:{}),...(busy?{explicitCapacityRejection:true}:{})});
  }
  if(uuid && Object.hasOwn(value,'uuid') && value.uuid!==uuid)throw Object.assign(new Error(`ODM ${action} returned a different task UUID`),{code:'provider_request_failed'});
  return value;
}

function optionArray(options) {
  return Object.entries(options || {}).map(([name, value]) => ({ name, value }));
}
function typedDefault(type,value){if(type==='bool'&&typeof value==='string')return value.toLowerCase()==='true';if(type==='int'){const n=Number(value);return Number.isInteger(n)?n:value;}if(type==='float'){const n=Number(value);return Number.isFinite(n)?n:value;}return value;}

function providerCapabilityError(code, message) {
  return Object.assign(new Error(message), { code });
}

function detectProviderType(info) {
  const validInfo = info && typeof info === 'object' && !Array.isArray(info)
    && typeof info.version === 'string' && /^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/.test(info.version)
    && typeof info.engine === 'string' && info.engine.length > 0 && info.engine.length <= 120
    && typeof info.engineVersion === 'string' && info.engineVersion.length > 0 && info.engineVersion.length <= 120
    && Number.isSafeInteger(info.taskQueueCount) && info.taskQueueCount >= 0
    && Object.hasOwn(info, 'maxImages') && (info.maxImages === null || (Number.isSafeInteger(info.maxImages) && info.maxImages >= 1));
  if (!validInfo) throw providerCapabilityError('provider_probe_unsupported', 'Endpoint does not expose the supported NodeODM capability schema.');

  // ClusterODM's official proxy deliberately reports these three sentinel
  // resource values from /info. Combined with its 1.x API line this is
  // positive proxy evidence, not a guess based only on a version number.
  const clusterSentinel = info.totalMemory === 99999999999
    && info.availableMemory === 99999999999
    && info.cpuCores === 99999999999;
  if (/^1\./.test(info.version) && clusterSentinel) return 'clusterodm';
  if (/^2\./.test(info.version) && !clusterSentinel) return 'nodeodm';
  throw providerCapabilityError('provider_probe_ambiguous', 'The endpoint is NodeODM-compatible, but its engine type cannot be identified safely.');
}

class NodeOdmProvider {
  constructor({ endpoint, token = '', fetchImpl = fetch, timeoutMs = 30000, transferTimeoutMs = 6*3600_000, providerType = null }) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid provider endpoint');
    this.endpoint = url.toString().replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.transferTimeoutMs = transferTimeoutMs;
    this.providerType = providerType;
  }

  url(route, query = {}) {
    const result = new URL(`${this.endpoint}${route}`);
    if (this.token) result.searchParams.set('token', this.token);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) result.searchParams.set(key, String(value));
    return result;
  }

  async request(route, init = {}, query = {}, { timeoutMs=this.timeoutMs, signal=null } = {}) {
    const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([timeout,signal]):timeout;
    let response;
    try { response = await this.fetch(this.url(route, query), { ...init, redirect:'error', signal:combined }); }
    catch(cause) {
      if(signal?.aborted)throw cause;
      const transportCode=cause?.cause?.code||cause?.code||'';
      const tls=/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(transportCode);
      throw Object.assign(new Error(tls?'ODM TLS verification failed':'ODM endpoint is temporarily unreachable'),{code:tls?'provider_tls_failed':'provider_unreachable',cause});
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      const error = new Error(`ODM request failed with HTTP ${response.status}`);
      error.code = response.status === 404 ? 'provider_task_not_found' :
        [401,403].includes(response.status)?'provider_authentication_failed':
        response.status===429?'provider_rate_limited':response.status>=500?'provider_unavailable':'provider_request_failed';
      error.status = response.status;
      if(['provider_rate_limited','provider_busy','provider_unavailable'].includes(error.code))error.retryAfterMs=providerRetryDelay(response.headers.get('retry-after'))||30_000;
      throw error;
    }
    return response;
  }

  async capabilities() {
    const [infoResponse, optionsResponse] = await Promise.all([this.request('/info'), this.request('/options')]);
    if (!String(infoResponse.headers.get('content-type')||'').includes('json') || !String(optionsResponse.headers.get('content-type')||'').includes('json')) throw new Error('provider returned an unexpected content type');
    const info = JSON.parse(await boundedText(infoResponse,1024*1024)); const options = JSON.parse(await boundedText(optionsResponse,4*1024*1024));
    if (!Array.isArray(options)) throw providerCapabilityError('provider_probe_unsupported', 'Endpoint returned an incompatible processing-options response.');
    const detectedType = detectProviderType(info);
    if (this.providerType && detectedType !== this.providerType) throw providerCapabilityError('provider_type_mismatch', 'The detected provider engine no longer matches the configured engine type.');
    const normalizedOptions = options.slice(0,1000).map((item) => {const type=String(item.type||'string');return { name:String(item.name).slice(0,120),type,domain:item.domain??null,help:String(item.help||'').slice(0,4000),value:typedDefault(type,item.value),rawDefault:item.value };});
    const capabilities = {
      apiVersion: info.version, engine: info.engine, engineVersion: info.engineVersion,
      maxImages: info.maxImages ?? null, maxParallelTasks: info.maxParallelTasks ?? null,
      taskQueueCount: Number(info.taskQueueCount || 0), totalMemory: info.totalMemory ?? null,
      availableMemory: info.availableMemory ?? null, cpuCores: info.cpuCores ?? null,
      providerType: detectedType, detectionMethod: 'capability-signature', options: normalizedOptions,
      testedBaseline: detectedType === 'clusterodm' ? '1.5.x' : '2.2.3',
      compatibilityWarning: null,
    };
    const compatibilityContract={apiVersion:capabilities.apiVersion,engine:capabilities.engine,engineVersion:capabilities.engineVersion,maxImages:capabilities.maxImages,maxParallelTasks:capabilities.maxParallelTasks,providerType:capabilities.providerType,options:capabilities.options};
    return { capabilities, fingerprint: crypto.createHash('sha256').update(JSON.stringify(compatibilityContract)).digest('hex') };
  }

  async initialize({ uuid, name, options, outputs }, { signal=null } = {}) {
    const body = new FormData();
    if (name) body.set('name', name);
    body.set('options', JSON.stringify(optionArray(options)));
    if (outputs) body.set('outputs', JSON.stringify(outputs));
    const response = await this.request('/task/new/init', { method:'POST', headers:{ 'set-uuid': uuid }, body }, {}, {signal});
    const result = checkedAction(await boundedJson(response),'initialize',uuid);
    if (!result.uuid || result.uuid !== uuid) throw new Error('provider did not honor the assigned task UUID');
    return result;
  }

  async upload(uuid, files, { signal=null } = {}) {
    const basenames = new Set();
    for (const file of files) { const name=path.basename(file.relativePath||file.absolutePath).toLowerCase(); if(basenames.has(name)) throw Object.assign(new Error('dataset contains duplicate source basenames'),{code:'duplicate_source_basename'}); basenames.add(name); }
    const body = new FormData();
    for (const file of files) {
      const blob = file.buffer == null ? await fs.openAsBlob(file.absolutePath) :
        new Blob([Buffer.from(file.buffer)], { type: 'text/plain' });
      body.append('images', blob, path.basename(file.relativePath || file.absolutePath));
    }
    return checkedAction(await boundedJson(await this.request(`/task/new/upload/${encodeURIComponent(uuid)}`, { method:'POST', body }, {}, {timeoutMs:this.transferTimeoutMs,signal})),'upload');
  }

  async commit(uuid,{signal=null}={}) { return checkedAction(await boundedJson(await this.request(`/task/new/commit/${encodeURIComponent(uuid)}`, { method:'POST' },{}, {signal})),'commit',uuid); }
  async status(uuid,{signal=null}={}) {
    const info = await boundedJson(await this.request(`/task/${encodeURIComponent(uuid)}/info`,{}, {}, {signal}),1024*1024);
    if (typeof info?.error === 'string') {
      const error = new Error('ODM task info request failed');
      error.code = /not found|no task table entry/i.test(info.error) ? 'provider_task_not_found' : 'provider_request_failed';
      throw error;
    }
    if (!info || info.uuid !== uuid || !info.status || !Number.isFinite(Number(info.status.code))) throw new Error('provider returned an incompatible task response');
    return { uuid:info.uuid, status:STATUS[Number(info.status?.code)] || 'unknown', statusCode:Number(info.status?.code),
      progress:Math.max(0,Math.min(1,Number(info.progress||0)/100)), imagesCount:info.imagesCount,
      processingDurationMs:require('./processingTiming').providerDurationMs(info.processingTime),
      ...Object.fromEntries(['engine','engineVersion'].filter(key=>typeof info[key]==='string'&&/^[A-Za-z0-9._+ -]{1,120}$/.test(info[key])).map(key=>[key,info[key]])) };
  }
  async output(uuid, fromLine = 0,{signal=null}={}) {
    if(!Number.isSafeInteger(fromLine)||fromLine<0)throw new Error('invalid provider output cursor');
    const value=await boundedJson(await this.request(`/task/${encodeURIComponent(uuid)}/output`, {}, { line:fromLine },{signal}),4*1024*1024);
    if(value&&typeof value==='object'&&!Array.isArray(value))checkedAction(value,'output');
    let lines;
    // NodeODM/NodeODX and ClusterODM return arrays. Preserve blank entries and
    // commas: the cursor counts provider records, not nonempty display lines.
    if(Array.isArray(value)&&value.every(line=>typeof line==='string'))lines=value;
    else if(typeof value==='string'){lines=value?value.split(/\r?\n/):[];if(lines.at(-1)==='')lines.pop();}
    else throw Object.assign(new Error('ODM output returned an invalid response'),{code:'provider_request_failed'});
    const nextLine=fromLine+lines.length;if(!Number.isSafeInteger(nextLine))throw new Error('provider output cursor overflow');
    return{lines,nextLine};
  }
  async cancel(uuid,{signal=null}={}) {
    const body = new URLSearchParams({ uuid });
    return checkedAction(await boundedJson(await this.request('/task/cancel', { method:'POST', headers:{'content-type':'application/x-www-form-urlencoded'}, body },{}, {signal})),'cancel');
  }
  async remove(uuid,{signal=null}={}) { const body=new URLSearchParams({uuid});return checkedAction(await boundedJson(await this.request('/task/remove',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body},{},{signal})),'remove'); }
  async downloadAll(uuid,{signal=null}={}) { return this.request(`/task/${encodeURIComponent(uuid)}/download/all.zip`,{}, {}, {timeoutMs:this.transferTimeoutMs,signal}); }
}

module.exports = { NodeOdmProvider, STATUS, boundedJson, boundedText, checkedAction, optionArray, typedDefault, detectProviderType, providerRetryDelay };
