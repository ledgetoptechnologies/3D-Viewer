#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NodeOdmProvider } from '../server/nodeOdmProvider.js';

const CONFIRMATION = 'I_UNDERSTAND_PROVIDER_TASKS_WILL_BE_CREATED_AND_REMOVED';
const MAX_CORPUS_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MIN_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 6 * 3600_000;
const PROVIDER_IMAGE_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,199}@sha256:[0-9a-f]{64}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (value && !value.startsWith('--')) { args.set(key, value); index += 1; }
    else args.set(key, true);
  }
  return args;
}

function positiveTimeout(value) {
  const timeoutMs = Number(value ?? 2 * 3600_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`--timeout-ms must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function deadlineSignal(deadline, label) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded the aggregate compatibility timeout`);
  return AbortSignal.timeout(remaining);
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function loadCorpus(corpus, deadline) {
  if (!corpus) throw new Error('destructive mode requires --corpus');
  const corpusRoot = fs.realpathSync.native(corpus);
  const extensions = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);
  const files = [];
  let totalBytes = 0;
  for (const entry of fs.readdirSync(corpusRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
    const absolutePath = path.join(corpusRoot, entry.name);
    const size = fs.statSync(absolutePath).size;
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) throw new Error('compatibility corpus contains an invalid or oversized file');
    if (totalBytes > MAX_CORPUS_BYTES - size) throw new Error('compatibility corpus exceeds the 2 GiB aggregate limit');
    totalBytes += size;
    files.push({ absolutePath, relativePath: entry.name, size });
  }
  files.sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0);
  if (!files.length || files.length > 50) throw new Error('compatibility corpus must contain 1-50 image files in its top-level directory');
  const manifest = [];
  for (const file of files) {
    if (Date.now() >= deadline) throw new Error('corpus hashing exceeded the aggregate compatibility timeout');
    manifest.push(`${file.relativePath}\t${file.size}\t${await hashFile(file.absolutePath)}`);
  }
  return {
    files: files.map(({ absolutePath, relativePath }) => ({ absolutePath, relativePath })),
    fileCount: files.length,
    totalBytes,
    manifestSha256: crypto.createHash('sha256').update(`${manifest.join('\n')}\n`).digest('hex'),
  };
}

async function removeAndVerify(provider, uuid, label) {
  let lastError = null;
  try { await provider.remove(uuid); }
  catch (error) {
    if (error.code === 'provider_task_not_found') return;
    if (error.status) {
      const cleanupError = new Error(`${label} removal was rejected`);
      cleanupError.code = 'provider_cleanup_unverified';
      cleanupError.cause = error;
      throw cleanupError;
    }
    lastError = error;
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await provider.status(uuid); }
    catch (error) {
      if (error.code === 'provider_task_not_found') return;
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const error = new Error(`${label} cleanup could not be verified`);
      error.code = 'provider_cleanup_unverified';
      error.cause = lastError;
      throw error;
    }
    await delay(500);
  }
}

const args = parseArguments(process.argv.slice(2));
const endpoint = args.get('--endpoint');
const providerType = args.get('--provider-type') || 'nodeodm';
const tokenEnv = args.get('--token-env') || 'ODM_PROVIDER_TOKEN';
const timeoutMs = positiveTimeout(args.get('--timeout-ms'));
if (!endpoint) throw new Error('--endpoint is required');
if (!['nodeodm', 'clusterodm'].includes(providerType)) throw new Error('--provider-type must be nodeodm or clusterodm');
const deadline = Date.now() + timeoutMs;
const provider = new NodeOdmProvider({ endpoint, providerType, token:process.env[tokenEnv] || '', transferTimeoutMs:timeoutMs });
const capability = await provider.capabilities();
console.log(JSON.stringify({
  mode:'read-only', providerType, apiVersion:capability.capabilities.apiVersion,
  engine:capability.capabilities.engine, engineVersion:capability.capabilities.engineVersion,
  optionCount:capability.capabilities.options.length, maxImages:capability.capabilities.maxImages,
  capabilityFingerprint:capability.fingerprint,
}, null, 2));

if (args.has('--destructive')) {
  if (args.get('--confirm') !== CONFIRMATION) throw new Error(`destructive mode requires --confirm ${CONFIRMATION}`);
  const providerImage = String(args.get('--provider-image') || '');
  if (!PROVIDER_IMAGE_PATTERN.test(providerImage)) throw new Error('destructive mode requires --provider-image with an immutable sha256 digest');
  const corpus = await loadCorpus(args.get('--corpus'), deadline);
  const uuid = crypto.randomUUID();
  const cancelUuid = crypto.randomUUID();
  let mainMayExist = false;
  let cancelMayExist = false;
  let result = null;
  let operationError = null;
  const cleanupErrors = [];
  try {
    mainMayExist = true;
    await provider.initialize({ uuid, name:'LTDS compatibility verification', options:{'pc-ept':true,gltf:true,'3d-tiles':true}, outputs:['all.zip'] }, {signal:deadlineSignal(deadline, 'provider initialization')});
    await provider.upload(uuid, corpus.files, {signal:deadlineSignal(deadline, 'provider upload')});
    await provider.commit(uuid, {signal:deadlineSignal(deadline, 'provider commit')});
    let finalStatus = null;
    for (;;) {
      const status = await provider.status(uuid, {signal:deadlineSignal(deadline, 'provider status')});
      await provider.output(uuid, 0, {signal:deadlineSignal(deadline, 'provider output')});
      if (TERMINAL.has(status.status)) { finalStatus = status; break; }
      await delay(Math.min(5000, Math.max(1, deadline - Date.now())));
    }
    if (finalStatus.status !== 'completed') throw new Error(`provider compatibility task ended as ${finalStatus.status}`);
    const response = await provider.downloadAll(uuid, {signal:deadlineSignal(deadline, 'provider download')});
    const outputHash = crypto.createHash('sha256');
    let outputBytes = 0;
    for await (const chunk of response.body) {
      outputBytes += chunk.byteLength;
      if (outputBytes > 20 * 1024 * 1024 * 1024) throw new Error('all.zip exceeded the 20 GiB verification limit');
      outputHash.update(chunk);
    }
    if (!outputBytes) throw new Error('all.zip was empty');

    cancelMayExist = true;
    await provider.initialize({ uuid:cancelUuid, name:'LTDS cancellation verification', options:{}, outputs:[] }, {signal:deadlineSignal(deadline, 'cancellation initialization')});
    await provider.upload(cancelUuid, corpus.files, {signal:deadlineSignal(deadline, 'cancellation upload')});
    await provider.commit(cancelUuid, {signal:deadlineSignal(deadline, 'cancellation commit')});
    const cancelDeadline = Math.min(deadline, Date.now() + 5 * 60_000);
    for (;;) {
      const status = await provider.status(cancelUuid, {signal:deadlineSignal(cancelDeadline, 'cancellation readiness')});
      if (['queued_upstream', 'running'].includes(status.status)) break;
      if (TERMINAL.has(status.status)) throw new Error(`provider cancellation task became ${status.status} before cancellation`);
      await delay(Math.min(1000, Math.max(1, cancelDeadline - Date.now())));
    }
    await provider.cancel(cancelUuid, {signal:deadlineSignal(cancelDeadline, 'provider cancellation')});
    let cancelStatus = null;
    for (;;) {
      cancelStatus = await provider.status(cancelUuid, {signal:deadlineSignal(cancelDeadline, 'cancellation status')});
      if (cancelStatus.status === 'cancelled') break;
      if (['completed', 'failed'].includes(cancelStatus.status)) throw new Error(`provider cancellation returned ${cancelStatus.status}`);
      await delay(Math.min(1000, Math.max(1, cancelDeadline - Date.now())));
    }
    result = {
      mode:'destructive', result:'compatible', providerType, providerImage,
      corpus:{fileCount:corpus.fileCount,totalBytes:corpus.totalBytes,manifestSha256:corpus.manifestSha256},
      taskStatus:finalStatus.status, downloadBytes:outputBytes, downloadSha256:outputHash.digest('hex'),
      cancelStatus:cancelStatus.status,
    };
  } catch (error) { operationError = error; }
  finally {
    if (cancelMayExist) try { await removeAndVerify(provider, cancelUuid, 'cancellation task'); } catch (error) { cleanupErrors.push(error); }
    if (mainMayExist) try { await removeAndVerify(provider, uuid, 'processing task'); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) {
    const cleanupError = new Error('provider compatibility cleanup could not be verified');
    cleanupError.code = 'provider_cleanup_unverified';
    cleanupError.cause = cleanupErrors[0];
    if (operationError) cleanupError.operationError = operationError;
    throw cleanupError;
  }
  if (operationError) throw operationError;
  console.log(JSON.stringify(result, null, 2));
}
