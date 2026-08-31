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
      shots: `${base}/shots.geojson`,
      cameraPhotos: `${base}/camera-photos`,
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
    if (url.pathname === `${assetPrefix}shots.geojson`) {
      const center = config.georef.bboxCenter;
      const features = [0, 1, 2].map((index) => {
        const translation = [
          config.georef.rtc.e + center.x + index * 4,
          config.georef.rtc.n + center.y + index * 3,
          config.georef.rtc.z + center.z + 20 + index,
        ];
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: translation.slice() },
          properties: {
            translation,
            rotation: [0, 0, 0],
            filename: `photo-${index}.jpg`,
          },
        };
      });
      reply.writeHead(200, { 'Content-Type': 'application/geo+json; charset=utf-8' });
      reply.end(JSON.stringify({ type: 'FeatureCollection', features }));
      return;
    }
    if (url.pathname.startsWith(`${assetPrefix}camera-photos/`)) {
      const filename = decodeURIComponent(url.pathname.slice(`${assetPrefix}camera-photos/`.length));
      if (!/^photo-[0-2]\.jpg$/.test(filename)) { reply.writeHead(404); reply.end(); return; }
      const body = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z8ZkAAAAASUVORK5CYII=', 'base64');
      reply.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      reply.end(body);
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

async function startSessionRefreshFixture(tileRoot, { fineTileDelayMs = 0 } = {}) {
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
      const sendAsset = () => {
        reply.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': statSync(file).size });
        createReadStream(file).pipe(reply);
      };
      if (fineTileDelayMs > 0 && /^leaf-(?:a\.b3dm|b\.glb)$/i.test(relative)) {
        setTimeout(sendAsset, fineTileDelayMs);
      } else {
        sendAsset();
      }
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
    const attachedTiles = [];
    const renderedTiles = [];
    const attachedMaterials = [];
    const visit = (tile) => {
      if (!tile) return;
      const children = tile.children || [];
      if (children.length) children.forEach(visit);
      const attached = Boolean(tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene));
      let rendered = false;
      if (attached) {
        tile.engineData.scene.traverse((object) => {
          if (!object.isMesh || !object.material) return;
          for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
            if (material.visible !== false) rendered = true;
            attachedMaterials.push({
              visible: material.visible !== false,
              depthWrite: material.depthWrite,
              polygonOffset: material.polygonOffset,
              renderOrder: object.renderOrder,
              hasMap: Boolean(material.map),
              imageReady: Boolean(material.map && (material.map.image?.width || material.map.source?.data?.width)),
            });
          }
        });
        const row = { uri: tile.content?.uri || tile.content?.url || null, error: Number(tile.geometricError), rendered };
        attachedTiles.push(row);
        if (rendered) renderedTiles.push(row);
      }
      if (!children.length && Number(tile.geometricError) === 0 && rendered) {
        visibleLeaves.push(tile.content?.uri || tile.content?.url || null);
      }
    };
    visit(root);
    const materials = [];
    root?.engineData?.scene?.traverse((object) => {
      if (!object.isMesh || !object.material) return;
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        materials.push({
          visible: material.visible !== false,
          depthWrite: material.depthWrite,
          polygonOffset: material.polygonOffset,
          renderOrder: object.renderOrder,
          hasMap: Boolean(material.map),
          imageReady: Boolean(material.map && (material.map.image?.width || material.map.source?.data?.width)),
        });
      }
    });
    return {
      errorPanel: getComputedStyle(document.querySelector('#error-panel')).display,
      lodStatus: document.querySelector('#lod-status')?.textContent || '',
      profile: window.__ltds.state?.lodRuntimeProfile || null,
      manifestValid: window.__ltds.state?.lodManifestReport?.valid === true,
      root: {
        uri: root?.content?.uri || root?.content?.url || null,
        refine: root?.refine || null,
        visible: Boolean(root?.traversal?.visible && root?.engineData?.scene?.visible),
        attached: Boolean(root?.engineData?.scene && tiles?.group?.children?.includes(root.engineData.scene)),
        rendered: Boolean(root?.engineData?.scene && tiles?.group?.children?.includes(root.engineData.scene)
          && materials.some((material) => material.visible)),
        materials,
      },
      visibleLeaves,
      attachedTiles,
      renderedTiles,
      attachedMaterials,
      cache: { minBytesSize: tiles?.lruCache?.minBytesSize, maxBytesSize: tiles?.lruCache?.maxBytesSize, minSize: tiles?.lruCache?.minSize, maxSize: tiles?.lruCache?.maxSize, unloadPercent: tiles?.lruCache?.unloadPercent },
    };
  })()`;
}

function foregroundCoverageExpression() {
  return `(() => {
    const tiles = window.__ltds.tiles();
    const root = tiles?.root;
    const rootScene = root?.engineData?.scene;
    const fineScenes = [];
    const visit = (tile) => {
      (tile?.children || []).forEach(visit);
      if (!(tile?.children || []).length && Number(tile?.geometricError) === 0
        && tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene)) fineScenes.push(tile.engineData.scene);
    };
    visit(root);
    tiles?.group?.updateWorldMatrix(true, true);
    const Raycaster = window.__ltds.controls()._raycaster.constructor;
    const raycaster = new Raycaster();
    raycaster.firstHitOnly = true;
    const rows = [];
    let fineSamples = 0;
    for (const y of [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]) {
      for (const x of [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]) {
        raycaster.setFromCamera({ x, y }, window.__ltds.camera());
        const rootHit = Boolean(rootScene && raycaster.intersectObject(rootScene, true).length);
        const fineHit = Boolean(fineScenes.length && raycaster.intersectObjects(fineScenes, true).length);
        if (fineHit) fineSamples += 1;
        if (rootHit) rows.push({ x, y, fineHit });
      }
    }
    let rootRendered = false;
    rootScene?.traverse?.((object) => {
      if (!object.isMesh || !object.material) return;
      for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
        if (material.visible !== false) rootRendered = true;
      }
    });
    return {
      rootSamples: rows.length,
      fineSamples,
      fineScenes: fineScenes.length,
      rootAttached: Boolean(rootScene && tiles?.group?.children?.includes(rootScene)),
      rootRendered: rootRendered && Boolean(rootScene && tiles?.group?.children?.includes(rootScene)),
      rootOnly: rows.filter((row) => !row.fineHit),
      queueRunning: Boolean(tiles?.downloadQueue?.running || tiles?.parseQueue?.running),
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

async function setViewAtFirstCamera(client) {
  await client.evaluate(`(() => {
    const values = window.__ltds.cameraWorldPositions();
    if (values.length < 3) return false;
    const Vector3 = window.__ltds.camera().position.constructor;
    const target = new Vector3(values[0], values[1], values[2]);
    window.__ltds.controls().setView(target.clone().add(new Vector3(40, 30, 40)), target);
    return true;
  })()`);
}

function assertHonestReplacement(snapshot, label) {
  assert.equal(snapshot.root.refine, 'REPLACE', `${label}: root refinement was mutated`);
  if (snapshot.root.rendered) {
    assert.deepEqual(snapshot.renderedTiles.map((tile) => tile.uri), [snapshot.root.uri], `${label}: root and refined tiles rendered together`);
    assert.doesNotMatch(snapshot.lodStatus, /full-detail/, `${label}: rendered root was mislabeled full-detail`);
  } else {
    assert.ok(snapshot.renderedTiles.length > 0, `${label}: REPLACE transition left no rendered tile`);
  }
}

test('browser LOD stream hides the coarse root after complete top-down foreground coverage', { timeout: 580_000 }, async (t) => {
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
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root && window.__ltds.tiles().group.children.length)', 'no LOD tile attached');
    await waitFor(client, 'window.__ltds.state?.lodManifestReport?.valid === true', 'REPLACE manifest did not validate');
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); return !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running; })()`, 'balanced startup queues did not settle');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); return !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running; })()`, 'balanced startup queues did not remain settled');
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 16`,
      'default view did not complete the 13 to 16 refinement stage', 20_000);
    const balancedStartup = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
      active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
      errorTarget: window.__ltds.tiles().errorTarget,
      phase: window.__ltds.lodDiagnostics().phase,
      bootstrapPhase: window.__ltds.state.lodRuntimeProfile?.bootstrapPhase,
      bootstrapCoverageTarget: window.__ltds.state.lodRuntimeProfile?.bootstrapCoverageTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
      status: document.querySelector('#lod-status').textContent,
    })`);
    assert.equal(balancedStartup.slider, '16');
    assert.equal(balancedStartup.requested, 16);
    assert.equal(balancedStartup.active, 16);
    assert.equal(balancedStartup.phase, 'requested-detail');
    assert.equal(balancedStartup.bootstrapPhase, 'complete');
    const balancedSteadyScale = Math.max(1, balancedStartup.errorScale / 2);
    assert.ok(Math.abs(balancedStartup.errorTarget - 15.023 * balancedSteadyScale) < 0.01,
      JSON.stringify(balancedStartup));
    assert.ok(balancedStartup.errorTarget < balancedStartup.bootstrapCoverageTarget,
      `steady Detail 16 must refine beyond the temporary coarse bootstrap target: ${JSON.stringify(balancedStartup)}`);
    assert.match(balancedStartup.status, /^LOD: (?:Detail 16|full-detail) \(\d+ tiles?\)$/);
    assert.doesNotMatch(balancedStartup.status, /warming|streaming/i);
    const startupLod0Requests = client.events.filter((event) => event.method === 'Network.requestWillBeSent'
      && /\/LOD-0\/[^/?#]+\.b3dm(?:[?#]|$)/i.test(event.params.request.url));
    assert.ok(startupLod0Requests.length < 16, `balanced startup fanned out to the complete LOD-0 frontier: ${startupLod0Requests.length}`);

    const home = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const volume = tiles.root.engineData.boundingVolume;
      const obb = volume.obb || volume.regionObb;
      const V = window.__ltds.camera().position.constructor;
      const min = new V(Infinity, Infinity, Infinity);
      const max = new V(-Infinity, -Infinity, -Infinity);
      tiles.group.updateWorldMatrix(true, false);
      const include = (x, y, z, matrix = null) => {
        const point = new V(x, y, z);
        if (matrix) point.applyMatrix4(matrix);
        point.applyMatrix4(tiles.group.matrixWorld);
        min.min(point); max.max(point);
      };
      if (obb?.box && obb?.transform) {
        for (const x of [obb.box.min.x, obb.box.max.x])
          for (const y of [obb.box.min.y, obb.box.max.y])
            for (const z of [obb.box.min.z, obb.box.max.z]) include(x, y, z, obb.transform);
      } else if (volume.sphere) {
        const c = volume.sphere.center, r = volume.sphere.radius;
        for (const x of [c.x-r, c.x+r])
          for (const y of [c.y-r, c.y+r])
            for (const z of [c.z-r, c.z+r]) include(x, y, z);
      } else return null;
      const center = min.clone().add(max).multiplyScalar(0.5);
      const diameter = max.clone().sub(min).length();
      const distance = Math.max(20, diameter * 0.9);
      const expected = new V(center.x, center.y + distance * 0.55, center.z + distance * 0.75);
      const actual = window.__ltds.camera().position;
      return { expected: expected.toArray(), actual: actual.toArray(), error: expected.distanceTo(actual), center: center.toArray(), diameter };
    })()`);
    assert.ok(home && home.error < 1e-5, `initial LOD framing ignored rendered world bounds: ${JSON.stringify(home)}`);

    await setView(client, [500, 600, 700], [50, 60, 70]);
    await client.evaluate(`document.querySelector('#btn-reset-float').click()`);
    const reset = await client.evaluate(`(() => {
      const expected = ${JSON.stringify(home.expected)};
      const p = window.__ltds.camera().position;
      return Math.hypot(p.x-expected[0], p.y-expected[1], p.z-expected[2]);
    })()`);
    assert.ok(reset < 1e-5, `Reset View did not restore world-bounds home: ${reset}`);

    const requestEventIndex = client.events.length;
    const explicitHighDetail = await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '24';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        slider: slider.value,
        requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
        active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
        errorTarget: window.__ltds.tiles().errorTarget,
      };
    })()`);
    assert.deepEqual(explicitHighDetail, {
      slider: '24', requested: 24, active: 16, errorTarget: balancedStartup.errorTarget,
    });

    const topRadius = Math.max(25, home.diameter * 0.15);
    const topPolar = 0.04;
    await setView(client, [
      home.center[0] + Math.sin(topPolar) * topRadius,
      home.center[1] + Math.cos(topPolar) * topRadius,
      home.center[2],
    ], home.center);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      await waitFor(client, `(() => {
        const tiles = window.__ltds.tiles();
        let visibleFine = 0;
        const visit = (tile) => {
          (tile?.children || []).forEach(visit);
          if (!(tile?.children || []).length && Number(tile?.geometricError) === 0
            && tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene)) visibleFine += 1;
        };
        visit(tiles?.root);
        return visibleFine > 0 && window.__ltds.state.lodRuntimeProfile?.activeDetail === 24
          && !tiles?.downloadQueue?.running && !tiles?.parseQueue?.running && !tiles?.processNodeQueue?.running;
      })()`, 'top-down foreground did not settle to visible fine leaves', 90_000);
    } catch (error) {
      const diagnostics = await client.evaluate(`(() => {
        const tiles=window.__ltds.tiles(); const rows=[];
        const visit=(tile,parent=null)=>{(tile?.children||[]).forEach(child=>visit(child,tile));rows.push({uri:tile?.content?.uri||tile?.content?.url||'',error:tile?.geometricError,used:tile?.traversal?.used,inFrustum:tile?.traversal?.inFrustum,active:tile?.traversal?.active,visible:tile?.traversal?.visible,attached:Boolean(tile?.engineData?.scene&&tiles.group.children.includes(tile.engineData.scene)),loadingState:tile?.internal?.loadingState,parent:parent?.content?.uri||parent?.content?.url||''});};visit(tiles.root);return {loadAncestors:tiles.loadAncestors,loadSiblings:tiles.loadSiblings,errorTarget:tiles.errorTarget,rootRefine:tiles.root?.refine,groupChildren:tiles.group.children.length,downloadRunning:tiles.downloadQueue?.running,parseRunning:tiles.parseQueue?.running,cacheBytes:tiles.lruCache?.bytesSize,cacheCount:tiles.lruCache?.itemSet?.size,rows};
      })()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    const topCoverage = await client.evaluate(foregroundCoverageExpression());
    assert.ok(topCoverage.fineSamples > 0, `top-down coverage probe did not intersect attached full-detail geometry: ${JSON.stringify(topCoverage)}`);
    assert.ok(topCoverage.fineScenes > 0, `top-down view exposed no full-detail scenes: ${JSON.stringify(topCoverage)}`);
    assert.equal(topCoverage.rootRendered, false, `settled top-down view still rendered the coarse root: ${JSON.stringify(topCoverage)}`);
    assert.equal(topCoverage.queueRunning, false);
    assert.ok(client.events.slice(requestEventIndex).some((event) => event.method === 'Network.requestWillBeSent'
      && /\/LOD-0\/[^/?#]+\.b3dm(?:[?#]|$)/i.test(event.params.request.url)), 'explicit Detail 24 requested no LOD-0 content');
    await client.evaluate(`document.querySelector('#btn-reset-float').click()`);

    const pole = await client.evaluate(`(() => {
      document.querySelector('#btn-top').click();
      const controls = window.__ltds.controls();
      const camera = window.__ltds.camera();
      const V = camera.position.constructor;
      const target = new V(0, 18, 0);
      const topPosition = camera.position.clone();
      const topRadius = topPosition.distanceTo(target);
      const initialPolar = Math.acos(Math.max(-1, Math.min(1, topPosition.clone().sub(target).normalize().y)));
      controls._applyOrbit(target, 0, 0.001);
      const firstOrbitDelta = camera.position.distanceTo(topPosition);
      let minimumPolar = Infinity;
      let minimumQuaternionDot = 1;
      let previous = camera.quaternion.clone();
      for (let i = 0; i < 80; i += 1) {
        controls._applyOrbit(target, i % 2 ? 0.012 : -0.012, -0.25);
        const offset = camera.position.clone().sub(target).normalize();
        const polar = Math.acos(Math.max(-1, Math.min(1, offset.y)));
        minimumPolar = Math.min(minimumPolar, polar);
        minimumQuaternionDot = Math.min(minimumQuaternionDot, Math.abs(previous.dot(camera.quaternion)));
        previous.copy(camera.quaternion);
      }
      return {
        minimumPolar,
        configuredMinimum: controls.minPolar,
        initialPolar,
        topRadius,
        firstOrbitDelta,
        minimumQuaternionDot,
        finite: [...camera.position.toArray(), ...camera.quaternion.toArray()].every(Number.isFinite),
      };
    })()`);
    assert.equal(pole.finite, true, `top-down orbit produced non-finite camera state: ${JSON.stringify(pole)}`);
    assert.ok(pole.initialPolar > pole.configuredMinimum, `Top View began on the polar clamp instead of inside it: ${JSON.stringify(pole)}`);
    assert.ok(pole.firstOrbitDelta < pole.topRadius * 0.002, `first top-down orbit made a clamp catch-up jump: ${JSON.stringify(pole)}`);
    assert.ok(pole.minimumPolar >= pole.configuredMinimum - 1e-8, `top-down orbit crossed the polar limit: ${JSON.stringify(pole)}`);
    assert.ok(pole.minimumQuaternionDot > 0.99, `top-down orbit orientation jumped or flipped: ${JSON.stringify(pole)}`);
    await client.evaluate(`document.querySelector('#btn-reset-float').click()`);
    await waitFor(client, `(() => {
      const tiles = window.__ltds.tiles();
      const root = tiles?.root;
      return root?.refine === 'REPLACE'
        && !tiles?.downloadQueue?.running && !tiles?.parseQueue?.running && !tiles?.processNodeQueue?.running
        && Boolean(tiles?.group?.children?.length);
    })()`, 'settled home view did not retain a valid REPLACE frontier', 210_000);

    const initial = await client.evaluate(snapshotExpression());
    assert.equal(initial.errorPanel, 'none');
    assertHonestReplacement(initial, 'settled home view');
    assert.ok(initial.attachedMaterials.length > 0);
    const visibleInitialMaterials = initial.attachedMaterials.filter((item) => item.visible);
    assert.ok(visibleInitialMaterials.length > 0);
    assert.ok(visibleInitialMaterials.every((item) => item.depthWrite === true && item.polygonOffset === false && item.renderOrder === 0));
    assert.ok(initial.root.materials.every((item) => item.depthWrite === true && item.polygonOffset === false && item.renderOrder === 0));
    assert.ok(initial.attachedMaterials.every((item) => item.hasMap && item.imageReady), 'attached full-detail B3DM textures were not decoded and bound');
    assert.deepEqual(initial.cache, { minBytesSize: 0.4 * GiB, maxBytesSize: 1.75 * GiB, minSize: 8, maxSize: 1024, unloadPercent: 0.20 });

    await client.evaluate(`document.querySelector('#layer-cameras').click()`);
    await waitFor(client, 'window.__ltdsCams === 3', 'camera positions did not load');
    await setViewAtFirstCamera(client);
    await waitFor(client, 'window.__ltdsCamDrawn > 0', 'camera-facing view did not expose a representative', 30_000);
    const visibleCameras = await client.evaluate(`(() => {
      const meshes = [];
      window.__ltds.scene().traverse((object) => {
        if (object.isInstancedMesh && object.visible && object.parent?.parent?.visible) {
          const colors = object.instanceColor;
          const sampled = object.material?.color?.clone?.();
          if (sampled && colors) sampled.fromBufferAttribute(colors, 0);
          const color = sampled?.getHex?.() ?? null;
          meshes.push({ count: object.count, color });
        }
      });
      return { totalInstances: meshes.reduce((sum, item) => sum + item.count, 0), meshes, drawn: window.__ltdsCamDrawn, drawToSource: window.__ltdsCamDrawToSource };
    })()`);
    assert.ok(visibleCameras.drawn > 0 && visibleCameras.drawn <= 3, JSON.stringify(visibleCameras));
    assert.equal(visibleCameras.totalInstances, visibleCameras.drawn * 3, 'each selected camera renders orange, white, and yellow frustum sections');
    assert.deepEqual(visibleCameras.meshes.map(item => item.count).sort((a, b) => a - b), [visibleCameras.drawn, visibleCameras.drawn, visibleCameras.drawn]);
    assert.equal(visibleCameras.drawToSource.length, visibleCameras.drawn);
    assert.deepEqual(visibleCameras.meshes.map(item => item.color).sort((a, b) => a - b), [0xEE5007, 0xFFFFFF, 0xFFA200].sort((a, b) => a - b));
    const cameraClick = await client.evaluate(`(() => {
      const meshes = [];
      window.__ltds.scene().traverse((object) => { if (object.isInstancedMesh && object.count === window.__ltdsCamDrawn && object.parent?.parent?.visible) meshes.push(object); });
      if (meshes.length !== 3) return null;
      const M = meshes[0].matrixWorld.constructor, V = window.__ltds.camera().position.constructor;
      const instance = new M();
      meshes[0].getMatrixAt(0, instance);
      meshes[0].updateWorldMatrix(true, false);
      const markerTarget = new V(0, 0, 0.24).applyMatrix4(instance).applyMatrix4(meshes[0].matrixWorld);
      window.__ltds.controls().setView(markerTarget.clone().add(new V(40, 30, 40)), markerTarget);
      window.__ltds.camera().updateMatrixWorld(true);
      const center = markerTarget.clone().project(window.__ltds.camera());
      const canvas = document.querySelector('#three-container canvas'), rect = canvas.getBoundingClientRect();
      const projected = { x: rect.left + (center.x + 1) * rect.width / 2, y: rect.top + (1 - center.y) * rect.height / 2 };
      const raycaster = new (window.__ltds.controls()._raycaster.constructor)();
      for (let radius = 0; radius <= 40; radius += 2) {
        for (let dy = -radius; dy <= radius; dy += 2) for (let dx = -radius; dx <= radius; dx += 2) {
          if (radius && Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
          const x = projected.x + dx, y = projected.y + dy;
          raycaster.setFromCamera(window.__ltds.controls()._ndc({ clientX: x, clientY: y }), window.__ltds.camera());
          const hit = raycaster.intersectObjects(meshes, false)[0];
          if (hit?.instanceId === 0) return { x, y, projected, meshHits: meshes.length };
        }
      }
      return { projected, meshHits: meshes.length, missed: true };
    })()`);
    assert.ok(cameraClick && !cameraClick.missed && Number.isFinite(cameraClick.x) && Number.isFinite(cameraClick.y), `no raycastable camera marker pixel: ${JSON.stringify(cameraClick)}`);
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(client, `document.querySelector('#photo-modal').style.display === 'flex'`, 'camera marker did not open its photo modal');
    const photoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(photoUrl, new RegExp(`/camera-photos/photo-${visibleCameras.drawToSource[0]}\\.jpg$`));
    assert.doesNotMatch(photoUrl, /storage|mnt|dataset/i);
    await waitFor(client, `document.querySelector('#photo-img').naturalWidth === 1`, 'capability-scoped camera image did not decode');
    await client.evaluate(`document.querySelector('#photo-close').click()`);
    await client.evaluate(`(() => { window.__ltds.state.activeMode='cloud'; window.__ltds.state.cloudMode='direct'; return true; })()`);
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(client, `document.querySelector('#photo-modal').style.display === 'flex'`, 'direct LAZ/PLY camera marker did not open its photo modal');
    const directPhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.equal(directPhotoUrl, photoUrl, 'Model and direct Point Cloud markers did not use the same scoped photo URL');
    await client.evaluate(`(() => { document.querySelector('#photo-close').click(); window.__ltds.state.activeMode='model'; window.__ltds.state.cloudMode='none'; return true; })()`);
    await client.evaluate(`document.querySelector('#btn-reset-float').click()`);
    await client.evaluate(`document.querySelector('#layer-cameras').click()`);

    const transferred = await client.evaluate(`(() => {
      const state = window.__ltds.state;
      const V = window.__ltds.camera().position.constructor;
      const expectedPosition = new V(35, 75, 95);
      const expectedTarget = new V(5, 15, 25);
      const positionUtm = window.__ltds.worldToUtm(expectedPosition);
      const targetUtm = window.__ltds.worldToUtm(expectedTarget);
      const iframe = document.createElement('iframe');
      iframe.id = 'pc-iframe';
      iframe.src = 'about:blank';
      document.querySelector('#cloud-container').appendChild(iframe);
      state.cloudMode = 'potree';
      state.pcIframeLoaded = true;
      document.querySelector('#tab-cloud').click();
      iframe.contentWindow.viewer = { scene: { view: {
        position: { x: positionUtm.e, y: positionUtm.n, z: positionUtm.alt },
        getPivot: () => ({ x: targetUtm.e, y: targetUtm.n, z: targetUtm.alt }),
      } } };
      iframe.contentWindow.__pcViewReady = true;
      iframe.contentWindow.__getViewUTM = () => ({
        position: [positionUtm.e, positionUtm.n, positionUtm.alt],
        target: [targetUtm.e, targetUtm.n, targetUtm.alt],
      });
      document.querySelector('#tab-model').click();
      return {
        expected: expectedPosition.toArray(),
        beforeRootError: window.__ltds.camera().position.distanceTo(expectedPosition),
      };
    })()`);
    assert.ok(transferred.beforeRootError < 1e-5, `point-cloud view was not transferred before LOD startup: ${JSON.stringify(transferred)}`);
    await waitFor(client, 'Boolean(window.__ltds.tiles()?.root && window.__ltds.tiles().group.children.length)', 'reloaded LOD view did not attach a tile after point-cloud transfer');
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); const root=t?.root; return Boolean(root?.engineData?.scene && t.group.children.includes(root.engineData.scene) && document.querySelector('#loading-overlay')?.classList.contains('hidden')); })()`, 'reloaded LOD view exposed the canvas before its root fallback attached', 90_000);
    const transferAfterRoot = await client.evaluate(`(() => {
      const expected = ${JSON.stringify([35, 75, 95])};
      const p = window.__ltds.camera().position;
      return Math.hypot(p.x-expected[0], p.y-expected[1], p.z-expected[2]);
    })()`);
    assert.ok(transferAfterRoot < 1e-5, `LOD startup overwrote the transferred point-cloud view: ${transferAfterRoot}`);

    await setView(client, [0, 44, 52], [0, 18, 0]);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&window.__ltds.tiles().group.children.includes(tile.engineData.scene))n++;};f(r);return n>0; })()`, 'close view did not refine');
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); return window.__ltds.state.lodRuntimeProfile?.activeDetail === 24 && !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running; })()`, 'close view did not complete staged foreground coverage', 210_000);
    const close = await client.evaluate(snapshotExpression());
    assert.ok(close.visibleLeaves.length > 0);
    assert.equal(close.root.rendered, false, `close view retained its coarse root: ${JSON.stringify(close)}`);
    assertHonestReplacement(close, 'close view');

    const orbitPixels = await client.evaluate(`(() => {
      const controls=window.__ltds.controls(); const rect=controls.dom.getBoundingClientRect();
      const rows=[],positions=[[0.08,0.08],[0.92,0.08],[0.08,0.92],[0.92,0.92],[0.5,0.5],[0.35,0.5],[0.65,0.5],[0.5,0.35],[0.5,0.65],[0.2,0.2],[0.8,0.2],[0.2,0.8],[0.8,0.8]];
      for(const [fx,fy] of positions){
        const x=rect.left+rect.width*fx,y=rect.top+rect.height*fy;
        const ndc={x:((x-rect.left)/rect.width)*2-1,y:-((y-rect.top)/rect.height)*2+1};
        rows.push({x,y,hit:Boolean(controls.surfacePick(ndc))});
        if(rows.some(row=>row.hit)&&rows.some(row=>!row.hit))break;
      }
      return {rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},surface:rows.find(row=>row.hit)||null,empty:rows.find(row=>!row.hit)||null};
    })()`);
    assert.ok(orbitPixels.surface && orbitPixels.empty, `could not locate both model and background pixels: ${JSON.stringify(orbitPixels)}`);
    const cameraState = () => client.evaluate(`({position:window.__ltds.camera().position.toArray(),quaternion:window.__ltds.camera().quaternion.toArray()})`);
    const dragFrom = async (point) => {
      const centerX=orbitPixels.rect.left+orbitPixels.rect.width/2;
      const centerY=orbitPixels.rect.top+orbitPixels.rect.height/2;
      const endX=point.x+(point.x<centerX?32:-32),endY=point.y+(point.y<centerY?18:-18);
      await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1});
      await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:endX,y:endY,button:'left',buttons:1});
      await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:endX,y:endY,button:'left',buttons:0,clickCount:1});
    };
    const emptyBefore = await cameraState();
    await dragFrom(orbitPixels.empty);
    const emptyAfter = await cameraState();
    const cameraDelta = (before,after) => Math.max(...before.position.map((value,index)=>Math.abs(value-after.position[index])),1-Math.abs(before.quaternion.reduce((sum,value,index)=>sum+value*after.quaternion[index],0)));
    assert.ok(cameraDelta(emptyBefore,emptyAfter)<1e-8,`empty-background drag moved the camera: ${JSON.stringify({emptyBefore,emptyAfter,orbitPixels})}`);
    const surfaceBefore = await cameraState();
    await dragFrom(orbitPixels.surface);
    const surfaceAfter = await cameraState();
    assert.ok(cameraDelta(surfaceBefore,surfaceAfter)>1e-4,'valid model-surface drag did not orbit');
    await setView(client, [0, 44, 52], [0, 18, 0]);

    const defaultDetail = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      errorTarget: window.__ltds.tiles().errorTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
      downloadJobs: window.__ltds.tiles().downloadQueue.maxJobs,
      parseJobs: window.__ltds.tiles().parseQueue.maxJobs,
    })`);
    assert.equal(defaultDetail.slider, '24');
    assert.equal(defaultDetail.downloadJobs, 6);
    assert.equal(defaultDetail.parseJobs, 2);
    assert.ok(Math.abs(defaultDetail.errorTarget - 2 * Math.max(1, defaultDetail.errorScale / 2)) < 0.01,
      JSON.stringify(defaultDetail));
    await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '2';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    try {
      await waitFor(client, `(() => { const r=window.__ltds.tiles().root; const p=window.__ltds.state.lodRuntimeProfile; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&window.__ltds.tiles().group.children.includes(tile.engineData.scene))n++;};f(r);return Math.abs(window.__ltds.tiles().errorTarget-512*Math.max(1,p.errorScale/2))<0.01&&n===0; })()`, 'minimum Detail setting did not coarsen the active frontier', 10_000);
    } catch (error) {
      const detailDiagnostics = await client.evaluate(`(() => {
        const tiles=window.__ltds.tiles(); const rows=[];
        const visit=(tile,parent=null)=>{(tile?.children||[]).forEach(child=>visit(child,tile));if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.traversal?.visible)rows.push({uri:tile.content?.uri||'',parentError:parent?.traversal?.error,parentInFrustum:parent?.traversal?.inFrustum,active:tile.traversal?.active,sceneVisible:tile.engineData?.scene?.visible});};
        visit(tiles.root); return {errorTarget:tiles.errorTarget,loadAncestors:tiles.loadAncestors,rootRefine:tiles.root?.refine,rows};
      })()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(detailDiagnostics)}`);
    }
    await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '24';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; const p=window.__ltds.state.lodRuntimeProfile; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&window.__ltds.tiles().group.children.includes(tile.engineData.scene))n++;};f(r);return Math.abs(window.__ltds.tiles().errorTarget-2*Math.max(1,p.errorScale/2))<0.01&&n>0; })()`, 'maximum Detail setting did not restore full-detail leaves');

    await setView(client, [0, 1300, 1300], [0, 18, 0]);
    await waitFor(client, `(() => { const r=window.__ltds.tiles().root; let n=0; const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&window.__ltds.tiles().group.children.includes(tile.engineData.scene))n++;};f(r);return n===0; })()`, 'far view kept LOD-0 leaves');
    const far = await client.evaluate(snapshotExpression());
    assert.equal(far.visibleLeaves.length, 0);
    assert.equal(far.root.rendered, true);
    assert.ok(far.attachedTiles.length > 0, JSON.stringify(far));
    assert.ok(far.attachedTiles.some((tile) => tile.error > 0), JSON.stringify(far.attachedTiles));

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
      try {
        await waitFor(client, `(() => { const t=window.__ltds.tiles(); const close=new Set(${JSON.stringify([...closeSet])}); let found=false; const f=(tile)=>{(tile?.children||[]).forEach(f);const uri=tile.content?.uri||tile.content?.url;if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)&&!close.has(uri))found=true;};f(t.root);return found; })()`, 'alternate detailed leaf did not attach', 30_000);
      } catch {}
      const sample = await client.evaluate(snapshotExpression());
      panSamples.push({ candidate, visibleLeaves: sample.visibleLeaves, camera: sample.camera });
      if (sample.visibleLeaves.some((uri) => !closeSet.has(uri))) {
        panned = sample;
        break;
      }
    }
    assert.ok(panned, `panning did not replace the detailed frontier: ${JSON.stringify({ close: [...closeSet], panSamples })}`);
    panned = await client.evaluate(snapshotExpression());
    assertHonestReplacement(panned, 'panned view');

    // Returning to the original close-up must restore its detailed REPLACE
    // frontier without retaining a coarse ancestor over or under it.
    await setView(client, [0, 44, 52], [0, 18, 0]);
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); const expected=new Set(${JSON.stringify([...closeSet])}); let found=false; const f=(tile)=>{(tile?.children||[]).forEach(f);const rendered=tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)&&(()=>{let visible=false;tile.engineData.scene.traverse(object=>{if(object.isMesh&&object.material)for(const material of(Array.isArray(object.material)?object.material:[object.material]))if(material.visible!==false)visible=true;});return visible;})();if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&rendered&&expected.has(tile.content?.uri||tile.content?.url))found=true;};f(t.root);return found; })()`, 'returning to the close view did not restore its detailed leaf', 120_000);
    const returned = await client.evaluate(snapshotExpression());
    assert.ok(returned.visibleLeaves.some((uri) => closeSet.has(uri)));
    assertHonestReplacement(returned, 'returned close view');

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

test('browser close view refines at the default Detail and small motion retains decoded tiles', { timeout: 300_000 }, async (t) => {
  const tileRoot = process.env.LTDS_LOD_TEST_TILE_ROOT;
  const executable = browserPath();
  if (!tileRoot || !existsSync(path.join(tileRoot, 'tileset.json')) || !executable) {
    t.skip('Set LTDS_LOD_TEST_TILE_ROOT and CHROME_PATH/EDGE_PATH to run real LOD retention acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startFixture(path.resolve(tileRoot));
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-lod-retention-browser-'));
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
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1440, screenHeight: 900,
    });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root?.engineData?.scene)', 'coarse root did not load');

    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 16`,
      'default Detail did not finish its bounded 13 to 16 stage', 180_000);
    const defaultState = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
      active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
      errorTarget: window.__ltds.tiles().errorTarget,
      bootstrapPhase: window.__ltds.state.lodRuntimeProfile?.bootstrapPhase,
      bootstrapCoverageTarget: window.__ltds.state.lodRuntimeProfile?.bootstrapCoverageTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
    })`);
    assert.equal(defaultState.slider, '16');
    assert.equal(defaultState.requested, 16);
    assert.equal(defaultState.active, 16);
    assert.equal(defaultState.bootstrapPhase, 'complete');
    assert.ok(Math.abs(defaultState.errorTarget - 15.023 * Math.max(1, defaultState.errorScale / 2)) < 0.01,
      `the default view must leave coarse bootstrap and resume bounded requested detail: ${JSON.stringify(defaultState)}`);
    assert.ok(defaultState.errorTarget < defaultState.bootstrapCoverageTarget, JSON.stringify(defaultState));

    const basePosition = [0, 44, 52];
    const baseTarget = [0, 18, 0];
    await setView(client, basePosition, baseTarget);
    await waitFor(client, `(() => {
      const t=window.__ltds.tiles(); let attached=0;
      const visit=(tile)=>{(tile?.children||[]).forEach(visit);if(!(tile?.children||[]).length
        && Number(tile?.geometricError)===0 && tile.engineData?.scene
        && t.group.children.includes(tile.engineData.scene))attached++;};
      visit(t.root); return attached>0 && !t.downloadQueue?.running
        && !t.parseQueue?.running && !t.processNodeQueue?.running;
    })()`, 'default Detail did not refine the close view to any zero-error leaf', 180_000);

    const requestStart = client.events.length;
    const baseline = await client.evaluate(`(() => {
      const t=window.__ltds.tiles(); const scenes={};
      const visit=(tile)=>{(tile?.children||[]).forEach(visit);const uri=tile?.content?.uri||tile?.content?.url||'';
        if(!(tile?.children||[]).length && Number(tile?.geometricError)===0 && tile.engineData?.scene
          && t.group.children.includes(tile.engineData.scene)) scenes[uri]=tile.engineData.scene.uuid;};
      visit(t.root); window.__ltdsRetentionBaseline=scenes;
      return { scenes, cachedBytes:t.lruCache.cachedBytes, minBytesSize:t.lruCache.minBytesSize,
        maxBytesSize:t.lruCache.maxBytesSize, minSize:t.lruCache.minSize, maxSize:t.lruCache.maxSize };
    })()`);
    assert.ok(Object.keys(baseline.scenes).length > 0, JSON.stringify(baseline));

    let boundary = null;
    for (const offset of [1, 2, 4, 8]) {
      await setView(client,
        [basePosition[0] + offset, basePosition[1], basePosition[2]],
        [baseTarget[0] + offset, baseTarget[1], baseTarget[2]],
      );
      await client.evaluate(`(() => {
        const V=window.__ltds.camera().position.constructor;
        window.__ltds.controls()._applyOrbit(new V(${baseTarget.join(',')}), 0.018, 0.006);
        return true;
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const sample = await client.evaluate(`(() => {
        const t=window.__ltds.tiles(); const baseline=window.__ltdsRetentionBaseline||{};
        const rows=[]; const visit=(tile)=>{(tile?.children||[]).forEach(visit);const uri=tile?.content?.uri||tile?.content?.url||'';
          if(Object.hasOwn(baseline,uri))rows.push({uri,used:tile?.traversal?.used===true,cacheUsed:t.lruCache.isUsed(tile),
            inFrustum:tile?.traversal?.inFrustum===true,scene:tile?.engineData?.scene?.uuid||null,
            attached:Boolean(tile?.engineData?.scene&&t.group.children.includes(tile.engineData.scene))});};
        visit(t.root); return {rows,cachedBytes:t.lruCache.cachedBytes,phase:window.__ltds.lodDiagnostics().phase};
      })()`);
      if (sample.rows.some((row) => row.scene && row.cacheUsed === false && row.attached === false)) {
        boundary = { offset, sample };
        break;
      }
    }
    assert.ok(boundary, 'an 8-meter pan plus one-degree orbit did not make a decoded baseline tile LRU-unused and detached');
    assert.notEqual(boundary.sample.phase, 'memory-limited', JSON.stringify(boundary));

    await setView(client, basePosition, baseTarget);
    await waitFor(client, `(() => {
      const t=window.__ltds.tiles(); const baseline=window.__ltdsRetentionBaseline||{};
      let expected=0,attached=0; const visit=(tile)=>{(tile?.children||[]).forEach(visit);
        const uri=tile?.content?.uri||tile?.content?.url||''; if(!Object.hasOwn(baseline,uri))return;
        expected++; if(tile?.engineData?.scene&&t.group.children.includes(tile.engineData.scene))attached++;};
      visit(t.root); return expected===Object.keys(baseline).length && attached===expected
        && !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running;
    })()`, 'returned close view did not restore and settle its previous frontier', 180_000);
    const returned = await client.evaluate(`(() => {
      const t=window.__ltds.tiles(); const baseline=window.__ltdsRetentionBaseline||{}; const rows=[];
      const visit=(tile)=>{(tile?.children||[]).forEach(visit);const uri=tile?.content?.uri||tile?.content?.url||'';
        if(Object.hasOwn(baseline,uri))rows.push({uri,before:baseline[uri],after:tile?.engineData?.scene?.uuid||null,
          attached:Boolean(tile?.engineData?.scene&&t.group.children.includes(tile.engineData.scene))});};
      visit(t.root); return {rows,cachedBytes:t.lruCache.cachedBytes,phase:window.__ltds.lodDiagnostics().phase};
    })()`);
    const changedScenes = returned.rows.filter((row) => row.before !== row.after);
    const baselineUris = Object.keys(baseline.scenes);
    const repeatedRequests = client.events.slice(requestStart)
      .filter((event) => event.method === 'Network.requestWillBeSent'
        && baselineUris.some((uri) => new URL(event.params.request.url).pathname.endsWith(`/${uri}`)))
      .map((event) => new URL(event.params.request.url).pathname);
    assert.deepEqual(changedScenes, [], `small camera motion discarded just-viewed decoded tiles: ${JSON.stringify({ baseline, boundary, returned })}`);
    assert.deepEqual(repeatedRequests, [], `small camera motion re-requested just-viewed tiles: ${JSON.stringify(repeatedRequests)}`);
    assert.notEqual(returned.phase, 'memory-limited', JSON.stringify(returned));
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

test('browser camera layer activates a bounded representative draw set', { timeout: 90_000 }, async (t) => {
  const tileRoot = process.env.LTDS_LOD_TEST_TILE_ROOT;
  const executable = browserPath();
  if (!tileRoot || !existsSync(path.join(tileRoot, 'tileset.json')) || !executable) {
    t.skip('Set LTDS_LOD_TEST_TILE_ROOT and CHROME_PATH/EDGE_PATH to run real camera browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startFixture(path.resolve(tileRoot));
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-camera-browser-'));
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
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root && window.__ltds.tiles().group.children.length)', 'no LOD tile attached');
    const lodDiagnostics = await client.evaluate(`window.__ltds.lodDiagnostics()`);
    assert.ok(['overview', 'coverage', 'warmup', 'requested-detail', 'reduced-memory', 'memory-limited'].includes(lodDiagnostics.phase), JSON.stringify(lodDiagnostics));
    assert.ok(Number.isInteger(lodDiagnostics.pendingRequiredLeaves) && lodDiagnostics.pendingRequiredLeaves >= 0, JSON.stringify(lodDiagnostics));
    assert.ok([768, 1792, 3072].includes(lodDiagnostics.cache.maxMiB), JSON.stringify(lodDiagnostics));
    assert.doesNotMatch(JSON.stringify(lodDiagnostics), /https?:|token|secret|storage|mnt/i);
    await client.evaluate(`document.querySelector('#layer-cameras').click()`);
    try {
      await waitFor(client, 'window.__ltdsCams === 3', 'camera positions did not load', 20_000);
    } catch (error) {
      const diagnostics = await client.evaluate(`({ cams: window.__ltdsCams, drawn: window.__ltdsCamDrawn, loading: window.__ltds?.state?.camerasLoading, loaded: window.__ltds?.state?.camerasLoaded })`).catch(() => null);
      const browserErrors = client.events.filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'));
      assert.fail(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}; browserErrors=${JSON.stringify(browserErrors)}`);
    }
    await setViewAtFirstCamera(client);
    try {
      await waitFor(client, 'window.__ltdsCamDrawn > 0', 'camera-facing view did not expose a representative', 30_000);
    } catch (error) {
      const diagnostics = await client.evaluate(`(() => {
        const camera=window.__ltds.camera(); camera.updateMatrixWorld(true);
        const V=camera.position.constructor;
        const projected=[[0,20,0],[4,21,-3],[8,22,-6]].map(value=>{const p=new V(...value),view=p.clone().applyMatrix4(camera.matrixWorldInverse),ndc=p.clone().project(camera);return {value,view:view.toArray(),ndc:ndc.toArray()};});
        const meshes=[];window.__ltds.scene().traverse(object=>{if(object.isInstancedMesh)meshes.push({count:object.count,parentVisible:object.parent?.parent?.visible,group:object.parent?.parent?.name||''});});
        return {cams:window.__ltdsCams,drawn:window.__ltdsCamDrawn,drawToSource:window.__ltdsCamDrawToSource,camera:camera.position.toArray(),cameraWorldPositions:window.__ltds.cameraWorldPositions(),projected,meshes};
      })()`);
      assert.fail(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
    }
    const state = await client.evaluate(`(() => {
      const meshes = [];
      window.__ltds.scene().traverse((object) => {
        if (!object.isInstancedMesh || !object.parent?.parent?.visible) return;
        const c = new object.material.color.constructor();
        object.getColorAt(0, c);
        meshes.push({ count: object.count, color: c.getHex(), opacity: object.material.opacity, renderOrder: object.renderOrder });
      });
      return { source: window.__ltdsCams, drawn: window.__ltdsCamDrawn, meshes };
    })()`);
    assert.equal(state.source, 3);
    assert.ok(state.drawn >= 0 && state.drawn <= 3, JSON.stringify(state));
    assert.deepEqual(state.meshes.map((mesh) => mesh.count), [state.drawn, state.drawn, state.drawn]);
    assert.deepEqual(state.meshes.map((mesh) => mesh.color), [0xEE5007, 0xFFFFFF, 0xFFA200]);
    assert.deepEqual(state.meshes.map((mesh) => mesh.opacity), [0.7, 0.7, 0.7]);
    assert.deepEqual(state.meshes.map((mesh) => mesh.renderOrder), [0, 1, 2]);

    const readScale = async (source = null) => client.evaluate(`(() => {
      const source = ${source === null ? 'window.__ltdsCamDrawToSource[0]' : Number(source)};
      const draw = window.__ltdsCamDrawToSource.indexOf(source);
      const mesh = (() => { let found = null; window.__ltds.scene().traverse((object) => {
        if (!found && object.isInstancedMesh && object.parent?.parent?.visible) found = object;
      }); return found; })();
      if (!mesh || draw < 0) return null;
      const matrix = new mesh.matrixWorld.constructor();
      const position = new mesh.position.constructor();
      const quaternion = new mesh.quaternion.constructor();
      const scale = new mesh.scale.constructor();
      mesh.getMatrixAt(draw, matrix);
      matrix.decompose(position, quaternion, scale);
      return { source, scale: scale.toArray() };
    })()`);
    const initialScale = await readScale();
    assert.ok(initialScale, 'initial representative scale was unavailable');
    assert.ok(initialScale.scale.every((value) => Math.abs(value - 0.5) < 1e-6), `default camera scale was not 0.5: ${JSON.stringify(initialScale)}`);
    const setCameraOffset = async (offset) => {
      await client.evaluate(`(() => {
        const values = window.__ltds.cameraWorldPositions();
        const Vector3 = window.__ltds.camera().position.constructor;
        const target = new Vector3(values[0], values[1], values[2]);
        window.__ltds.controls().setView(target.clone().add(new Vector3(${offset.join(',')})), target);
      })()`);
      await waitFor(client, `window.__ltdsCamDrawToSource.includes(${initialScale.source})`, 'source camera disappeared while zooming');
      return readScale(initialScale.source);
    };
    const closeScale = await setCameraOffset([4, 3, 4]);
    if (process.env.LTDS_CAMERA_SCREENSHOT_PREFIX) {
      const closeCapture = await client.command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${process.env.LTDS_CAMERA_SCREENSHOT_PREFIX}-close.png`, Buffer.from(closeCapture.data, 'base64'));
    }
    const farScale = await setCameraOffset([100, 75, 100]);
    if (process.env.LTDS_CAMERA_SCREENSHOT_PREFIX) {
      const farCapture = await client.command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(`${process.env.LTDS_CAMERA_SCREENSHOT_PREFIX}-far.png`, Buffer.from(farCapture.data, 'base64'));
    }
    assert.deepEqual(closeScale.scale, initialScale.scale, 'close zoom changed camera world scale');
    assert.deepEqual(farScale.scale, initialScale.scale, 'far zoom changed camera world scale');
    await client.evaluate(`(() => {
      const values = window.__ltds.cameraWorldPositions();
      const Vector3 = window.__ltds.camera().position.constructor;
      const target = new Vector3(values[0], values[1], values[2]);
      window.__ltds.controls().setView(target.clone().add(new Vector3(1000, 750, 1000)), target);
    })()`);
    await waitFor(client, `window.__ltdsCamDrawn > 0`, 'extreme far view exposed no camera representative');
    const extremeClick = await client.evaluate(`(() => {
      const source = window.__ltdsCamDrawToSource[0];
      const values = window.__ltds.cameraWorldPositions();
      const Vector3 = window.__ltds.camera().position.constructor;
      const point = new Vector3(values[source * 3], values[source * 3 + 1], values[source * 3 + 2]).project(window.__ltds.camera());
      const rect = document.querySelector('#three-container canvas').getBoundingClientRect();
      const x = rect.left + (point.x + 1) * rect.width / 2 + 8;
      const y = rect.top + (1 - point.y) * rect.height / 2;
      let expectedSource = -1, nearestDistance = Infinity;
      for (const candidate of window.__ltdsCamDrawToSource) {
        const projected = new Vector3(values[candidate * 3], values[candidate * 3 + 1], values[candidate * 3 + 2]).project(window.__ltds.camera());
        const px = rect.left + (projected.x + 1) * rect.width / 2;
        const py = rect.top + (1 - projected.y) * rect.height / 2;
        const distance = Math.hypot(px - x, py - y);
        if (distance < nearestDistance) { nearestDistance = distance; expectedSource = candidate; }
      }
      return { source, expectedSource, nearestDistance, x, y };
    })()`);
    assert.ok(extremeClick.nearestDistance <= 12, JSON.stringify(extremeClick));
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: extremeClick.x, y: extremeClick.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: extremeClick.x, y: extremeClick.y, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(client, `document.querySelector('#photo-modal').style.display === 'flex'`, 'screen-space fallback did not pick a sub-pixel distant camera');
    const extremePhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(extremePhotoUrl, new RegExp(`/camera-photos/photo-${extremeClick.expectedSource}\\.jpg$`));
    await client.evaluate(`document.querySelector('#photo-close').click()`);


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

test('browser hides the coarse root when every visible branch meets the active Detail target', { timeout: 720_000 }, async (t) => {
  const tileRoot = process.env.LTDS_LOD_TEST_TILE_ROOT;
  const executable = browserPath();
  if (!tileRoot || !existsSync(path.join(tileRoot, 'tileset.json')) || !executable) {
    t.skip('Set LTDS_LOD_TEST_TILE_ROOT and CHROME_PATH/EDGE_PATH to run real foreground coverage acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startFixture(path.resolve(tileRoot));
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-foreground-browser-'));
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
    await client.command('Log.enable');
    await client.command('Network.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root?.engineData?.scene)', 'coarse root did not load');
    const cacheOverrideGiB = Number(process.env.LTDS_LOD_TEST_CACHE_GIB);
    if (Number.isFinite(cacheOverrideGiB) && cacheOverrideGiB > 0) {
      await client.evaluate(`window.__ltds.tiles().lruCache.maxBytesSize = ${cacheOverrideGiB} * 2 ** 30`);
    }
    const sustainedAllLeaves = true;
    assert.equal(await client.evaluate(`window.__ltds.tiles().root.refine`), 'REPLACE');
    await client.evaluate(`(() => { const slider=document.querySelector('#lod-detail');slider.value='2';slider.dispatchEvent(new Event('input',{bubbles:true}));return true; })()`);
    await waitFor(client, 'window.__ltds.state.lodRuntimeProfile?.activeDetail===2', 'Detail 2 did not reset the warmup stage');
    await setView(client, [4.964815557187116, 124.12038892967789, 0], [0, 0, 0]);
    const stagedRequest = await client.evaluate(`(() => {
      const slider=document.querySelector('#lod-detail');slider.value='24';slider.dispatchEvent(new Event('input',{bubbles:true}));
      return {requested:window.__ltds.state.lodRuntimeProfile?.requestedDetail,
        active:window.__ltds.state.lodRuntimeProfile?.activeDetail,errorTarget:window.__ltds.tiles().errorTarget,
        errorScale:window.__ltds.state.lodRuntimeProfile?.errorScale};
    })()`);
    assert.equal(stagedRequest.requested, 24);
    assert.equal(stagedRequest.active, 13);
    assert.ok(Math.abs(stagedRequest.errorTarget - 32 * Math.max(1, stagedRequest.errorScale / 2)) < 0.01,
      JSON.stringify(stagedRequest));
    try {
      await waitFor(client, `(() => {
        const t=window.__ltds.tiles(); let required=0,attached=0;
        const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile?.traversal?.used===true&&tile?.traversal?.inFrustum===true){required++;if(tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene))attached++;}};
        f(t.root);
        const idle=!t.downloadQueue?.running&&!t.parseQueue?.running&&!t.processNodeQueue?.running;
        const rootAttached=Boolean(t.root?.engineData?.scene&&t.group.children.includes(t.root.engineData.scene));
        return required===16&&attached===required&&!rootAttached&&idle&&window.__ltds.state.lodRuntimeProfile?.activeDetail===24;
      })()`, 'sustained 16-leaf REPLACE frontier did not converge cleanly', 300_000);
    } catch (error) {
      const convergenceDiagnostics = await client.evaluate(`(() => {
        const t=window.__ltds.tiles();const rows=[];const visit=(tile,parent=null)=>{(tile?.children||[]).forEach(child=>visit(child,tile));
          if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0)rows.push({uri:tile.content?.uri||'',error:tile.traversal?.error,
            used:tile.traversal?.used,inFrustum:tile.traversal?.inFrustum,visible:tile.traversal?.visible,active:tile.traversal?.active,
            attached:Boolean(tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)),loadingState:tile.internal?.loadingState,
            parentError:parent?.traversal?.error,parentVisible:parent?.traversal?.visible,parentActive:parent?.traversal?.active});};
        visit(t.root);return {profile:window.__ltds.state.lodRuntimeProfile,errorTarget:t.errorTarget,diagnostics:window.__ltds.lodDiagnostics(),rows,
          queues:{download:t.downloadQueue?.running,parse:t.parseQueue?.running,process:t.processNodeQueue?.running},
          cache:{bytes:t.lruCache.cachedBytes,maxBytes:t.lruCache.maxBytesSize,full:t.lruCache.isFull(),items:t.lruCache.itemSet?.size,maxItems:t.lruCache.maxSize}};
      })()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(convergenceDiagnostics)}`);
    }

    const diagnostic = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const root = tiles.root;
      const attachedScenes = tiles.group.children;
      const target = Number(tiles.errorTarget);
      const isAttached = (tile) => Boolean(tile?.engineData?.scene && attachedScenes.includes(tile.engineData.scene));
      const targetCovered = [];
      const uncovered = [];
      const strictLeaves = [];
      const visitStrict = (tile, parent = null) => {
        for (const child of (tile?.children || [])) visitStrict(child, tile);
        if ((tile?.children || []).length || Number(tile?.geometricError) !== 0
          || tile?.traversal?.used !== true || tile?.traversal?.inFrustum !== true) return;
        strictLeaves.push({
          uri: tile.content?.uri || tile.content?.url || '', attached: isAttached(tile),
          sceneUuid: tile.engineData?.scene?.uuid || null,
          loadingState: tile.internal?.loadingState ?? null,
          parentError: parent?.traversal?.error ?? null,
          parentAttached: isAttached(parent),
        });
      };
      const visitCoverage = (tile, path = 'root') => {
        if (!tile || tile.traversal?.used !== true || tile.traversal?.inFrustum !== true) return;
        const attached = isAttached(tile);
        const error = Number(tile.traversal?.error);
        if (tile !== root && attached && Number.isFinite(error) && error <= target) {
          targetCovered.push({ path, uri: tile.content?.uri || tile.content?.url || '', error, geometricError: tile.geometricError });
          return;
        }
        const children = tile.children || [];
        if (children.length) {
          children.forEach((child, index) => visitCoverage(child, path + '.' + index));
        } else if (Number(tile.geometricError) === 0) {
          if (attached) targetCovered.push({ path, uri: tile.content?.uri || tile.content?.url || '', error: 0, geometricError: 0 });
          else uncovered.push({ path, uri: tile.content?.uri || tile.content?.url || '', loadingState: tile.internal?.loadingState ?? null });
        }
      };
      visitStrict(root);
      for (const child of (root.children || [])) visitCoverage(child);
      const rootMaterials = [];
      root.engineData.scene.traverse((object) => {
        if (!object.isMesh || !object.material) return;
        for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
          rootMaterials.push({ visible: material.visible !== false, transparent: material.transparent, opacity: material.opacity,
            alphaTest: material.alphaTest, hasAlphaMap: Boolean(material.alphaMap), depthWrite: material.depthWrite });
        }
      });
      return {
        target, targetCovered, uncovered, strictLeaves,
        rootAttached: isAttached(root),
        rootRendered: isAttached(root) && rootMaterials.some((material) => material.visible),
        rootMaterials,
        cache: {
          isFull: tiles.lruCache.isFull(),
          cachedBytes: tiles.lruCache.cachedBytes,
          maxBytesSize: tiles.lruCache.maxBytesSize,
          itemCount: tiles.lruCache.itemSet?.size ?? null,
          maxSize: tiles.lruCache.maxSize,
          items: [...(tiles.lruCache.bytesMap?.entries?.() || [])].map(([tile, bytes]) => ({
            uri: tile?.content?.uri || tile?.content?.url || 'root', bytes,
            used: tiles.lruCache.isUsed?.(tile) ?? null,
            loaded: tile?.internal?.loadingState ?? null,
          })).sort((left, right) => right.bytes - left.bytes),
        },
        queues: {
          download: Boolean(tiles.downloadQueue?.running), parse: Boolean(tiles.parseQueue?.running),
          process: Boolean(tiles.processNodeQueue?.running),
        },
      };
    })()`);

    assert.ok(diagnostic.targetCovered.length > 0, JSON.stringify(diagnostic));
    assert.equal(diagnostic.cache.isFull, false, `foreground refinement was blocked by a full LRU cache: ${JSON.stringify(diagnostic)}`);
    assert.deepEqual(diagnostic.uncovered, [], `foreground branches remained unloaded and unqueued: ${JSON.stringify(diagnostic)}`);
    assert.equal(diagnostic.rootRendered, false, `coarse root remained rendered over target-satisfied foreground: ${JSON.stringify(diagnostic)}`);

    if (process.env.LTDS_LOD_SCREENSHOT_PATH) {
      const capture = await client.command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(process.env.LTDS_LOD_SCREENSHOT_PATH, Buffer.from(capture.data, 'base64'));
    }

    const closeScenes = Object.fromEntries(diagnostic.strictLeaves.map((leaf) => [leaf.uri, leaf.sceneUuid]));
    const closeUris = Object.keys(closeScenes).sort();
    const returnRequestIndex = client.events.length;
    await setView(client, [0, 1300, 1300], [0, 18, 0]);
    await waitFor(client, `(() => {
      const t=window.__ltds.tiles(); let attached=0;
      const f=(tile)=>{(tile?.children||[]).forEach(f);if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene))attached++;};
      f(t.root); return attached===0 && !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running;
    })()`, 'far view did not detach the close leaves', 180_000);
    const farRetention = await client.evaluate(`(() => {
      const t=window.__ltds.tiles(); const expected=${JSON.stringify(closeScenes)}; const rows=[];
      const f=(tile)=>{(tile?.children||[]).forEach(f);const uri=tile.content?.uri||tile.content?.url||'';
        if(Object.hasOwn(expected,uri))rows.push({uri,before:expected[uri],after:tile.engineData?.scene?.uuid||null,cacheUsed:t.lruCache.isUsed(tile),
          attached:Boolean(tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene))});};
      f(t.root); return {rows,cachedBytes:t.lruCache.cachedBytes,minBytesSize:t.lruCache.minBytesSize,maxBytesSize:t.lruCache.maxBytesSize};
    })()`);
    assert.deepEqual(farRetention.rows.filter((row) => row.before !== row.after), [], `far view discarded the recent decoded frontier below the hard cap: ${JSON.stringify(farRetention)}`);
    assert.ok(farRetention.rows.every((row) => row.attached === false), JSON.stringify(farRetention));
    assert.ok(farRetention.rows.every((row) => row.cacheUsed === false), JSON.stringify(farRetention));
    await setView(client, sustainedAllLeaves ? [4.964815557187116, 124.12038892967789, 0] : [0, 44, 52], sustainedAllLeaves ? [0, 0, 0] : [0, 18, 0]);
    await waitFor(client, `(() => {
      const t=window.__ltds.tiles(); const expected=new Set(${JSON.stringify(closeUris)});
      const attached=new Set();
      const f=(tile)=>{(tile?.children||[]).forEach(f);const uri=tile.content?.uri||tile.content?.url;if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)&&expected.has(uri))attached.add(uri);};
      f(t.root); return attached.size===expected.size && window.__ltds.state.lodRuntimeProfile?.activeDetail===24 && !t.downloadQueue?.running && !t.parseQueue?.running && !t.processNodeQueue?.running;
    })()`, 'returning to close view did not restore every foreground leaf', 240_000);
    const returned = await client.evaluate(`(() => {
      const t=window.__ltds.tiles(); const expected=new Set(${JSON.stringify(closeUris)}); const attached=[];
      const f=(tile)=>{(tile?.children||[]).forEach(f);const uri=tile.content?.uri||tile.content?.url;if(!(tile?.children||[]).length&&Number(tile?.geometricError)===0&&tile.engineData?.scene&&t.group.children.includes(tile.engineData.scene)&&expected.has(uri))attached.push(uri);};
      f(t.root); let rootRendered=Boolean(t.root.engineData.scene&&t.group.children.includes(t.root.engineData.scene));
      const scenes={};const collect=(tile)=>{(tile?.children||[]).forEach(collect);const uri=tile.content?.uri||tile.content?.url||'';if(expected.has(uri))scenes[uri]=tile.engineData?.scene?.uuid||null;};collect(t.root);
      return {attached:attached.sort(),scenes,rootRendered,cacheBytes:t.lruCache.cachedBytes};
    })()`);
    assert.deepEqual(returned.attached, closeUris);
    assert.deepEqual(returned.scenes, closeScenes, `returning to the close view re-decoded retained scenes: ${JSON.stringify(returned)}`);
    const duplicateCloseRequests = client.events.slice(returnRequestIndex)
      .filter((event) => event.method === 'Network.requestWillBeSent'
        && closeUris.some((uri) => new URL(event.params.request.url).pathname.endsWith(`/${uri}`)))
      .map((event) => new URL(event.params.request.url).pathname);
    assert.deepEqual(duplicateCloseRequests, [], `far/return re-requested retained close leaves: ${JSON.stringify(duplicateCloseRequests)}`);
    assert.equal(returned.rootRendered, false, `returned view retained coarse root: ${JSON.stringify(returned)}`);
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

  const { makeGlb, TRIANGLE_A, writeAuditableFixture } = await import('./helpers/lod-fixture.mjs');
  const tileRoot = mkdtempSync(path.join(tmpdir(), 'ltds-session-lod-fixture-'));
  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  writeAuditableFixture(tileRoot, {
    leafBTexture: validPng,
  });
  writeFileSync(path.join(tileRoot, 'coarse.glb'), makeGlb([TRIANGLE_A], validPng));
  const sessionTilesetPath = path.join(tileRoot, 'tileset.json');
  const sessionTileset = JSON.parse(readFileSync(sessionTilesetPath, 'utf8'));
  sessionTileset.root.content = { uri: 'coarse.glb' };
  writeFileSync(sessionTilesetPath, JSON.stringify(sessionTileset));
  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client, fixture;
  try {
    fixture = await startSessionRefreshFixture(tileRoot, { fineTileDelayMs: 1_500 });
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
    await client.evaluate(`document.querySelector('#tab-model').click()`);
    await waitFor(client, `location.search.includes('view=model')`, 'refreshed session could not enter model view');
    const hierarchyDeadline = Date.now() + 10_000;
    while (!await client.evaluate(`Boolean(window.__ltds?.tiles()?.root)`) && Date.now() < hierarchyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const refreshedRuntime = await client.evaluate(`({
      activeMode: window.__ltds?.state?.activeMode,
      meshSource: window.__ltds?.state?.meshSource,
      tiles: Boolean(window.__ltds?.tiles()),
      root: Boolean(window.__ltds?.tiles()?.root),
      manifest: window.__ltds?.state?.lodManifestReport,
      modeStatus: document.querySelector('#mode-status')?.textContent,
      lodStatus: document.querySelector('#lod-status')?.textContent,
    })`);
    const browserErrors = client.events.filter((event) => event.method === 'Log.entryAdded'
      || event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled').slice(-10);
    assert.equal(refreshedRuntime.root, true, `refreshed session did not attach the LOD hierarchy: ${JSON.stringify({ refreshedRuntime, requests: fixture.requests, browserErrors })}`);
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 16`,
      'refreshed session did not complete the default 13 to 16 refinement stage', 20_000);
    const balancedStartup = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
      active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
      errorTarget: window.__ltds.tiles().errorTarget,
      phase: window.__ltds.lodDiagnostics().phase,
      bootstrapPhase: window.__ltds.state.lodRuntimeProfile?.bootstrapPhase,
      bootstrapCoverageTarget: window.__ltds.state.lodRuntimeProfile?.bootstrapCoverageTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
    })`);
    assert.deepEqual({ ...balancedStartup, errorTarget: undefined, errorScale: undefined, bootstrapCoverageTarget: undefined }, {
      slider: '16', requested: 16, active: 16, errorTarget: undefined,
      phase: 'requested-detail', bootstrapPhase: 'complete', errorScale: undefined,
      bootstrapCoverageTarget: undefined,
    });
    const sessionSteadyScale = Math.max(1, balancedStartup.errorScale / 2);
    assert.ok(Math.abs(balancedStartup.errorTarget - 15.023 * sessionSteadyScale) < 0.01,
      `steady Detail 16 stayed at the coarse bootstrap target: ${JSON.stringify(balancedStartup)}`);
    assert.ok(balancedStartup.errorTarget < balancedStartup.bootstrapCoverageTarget, JSON.stringify(balancedStartup));
    const startupRefinementDeadline = Date.now() + 10_000;
    while (!fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-a.b3dm')
      || requestPath.endsWith('/leaf-b.glb')) && Date.now() < startupRefinementDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-a.b3dm')
      || requestPath.endsWith('/leaf-b.glb')), true,
    'balanced startup did not request close-responsive child refinement');
    const coarseRequestIndex = fixture.requests.findIndex(requestPath => requestPath.endsWith('/coarse.glb'));
    const firstFineRequestIndex = fixture.requests.findIndex(requestPath => requestPath.endsWith('/leaf-a.b3dm')
      || requestPath.endsWith('/leaf-b.glb'));
    assert.ok(coarseRequestIndex >= 0 && firstFineRequestIndex > coarseRequestIndex,
      `the complete coarse root was not requested before refinement: ${JSON.stringify(fixture.requests)}`);
    await waitFor(client, `(() => { const t=window.__ltds.tiles(); const root=t.root;
      const rootAttached=Boolean(root?.engineData?.scene&&t.group.children.includes(root.engineData.scene));
      const childAttached=root?.children?.some(child=>child.engineData?.scene&&t.group.children.includes(child.engineData.scene));
      return rootAttached||childAttached; })()`,
    'default refinement left no attached REPLACE coverage', 10_000);

    const explicitHighDetail = await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '24';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
        active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
        errorTarget: window.__ltds.tiles().errorTarget,
      };
    })()`);
    assert.deepEqual(explicitHighDetail, {
      requested: 24, active: 16, errorTarget: balancedStartup.errorTarget,
    });
    const fallbackSampleDeadline = Date.now() + 1_000;
    let fallbackSamples = 0;
    while (Date.now() < fallbackSampleDeadline) {
      const transitionFallback = await client.evaluate(`(() => {
        const tiles = window.__ltds.tiles();
        const root = tiles.root;
        const selectedChildren = root.children.filter((child) => child.traversal?.used === true && child.traversal?.inFrustum === true);
        const attachedSelectedChildren = selectedChildren.filter((child) => child.engineData?.scene && tiles.group.children.includes(child.engineData.scene));
        const childStates = selectedChildren.map((child) => ({ loadingState: child.internal?.loadingState,
          hasScene: Boolean(child.engineData?.scene), parentIsGroup: child.engineData?.scene?.parent === tiles.group,
          visible: child.traversal?.visible, active: child.traversal?.active }));
        return {
          activeDetail: window.__ltds.state.lodRuntimeProfile?.activeDetail,
          loadAncestors: tiles.loadAncestors,
          loadSiblings: tiles.loadSiblings,
          loadAncestorSiblings: tiles.loadAncestorSiblings,
          rootVisible: root.traversal?.visible,
          rootAttached: Boolean(root.engineData?.scene && tiles.group.children.includes(root.engineData.scene)),
          rootActive: root.traversal?.active,
          rootIsLeaf: root.traversal?.isLeaf,
          rootAllChildrenLoaded: root.traversal?.allChildrenLoaded,
          rootWasSetActive: root.traversal?.wasSetActive,
          rootLoadingState: root.internal?.loadingState,
          rootHasScene: Boolean(root.engineData?.scene),
          loadingVisible: !document.querySelector('#loading-overlay')?.classList.contains('hidden'),
          selectedChildren: selectedChildren.length,
          attachedSelectedChildren: attachedSelectedChildren.length,
          childStates,
        };
      })()`);
      assert.ok(transitionFallback.activeDetail >= 13 && transitionFallback.activeDetail <= 24, JSON.stringify(transitionFallback));
      assert.equal(transitionFallback.loadAncestors, false);
      assert.equal(transitionFallback.loadSiblings, false);
      assert.equal(transitionFallback.loadAncestorSiblings, false);
      const coarseCoverage = transitionFallback.rootVisible && transitionFallback.rootAttached;
      const fineCoverage = transitionFallback.selectedChildren > 0
        && transitionFallback.attachedSelectedChildren === transitionFallback.selectedChildren;
      assert.ok(coarseCoverage || fineCoverage,
        `REPLACE transition lost both coarse fallback and selected-child coverage: ${JSON.stringify(transitionFallback)}`);
      fallbackSamples += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(fallbackSamples >= 10, `expected continuous fallback samples, received ${fallbackSamples}`);
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 24`, 'explicit high-detail request did not complete its staged warmup');
    await waitFor(client, `(() => {
      const tiles = window.__ltds.tiles();
      return tiles.root?.traversal?.visible === false
        && tiles.root.children.some((child) => child.traversal?.visible === true);
    })()`, 'settled fine frontier did not replace the coarse fallback');
    const fineTileDeadline = Date.now() + 10_000;
    while (!fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-b.glb')) && Date.now() < fineTileDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-b.glb')), true,
      'explicit Detail 24 did not refine into the fine child tile');
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
