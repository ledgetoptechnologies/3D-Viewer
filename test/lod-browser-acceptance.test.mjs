import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureId = 'lod-browser-fixture';
const GiB = 1024 * 1024 * 1024;

function removeBrowserProfile(profile) {
  if (!profile) return;
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } catch (error) {
    // Edge can retain a Windows file handle briefly after its process exits.
    // The isolated OS temp profile is non-authoritative test scratch; cleanup
    // must never strand the cross-process browser lock or mask UI assertions.
    if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
  }
}

function browserPath() {
  return [
    process.env.CHROME_PATH,
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean).find(existsSync) || null;
}

function fixtureConfig() {
  const base = `/assets/${fixtureId}/derivatives`;
  return {
    id: fixtureId,
    title: 'LOD browser fixture',
    displayUnits: 'imperial',
    assets: {
      glb: `${base}/odm_textured_model_geo.glb`,
      obj: null,
      tiles: `${base}/tileset.json`,
      shots: null,
      ortho: null,
      dsm: null,
      dtm: null,
      ept: null,
      pointCloud: null,
      pointCloudFormat: null,
    },
    lodProvenance: {
      schemaVersion: 2,
      sourceAsset: 'odm_textured_model_geo.glb',
      sourceSha256: 'a'.repeat(64),
      geometry: 'bounded-triangle-equivalence',
      textures: 'byte-identical-material-equivalence',
      leafGeometricError: 0,
      audit: {
        algorithm: 'ltds-glb-leaf-equivalence-v2',
        triangleCount: 1,
        equivalenceSha256: 'b'.repeat(64),
        coordinateTolerance: 0.0001,
        maxNumericDelta: 0,
        artifactCount: 2,
      },
    },
    georef: {
      rtc: { e: 367257, n: 4759982, z: 0 },
      bboxCenter: { x: -10.998394, y: -30.590805, z: 202.373772 },
      utmZoneLon0Deg: -87,
    },
  };
}

function contentType(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.b3dm')) return 'application/octet-stream';
  return 'application/octet-stream';
}

async function startFixture(tileRoot) {
  const vite = await createViteServer({ root, appType: 'spa', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  const assetPrefix = `/assets/${fixtureId}/derivatives/`;
  const config = fixtureConfig();
  config.assets.ortho = '/fixtures/orthophoto.tif';
  const server = createServer((request, reply) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/v1/health') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-LTDS-Viewer-Revision': 'a'.repeat(40) });
      reply.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/models') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify([config]));
      return;
    }
    if (url.pathname === `/api/models/${fixtureId}`) {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify(config));
      return;
    }
    if (url.pathname.startsWith(assetPrefix)) {
      const relative = decodeURIComponent(url.pathname.slice(assetPrefix.length));
      const file = path.resolve(tileRoot, relative);
      if (!file.startsWith(`${tileRoot}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        reply.writeHead(404);
        reply.end('not found');
        return;
      }
      reply.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': statSync(file).size });
      createReadStream(file).pipe(reply);
      return;
    }
    vite.middlewares(request, reply);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, vite, origin: `http://127.0.0.1:${server.address().port}` };
}

async function startStreamingOnlyFixture(assetOverrides = {}) {
  const vite = await createViteServer({ root, appType: 'spa', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  const requests = [];
  const config = fixtureConfig();
  config.assets.tiles = null;
  Object.assign(config.assets, assetOverrides);
  const server = createServer((request, reply) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/health') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-LTDS-Viewer-Revision': 'a'.repeat(40) });
      reply.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/models') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify([config]));
      return;
    }
    if (url.pathname === `/api/models/${fixtureId}`) {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      reply.end(JSON.stringify(config));
      return;
    }
    if (url.pathname === config.assets.glb) {
      reply.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': 4 });
      reply.end('GLB!');
      return;
    }
    vite.middlewares(request, reply);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, vite, requests, glbPath: config.assets.glb, origin: `http://127.0.0.1:${server.address().port}` };
}

async function startSessionRefreshFixture(tileRoot) {
  const vite = await createViteServer({ root, appType: 'spa', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
  const requests = [];
  let currentRequests = 0;
  const config = fixtureConfig();
  const assetPrefix = `/session-assets/session-token/${fixtureId}/derivatives/`;
  config.assets.glb = `${assetPrefix}odm_textured_model_geo.glb`;
  config.assets.tiles = `${assetPrefix}tileset.json`;
  const server = createServer((request, reply) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    if (url.pathname === '/api/v1/health') {
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-LTDS-Viewer-Revision': 'a'.repeat(40) });
      reply.end('{"ok":true}');
      return;
    }
    if (url.pathname === '/api/v1/sessions/current') {
      currentRequests += 1;
      const model = structuredClone(config);
      if (currentRequests === 1) model.assets.tiles = null;
      reply.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      reply.end(JSON.stringify({
        model,
        permissions: { view: true, measure: true, cameras: true },
        sessionId: 'refresh-session',
        accessToken: 'session-token',
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        allowedEmbedOrigins: [],
      }));
      return;
    }
    if (url.pathname.startsWith(assetPrefix)) {
      const relative = decodeURIComponent(url.pathname.slice(assetPrefix.length));
      const file = path.resolve(tileRoot, relative);
      if (!file.startsWith(`${tileRoot}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        reply.writeHead(404);
        reply.end('not found');
        return;
      }
      reply.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': statSync(file).size });
      createReadStream(file).pipe(reply);
      return;
    }
    vite.middlewares(request, reply);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    vite,
    requests,
    glbPath: config.assets.glb,
    currentRequests: () => currentRequests,
    origin: `http://127.0.0.1:${server.address().port}`,
  };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        this.events.push(message);
        return;
      }
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

  command(method, params = {}, timeoutMs = 30_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method}: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
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

async function waitFor(client, expression, message, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await client.evaluate(expression);
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${message}; last=${JSON.stringify(last)}`);
}

async function reserveDevToolsPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDevTools(port) {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${origin}/json/version`)).ok) return origin;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('browser did not expose DevTools');
}

function snapshotExpression() {
  return `(() => {
    const tiles = window.__ltds.tiles();
    const root = tiles?.root;
    const visibleLeaves = [];
    const visit = (tile) => {
      if (!tile) return;
      const children = tile.children || [];
      if (children.length) children.forEach(visit);
      if (!children.length && Number(tile.geometricError) === 0 && tile.traversal?.visible && tile.engineData?.scene?.visible) {
        visibleLeaves.push(tile.content?.uri || tile.content?.url || null);
      }
    };
    visit(root);
    const materials = [];
    root?.engineData?.scene?.traverse((object) => {
      if (object.isMesh && object.material) materials.push({ depthWrite: object.material.depthWrite, polygonOffset: object.material.polygonOffset, renderOrder: object.renderOrder });
    });
    return {
      errorPanel: getComputedStyle(document.querySelector('#error-panel')).display,
      manifestValid: window.__ltds.state?.lodManifestReport?.valid === true,
      root: { refine: root?.refine || null, visible: Boolean(root?.traversal?.visible && root?.engineData?.scene?.visible), materials },
      visibleLeaves,
      cache: { minBytesSize: tiles?.lruCache?.minBytesSize, maxBytesSize: tiles?.lruCache?.maxBytesSize, minSize: tiles?.lruCache?.minSize, maxSize: tiles?.lruCache?.maxSize, unloadPercent: tiles?.lruCache?.unloadPercent },
    };
  })()`;
}

async function setView(client, position, lookAt) {
  await client.evaluate(`(() => {
    const Vector3 = window.__ltds.camera().position.constructor;
    window.__ltds.controls().setView(new Vector3(${position.join(',')}), new Vector3(${lookAt.join(',')}));
    return true;
  })()`);
}

test('browser LOD stream preserves the root backdrop through close, far, pan, and return views', { timeout: 180_000 }, async (t) => {
  const tileRoot = process.env.LTDS_LOD_TEST_TILE_ROOT;
  const executable = browserPath();
  if (!tileRoot || !existsSync(path.join(tileRoot, 'tileset.json')) || !executable) {
    t.skip('Set LTDS_LOD_TEST_TILE_ROOT and CHROME_PATH/EDGE_PATH to run real LOD browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client, origin;
  try {
    ({ server, vite, origin } = await startFixture(path.resolve(tileRoot)));
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-lod-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });
    await client.command('Page.navigate', { url: `${origin}/?project=${fixtureId}` });
    await waitFor(client, `location.search.includes('view=model') && document.querySelector('#tab-model')?.classList.contains('active')`, 'verified LOD was not selected over the available orthophoto');
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root?.engineData?.scene)', 'root B3DM did not load');
    await waitFor(client, 'window.__ltds.state?.lodManifestReport?.valid === true', 'REPLACE manifest did not validate');

    const initial = await client.evaluate(snapshotExpression());
    assert.equal(initial.errorPanel, 'none');
    assert.equal(initial.root.refine, 'ADD');
    assert.equal(initial.root.visible, true);
    assert.ok(initial.root.materials.length > 0);
    assert.ok(initial.root.materials.every((item) => item.depthWrite === false && item.polygonOffset === true && item.renderOrder === -100));
    assert.deepEqual(initial.cache, { minBytesSize: 0.4 * GiB, maxBytesSize: 1.75 * GiB, minSize: 8, maxSize: 48, unloadPercent: 0.20 });

    await setView(client, [0, 44, 52], [0, 18, 0]);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.traversal?.visible&&tile.engineData?.scene?.visible)n++;};f(r);return n>0; })()`, 'close view did not refine');
    const close = await client.evaluate(snapshotExpression());
    assert.ok(close.visibleLeaves.length > 0);

    await setView(client, [0, 1300, 1300], [0, 18, 0]);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.traversal?.visible&&tile.engineData?.scene?.visible)n++;};f(r);return n===0; })()`, 'far view kept LOD-0 leaves');
    const far = await client.evaluate(snapshotExpression());
    assert.equal(far.visibleLeaves.length, 0);
    assert.equal(far.root.visible, true);

    const closeSet = new Set(close.visibleLeaves);
    const candidates = await client.evaluate(`(() => {
      const tiles=window.__ltds.tiles();
      const Vector3=window.__ltds.camera().position.constructor;
      tiles.group.updateMatrixWorld(true);
      const close=new Set(${JSON.stringify([...closeSet])});
      const rows=[];
      const visit=(tile)=>{
        (tile?.children||[]).forEach(visit);
        const uri=tile.content?.uri||tile.content?.url||null;
        if ((tile?.children||[]).length || Number(tile?.geometricError)!==0 || close.has(uri)) return;
        const volume=tile.engineData?.boundingVolume;
        const obb=volume?.obb||volume?.regionObb;
        let center=null;
        if (obb?.box&&obb?.transform) center=obb.box.getCenter(new Vector3()).applyMatrix4(obb.transform);
        else if (volume?.sphere?.center) center=volume.sphere.center.clone();
        if (!center) return;
        center.applyMatrix4(tiles.group.matrixWorld);
        rows.push({uri,lookAt:[center.x,center.y,center.z],position:[center.x,center.y+30,center.z+55]});
      };
      visit(tiles.root);
      return rows;
    })()`);
    assert.ok(candidates.length > 0, 'tile hierarchy exposed no alternate full-detail view');
    let panned = null;
    const panSamples = [];
    for (const candidate of candidates) {
      await setView(client, candidate.position, candidate.lookAt);
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      const sample = await client.evaluate(snapshotExpression());
      panSamples.push({ candidate, visibleLeaves: sample.visibleLeaves, camera: sample.camera });
      if (sample.visibleLeaves.some((uri) => !closeSet.has(uri))) {
        panned = sample;
        break;
      }
    }
    assert.ok(panned, `panning did not replace the detailed frontier: ${JSON.stringify({ close: [...closeSet], panSamples })}`);
    assert.equal(panned.root.visible, true);

    // The original close-up leaves normally stay cached. Returning to that view
    // must make those same scene objects render again rather than leaving an
    // invisible cached hole beneath the coarse root backdrop.
    await setView(client, [0, 44, 52], [0, 18, 0]);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; const expected=new Set(${JSON.stringify([...closeSet])}); let found=false; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.traversal?.visible&&tile.engineData?.scene?.visible&&expected.has(tile.content?.uri||tile.content?.url))found=true;};f(r);return found; })()`, 'returning to the close view did not restore cached full-detail leaves');
    const returned = await client.evaluate(snapshotExpression());
    assert.ok(returned.visibleLeaves.some((uri) => closeSet.has(uri)));
    assert.equal(returned.root.visible, true);

    const failures = client.events.filter((event) => event.method === 'Network.responseReceived' && event.params.response.status >= 400);
    // Middleware-mode Vite has no HMR WebSocket endpoint. Its injected client
    // emits a URL-attributed error for that absent test-only socket; every
    // application or tile error still fails this assertion.
    const isViteHmrEvent = (event) => {
      const url = event.method === 'Log.entryAdded'
        ? event.params.entry.url
        : event.method === 'Runtime.exceptionThrown'
          ? event.params.exceptionDetails.url
          : null;
      return typeof url === 'string' && url.includes('/@vite/client');
    };
    const errors = client.events.filter((event) => (
      event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
    ) && !isViteHmrEvent(event));
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    removeBrowserProfile(profile);
  }
});

test('browser never requests the original GLB when verified streaming tiles are absent', { timeout: 60_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for streaming-only browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startStreamingOnlyFixture();
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-streaming-only-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, `document.querySelector('#layer-tiles')?.textContent === 'Streaming LOD unavailable'`, 'streaming-only state did not render');
    const state = await client.evaluate(`({
      layerDisabled: document.querySelector('#layer-tiles')?.disabled,
      fullMeshLayerPresent: Boolean(document.querySelector('#layer-glb')),
      status: document.querySelector('#mode-status')?.textContent,
      tilesRuntimePresent: Boolean(window.__ltds?.tiles?.()),
    })`);
    assert.deepEqual(state, {
      layerDisabled: true,
      fullMeshLayerPresent: false,
      status: 'Streaming LOD unavailable or processing',
      tilesRuntimePresent: false,
    });
    await client.evaluate(`document.querySelector('#layer-tiles').click()`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fixture.requests.filter((requestPath) => requestPath === fixture.glbPath).length, 0, 'initialization or layer UI fetched the original GLB');
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    removeBrowserProfile(profile);
  }
});

test('an open authenticated workspace discovers completed LOD tiles without loading the original GLB', { timeout: 90_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for session LOD refresh acceptance.');
    return;
  }

  const { makeB3dm, makeGlb, TRIANGLE_A, writeAuditableFixture } = await import('./helpers/lod-fixture.mjs');
  const tileRoot = mkdtempSync(path.join(tmpdir(), 'ltds-session-lod-fixture-'));
  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  writeAuditableFixture(tileRoot, {
    leafABytes: makeB3dm(makeGlb([TRIANGLE_A], validPng)),
    leafBTexture: validPng,
  });
  const sessionTilesetPath = path.join(tileRoot, 'tileset.json');
  const sessionTileset = JSON.parse(readFileSync(sessionTilesetPath, 'utf8'));
  sessionTileset.root.content = { uri: 'leaf-a.b3dm' };
  writeFileSync(sessionTilesetPath, JSON.stringify(sessionTileset));
  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client, fixture;
  try {
    fixture = await startSessionRefreshFixture(tileRoot);
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-session-lod-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Page.navigate', { url: `${fixture.origin}/session/active/refresh-session` });
    await waitFor(client, `document.querySelector('#layer-tiles')?.textContent === 'Streaming LOD unavailable'`, 'initial unavailable LOD state did not render');
    assert.equal(await client.evaluate(`document.querySelector('#loading-overlay')?.classList.contains('hidden')`), true, 'unavailable tiles left the workspace blocked by its initializing overlay');
    const refreshDeadline = Date.now() + 15_000;
    while (fixture.currentRequests() < 2 && Date.now() < refreshDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fixture.currentRequests() >= 2, 'open session never refreshed its live model configuration');
    await waitFor(client, `window.__ltds?.state?.meshSource === 'tiles' && document.querySelector('#layer-tiles')?.textContent === 'Streamed LOD Mesh'`, 'completed LOD derivative was not applied to the open session');
    const tilesetDeadline = Date.now() + 10_000;
    while (!fixture.requests.includes('/session-assets/session-token/lod-browser-fixture/derivatives/tileset.json') && Date.now() < tilesetDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(fixture.requests.includes('/session-assets/session-token/lod-browser-fixture/derivatives/tileset.json'), 'refreshed session did not initialize the streaming tileset');
    assert.ok(fixture.currentRequests() >= 2);
    assert.equal(fixture.requests.filter((requestPath) => requestPath === fixture.glbPath).length, 0, 'session refresh fetched the original GLB');
    assert.equal(await client.evaluate(`document.querySelector('#layer-tiles')?.textContent`), 'Streamed LOD Mesh');
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    rmSync(tileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    releaseLock();
    removeBrowserProfile(profile);
  }
});

test('browser defaults to orthophoto when LOD is unavailable and tears down point-cloud runtime across history navigation', { timeout: 60_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for view lifecycle browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startStreamingOnlyFixture({
      ortho: '/fixtures/orthophoto.tif',
      ept: '/fixtures/ept/ept.json',
    });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-view-mode-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, `location.search.includes('view=ortho') && document.querySelector('#tab-ortho')?.classList.contains('active')`, 'orthophoto fallback was not selected');

    await client.evaluate(`document.querySelector('#tab-cloud').click()`);
    await waitFor(client, `location.search.includes('view=cloud') && Boolean(document.querySelector('#pc-iframe'))`, 'point-cloud mode did not start');
    await client.evaluate(`document.querySelector('#tab-ortho').click()`);
    await waitFor(client, `location.search.includes('view=ortho') && !document.querySelector('#pc-iframe')`, 'leaving point cloud did not stop its iframe');

    await client.evaluate('history.back()');
    await waitFor(client, `location.search.includes('view=cloud') && Boolean(document.querySelector('#pc-iframe'))`, 'browser history did not restore point-cloud mode');
    await client.command('Page.reload');
    await waitFor(client, `location.search.includes('view=cloud') && document.querySelector('#tab-cloud')?.classList.contains('active') && Boolean(document.querySelector('#pc-iframe'))`, 'refresh did not preserve point-cloud mode');

    assert.equal(fixture.requests.filter((requestPath) => requestPath === fixture.glbPath).length, 0, 'view lifecycle fetched the original GLB');
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise((resolve) => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    removeBrowserProfile(profile);
  }
});
