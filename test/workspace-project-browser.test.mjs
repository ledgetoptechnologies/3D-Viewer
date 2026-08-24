import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArrayBuffer } from 'geotiff';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = 'browser_workspace_token_1234567890abcdef';
const orthophotoFixture = Buffer.from(writeArrayBuffer(new Uint8Array([
  238,80,7, 255,150,48,
  34,97,74, 109,190,140,
]), { width:2, height:2, SamplesPerPixel:3, BitsPerSample:[8,8,8], PhotometricInterpretation:2, PlanarConfiguration:1 }));

const fixtures = {
  projects: [
    { id: 'project-johnson', displayName: 'Johnson Road Survey', description: 'Road corridor reconstruction', status: 'active' },
    { id: 'project-quarry', displayName: 'Alpha Quarry', description: 'Quarry progress capture', status: 'active' },
  ],
  datasets: [
    { id: 'dataset-johnson', projectId: 'project-johnson', displayName: 'Johnson imagery', status: 'finalized', fileCount: 48, byteSize: 7340032 },
    { id: 'dataset-quarry', projectId: 'project-quarry', displayName: 'Quarry imagery', status: 'finalized', fileCount: 12, byteSize: 1048576 },
  ],
  tasks: [
    {
      id: 'task-johnson', projectId: 'project-johnson', datasetId: 'dataset-johnson', displayName: 'Johnson reconstruction',
      status: 'processing', createdAt: '2026-08-19T12:00:00.000Z',
      metrics: { sourceImageCount: 48 },
      latestAttempt: {
        id: 'attempt-johnson', providerId: 'provider-nodeodm', status: 'running',
        createdAt: '2026-08-19T12:00:00.000Z', startedAt: '2026-08-19T12:01:00.000Z', updatedAt: '2026-08-19T12:05:00.000Z',
      },
    },
    {
      id: 'task-quarry', projectId: 'project-quarry', datasetId: 'dataset-quarry', displayName: 'Quarry reconstruction',
      status: 'ready_for_review', createdAt: '2026-08-18T12:00:00.000Z', metrics: { sourceImageCount: 12 },
      latestAttempt: { id: 'attempt-quarry', providerId: 'provider-nodeodm', status: 'ready_for_review', createdAt: '2026-08-18T12:00:00.000Z', updatedAt: '2026-08-18T12:05:00.000Z' },
    },
  ],
  providers: [
    {
      id: 'provider-nodeodm', displayName: 'TrueNAS NodeODM', type: 'nodeodm', endpoint: 'https://nodeodm.example.test',
      enabled: true, admissionLimit: 2, runtimeHealth: 'healthy', capabilityFingerprint: 'browser-fingerprint', credential: { configured: true, mode: 'token' },
      capabilities: {
        providerType: 'nodeodm', apiVersion: '2.2.3', engine: 'ODM', engineVersion: '3.5.0', taskQueueCount: 1,
        maxParallelTasks: 2, options: [{ name: 'orthophoto-resolution', type: 'integer', value: 5 }],
      },
    },
  ],
  presets: [{ id: 'preset-fast', displayName: 'Fast', description: '', providerType: 'nodeodm', capabilityFingerprint: 'browser-fingerprint', options: {}, enabled: true, builtIn: false }],
  outputs: [{
    id: 'output-johnson', taskId: 'task-johnson', modelId: 'model-johnson', displayName: 'Johnson output',
    status: 'published', activePublished: true, byteSize: 4096, assetCount: 3, assetKinds: ['glb', 'ortho', 'report'],
    lod: { status: 'fallback', canGenerate: false, canRetry: true, jobId: 'derivative-stale-fallback', reason: 'Imported tiles did not verify.' },
    downloadUrl: '/api/v1/processing/outputs/output-johnson/assets/glb',
    reportUrl: '/api/v1/processing/outputs/output-johnson/assets/report',
    viewSessionUrl: '/api/v1/processing/outputs/output-johnson/view-sessions',
  }, {
    id: 'output-johnson-archived', taskId: 'task-johnson', modelId: 'model-johnson-old', displayName: 'Johnson archived output',
    status: 'archived', activePublished: false, byteSize: 2048, assetCount: 1, assetKinds: [],
  }, {
    id: 'output-quarry-ready', taskId: 'task-quarry', modelId: 'model-quarry', attemptId: 'attempt-quarry', displayName: 'Quarry ready output',
    status: 'ready', activePublished: false, byteSize: 3072, assetCount: 3, assetKinds: ['glb', 'ortho', 'report'],
    lod: { status: 'eligible', canGenerate: true },
    downloadUrl: '/api/v1/processing/outputs/output-quarry-ready/assets/glb',
    reportUrl: '/api/v1/processing/outputs/output-quarry-ready/assets/report',
  }],
  operations: [{
    id: 'operation-running', type: 'webodm_task_import', subject: 'server import', projectId: 'project-johnson',
    status: 'leased', phase: 'adopting', progress: .35, source: { kind: 'server_zip', browserTransferRequired: false, transferComplete: true },
    attemptCount: 1, heartbeatAt: '2026-08-19T13:04:00.000Z', createdAt: '2026-08-19T13:00:00.000Z', updatedAt: '2026-08-19T13:04:00.000Z',
  }, {
    id: 'operation-failed', type: 'webodm_task_import', subject: 'failed import', projectId: 'project-quarry',
    status: 'failed', phase: 'failed', progress: .25, source: { kind: 'server_folder', browserTransferRequired: false, transferComplete: true },
    attemptCount: 1, errorCode: 'invalid_archive', errorMessage: 'The archive could not be imported.', createdAt: '2026-08-19T11:00:00.000Z', updatedAt: '2026-08-19T11:02:00.000Z',
  }],
  derivatives: [
    { id: 'derivative-running', attemptId: 'attempt-running', type: 'lod_audit', status: 'leased', optional: true, result: {}, taskId: 'task-running', taskDisplayName: 'Existing tile audit', projectId: 'project-johnson', projectDisplayName: 'Johnson Road Survey', heartbeatAt: '2026-08-19T13:04:00.000Z', createdAt: '2026-08-19T13:00:00.000Z', updatedAt: '2026-08-19T13:04:00.000Z' },
    { id: 'derivative-queued', attemptId: 'attempt-queued', type: 'mesh_tiles', status: 'pending', optional: true, result: {}, taskId: 'task-queued', taskDisplayName: 'Queued tile model', projectId: 'project-quarry', projectDisplayName: 'Alpha Quarry', createdAt: '2026-08-19T12:00:00.000Z', updatedAt: '2026-08-19T12:00:00.000Z' },
    { id: 'derivative-failed', attemptId: 'attempt-johnson', type: 'mesh_tiles', status: 'failed', optional: true, result: { error: 'Tile conversion failed; the original model remains available.' }, taskId: 'task-johnson', taskDisplayName: 'Johnson task', projectId: 'project-johnson', projectDisplayName: 'Johnson Road Survey', createdAt: '2026-08-19T11:00:00.000Z', updatedAt: '2026-08-19T11:02:00.000Z' },
  ],
};

function browserPath() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find(existsSync) || null;
}

async function removeBrowserProfile(profile, t) {
  if (!profile) return;
  const resolved = path.resolve(profile);
  const expectedPrefix = path.resolve(tmpdir(), 'ltds-viewer-browser-');
  if (!resolved.startsWith(expectedPrefix)) throw new Error(`refusing to remove unexpected browser profile: ${resolved}`);
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(lastError?.code)) {
    t.diagnostic(`Windows retained a lock on temporary browser profile ${resolved}; functional browser assertions completed.`);
    return;
  }
  throw lastError;
}

function json(response, status = 200) {
  return { status, body: Buffer.from(JSON.stringify(response)), type: 'application/json; charset=utf-8' };
}

function apiResponse(url, runtime, method = 'GET', body = {}) {
  const pathname = url.pathname;
  if (pathname === '/api/v1/admin-sessions/current') {
    return json({
      controllerOrigin: 'https://ops.example.test',
      session: {
        id: 'browser-session', subject: 'ops:browser-audit', displayUnits: 'imperial',
        permissions: ['viewer.projects.read','viewer.projects.write','viewer.datasets.read','viewer.datasets.write','viewer.datasets.import','viewer.processing.read','viewer.processing.write','viewer.processing.publish','viewer.providers.read','viewer.providers.write','viewer.storage.purge','viewer.gcp.read','viewer.gcp.write','viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.client_grants.manage'],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    });
  }
  if (pathname === '/api/v1/projects') return json({ projects: fixtures.projects.map(item=>runtime.archivedProjects.has(item.id)?{...item,status:'archived'}:item), nextCursor: null });
  if (pathname === '/api/v1/datasets') return json({ datasets: fixtures.datasets, nextCursor: null });
  if (pathname === '/api/v1/tasks') return json({ tasks: fixtures.tasks.map(item=>runtime.archivedTasks.has(item.id)?{...item,status:'archived'}:item), nextCursor: null });
  if (pathname === '/api/v1/processing/providers' && method === 'GET') return json({ providers: fixtures.providers });
  if (pathname === '/api/v1/processing/providers/provider-nodeodm' && method === 'PATCH') return json({ provider: { ...fixtures.providers[0], ...body } });
  if (pathname === '/api/v1/processing/providers/provider-nodeodm/credential' && ['PUT', 'DELETE'].includes(method)) return json({ provider: fixtures.providers[0] });
  if (pathname === '/api/v1/processing/providers/provider-nodeodm/capabilities/probe' && method === 'POST') return json({ capabilities: fixtures.providers[0].capabilities, fingerprint: 'browser-fingerprint' });
  if (pathname === '/api/v1/processing/presets' && method === 'GET') return json({ presets: fixtures.presets });
  if (pathname === '/api/v1/processing/presets' && method === 'POST') return json({ preset: { id: 'preset-new', providerType: 'nodeodm', capabilityFingerprint: 'browser-fingerprint', ...body } }, 201);
  if (pathname.startsWith('/api/v1/processing/presets/') && ['PATCH', 'DELETE'].includes(method)) return method === 'DELETE' ? { status: 204, body: Buffer.alloc(0), type: 'application/json' } : json({ preset: { ...fixtures.presets[0], ...body } });
  if (pathname === '/api/v1/processing/outputs') return json({ outputs: fixtures.outputs, nextCursor: null });
  if (pathname === '/api/v1/processing/outputs/output-johnson/shares') return json({ shares: [] });
  if (pathname === '/api/v1/processing/outputs/output-johnson/view-sessions' && method === 'POST') return json({ embedUrl: '/session/browser-published-grant' }, 201);
  if (pathname === '/api/v1/attempts/attempt-quarry/review-sessions' && method === 'POST') return json({ embedUrl: '/session/browser-review-grant', assetKinds: ['glb', 'ortho', 'report'] }, 201);
  if (pathname === '/api/v1/processing/outputs/output-johnson/assets/glb') return { status: 200, body: Buffer.from('browser-glb'), type: 'model/gltf-binary' };
  if (pathname === '/api/v1/processing/outputs/output-johnson/assets/ortho') return { status: 200, body: orthophotoFixture, type: 'image/tiff' };
  if (pathname === '/api/v1/processing/outputs/output-johnson/assets/report') return { status: 200, body: Buffer.from('%PDF-browser'), type: 'application/pdf' };
  if (pathname === '/api/v1/processing/outputs/output-johnson/archive' && method === 'POST') return json({ output: fixtures.outputs[0] });
  if (pathname === '/api/v1/processing/outputs/output-johnson-archived' && method === 'DELETE') return json({ output: fixtures.outputs[1], trash: { id: 'trash-output' } });
  if (pathname === '/api/v1/projects/project-quarry/archive' && method === 'POST') { runtime.archivedProjects.add('project-quarry'); return json({ project: { ...fixtures.projects[1], status: 'archived' } }); }
  if (pathname === '/api/v1/tasks/task-quarry/archive' && method === 'POST') { runtime.archivedTasks.add('task-quarry'); return json({ task: { ...fixtures.tasks[1], status: 'archived' } }); }
  if (pathname === '/api/v1/datasets/dataset-johnson/archive' && method === 'POST') return json({ dataset: fixtures.datasets[0] });
  if (pathname === '/api/v1/datasets/dataset-johnson' && method === 'DELETE') return json({ trash: { id: 'trash-dataset' } });
  if (pathname === '/api/v1/storage') return url.searchParams.get('cursor')
    ? json({ storage: {}, trash: { items: [{ id: 'trash-second-page', entityId: 'output-trash', entityType: 'output', displayName: 'Old output', byteSize: 1024 }], nextCursor: null } })
    : json({ storage: {}, trash: { items: [{ id: 'trash-johnson', entityId: 'dataset-trash', entityType: 'dataset', displayName: 'Discarded draft', byteSize: 0 }], nextCursor: 'trash-page-two' } });
  if (pathname === '/api/v1/storage/mutations') return json({ mutations: [{ id: 'mutation-failed', type: 'restore', entityType: 'output', entityId: 'output-conflict', status: 'failed', errorCode: 'storage_conflict', errorMessage: 'destination conflicts with the recorded item' }], nextCursor: null });
  if (pathname === '/api/v1/storage/mutations/mutation-failed/retry' && method === 'POST') return json({ mutation: { id: 'mutation-failed', status: 'complete' } });
  if (pathname === '/api/v1/storage/trash/trash-johnson/restore' && method === 'POST') return json({ dataset: { id: 'dataset-trash', status: 'archived' } });
  if (pathname === '/api/v1/storage/trash/trash-johnson' && method === 'DELETE') return { status: 204, body: Buffer.alloc(0), type: 'application/json' };
  if (pathname === '/api/v1/processing/ready') return json({ ok: true });
  if (pathname === '/api/v1/workspace/client-grants') return json({ projects: [], associations: [], grants: [] });
  if (pathname === '/api/v1/operations' && method === 'GET') return json({ operations: runtime.operations, nextCursor: null });
  if (pathname === '/api/v1/processing/derivatives' && method === 'GET') return json({ derivatives: runtime.derivatives });
  if (pathname === '/api/v1/processing/derivatives/derivative-failed/retry' && method === 'POST') {
    runtime.derivatives = runtime.derivatives.map(job => job.id === 'derivative-failed' ? { ...job, status: 'pending', result: {} } : job);
    return json({ derivative: runtime.derivatives.find(job => job.id === 'derivative-failed') }, 202);
  }
  if (pathname === '/api/v1/processing/derivatives/derivative-stale-fallback/retry' && method === 'POST') {
    return json({ derivative: { id: 'derivative-stale-fallback', status: 'pending', manualRetryCount: 1 } }, 202);
  }
  if (pathname === '/api/v1/processing/outputs/output-quarry-ready/derivatives/tiles' && method === 'POST') {
    const derivative = { id: 'derivative-quarry', attemptId: 'attempt-quarry', type: 'mesh_tiles', status: 'pending', optional: true, result: {}, taskId: 'task-quarry', taskDisplayName: 'Quarry reconstruction', projectId: 'project-quarry', projectDisplayName: 'Alpha Quarry', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    runtime.derivatives = [derivative, ...runtime.derivatives];
    return json({ derivative }, 202);
  }
  if (pathname === '/api/v1/operations/operation-failed/retry' && method === 'POST') {
    runtime.operations = runtime.operations.map(operation => operation.id === 'operation-failed' ? { ...operation, status: 'queued', phase: 'queued', progress: 0, heartbeatAt: null, errorCode: null, errorMessage: null, updatedAt: new Date().toISOString() } : operation);
    return json({ operation: runtime.operations.find(operation => operation.id === 'operation-failed') }, 202);
  }
  if (pathname === '/api/v1/processing/server-task-imports/browse' && method === 'GET') return json({ path: '', entries: [{ name: 'church-backup.zip', relativePath: 'church-backup.zip', kind: 'zip', byteSize: 4096 }], nextCursor: null });
  if (pathname === '/api/v1/processing/server-task-imports' && method === 'POST') {
    const operation = { id: 'operation-new', type: 'webodm_task_import', subject: body.taskDisplayName, projectId: body.projectId, status: 'queued', phase: 'queued', progress: 0, source: { kind: 'server_zip', browserTransferRequired: false, transferComplete: true }, attemptCount: 0, heartbeatAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    runtime.operations = [operation, ...runtime.operations];
    return json({ operation }, 202);
  }
  if (pathname === '/api/v1/tasks/task-johnson') {
    return json({ task: { ...fixtures.tasks[0], metrics: {
      averageGsdM: 0.021, surveyedAreaM2: 18000, sourceImageCount: 48, reconstructedPointCount: 1250000,
      georeferencingCrs: 'EPSG:32616', processingDurationMs: 240000, processingStatus: 'running', outputCount: 1,
      taskDiskUsageBytes: 9437184,
    }, outputs: fixtures.outputs } });
  }
  if (pathname === '/api/v1/tasks/task-quarry') return json({ task: { ...fixtures.tasks[1], status: runtime.archivedTasks.has('task-quarry')?'archived':'ready_for_review', metrics: { sourceImageCount: 12, processingStatus: 'ready_for_review', outputCount: 1 }, outputs: [fixtures.outputs[2]] } });
  if (pathname === '/api/v1/tasks/task-johnson/storage') return json({ task: { totalBytes: 9437184 } });
  if (pathname === '/api/v1/tasks/task-quarry/storage') return json({ task: { totalBytes: 1048576 } });
  if (pathname === '/api/v1/tasks/task-johnson/attempts') return json({ attempts: [fixtures.tasks[0].latestAttempt], nextCursor: null });
  if (pathname === '/api/v1/tasks/task-quarry/attempts') return json({ attempts: [fixtures.tasks[1].latestAttempt], nextCursor: null });
  const gcpSet = { id: 'gcp-set-johnson', displayName: 'Rome Dam control', pointCount: 1, crs: 'EPSG:32616', provenance: { coordinateSystem: 'NAD83 / UTM zone 16N', verticalDatum: 'NAVD88', linearUnit: 'ftUS' } };
  const gcpPoint = { id: 'gcp-point-1', externalId: 'ltds-1', label: 'ltds-1', latitude: 44.1, longitude: -88.2, elevationM: 220 };
  if (pathname === '/api/v1/datasets/dataset-johnson/gcp-sets') return json({ sets: [gcpSet] });
  if (pathname === '/api/v1/gcp-sets/gcp-set-johnson') return json({ set: gcpSet, points: [gcpPoint] });
  if (pathname === '/api/v1/tasks/task-johnson/gcp-correspondences' && method === 'GET') return json({ correspondences: runtime.correspondences });
  if (pathname === '/api/v1/tasks/task-johnson/gcp-correspondences' && method === 'POST') {
    const correspondence = { id: 'gcp-mark-1', ...body };
    runtime.correspondences = [correspondence];
    return json({ correspondence }, 201);
  }
  if (pathname === '/api/v1/gcp-correspondences/gcp-mark-1' && method === 'PATCH') {
    runtime.correspondences = runtime.correspondences.map(item => ({ ...item, ...body }));
    return json({ correspondence: runtime.correspondences[0] });
  }
  if (pathname === '/api/v1/gcp-correspondences/gcp-mark-1' && method === 'DELETE') {
    runtime.correspondences = [];
    return { status: 204, body: Buffer.alloc(0), type: 'application/json' };
  }
  if (pathname === '/api/v1/datasets/dataset-johnson/gcp-images') return json({ images: [{ id: 'image-1', relativePath: 'DJI_0001.JPG', distanceM: 4.2, width: 100, height: 80 }], ranking: { mode: 'auto', notice: 'Adaptive camera spacing', warnings: [] } });
  if (pathname === '/api/v1/datasets/dataset-johnson/gcp-images/image-1/content') return { status: 200, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="#555"/></svg>'), type: 'image/svg+xml' };
  if (pathname === '/api/v1/attempts/attempt-johnson') {
    const sequence = ++runtime.logSequence;
    return json({
      attempt: fixtures.tasks[0].latestAttempt,
      logs: [{ createdAt: new Date().toISOString(), level: 'info', message: `browser refresh ${sequence}` }],
    });
  }
  return json({ error: `Unhandled fixture route: ${pathname}` }, 404);
}

function startFixtureServer() {
  const runtime = { logSequence: 0, correspondences: [], requests: [], archivedProjects: new Set(), archivedTasks: new Set(), operations: structuredClone(fixtures.operations), derivatives: structuredClone(fixtures.derivatives) };
  const builtRoot = path.join(root, 'dist');
  const server = createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    let result;
    if (url.pathname.startsWith('/api/')) {
      if (request.headers.authorization !== `Bearer ${token}`) result = json({ error: 'authorization_required' }, 401);
      else {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString();
        let body = {};
        if (raw) try { body = JSON.parse(raw); } catch {}
        runtime.requests.push({ method: request.method, path: url.pathname, body });
        result = apiResponse(url, runtime, request.method, body);
      }
    } else {
      const relative = url.pathname === '/workspace' || url.pathname === '/' ? 'workspace.html' : decodeURIComponent(url.pathname.slice(1));
      const absolute = path.resolve(builtRoot, relative);
      if (!absolute.startsWith(builtRoot + path.sep) || !existsSync(absolute)) result = json({ error: 'not_found' }, 404);
      else {
        const extension = path.extname(absolute);
        const type = extension === '.html' ? 'text/html; charset=utf-8'
          : extension === '.css' ? 'text/css; charset=utf-8'
            : ['.js', '.mjs'].includes(extension) ? 'text/javascript; charset=utf-8'
              : 'application/octet-stream';
        result = { status: 200, body: readFileSync(absolute), type };
      }
    }
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (result.status === 200 && range) {
      const start = Number(range[1]), end = Math.min(Number(range[2]), result.body.length - 1);
      if (start <= end) result = { ...result, status: 206, body: result.body.subarray(start, end + 1), headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${result.body.length}` } };
    }
    response.writeHead(result.status, { 'Content-Type': result.type, 'Cache-Control': 'no-store', ...(result.headers || {}) });
    response.end(result.body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, runtime, origin: `http://127.0.0.1:${server.address().port}` }));
  });
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result || {});
      } else {
        this.events.push(message);
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }

  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(client, expression, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await client.evaluate(expression);
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const diagnostics = await client.evaluate(`({
    readyState: document.readyState,
    title: document.title,
    content: document.querySelector('#workspace-content')?.textContent?.trim().slice(0, 240),
    tokenPresent: Boolean(sessionStorage.getItem('ltds-viewer-admin-token')),
  })`).catch(error => ({ evaluationError: error.message }));
  const exceptions = client.events
    .filter(event => event.method === 'Runtime.exceptionThrown')
    .map(event => ({
      description: event.params?.exceptionDetails?.exception?.description || event.params?.exceptionDetails?.text,
      url: event.params?.exceptionDetails?.url,
      line: event.params?.exceptionDetails?.lineNumber,
      column: event.params?.exceptionDetails?.columnNumber,
    }))
    .slice(-3);
  throw new Error(`${message}; last result: ${JSON.stringify(last)}; diagnostics: ${JSON.stringify(diagnostics)}; exceptions: ${JSON.stringify(exceptions)}`);
}

async function waitForRequest(runtime, start, method, pathname, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (runtime.requests.slice(start).some(item => item.method === method && item.path === pathname)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`missing browser mutation ${method} ${pathname}`);
}

async function waitForDevTools(profile) {
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(activePortFile)) {
      const port = readFileSync(activePortFile, 'utf8').split(/\r?\n/, 1)[0];
      if (port) return `http://127.0.0.1:${port}`;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Browser did not expose a DevTools endpoint');
}

async function verifyViewport(devTools, origin, viewport, runtime) {
  runtime.archivedProjects.clear();
  runtime.archivedTasks.clear();
  runtime.operations = structuredClone(fixtures.operations);
  runtime.derivatives = structuredClone(fixtures.derivatives);
  const requestStart = runtime.requests.length;
  const targetResponse = await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' });
  assert.equal(targetResponse.ok, true, `create browser target for ${viewport.name}`);
  const target = await targetResponse.json();
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
      screenWidth: viewport.width, screenHeight: viewport.height,
    });
    await client.command('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        sessionStorage.setItem('ltds-viewer-admin-token', ${JSON.stringify(token)});
        window.__viewerActions=[];
        window.__promptValue='dataset-trash';
        window.confirm=()=>true;
        window.prompt=()=>window.__promptValue;
        window.open=()=>({opener:null,closed:false,location:{replace:url=>window.__viewerActions.push({type:'open',url})},close(){}});
        const originalAnchorClick=HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click=function(){window.__viewerActions.push({type:'download',name:this.download});};
      `,
    });
    await client.command('Page.navigate', { url: `${origin}/workspace` });
    await waitFor(client, "document.querySelectorAll('[data-project-name]').length === 2", `${viewport.name}: workspace did not load`);

    await waitFor(client, "document.querySelector('#background-work-count')?.textContent === '3'", `${viewport.name}: background work count did not include active derivatives`);
    await client.evaluate(`document.querySelector('[data-section="background"]').click()`);
    await waitFor(client, "document.querySelectorAll('#import-activity .operation-row').length === 2", `${viewport.name}: dedicated import activity did not load`);
    const activityText = await client.evaluate(`document.querySelector('#import-activity').textContent`);
    for (const expected of ['Import activity', '35%', 'Server ZIP', 'Phase: adopting', 'Worker heartbeat', 'The archive could not be imported.']) assert.ok(activityText.includes(expected), `${viewport.name}: missing operation detail ${expected}`);
    const derivativeText = await client.evaluate(`document.querySelector('#workspace-content').textContent`);
    for (const expected of ['Model derivatives', 'Validate imported 3D tiles', 'Generate streaming 3D tiles', 'Running', 'Queued', 'Tile conversion failed']) assert.ok(derivativeText.includes(expected), `${viewport.name}: missing derivative detail ${expected}`);
    assert.equal(await client.evaluate(`document.querySelector('[data-derivative-id="derivative-running"] progress')?.hasAttribute('value')`), false, `${viewport.name}: running derivative progress was not indeterminate`);
    assert.equal(activityText.includes('server import'), false, `${viewport.name}: internal operation subject leaked into the activity title`);
    await client.evaluate(`document.querySelector('[data-action="retry-operation"][data-id="operation-failed"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/operations/operation-failed/retry');
    await waitFor(client, "document.querySelector('[data-operation-id=\"operation-failed\"]')?.textContent.includes('queued')", `${viewport.name}: failed import retry did not return to queued`);
    await waitFor(client, "document.querySelector('[data-action=\"retry-derivative\"][data-id=\"derivative-failed\"]')", `${viewport.name}: failed optional derivative did not expose manual retry`);
    await client.evaluate(`document.querySelector('[data-action="retry-derivative"][data-id="derivative-failed"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/derivatives/derivative-failed/retry');
    await client.evaluate(`document.querySelector('[data-section="dashboard"]').click()`);

    const noOverflow = `Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth`;
    assert.equal(await client.evaluate(noOverflow), true, `${viewport.name}: dashboard overflows horizontally`);

    await client.evaluate(`(() => { const input=document.querySelector('#project-filter'); input.value='Johnson'; input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('[data-project-name]')].map(row=>({name:row.dataset.projectName,hidden:row.hidden}))`), [
      { name: 'johnson road survey', hidden: false },
      { name: 'alpha quarry', hidden: true },
    ], `${viewport.name}: project search result visibility`);

    await client.evaluate(`document.querySelector('[data-action="open-project"][data-id="project-johnson"]').click()`);
    await waitFor(client, "document.querySelector('.project-detail')?.getAttribute('aria-label') === 'Johnson Road Survey project'", `${viewport.name}: project selection failed`);
    assert.equal(await client.evaluate(`new URL(location.href).searchParams.get('project')`), 'project-johnson', `${viewport.name}: selected project was not encoded in the URL`);
    assert.equal(await client.evaluate(`document.body.textContent.includes('Project datasets')`), false, `${viewport.name}: redundant project datasets card remained visible`);
    assert.equal(await client.evaluate(noOverflow), true, `${viewport.name}: selected project overflows horizontally`);

    await client.evaluate(`document.querySelector('[data-action="project-import"][data-id="project-johnson"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === true", `${viewport.name}: import dialog did not open`);
    await client.evaluate(`document.querySelector('[data-import-tab="server"]').click()`);
    await waitFor(client, "document.querySelector('[data-select-path=\"church-backup.zip\"]') !== null", `${viewport.name}: server import browser did not load`);
    await client.evaluate(`document.querySelector('[data-select-path="church-backup.zip"]').click()`);
    await client.evaluate(`document.querySelector('#server-import-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/server-task-imports');
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === false && Number(document.querySelector('#background-work-count')?.textContent) >= 1", `${viewport.name}: modal import did not update the background work count`);

    await client.evaluate(`document.querySelector('[data-action="toggle-task"][data-id="task-johnson"]').click()`);
    await waitFor(client, "document.querySelector('.task-detail .log-tail')?.textContent.includes('browser refresh')", `${viewport.name}: task details did not expand`);
    assert.deepEqual(await client.evaluate(`({section:new URL(location.href).searchParams.get('section'),project:new URL(location.href).searchParams.get('project'),task:new URL(location.href).searchParams.get('task')})`),
      { section: 'dashboard', project: 'project-johnson', task: 'task-johnson' }, `${viewport.name}: expanded task route state`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.task-quick-actions button')].map(button=>button.textContent)`),
      ['View', 'Retry 3D tiles', 'Download', 'Report', 'Share'], `${viewport.name}: published task shortcuts and DTO-backed stale derivative retry`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="retry-derivative"][data-id="derivative-stale-fallback"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/derivatives/derivative-stale-fallback/retry');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: stale derivative retry did not settle`);
    assert.equal(await client.evaluate(`document.querySelectorAll('button button').length`), 0, `${viewport.name}: task shortcuts were nested inside a button`);
    assert.equal(await client.evaluate(`[...document.querySelectorAll('.task-quick-actions button')].every(button=>button.getBoundingClientRect().height>=44)`), true, `${viewport.name}: task shortcuts have sub-44px targets`);
    await client.evaluate(`history.back()`);
    await waitFor(client, "new URL(location.href).searchParams.get('project')==='project-johnson' && !new URL(location.href).searchParams.has('task') && document.querySelector('[data-action=\"toggle-task\"][data-id=\"task-johnson\"]')?.getAttribute('aria-expanded')==='false'", `${viewport.name}: browser Back did not collapse the task in place`);
    await client.evaluate(`history.forward()`);
    await waitFor(client, "new URL(location.href).searchParams.get('task')==='task-johnson' && document.querySelector('[data-action=\"toggle-task\"][data-id=\"task-johnson\"]')?.getAttribute('aria-expanded')==='true'", `${viewport.name}: browser Forward did not restore the task`);
    await client.command('Page.reload');
    await waitFor(client, "new URL(location.href).searchParams.get('task')==='task-johnson' && document.querySelector('.task-detail .log-tail')?.textContent.includes('browser refresh')", `${viewport.name}: refresh did not restore the selected project and expanded task`);
    assert.equal(await client.evaluate(`document.querySelector('[data-task-disclosure="logs"]').open`), false, `${viewport.name}: task output was not progressively disclosed`);
    await client.evaluate(`document.querySelector('[data-task-disclosure="logs"] summary').click()`);
    await waitFor(client, "document.querySelector('[data-task-disclosure=\"logs\"]')?.open === true", `${viewport.name}: task output disclosure did not open`);
    const firstLog = await client.evaluate(`document.querySelector('.task-detail .log-tail').textContent`);
    await waitFor(client, `document.querySelector('.task-detail .log-tail')?.textContent !== ${JSON.stringify(firstLog)}`, `${viewport.name}: running-task log tail did not refresh`, 7_000);
    assert.equal(await client.evaluate(noOverflow), true, `${viewport.name}: expanded task overflows horizontally`);
    await waitFor(client, "document.querySelector('.task-ortho-preview canvas')?.getAttribute('aria-label') === 'Published orthophoto preview' || document.querySelector('.task-ortho-preview img') !== null", `${viewport.name}: real orthophoto preview did not render`);
    assert.equal(await client.evaluate(`(() => { const canvas=document.querySelector('.task-ortho-preview canvas'); if(!canvas)return true; return [...canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data].some(value=>value>0) })()`), true, `${viewport.name}: orthophoto preview canvas is empty`);

    await client.evaluate(`document.querySelector('[data-task-disclosure="gcp"] summary').click()`);
    await waitFor(client, "document.querySelector('[data-task-disclosure=\"gcp\"]')?.open === true", `${viewport.name}: GCP disclosure did not open`);
    await waitFor(client, "document.querySelector('[data-action=\"gcp-open-image\"][data-id=\"image-1\"]') !== null", `${viewport.name}: GCP image candidates did not load`);
    await client.evaluate(`document.querySelector('[data-action="gcp-open-image"][data-id="image-1"]').click()`);
    await waitFor(client, "document.querySelector('.gcp-mark-form') !== null", `${viewport.name}: private GCP image did not open`);
    await client.evaluate(`(() => { const form=document.querySelector('.gcp-mark-form'); form.elements.pixelX.value='12'; form.elements.pixelY.value='14'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "document.querySelector('.gcp-mark-row')?.textContent.includes('x 12, y 14')", `${viewport.name}: GCP correspondence was not created`);
    await client.evaluate(`(() => { const form=document.querySelector('.gcp-mark-form'); form.elements.pixelX.value='13'; form.elements.pixelY.value='15'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "document.querySelector('.gcp-mark-row')?.textContent.includes('x 13, y 15')", `${viewport.name}: GCP correspondence was not updated`);
    await client.evaluate(`document.querySelector('[data-action="gcp-delete-mark"]').click()`);
    await waitFor(client, "document.querySelector('.gcp-mark-row') === null", `${viewport.name}: GCP correspondence was not deleted`);

    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="download-report"]').click()`);
    await waitFor(client, "window.__viewerActions.some(item=>item.type==='download'&&item.name.includes('report.pdf'))", `${viewport.name}: authenticated report download did not complete`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="view-output"]').click()`);
    await waitFor(client, "window.__viewerActions.some(item=>item.type==='open'&&item.url==='/session/browser-published-grant')", `${viewport.name}: published output session did not open`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="share-output"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === true && document.querySelector('.share-form')?.dataset.outputId === 'output-johnson'", `${viewport.name}: task Share shortcut did not target the published output`);
    await client.evaluate(`document.querySelector('.modal-close').click()`);

    await client.evaluate(`document.querySelector('[data-task-disclosure="outputs"] summary').click()`);
    await waitFor(client, "document.querySelector('[data-task-disclosure=\"outputs\"]')?.open === true", `${viewport.name}: output disclosure did not open`);

    await client.evaluate(`document.querySelector('[data-action="archive-output"][data-id="output-johnson"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/outputs/output-johnson/archive');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: output archive did not settle`);
    await client.evaluate(`document.querySelector('[data-action="trash-output"][data-id="output-johnson-archived"]').click()`);
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/processing/outputs/output-johnson-archived');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: output trash did not settle`);
    await client.evaluate(`document.querySelector('[data-task-disclosure="advanced"] summary').click()`);
    await waitFor(client, "document.querySelector('[data-task-disclosure=\"advanced\"]')?.open === true", `${viewport.name}: advanced task controls did not open`);
    await client.evaluate(`document.querySelector('[data-action="archive-dataset"][data-id="dataset-johnson"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/datasets/dataset-johnson/archive');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: dataset archive did not settle`);
    await client.evaluate(`document.querySelector('[data-action="trash-dataset"][data-id="dataset-johnson"]').click()`);
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/datasets/dataset-johnson');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: dataset trash did not settle`);

    await client.evaluate(`(() => { const input=document.querySelector('#project-filter'); input.value=''; input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`);
    await waitFor(client, "document.querySelector('[data-action=\"open-project\"][data-id=\"project-quarry\"]') !== null", `${viewport.name}: project filter did not clear`);
    await client.evaluate(`document.querySelector('[data-action="open-project"][data-id="project-quarry"]').click()`);
    await waitFor(client, "document.querySelector('.project-detail')?.getAttribute('aria-label') === 'Alpha Quarry project'", `${viewport.name}: terminal project selection failed`);
    assert.deepEqual(await client.evaluate(`[...document.querySelectorAll('.task-quick-actions button')].map(button=>button.textContent)`),
      ['View', 'Generate 3D tiles', 'Download', 'Report'], `${viewport.name}: ready output did not expose review/tile/download/report shortcuts or exposed Share before publish`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="generate-tiles"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/processing/outputs/output-quarry-ready/derivatives/tiles');
    await waitFor(client, "document.querySelector('.task-quick-actions')?.textContent.includes('3D tiles queued')", `${viewport.name}: queued tile derivative did not replace the generate action`);
    await client.evaluate(`document.querySelector('.task-quick-actions [data-action="open-review"]').click()`);
    await waitFor(client, "window.__viewerActions.some(item=>item.type==='open'&&item.url==='/session/browser-review-grant')", `${viewport.name}: ready output View did not open its isolated review session`);
    await client.evaluate(`document.querySelector('[data-action="toggle-task"][data-id="task-quarry"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"archive-task\"][data-id=\"task-quarry\"]') !== null", `${viewport.name}: terminal task archive was not reachable`);
    await client.evaluate(`document.querySelector('[data-action="archive-task"][data-id="task-quarry"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/tasks/task-quarry/archive');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: task archive did not settle`);
    await waitFor(client, "document.querySelector('[data-action=\"archive-task\"][data-id=\"task-quarry\"]') === null && document.querySelector('.task-detail')?.textContent.includes('archived and read-only')", `${viewport.name}: archived task remained mutable`);
    await client.evaluate(`document.querySelector('[data-action="archive-project"][data-id="project-quarry"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/projects/project-quarry/archive');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: project archive did not settle`);
    await waitFor(client, "document.querySelector('.project-detail')?.textContent.includes('project is archived and read-only') && document.querySelector('[data-action=\"project-process\"]') === null", `${viewport.name}: archived project remained mutable`);

    await client.evaluate(`document.querySelector('[data-section="providers"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"open-provider\"][data-id=\"provider-nodeodm\"]') !== null", `${viewport.name}: provider section did not render`);
    assert.equal(await client.evaluate(`Number(document.querySelector('#background-work-count')?.textContent) >= 1`), true, `${viewport.name}: background count did not persist across navigation`);
    await client.evaluate(`document.querySelector('[data-action="open-provider"][data-id="provider-nodeodm"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === true && document.querySelector('.provider-master-detail') !== null", `${viewport.name}: provider modal did not open`);
    assert.equal(await client.evaluate(`document.querySelector('.provider-detail h3')?.textContent`), 'TrueNAS NodeODM', `${viewport.name}: provider modal selection`);
    await client.evaluate(`document.querySelector('[data-action="edit-provider"]').click()`);
    await waitFor(client, "document.querySelector('#provider-edit-form') !== null", `${viewport.name}: provider edit form did not open`);
    await client.evaluate(`(() => { const form=document.querySelector('#provider-edit-form'); form.elements.admissionLimit.value='3'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "document.querySelector('[data-action=\"replace-provider-token\"]') !== null", `${viewport.name}: provider edit did not return to node detail`);
    await client.evaluate(`document.querySelector('[data-action="replace-provider-token"]').click()`);
    await waitFor(client, "document.querySelector('#provider-token-form') !== null", `${viewport.name}: provider token form did not open`);
    await client.evaluate(`(() => { const form=document.querySelector('#provider-token-form'); form.elements.token.value='browser-secret-token'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "document.querySelector('[data-action=\"new-preset\"]') !== null", `${viewport.name}: provider token update did not return to node detail`);
    await client.evaluate(`document.querySelector('[data-action="new-preset"]').click()`);
    await waitFor(client, "document.querySelector('#preset-form') !== null", `${viewport.name}: preset form did not open`);
    await client.evaluate(`(() => { const form=document.querySelector('#preset-form'); form.elements.displayName.value='Browser preset'; form.elements.options.value='{}'; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, "document.querySelector('[data-action=\"delete-preset\"]') !== null", `${viewport.name}: preset creation did not return to node detail`);
    await client.evaluate(`document.querySelector('[data-action="delete-preset"]').click()`);
    await waitFor(client, "document.querySelector('#workspace-modal')?.open === true && document.querySelector('.provider-master-detail') !== null", `${viewport.name}: preset deletion did not return to node detail`);
    assert.equal(await client.evaluate(noOverflow), true, `${viewport.name}: provider modal overflows horizontally`);

    await client.evaluate(`document.querySelector('.modal-close').click(); document.querySelector('[data-section="diagnostics"]').click()`);
    await waitFor(client, "document.querySelector('[data-action=\"purge-trash\"]') !== null", `${viewport.name}: trash lifecycle controls did not render`);
    assert.equal(await client.evaluate(`document.querySelectorAll('[data-action="restore-trash"]').length`), 2, `${viewport.name}: paginated trash was not fully rendered`);
    await client.evaluate(`document.querySelector('[data-action="restore-trash"][data-id="trash-johnson"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/storage/trash/trash-johnson/restore');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: trash restore did not settle`);
    await client.evaluate(`document.querySelector('[data-action="retry-storage-mutation"][data-id="mutation-failed"]').click()`);
    await waitForRequest(runtime, requestStart, 'POST', '/api/v1/storage/mutations/mutation-failed/retry');
    await waitFor(client, "!document.querySelector('#workspace').hasAttribute('aria-busy')", `${viewport.name}: lifecycle retry did not settle`);
    assert.deepEqual(await client.evaluate(`({ entityId: document.querySelector('[data-action="purge-trash"]').dataset.entityId, promptValue: window.prompt('test') })`),
      { entityId: 'dataset-trash', promptValue: 'dataset-trash' }, `${viewport.name}: trash confirmation contract`);
    await client.evaluate(`document.querySelector('[data-action="purge-trash"]').click()`);
    await waitForRequest(runtime, requestStart, 'DELETE', '/api/v1/storage/trash/trash-johnson');

    const recent = runtime.requests.slice(requestStart);
    for (const expected of [
      ['POST', '/api/v1/tasks/task-johnson/gcp-correspondences'],
      ['PATCH', '/api/v1/gcp-correspondences/gcp-mark-1'],
      ['DELETE', '/api/v1/gcp-correspondences/gcp-mark-1'],
      ['POST', '/api/v1/processing/outputs/output-johnson/view-sessions'],
      ['POST', '/api/v1/processing/outputs/output-johnson/archive'],
      ['POST', '/api/v1/processing/outputs/output-quarry-ready/derivatives/tiles'],
      ['DELETE', '/api/v1/processing/outputs/output-johnson-archived'],
      ['POST', '/api/v1/datasets/dataset-johnson/archive'],
      ['DELETE', '/api/v1/datasets/dataset-johnson'],
      ['POST', '/api/v1/tasks/task-quarry/archive'],
      ['POST', '/api/v1/projects/project-quarry/archive'],
      ['PATCH', '/api/v1/processing/providers/provider-nodeodm'],
      ['PUT', '/api/v1/processing/providers/provider-nodeodm/credential'],
      ['POST', '/api/v1/processing/presets'],
      ['DELETE', '/api/v1/processing/presets/preset-fast'],
      ['POST', '/api/v1/storage/trash/trash-johnson/restore'],
      ['POST', '/api/v1/storage/mutations/mutation-failed/retry'],
      ['DELETE', '/api/v1/storage/trash/trash-johnson'],
    ]) assert.ok(recent.some(item => item.method === expected[0] && item.path === expected[1]), `${viewport.name}: missing browser mutation ${expected.join(' ')}`);

    const exceptions = client.events.filter(event => event.method === 'Runtime.exceptionThrown');
    assert.deepEqual(exceptions, [], `${viewport.name}: uncaught browser exceptions`);
  } finally {
    await client.command('Page.close').catch(() => {});
    client.close();
  }
}

test('project-first workspace is interactive and overflow-free in real desktop and mobile browsers', { timeout: 180_000 }, async t => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Set CHROME_PATH or EDGE_PATH to a Chromium-family browser to run the real browser verification.');
    return;
  }

  const releaseBrowserLock = await acquireBrowserHarnessLock({ root });
  let server, runtime, origin, profile, browser;
  try {
    ({ server, runtime, origin } = await startFixtureServer());
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-browser-'));
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const devTools = await waitForDevTools(profile);
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900, mobile: false },
      { name: '390px mobile', width: 390, height: 844, mobile: true },
      { name: '320px mobile', width: 320, height: 720, mobile: true },
    ]) await t.test(viewport.name, () => verifyViewport(devTools, origin, viewport, runtime));
  } finally {
    try {
      if (browser) {
        const exited = new Promise(resolve => browser.once('exit', resolve));
        browser.kill();
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
      }
    } finally {
      releaseBrowserLock();
    }
    if (server) await new Promise(resolve => server.close(resolve));
    await removeBrowserProfile(profile, t);
  }
});
