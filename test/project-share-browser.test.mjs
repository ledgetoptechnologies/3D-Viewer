import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adminToken = 'project_share_browser_admin_token_1234567890';
const revokeOnlyToken = 'project_share_browser_revoke_token_123456789';

function browserPath() {
  return [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean).find(existsSync) || null;
}

async function removeBrowserProfile(profile, t) {
  if (!profile) return;
  const resolved = path.resolve(profile);
  const expectedPrefix = path.resolve(tmpdir(), 'ltds-project-share-browser-');
  if (!resolved.startsWith(expectedPrefix)) throw new Error(`refusing to remove unexpected browser profile: ${resolved}`);
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(lastError?.code)) {
    t.diagnostic(`Windows retained a lock on temporary browser profile ${resolved}; functional browser assertions completed.`);
    return;
  }
  throw lastError;
}

function response(body, status = 200, headers = {}) {
  return { status, body: Buffer.from(JSON.stringify(body)), headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } };
}

function projectShare(id, label, revokedAt = null) {
  return { id, projectId: 'project-one', label, permissions: { view: true, measure: true, cameras: true, download: false }, hasPassword: true, expiresAt: null, revokedAt, accessCount: 0, createdAt: '2026-08-19T00:00:00.000Z' };
}

function catalog() {
  return {
    project: { id: 'project-one', displayName: 'Browser project' },
    share: { label: 'Browser project share' },
    permissions: { view: true, measure: true, cameras: true, download: false },
    displayUnits: 'imperial',
    tasks: [
      { id: 'task-one', displayName: 'Published task one', modelId: 'model-one', modelTitle: 'Published task one' },
      { id: 'task-two', displayName: 'Published task two', modelId: 'model-two', modelTitle: 'Published task two' },
    ],
    nextCursor: null,
  };
}

function taskConfig(taskId) {
  const suffix = taskId === 'task-two' ? 'two' : 'one';
  return {
    id: `model-${suffix}`,
    title: `Published task ${suffix}`,
    permissions: { view: true, measure: true, cameras: true, download: false },
    displayUnits: 'imperial',
    assets: { glb: null, tiles: null, obj: null, shots: null, ortho: null, dsm: null, dtm: null, ept: null, pointCloud: null, pointCloudFormat: null },
    georef: { rtc: { e: 0, n: 0, z: 0 }, bboxCenter: { x: 0, y: 0, z: 0 }, utmZoneLon0Deg: -87 },
  };
}

function fixtureApi(url, request, body, runtime) {
  const pathname = url.pathname;
  const method = request.method || 'GET';
  const authorized = [`Bearer ${adminToken}`, `Bearer ${revokeOnlyToken}`].includes(request.headers.authorization);
  if (pathname.startsWith('/api/v1/') && !authorized) return response({ error: 'authorization_required' }, 401);
  if (pathname === '/api/v1/admin-sessions/current') return response({
    controllerOrigin: 'https://ops.example.test',
    session: {
      id: 'project-share-browser-session', subject: 'ops:project-share-browser', displayUnits: 'imperial',
      permissions: request.headers.authorization === `Bearer ${revokeOnlyToken}`
        ? ['viewer.projects.read', 'viewer.datasets.read', 'viewer.processing.read', 'viewer.providers.read', 'viewer.shares.revoke']
        : ['viewer.projects.read', 'viewer.datasets.read', 'viewer.processing.read', 'viewer.providers.read', 'viewer.shares.read', 'viewer.shares.create', 'viewer.shares.revoke'],
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    },
  });
  if (pathname === '/api/v1/projects') return response({ projects: [{ id: 'project-one', displayName: 'Browser project', description: 'Public sharing browser fixture', status: 'active' }], nextCursor: null });
  if (pathname === '/api/v1/datasets') return response({ datasets: [], nextCursor: null });
  if (pathname === '/api/v1/tasks') return response({ tasks: [{ id: 'task-one', projectId: 'project-one', displayName: 'Published task one', status: 'published', createdAt: '2026-08-19T00:00:00.000Z' }], nextCursor: null });
  if (pathname === '/api/v1/processing/providers') return response({ providers: [] });
  if (pathname === '/api/v1/processing/presets') return response({ presets: [] });
  if (pathname === '/api/v1/processing/outputs') return response({ outputs: [{ id: 'output-one', taskId: 'task-one', modelId: 'model-one', displayName: 'Published task one', status: 'published', activePublished: true, assetKinds: ['glb'] }], nextCursor: null });
  if (pathname === '/api/v1/processing/outputs/output-one/shares') return response({ shares: [] });
  if (pathname === '/api/v1/storage') return response({ storage: {}, trash: { items: [], nextCursor: null } });
  if (pathname === '/api/v1/storage/mutations') return response({ mutations: [], nextCursor: null });
  if (pathname === '/api/v1/processing/ready') return response({ ok: true });
  if (pathname === '/api/v1/workspace/client-grants') return response({ projects: [], associations: [], grants: [] });
  if (pathname === '/api/v1/projects/project-one/public-shares' && method === 'GET') return response({ shares: runtime.projectShares });
  if (pathname === '/api/v1/projects/project-one/public-shares' && method === 'POST') {
    const created = projectShare('share-created', body.label || 'Created in browser');
    runtime.projectShares = [...runtime.projectShares.filter((item) => item.id !== created.id), created];
    return response({ share: created, viewUrl: `${runtime.origin}/project/created-project-token` }, 201);
  }
  const revokeMatch = pathname.match(/^\/api\/v1\/project-shares\/(share-created|share-existing)$/);
  if (revokeMatch && method === 'DELETE') {
    runtime.projectShares = runtime.projectShares.map((item) => item.id === revokeMatch[1] ? { ...item, revokedAt: new Date().toISOString() } : item);
    return response({ share: runtime.projectShares.find((item) => item.id === revokeMatch[1]) });
  }
  const unlockMatch = pathname.match(/^\/api\/project-share\/([^/]+)\/unlock$/);
  if (unlockMatch && method === 'POST') {
    const shareToken = decodeURIComponent(unlockMatch[1]);
    if (body.password !== 'browser password') return response({ error: 'incorrect_password' }, 401);
    return response(catalog(), 200, { 'Set-Cookie': `project_share_test=${shareToken}; Path=/; HttpOnly; SameSite=Lax` });
  }
  const publicMatch = pathname.match(/^\/api\/project-share\/([^/]+)$/);
  if (publicMatch && method === 'GET') {
    const shareToken = decodeURIComponent(publicMatch[1]);
    return String(request.headers.cookie || '').includes(`project_share_test=${shareToken}`)
      ? response(catalog())
      : response({ error: 'password_required', requiresPassword: true }, 401);
  }
  const taskMatch = pathname.match(/^\/api\/project-share\/([^/]+)\/tasks\/(task-one|task-two)$/);
  if (taskMatch) {
    const shareToken = decodeURIComponent(taskMatch[1]);
    if (!String(request.headers.cookie || '').includes(`project_share_test=${shareToken}`)) return response({ error: 'password_required', requiresPassword: true }, 401);
    return response(taskConfig(taskMatch[2]));
  }
  return response({ error: `Unhandled fixture route: ${method} ${pathname}` }, 404);
}

async function startFixtureServer() {
  const runtime = { requests: [], projectShares: [], origin: '' };
  const vite = await createViteServer({ root, appType: 'spa', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      let body = {};
      const raw = Buffer.concat(chunks).toString();
      if (raw) try { body = JSON.parse(raw); } catch {}
      runtime.requests.push({ method: request.method, path: url.pathname, body });
      const result = fixtureApi(url, request, body, runtime);
      reply.writeHead(result.status, { 'Cache-Control': 'no-store', ...result.headers });
      reply.end(result.body);
      return;
    }
    if (url.pathname === '/workspace') request.url = `/workspace.html${url.search}`;
    else if (url.pathname.startsWith('/project/')) request.url = `/index.html${url.search}`;
    vite.middlewares(request, reply);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  runtime.origin = `http://127.0.0.1:${server.address().port}`;
  return { server, vite, runtime };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) { this.events.push(message); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
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
  command(method, params = {}, timeoutMs = 15_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`${method}: no DevTools response within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, method, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function waitFor(client, expression, message, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await client.evaluate(expression);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${message}; last=${JSON.stringify(last)}`);
}

async function waitForDevTools(profile) {
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(activePortFile)) {
      const port = readFileSync(activePortFile, 'utf8').split(/\r?\n/, 1)[0];
      if (port) return `http://127.0.0.1:${port}`;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Browser did not expose a DevTools endpoint');
}

async function openTarget(devTools, viewport) {
  const targetResponse = await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' });
  assert.equal(targetResponse.ok, true);
  const target = await targetResponse.json();
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.command('Page.enable');
  await client.command('Runtime.enable');
  await client.command('Emulation.setDeviceMetricsOverride', {
    width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
    screenWidth: viewport.width, screenHeight: viewport.height,
  });
  return client;
}

async function verifyStaffShare(devTools, origin, viewport, runtime) {
  runtime.projectShares = [projectShare('share-existing', 'Existing link')];
  const start = runtime.requests.length;
  const client = await openTarget(devTools, viewport);
  try {
    await client.command('Page.addScriptToEvaluateOnNewDocument', { source: `
      sessionStorage.setItem('ltds-viewer-admin-token', ${JSON.stringify(adminToken)});
      window.__copied='';
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText(value){window.__copied=value;return Promise.resolve();}}});
      window.confirm=()=>true;
    ` });
    await client.command('Page.navigate', { url: `${origin}/workspace` });
    await waitFor(client, `document.querySelector('[data-action="open-project"]') !== null`, `${viewport.name}: workspace did not load`);
    await client.evaluate(`document.querySelector('[data-action="open-project"]').click()`);
    await waitFor(client, `document.querySelector('[data-action="project-share"]') !== null`, `${viewport.name}: project did not open`);
    await client.evaluate(`document.querySelector('[data-action="project-share"]').click()`);
    await waitFor(client, `document.querySelector('.project-share-form') !== null`, `${viewport.name}: whole-project share form did not open`);
    assert.match(await client.evaluate(`document.querySelector('.project-share-form .form-note').textContent`), /tasks published later/);
    assert.equal(await client.evaluate(`document.querySelector('[data-action="revoke-project-share"][data-id="share-existing"]') !== null`), true);
    await client.evaluate(`(() => { const form=document.querySelector('.project-share-form'); form.elements.label.value='Created in browser'; form.elements.password.value='browser password'; form.elements.download.checked=true; form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); return true })()`);
    await waitFor(client, `window.__copied === ${JSON.stringify(`${origin}/project/created-project-token`)}`, `${viewport.name}: created link was not copied`);
    await waitFor(client, `document.querySelector('[data-action="revoke-project-share"][data-id="share-created"]') !== null`, `${viewport.name}: created link was not listed`);
    await client.evaluate(`document.querySelector('[data-action="copy-share"]').click()`);
    await waitFor(client, `window.__copied === ${JSON.stringify(`${origin}/project/created-project-token`)}`, `${viewport.name}: explicit copy did not complete`);
    await client.evaluate(`document.querySelector('[data-action="revoke-project-share"][data-id="share-created"]').click()`);
    await waitFor(client, `!document.querySelector('#workspace').hasAttribute('aria-busy')`, `${viewport.name}: revoke did not settle`);
    const recent = runtime.requests.slice(start);
    assert.ok(recent.some((item) => item.method === 'POST' && item.path === '/api/v1/projects/project-one/public-shares'));
    assert.ok(recent.some((item) => item.method === 'DELETE' && item.path === '/api/v1/project-shares/share-created'));
    assert.deepEqual(client.events.filter((event) => event.method === 'Runtime.exceptionThrown'), []);
  } finally {
    await client.command('Page.close', {}, 2_000).catch(() => {});
    client.close();
  }
}

async function verifyPublicShare(devTools, origin, viewport) {
  const token = `project-${viewport.width}`;
  const client = await openTarget(devTools, viewport);
  try {
    await client.command('Page.navigate', { url: `${origin}/project/${token}?task=stale-task` });
    await waitFor(client, `document.querySelector('#share-password-overlay') && getComputedStyle(document.querySelector('#share-password-overlay')).display !== 'none'`, `${viewport.name}: password prompt did not open`);
    await client.evaluate(`document.querySelector('#share-password-input').value='browser password'; document.querySelector('#share-password-submit').click()`);
    try {
      await waitFor(client, `document.querySelector('#project-switcher').value === 'task-one'`, `${viewport.name}: stale task query did not recover to the first live task`);
    } catch (error) {
      const diagnostics = await client.evaluate(`({
        value: document.querySelector('#project-switcher')?.value,
        options: [...(document.querySelector('#project-switcher')?.options||[])].map(item=>item.value),
        passwordDisplay: getComputedStyle(document.querySelector('#share-password-overlay')).display,
        passwordError: document.querySelector('#share-password-error')?.textContent,
        loadingText: document.querySelector('#loading-text')?.textContent,
        loadingProgress: document.querySelector('#loading-progress')?.textContent,
      })`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    await waitFor(client, `new URL(location.href).searchParams.get('task') === 'task-one'`, `${viewport.name}: recovered task URL was not canonicalized`);
    await waitFor(client, `document.querySelector('#brand-project')?.textContent.includes('Published task one')`, `${viewport.name}: recovered task config did not load`);
    assert.equal(await client.evaluate(`getComputedStyle(document.querySelector('#admin-controls')).display`), 'none', `${viewport.name}: public project exposed admin controls`);
    await client.evaluate(`(() => { const select=document.querySelector('#project-switcher'); select.value='task-two'; select.dispatchEvent(new Event('change',{bubbles:true})); return true })()`);
    await waitFor(client, `new URL(location.href).searchParams.get('task') === 'task-two' && document.querySelector('#project-switcher')?.value === 'task-two'`, `${viewport.name}: task switch did not survive navigation`);
    await waitFor(client, `document.querySelector('#brand-project')?.textContent.includes('Published task two')`, `${viewport.name}: switched task config did not load`);
    assert.deepEqual(client.events.filter((event) => event.method === 'Runtime.exceptionThrown'), []);
  } finally {
    await client.command('Page.close', {}, 2_000).catch(() => {});
    client.close();
  }
}

async function verifyRevokeOnlyStaff(devTools, origin, runtime) {
  runtime.projectShares = [projectShare('share-existing', 'Existing link')];
  const start = runtime.requests.length;
  const client = await openTarget(devTools, { name: 'revoke-only desktop', width: 1440, height: 900, mobile: false });
  try {
    await client.command('Page.addScriptToEvaluateOnNewDocument', { source: `
      sessionStorage.setItem('ltds-viewer-admin-token', ${JSON.stringify(revokeOnlyToken)});
      window.confirm=()=>true;
    ` });
    await client.command('Page.navigate', { url: `${origin}/workspace` });
    await waitFor(client, `document.querySelector('[data-action="open-project"]') !== null`, 'revoke-only: workspace did not load');
    await client.evaluate(`document.querySelector('[data-action="open-project"]').click()`);
    await waitFor(client, `document.querySelector('[data-action="project-share"]') !== null`, 'revoke-only: Share button was hidden');
    await client.evaluate(`document.querySelector('[data-action="project-share"]').click()`);
    await waitFor(client, `document.querySelector('[data-action="revoke-project-share"][data-id="share-existing"]') !== null`, 'revoke-only: project link row was not listed');
    assert.equal(await client.evaluate(`document.querySelector('.project-share-form') === null`), true, 'revoke-only: create form was exposed');
    await client.evaluate(`document.querySelector('[data-action="revoke-project-share"][data-id="share-existing"]').click()`);
    await waitFor(client, `!document.querySelector('#workspace').hasAttribute('aria-busy')`, 'revoke-only: revoke did not settle');
    assert.ok(runtime.requests.slice(start).some((item) => item.method === 'DELETE' && item.path === '/api/v1/project-shares/share-existing'));
    assert.deepEqual(client.events.filter((event) => event.method === 'Runtime.exceptionThrown'), []);
  } finally {
    await client.command('Page.close', {}, 2_000).catch(() => {});
    client.close();
  }
}

test('whole-project public sharing works in real desktop and mobile browsers', { timeout: 180_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Set CHROME_PATH or EDGE_PATH to a Chromium-family browser to run the real browser verification.');
    return;
  }
  const releaseBrowserLock = await acquireBrowserHarnessLock({ root });
  let server, vite, runtime, profile, browser;
  try {
    ({ server, vite, runtime } = await startFixtureServer());
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-project-share-browser-'));
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });
    const devTools = await waitForDevTools(profile);
    for (const viewport of [
      { name: 'desktop', width: 1440, height: 900, mobile: false },
      { name: '390px mobile', width: 390, height: 844, mobile: true },
      { name: '320px mobile', width: 320, height: 720, mobile: true },
    ]) {
      await t.test(`${viewport.name} staff controls`, () => verifyStaffShare(devTools, runtime.origin, viewport, runtime));
      await t.test(`${viewport.name} public project`, () => verifyPublicShare(devTools, runtime.origin, viewport));
    }
    await t.test('revoke-only staff project-link controls', () => verifyRevokeOnlyStaff(devTools, runtime.origin, runtime));
  } finally {
    try {
      if (browser) {
        const exited = new Promise((resolve) => browser.once('exit', resolve));
        browser.kill();
        await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      }
    } finally {
      releaseBrowserLock();
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    await removeBrowserProfile(profile, t);
  }
});
