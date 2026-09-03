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
import { makeB3dm, makeGlb } from './helpers/lod-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureId = 'lod-browser-fixture';
const GiB = 1024 * 1024 * 1024;

async function removeBrowserProfile(profile) {
  if (!profile) return;
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  // Edge can retain a Windows file handle briefly after its process exits.
  // The isolated OS temp profile is non-authoritative test scratch; cleanup
  // must never strand the cross-process browser lock or mask UI assertions.
  if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY'].includes(lastError?.code)) return;
  throw lastError;
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

function focusOwnerTilesetFixture() {
  const translation = x => [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    x, 0, 0, 1,
  ];
  const box = halfWidth => [
    0, 0, 0,
    halfWidth, 0, 0,
    0, 1, 0,
    0, 0, 1,
  ];
  const branch = (name, x) => ({
    transform: translation(x),
    boundingVolume: { box: box(1) },
    geometricError: 32,
    refine: 'REPLACE',
    content: { uri: `${name}/root.b3dm` },
    children: [{
      boundingVolume: { box: box(1) },
      geometricError: 0,
      refine: 'REPLACE',
      content: { uri: `${name}/leaf.b3dm` },
    }],
  });
  return {
    asset: { version: '1.0' },
    geometricError: 128,
    root: {
      boundingVolume: { box: box(6) },
      geometricError: 128,
      refine: 'REPLACE',
      content: { uri: 'root.b3dm' },
      children: [branch('a', -4), branch('b', 4)],
    },
  };
}

function foregroundAcceptanceFixture({
  worldCenterY = 18,
  boundaryGrid = false,
  alternateBranches = false,
} = {}) {
  const scaleAndTranslate = (scale, x, y) => [
    scale, 0, 0, 0,
    0, scale, 0, 0,
    0, 0, scale, 0,
    x, y, 0, 1,
  ];
  const unitBox = [
    0, 0, 0,
    1, 0, 0,
    0, 1, 0,
    0, 0, 0.2,
  ];
  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const tileBytes = makeB3dm(makeGlb([
    [[-1, -1, 0], [1, -1, 0], [-1, 1, 0]],
    [[1, -1, 0], [1, 1, 0], [-1, 1, 0]],
  ], validPng));
  const assetBodies = {
    'coarse/root.b3dm': tileBytes,
  };
  const xs = boundaryGrid ? [-48, -16, 16, 48] : [-36, -12, 12, 36];
  const ys = [-24, -8, 8, 24];
  const tileScale = boundaryGrid ? 8 : 10;
  const positions = ys.flatMap(y => xs.map(x => [x, y]));
  if (alternateBranches) positions.push([-88, -16], [-88, 16], [88, -16], [88, 16]);
  const children = [];
  let index = 0;
  for (const [x, y] of positions) {
    const suffix = String(index).padStart(2, '0');
    const shellUri = `shell-${suffix}/root.b3dm`;
    const leafUri = `LOD-0/Mesh-${suffix}.b3dm`;
    assetBodies[shellUri] = tileBytes;
    assetBodies[leafUri] = tileBytes;
    children.push({
      transform: scaleAndTranslate(tileScale, x, y),
      boundingVolume: { box: unitBox },
      geometricError: 0.75,
      refine: 'REPLACE',
      content: { uri: shellUri },
      children: [{
        boundingVolume: { box: unitBox },
        geometricError: 0,
        refine: 'REPLACE',
        content: { uri: leafUri },
      }],
    });
    index += 1;
  }
  return {
    tilesetJson: {
      asset: { version: '1.0' },
      geometricError: 64,
      root: {
        boundingVolume: {
          box: [
            0, 0, 0,
            alternateBranches ? 98 : boundaryGrid ? 58 : 50, 0, 0,
            0, 36, 0,
            0, 0, 2,
          ],
        },
        geometricError: 64,
        refine: 'REPLACE',
        content: { uri: 'coarse/root.b3dm' },
        children,
      },
    },
    assetBodies,
    configureConfig(config) {
      // The generated hierarchy is centered at local (0, 0, 0). Pick the
      // georeference offset that maps it to the test's documented world-space
      // model center after the renderer and tilesParent axis corrections.
      config.georef.bboxCenter = { x: 0, y: 0, z: -worldCenterY };
    },
  };
}

function contentType(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.b3dm')) return 'application/octet-stream';
  return 'application/octet-stream';
}

async function startFixture(tileRoot, {
  assetDelayMs = () => 0,
  forceOptimizeDeps = false,
  tilesetJson = null,
  assetAliases = {},
  assetBodies = {},
  configureConfig = null,
} = {}) {
  const vite = await createViteServer({
    root,
    appType: 'spa',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { force: forceOptimizeDeps },
  });
  const assetPrefix = `/assets/${fixtureId}/derivatives/`;
  const config = fixtureConfig();
  configureConfig?.(config);
  const requests = [];
  config.assets.ortho = '/fixtures/orthophoto.tif';
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
      if (relative === 'tileset.json' && tilesetJson) {
        const body = Buffer.from(JSON.stringify(tilesetJson));
        reply.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': body.length,
        });
        reply.end(body);
        return;
      }
      if (Object.hasOwn(assetBodies, relative)) {
        const body = Buffer.from(assetBodies[relative]);
        const sendAsset = () => {
          if (reply.destroyed) return;
          reply.writeHead(200, { 'Content-Type': contentType(relative), 'Content-Length': body.length });
          reply.end(body);
        };
        const delayMs = Math.max(0, Number(assetDelayMs(relative)) || 0);
        if (delayMs > 0) setTimeout(sendAsset, delayMs);
        else sendAsset();
        return;
      }
      const sourceRelative = assetAliases[relative] || relative;
      const file = path.resolve(tileRoot, sourceRelative);
      if (!file.startsWith(`${tileRoot}${path.sep}`) || !existsSync(file) || !statSync(file).isFile()) {
        reply.writeHead(404);
        reply.end('not found');
        return;
      }
      const sendAsset = () => {
        if (reply.destroyed || !existsSync(file)) {
          reply.destroy();
          return;
        }
        reply.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': statSync(file).size });
        createReadStream(file).pipe(reply);
      };
      const delayMs = Math.max(0, Number(assetDelayMs(relative)) || 0);
      if (delayMs > 0) setTimeout(sendAsset, delayMs);
      else sendAsset();
      return;
    }
    vite.middlewares(request, reply);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { server, vite, requests, origin: `http://127.0.0.1:${server.address().port}` };
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

async function startSessionRefreshFixture(tileRoot, { fineTileDelayMs = 0, shellTileDelayMs = 0 } = {}) {
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
      if (shellTileDelayMs > 0 && /^mid-(?:a|b)\.glb$/i.test(relative)) {
        setTimeout(sendAsset, shellTileDelayMs);
      } else if (fineTileDelayMs > 0 && /^leaf-(?:a\.b3dm|b\.glb)$/i.test(relative)) {
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

async function waitForDevTools(port, browser) {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let lastState = 'connection was not accepted';
  while (Date.now() < deadline) {
    // Edge on Windows may hand the profile to a child and let its launcher
    // exit successfully. Only a failed exit or signal proves startup failed.
    if ((browser.exitCode !== null && browser.exitCode !== 0) || browser.signalCode !== null) {
      throw new Error(`browser exited before exposing DevTools (exit=${browser.exitCode}, signal=${browser.signalCode})`);
    }
    try {
      const response = await fetch(`${origin}/json/version`);
      if (response.ok) return origin;
      lastState = `DevTools returned HTTP ${response.status}`;
    } catch (error) {
      lastState = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`browser did not expose DevTools within 30 seconds: ${lastState}`);
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

function focusOwnerExpression() {
  return `(() => {
    const tiles = window.__ltds.tiles();
    const owner = tiles?.__ltdsFocusOwnerState?.owner;
    if (!owner) return null;
    const path = [];
    let cursor = owner;
    while (cursor && cursor !== tiles.root && cursor.parent) {
      path.unshift((cursor.parent.children || []).indexOf(cursor));
      cursor = cursor.parent;
    }
    const uri = owner.content?.uri || owner.content?.url || null;
    let overlap = Number(owner.__ltdsFocusOverlap) || 0;
    const visit = tile => {
      if (tile?.__ltdsFallbackOwner === owner) {
        overlap = Math.max(overlap, Number(tile.__ltdsFocusOverlap) || 0);
      }
      (tile?.children || []).forEach(visit);
    };
    visit(tiles.root);
    return {
      key: (path.length ? path.join('.') : 'root') + '|' + (uri || ''),
      uri,
      path,
      locked: owner.__ltdsFocalOwnerLocked === true,
      overlap,
      ownerView: tiles.__ltdsFocusOwnerState?.ownerView || null,
      currentView: tiles.__ltdsFocusOwnerState?.currentView || null,
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

test('browser camera-centered focal owner reacquires A across A -> B -> A views', { timeout: 180_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for focal-owner browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const tileRoot = path.join(root, 'test', 'fixtures', 'ktx2-tiles');
    const fixture = await startFixture(tileRoot, {
      tilesetJson: focusOwnerTilesetFixture(),
      assetAliases: {
        'a/root.b3dm': 'root.b3dm',
        'a/leaf.b3dm': 'LOD-0/Mesh.b3dm',
        'b/root.b3dm': 'root.b3dm',
        'b/leaf.b3dm': 'LOD-0/Mesh.b3dm',
      },
    });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-focus-owner-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Network.enable');
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1200, height: 800, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1200, screenHeight: 800,
    });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, `window.__ltds?.tiles?.()?.root?.children?.length === 2`,
      'two-owner fixture hierarchy did not load');
    await client.evaluate(`(() => {
      const slider = document.querySelector('#lod-detail');
      slider.value = '24';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

    const views = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const Vector3 = window.__ltds.camera().position.constructor;
      tiles.group.updateWorldMatrix(true, false);
      return tiles.root.children.map(tile => {
        const volume = tile.engineData?.boundingVolume;
        const obb = volume?.obb || volume?.regionObb;
        let center = null;
        if (obb?.box && obb?.transform) center = obb.box.getCenter(new Vector3()).applyMatrix4(obb.transform);
        else if (volume?.sphere?.center) center = volume.sphere.center.clone();
        if (!center) return null;
        center.applyMatrix4(tiles.group.matrixWorld);
        return {
          lookAt: center.toArray(),
          position: center.clone().add(new Vector3(0, 2.5, 3.5)).toArray(),
        };
      });
    })()`);
    assert.equal(views.length, 2);
    assert.ok(views.every(Boolean), JSON.stringify(views));
    assert.ok(Math.hypot(...views[0].lookAt.map((value, index) => value - views[1].lookAt[index])) > 4,
      `fixture owners are not spatially distinct: ${JSON.stringify(views)}`);

    const observeView = async (index, label) => {
      await setView(client, views[index].position, views[index].lookAt);
      await waitFor(client, `(() => {
        const tiles=window.__ltds.tiles();
        const leaf=tiles.root?.children?.[${index}]?.children?.[0];
        if (!leaf?.engineData?.scene || !tiles.group.children.includes(leaf.engineData.scene)) return false;
        let rendered=false;
        leaf.engineData.scene.traverse(object=>{
          if (!object.isMesh || !object.material) return;
          for (const material of (Array.isArray(object.material)?object.material:[object.material])) {
            if (material.visible !== false) rendered=true;
          }
        });
        return rendered;
      })()`, `${label} did not attach its zero-error replacement leaf`, 60_000);
      await waitFor(client, `(() => {
        const owner=(${focusOwnerExpression()});
        return Boolean(owner?.locked && owner.overlap > 0 && owner.path?.[0] === ${index});
      })()`, `${label} did not acquire its camera-centered focal owner`, 30_000);
      const owner = await client.evaluate(focusOwnerExpression());
      const branch = await client.evaluate(`(() => {
        const tiles=window.__ltds.tiles();
        const owner=tiles.root.children[${index}],leaf=owner.children[0];
        const rendered=tile=>{
          if (!tile?.engineData?.scene || !tiles.group.children.includes(tile.engineData.scene)) return false;
          let visible=false;
          tile.engineData.scene.traverse(object=>{
            if (!object.isMesh || !object.material) return;
            for (const material of (Array.isArray(object.material)?object.material:[object.material])) {
              if (material.visible !== false) visible=true;
            }
          });
          return visible;
        };
        return { ownerRendered:rendered(owner), leafRendered:rendered(leaf) };
      })()`);
      assert.equal(branch.leafRendered, true, `${label} leaf is not rendered`);
      assert.equal(branch.ownerRendered, false, `${label} violated strict REPLACE rendering`);
      return owner;
    };

    const ownerA = await observeView(0, 'camera view A');
    const ownerB = await observeView(1, 'camera view B');
    assert.notEqual(ownerB.key, ownerA.key, 'camera view B retained A as focal owner');
    const returnedA = await observeView(0, 'returned camera view A');
    assert.equal(returnedA.key, ownerA.key, 'returning to A did not reacquire A');

    const failures = client.events.filter(event => event.method === 'Network.responseReceived'
      && event.params.response.status >= 400);
    const errors = client.events.filter(event => event.method === 'Runtime.exceptionThrown'
      && !event.params.exceptionDetails?.url?.includes('/@vite/client'));
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (vite) await vite.close();
    releaseLock();
    await removeBrowserProfile(profile);
  }
});

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
    ({ server, vite, origin } = await startFixture(
      path.resolve(tileRoot),
      foregroundAcceptanceFixture({ alternateBranches: true }),
    ));
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-lod-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
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
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 20`,
      'default view did not enter direct Detail 20 refinement', 20_000);
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
    assert.equal(balancedStartup.slider, '20');
    assert.equal(balancedStartup.requested, 20);
    assert.equal(balancedStartup.active, 20);
    assert.equal(balancedStartup.phase, 'requested-detail');
    assert.equal(balancedStartup.bootstrapPhase, 'complete');
    assert.ok(Math.abs(balancedStartup.errorTarget - 5.481) < 0.01,
      JSON.stringify(balancedStartup));
    assert.ok(balancedStartup.errorTarget < balancedStartup.bootstrapCoverageTarget,
      `steady Detail 20 must refine beyond the temporary coarse bootstrap target: ${JSON.stringify(balancedStartup)}`);
    assert.match(balancedStartup.status, /^LOD: (?:Detail 20|full-detail) \(\d+ tiles?\)$/);
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
      slider: '24', requested: 24, active: 24, errorTarget: 2,
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
    assert.equal(initial.profile.memoryProfile.policyKey, 'roomy');
    assert.deepEqual(initial.cache, { minBytesSize: 0.5 * GiB, maxBytesSize: 3.75 * GiB, minSize: 8, maxSize: 1024, unloadPercent: 0.20 });

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
    assert.equal(visibleCameras.totalInstances, visibleCameras.drawn * 4, 'each selected camera renders body, face, amber cue, and orange image-up tab');
    assert.deepEqual(visibleCameras.meshes.map(item => item.count).sort((a, b) => a - b), [visibleCameras.drawn, visibleCameras.drawn, visibleCameras.drawn, visibleCameras.drawn]);
    assert.equal(visibleCameras.drawToSource.length, visibleCameras.drawn);
    assert.deepEqual(visibleCameras.meshes.map(item => item.color).sort((a, b) => a - b), [0x6F7782, 0xD8DEE6, 0xF8CB2E, 0xEE5007].sort((a, b) => a - b));
    const cameraClick = await client.evaluate(`(() => {
      const meshes = [];
      window.__ltds.scene().traverse((object) => { if (object.isInstancedMesh && object.count === window.__ltdsCamDrawn && object.parent?.parent?.visible) meshes.push(object); });
      if (meshes.length !== 4) return null;
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
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'camera marker did not open its docked photo preview');
    const photoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(photoUrl, new RegExp(`/camera-photos/photo-${visibleCameras.drawToSource[0]}\\.jpg$`));
    assert.doesNotMatch(photoUrl, /storage|mnt|dataset/i);
    await waitFor(client, `document.querySelector('#photo-img').naturalWidth === 1`, 'capability-scoped camera image did not decode');
    const dockedPhoto = await client.evaluate(`(() => {
      const modal=document.querySelector('#photo-modal'),frame=document.querySelector('#photo-frame'),wrap=document.querySelector('#photo-imgwrap');
      const fr=frame.getBoundingClientRect(),wr=wrap.getBoundingClientRect();
      return {presentation:modal.dataset.presentation,modalPointer:getComputedStyle(modal).pointerEvents,framePointer:getComputedStyle(frame).pointerEvents,right:innerWidth-fr.right,top:fr.top,aspect:wr.width/wr.height};
    })()`);
    assert.equal(dockedPhoto.presentation, 'docked');
    assert.equal(dockedPhoto.modalPointer, 'none', 'docked host must not intercept model navigation outside the photo');
    assert.equal(dockedPhoto.framePointer, 'auto');
    assert.ok(dockedPhoto.right >= 0 && dockedPhoto.right <= 20 && dockedPhoto.top > 50, JSON.stringify(dockedPhoto));
    assert.ok(Math.abs(dockedPhoto.aspect - 1) < 0.02, 'natural square photo aspect was not preserved');
    await client.evaluate(`document.querySelector('#photo-imgwrap').click()`);
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'expanded'`, 'photo click did not open the expanded inspector');
    const expandedCenter = await client.evaluate(`(() => { const r=document.querySelector('#photo-imgwrap').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await client.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: expandedCenter.x, y: expandedCenter.y, deltaX: 0, deltaY: -420 });
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: expandedCenter.x, y: expandedCenter.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'left', buttons: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', buttons: 0, clickCount: 1 });
    const clampedPhoto = await client.evaluate(`(() => { const w=document.querySelector('#photo-imgwrap').getBoundingClientRect(),i=document.querySelector('#photo-img').getBoundingClientRect(); return {wrap:{l:w.left,t:w.top,r:w.right,b:w.bottom},image:{l:i.left,t:i.top,r:i.right,b:i.bottom},transform:getComputedStyle(document.querySelector('#photo-img')).transform}; })()`);
    assert.notEqual(clampedPhoto.transform, 'none', 'expanded wheel did not zoom the camera photo');
    assert.ok(clampedPhoto.image.l <= clampedPhoto.wrap.l + 2 && clampedPhoto.image.t <= clampedPhoto.wrap.t + 2
      && clampedPhoto.image.r >= clampedPhoto.wrap.r - 2 && clampedPhoto.image.b >= clampedPhoto.wrap.b - 2,
    `expanded pan exposed empty frame background: ${JSON.stringify(clampedPhoto)}`);
    await client.evaluate(`document.querySelector('#photo-close').click()`);
    await client.evaluate(`(() => { window.__ltds.state.activeMode='cloud'; window.__ltds.state.cloudMode='direct'; return true; })()`);
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cameraClick.x, y: cameraClick.y, button: 'left', buttons: 0, clickCount: 1 });
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'direct LAZ/PLY camera marker did not open its docked photo preview');
    const directPhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.equal(directPhotoUrl, photoUrl, 'Model and direct Point Cloud markers did not use the same scoped photo URL');
    await client.evaluate(`(() => { document.querySelector('#photo-close').click(); window.__ltds.state.activeMode='model'; window.__ltds.state.cloudMode='none'; return true; })()`);
    await client.evaluate(`document.querySelector('#tab-ortho').click()`);
    await waitFor(client, `document.querySelector('#panel-camera-positions').style.display === 'block' && window.__ltdsMapCamDrawn > 0`, 'orthophoto did not expose bounded camera positions', 30_000);
    const mapCamera = await client.evaluate(`(() => ({drawn:window.__ltdsMapCamDrawn,sources:window.__ltdsMapCamDrawToSource.slice(),icons:document.querySelectorAll('.map-camera-marker').length}))()`);
    assert.ok(mapCamera.drawn > 0 && mapCamera.drawn <= 1200, JSON.stringify(mapCamera));
    assert.equal(mapCamera.icons, mapCamera.drawn);
    await client.evaluate(`document.querySelector('.map-camera-marker').click()`);
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'orthophoto camera did not open the shared photo preview');
    const mapPhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(mapPhotoUrl, new RegExp(`/camera-photos/photo-${mapCamera.sources[0]}\\.jpg$`));
    await client.evaluate(`document.querySelector('#photo-close').click(); document.querySelector('#tab-model').click()`);
    await waitFor(client, `document.querySelector('#tab-model').classList.contains('active')`, 'model did not resume after orthophoto camera verification');
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
    try {
      await waitFor(client, 'Boolean(window.__ltds.tiles()?.root && window.__ltds.tiles().group.children.length)', 'reloaded LOD view did not attach a tile after point-cloud transfer', 15_000);
    } catch (error) {
      const transferDiagnostics = await client.evaluate(`(() => ({
        activeMode:window.__ltds.state?.activeMode,meshSource:window.__ltds.state?.meshSource,
        tabModel:document.querySelector('#tab-model')?.classList.contains('active'),
        error:getComputedStyle(document.querySelector('#error-panel')).display,
        errorText:document.querySelector('#error-panel')?.textContent,
        profile:window.__ltds.state?.lodRuntimeProfile,
        root:Boolean(window.__ltds.tiles()?.root),children:window.__ltds.tiles()?.group?.children?.length ?? null,
        queues:window.__ltds.tiles()?{download:window.__ltds.tiles().downloadQueue?.running,parse:window.__ltds.tiles().parseQueue?.running,process:window.__ltds.tiles().processNodeQueue?.running}:null,
      }))()`);
      throw new Error(`${error.message}; diagnostics=${JSON.stringify(transferDiagnostics)}`);
    }
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
    assert.equal(defaultDetail.downloadJobs, 8);
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
    assert.ok(far.attachedTiles.length > 0, JSON.stringify(far));
    assert.ok(far.renderedTiles.some((tile) => tile.error > 0),
      `far view rendered no positive-error coarse/fallback tile: ${JSON.stringify(far)}`);

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
    // Middleware-mode Vite has no HMR WebSocket endpoint, and the sandboxed
    // browser cannot fetch the production site's decorative branding image.
    // Ignore only those exact harness-only URLs; every application or tile
    // error still fails this assertion.
    const isHarnessOnlyEvent = (event) => {
      const url = event.method === 'Log.entryAdded'
        ? event.params.entry.url
        : event.method === 'Runtime.exceptionThrown'
          ? event.params.exceptionDetails.url
          : null;
      return typeof url === 'string' && (
        url.includes('/@vite/client')
        || url === 'https://ledgetopdroneservices.com/images/DroneLogo01.webp'
      );
    };
    const errors = client.events.filter((event) => (
      event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
    ) && !isHarnessOnlyEvent(event));
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
    await removeBrowserProfile(profile);
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
    const fixture = await startFixture(
      path.resolve(tileRoot),
      foregroundAcceptanceFixture({ boundaryGrid: true }),
    );
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-lod-retention-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
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

    await waitFor(client, `(() => {
      const profile=window.__ltds.state.lodRuntimeProfile;
      return profile?.activeDetail===20 && profile?.bootstrapPhase==='complete'
        && Math.abs(window.__ltds.tiles().errorTarget-5.481)<0.01;
    })()`, 'default Detail did not finish bounded prefetch and enter raw Detail 20 refinement', 180_000);
    const defaultState = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
      active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
      errorTarget: window.__ltds.tiles().errorTarget,
      bootstrapPhase: window.__ltds.state.lodRuntimeProfile?.bootstrapPhase,
      bootstrapCoverageTarget: window.__ltds.state.lodRuntimeProfile?.bootstrapCoverageTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
    })`);
    assert.equal(defaultState.slider, '20');
    assert.equal(defaultState.requested, 20);
    assert.equal(defaultState.active, 20);
    assert.equal(defaultState.bootstrapPhase, 'complete');
    assert.ok(Math.abs(defaultState.errorTarget - 5.481) < 0.01,
      `the default view must leave coarse bootstrap and resume raw Detail 20: ${JSON.stringify(defaultState)}`);
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
    const motionSamples = [];
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
      // Sample inside the documented two-second recent-frontier window. The
      // purpose of this motion gate is to prove a newly detached scene remains
      // decoded for an immediate return, not to wait until retention expires.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const sample = await client.evaluate(`(() => {
        const t=window.__ltds.tiles(); const baseline=window.__ltdsRetentionBaseline||{};
        const rows=[]; const visit=(tile)=>{(tile?.children||[]).forEach(visit);const uri=tile?.content?.uri||tile?.content?.url||'';
          if(Object.hasOwn(baseline,uri))rows.push({uri,used:tile?.traversal?.used===true,cacheUsed:t.lruCache.isUsed(tile),
            inFrustum:tile?.traversal?.inFrustum===true,scene:tile?.engineData?.scene?.uuid||null,
            attached:Boolean(tile?.engineData?.scene&&t.group.children.includes(tile.engineData.scene))});};
        visit(t.root); return {rows,cachedBytes:t.lruCache.cachedBytes,phase:window.__ltds.lodDiagnostics().phase};
      })()`);
      motionSamples.push({ offset, sample });
      if (sample.rows.some((row) => row.scene && row.cacheUsed === true && row.attached === false)) {
        boundary = { offset, sample };
        break;
      }
    }
    assert.ok(boundary, `an 8-meter pan plus one-degree orbit did not detach a decoded baseline tile inside bounded recent-frontier retention: ${JSON.stringify(motionSamples)}`);
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
    await removeBrowserProfile(profile);
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
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root && window.__ltds.tiles().group.children.length)', 'no LOD tile attached');
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.bootstrapPhase === 'complete'`,
      'camera-layer fixture did not finish bounded LOD prefetch');
    const lodDiagnostics = await client.evaluate(`window.__ltds.lodDiagnostics()`);
    assert.ok(['overview', 'coverage', 'warmup', 'requested-detail', 'reduced-memory', 'memory-limited'].includes(lodDiagnostics.phase), JSON.stringify(lodDiagnostics));
    assert.ok(Number.isInteger(lodDiagnostics.pendingRequiredLeaves) && lodDiagnostics.pendingRequiredLeaves >= 0, JSON.stringify(lodDiagnostics));
    assert.ok([768, 1792, 3072, 3840].includes(lodDiagnostics.cache.maxMiB), JSON.stringify(lodDiagnostics));
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
    assert.deepEqual(state.meshes.map((mesh) => mesh.count), [state.drawn, state.drawn, state.drawn, state.drawn]);
    assert.deepEqual(state.meshes.map((mesh) => mesh.color), [0x6F7782, 0xD8DEE6, 0xF8CB2E, 0xEE5007]);
    assert.deepEqual(state.meshes.map((mesh) => mesh.opacity), [0.82, 0.82, 0.82, 0.82]);
    assert.deepEqual(state.meshes.map((mesh) => mesh.renderOrder), [0, 1, 2, 3]);

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
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'screen-space fallback did not pick a sub-pixel distant camera');
    const extremePhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(extremePhotoUrl, new RegExp(`/camera-photos/photo-${extremeClick.expectedSource}\\.jpg$`));
    await waitFor(client, `document.querySelector('#photo-img').naturalWidth === 1`, 'camera photo did not decode in the docked preview');
    const dockedPhoto = await client.evaluate(`(() => {
      const modal=document.querySelector('#photo-modal'),frame=document.querySelector('#photo-frame'),wrap=document.querySelector('#photo-imgwrap');
      const fr=frame.getBoundingClientRect(),wr=wrap.getBoundingClientRect();
      return {presentation:modal.dataset.presentation,modalPointer:getComputedStyle(modal).pointerEvents,framePointer:getComputedStyle(frame).pointerEvents,right:innerWidth-fr.right,top:fr.top,aspect:wr.width/wr.height};
    })()`);
    assert.equal(dockedPhoto.modalPointer, 'none', 'docked host must not intercept viewer navigation outside the photo');
    assert.equal(dockedPhoto.framePointer, 'auto');
    assert.ok(dockedPhoto.right >= 0 && dockedPhoto.right <= 20 && dockedPhoto.top > 50, JSON.stringify(dockedPhoto));
    assert.ok(Math.abs(dockedPhoto.aspect - 1) < 0.02, 'docked preview did not preserve the photo natural aspect ratio');
    await client.evaluate(`document.querySelector('#photo-imgwrap').click()`);
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'expanded'`, 'photo click did not open the expanded inspector');
    const expandedCenter = await client.evaluate(`(() => { const r=document.querySelector('#photo-imgwrap').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    await client.command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: expandedCenter.x, y: expandedCenter.y, deltaX: 0, deltaY: -420 });
    await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: expandedCenter.x, y: expandedCenter.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'left', buttons: 1 });
    await client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 2, y: 2, button: 'left', buttons: 0, clickCount: 1 });
    const clampedPhoto = await client.evaluate(`(() => { const w=document.querySelector('#photo-imgwrap').getBoundingClientRect(),i=document.querySelector('#photo-img').getBoundingClientRect(); return {wrap:{l:w.left,t:w.top,r:w.right,b:w.bottom},image:{l:i.left,t:i.top,r:i.right,b:i.bottom},transform:getComputedStyle(document.querySelector('#photo-img')).transform}; })()`);
    assert.notEqual(clampedPhoto.transform, 'none', 'expanded wheel did not zoom the camera photo');
    assert.ok(clampedPhoto.image.l <= clampedPhoto.wrap.l + 2 && clampedPhoto.image.t <= clampedPhoto.wrap.t + 2
      && clampedPhoto.image.r >= clampedPhoto.wrap.r - 2 && clampedPhoto.image.b >= clampedPhoto.wrap.b - 2,
    `expanded pan exposed empty frame background: ${JSON.stringify(clampedPhoto)}`);
    await client.evaluate(`document.querySelector('#photo-close').click(); document.querySelector('#tab-ortho').click()`);
    await waitFor(client, `document.querySelector('#panel-camera-positions').style.display === 'block' && window.__ltdsMapCamDrawn > 0`, 'orthophoto did not expose bounded camera positions', 30_000);
    const mapCamera = await client.evaluate(`(() => ({drawn:window.__ltdsMapCamDrawn,sources:window.__ltdsMapCamDrawToSource.slice(),icons:document.querySelectorAll('.map-camera-marker').length}))()`);
    assert.ok(mapCamera.drawn > 0 && mapCamera.drawn <= 1200, JSON.stringify(mapCamera));
    assert.equal(mapCamera.icons, mapCamera.drawn);
    await client.evaluate(`document.querySelector('.map-camera-marker').click()`);
    await waitFor(client, `document.querySelector('#photo-modal').dataset.presentation === 'docked'`, 'orthophoto camera did not open the shared photo preview');
    const mapPhotoUrl = await client.evaluate(`document.querySelector('#photo-img').src`);
    assert.match(mapPhotoUrl, new RegExp(`/camera-photos/photo-${mapCamera.sources[0]}\\.jpg$`));
    await client.evaluate(`document.querySelector('#photo-close').click(); document.querySelector('#tab-model').click()`);
    await waitFor(client, `document.querySelector('#tab-model').classList.contains('active')`, 'model did not resume after orthophoto camera verification');


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
    await removeBrowserProfile(profile);
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
    const fixture = await startFixture(
      path.resolve(tileRoot),
      foregroundAcceptanceFixture({ worldCenterY: 0 }),
    );
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-foreground-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Network.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    await waitFor(client, 'Boolean(window.__ltds?.tiles()?.root?.engineData?.scene)', 'coarse root did not load');
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.bootstrapPhase === 'complete'`,
      '16-leaf fixture did not finish its initial bounded prefetch', 180_000);
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
    assert.equal(stagedRequest.active, 24);
    assert.ok(Math.abs(stagedRequest.errorTarget - 2 * Math.max(1, stagedRequest.errorScale / 2)) < 0.01,
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
      root.engineData.scene?.traverse((object) => {
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
    assert.ok(farRetention.rows.every((row) => row.cacheUsed === true),
      `bounded recent-frontier retention did not protect the detached decoded cut: ${JSON.stringify(farRetention)}`);
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
    await removeBrowserProfile(profile);
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
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
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
    await removeBrowserProfile(profile);
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
  writeFileSync(path.join(tileRoot, 'mid-a.glb'), makeGlb([TRIANGLE_A], validPng));
  writeFileSync(path.join(tileRoot, 'mid-b.glb'), makeGlb([TRIANGLE_A], validPng));
  const sessionTilesetPath = path.join(tileRoot, 'tileset.json');
  const sessionTileset = JSON.parse(readFileSync(sessionTilesetPath, 'utf8'));
  sessionTileset.root.content = { uri: 'coarse.glb' };
  sessionTileset.root.children = sessionTileset.root.children.map((leaf, index) => ({
    geometricError: 4,
    boundingVolume: leaf.boundingVolume,
    content: { uri: `mid-${index === 0 ? 'a' : 'b'}.glb` },
    children: [leaf],
  }));
  writeFileSync(sessionTilesetPath, JSON.stringify(sessionTileset));
  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client, fixture;
  try {
    fixture = await startSessionRefreshFixture(tileRoot, { fineTileDelayMs: 3_000, shellTileDelayMs: 5_000 });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-session-lod-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
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
    const logicalShellBytes = 1329 * 1024 * 1024;
    await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const shell = tiles.root.children;
      const logicalBytesPerTile = ${logicalShellBytes} / shell.length;
      const originalGetBytesUsed = tiles.getBytesUsed;
      tiles.getBytesUsed = function (tile) {
        return shell.includes(tile)
          ? logicalBytesPerTile
          : originalGetBytesUsed.call(this, tile);
      };
      // Keep both per-tile accounting and the aggregate cache total coherent.
      // This makes the browser exercise the real hard/soft byte paths instead
      // of only spoofing Map.get while cachedBytes remains near zero.
      for (const tile of shell) {
        if (tiles.lruCache.has(tile) && tile.internal?.loadingState === 4) {
          tiles.lruCache.setMemoryUsage(tile, logicalBytesPerTile);
        }
      }
      window.__restoreLogicalShellBytes = () => {
        tiles.getBytesUsed = originalGetBytesUsed;
        for (const tile of shell) {
          if (tiles.lruCache.has(tile)) {
            tiles.lruCache.setMemoryUsage(tile, originalGetBytesUsed.call(tiles, tile));
          }
        }
      };
      return true;
    })()`);
    await waitFor(client, `window.__ltds.state.lodRuntimeProfile?.activeDetail === 20
      && window.__ltds.state.lodRuntimeProfile?.bootstrapPhase === 'complete'`,
      'refreshed session did not enter direct Detail 20 refinement', 20_000);
    const balancedStartup = await client.evaluate(`({
      slider: document.querySelector('#lod-detail').value,
      requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
      active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
      errorTarget: window.__ltds.tiles().errorTarget,
      phase: window.__ltds.lodDiagnostics().phase,
      bootstrapPhase: window.__ltds.state.lodRuntimeProfile?.bootstrapPhase,
      bootstrapCoverageTarget: window.__ltds.state.lodRuntimeProfile?.bootstrapCoverageTarget,
      errorScale: window.__ltds.state.lodRuntimeProfile?.errorScale,
      prefetch: window.__ltds.lodDiagnostics().prefetch,
    })`);
    assert.deepEqual({ ...balancedStartup, errorTarget: undefined, errorScale: undefined, bootstrapCoverageTarget: undefined, prefetch: undefined }, {
      slider: '20', requested: 20, active: 20, errorTarget: undefined,
      phase: 'requested-detail', bootstrapPhase: 'complete', errorScale: undefined,
      bootstrapCoverageTarget: undefined, prefetch: undefined,
    });
    assert.equal(balancedStartup.errorScale, 1);
    assert.equal(balancedStartup.prefetch.shellMiB, 1329,
      `runtime did not measure the production-sized logical shell: ${JSON.stringify(balancedStartup)}`);
    assert.equal(balancedStartup.prefetch.shellSoftLimitMiB, 512);
    assert.equal(balancedStartup.prefetch.shellLimitMiB, 1536);
    assert.equal(balancedStartup.prefetch.detailReserveMiB, 1664);
    assert.equal(balancedStartup.prefetch.overSoftBudget, true,
      'crossing the 1.25 GiB target must remain diagnostic while the safe shell promotes');
    assert.equal(balancedStartup.errorTarget, 5.481,
      `steady Detail 20 did not use raw SSE: ${JSON.stringify(balancedStartup)}`);
    assert.ok(balancedStartup.errorTarget < balancedStartup.bootstrapCoverageTarget, JSON.stringify(balancedStartup));
    const promotedShell = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      return {
        rootInFallback: tiles.lodFallbackTiles?.has(tiles.root) === true,
        rootVisible: tiles.root?.traversal?.visible === true,
        rootAttached: Boolean(tiles.root?.engineData?.scene && tiles.group.children.includes(tiles.root.engineData.scene)),
        fallbackUris: [...(tiles.lodFallbackTiles || [])].map(tile => tile.content?.uri || tile.content?.url || ''),
        status: document.querySelector('#lod-status')?.textContent || '',
      };
    })()`);
    assert.equal(promotedShell.rootInFallback, false,
      `whole-model root remained a permanent fallback after shell promotion: ${JSON.stringify(promotedShell)}`);
    assert.equal(promotedShell.rootVisible, false,
      `whole-model root reactivated while direct shell coverage was available: ${JSON.stringify(promotedShell)}`);
    assert.equal(promotedShell.rootAttached, false,
      `whole-model root remained attached after complete shell promotion: ${JSON.stringify(promotedShell)}`);
    assert.deepEqual(promotedShell.fallbackUris.sort(), ['mid-a.glb', 'mid-b.glb']);
    assert.doesNotMatch(promotedShell.status, /full-detail/,
      `pending deep replacement work was mislabeled full-detail: ${JSON.stringify(promotedShell)}`);
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
    assert.deepEqual(explicitHighDetail, { requested: 24, active: 24, errorTarget: 2 });
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
      let descendantVisible = false;
      const visit = tile => { for (const child of (tile?.children || [])) {
        if (child.traversal?.visible === true) descendantVisible = true;
        visit(child);
      }};
      visit(tiles.root);
      return tiles.root?.traversal?.visible === false && descendantVisible;
    })()`, 'settled fine frontier did not replace the coarse fallback');
    const fineTileDeadline = Date.now() + 10_000;
    while (!fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-b.glb')) && Date.now() < fineTileDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(fixture.requests.some((requestPath) => requestPath.endsWith('/leaf-b.glb')), true,
      'explicit Detail 24 did not refine into the fine child tile');

    await waitFor(client, `(() => {
      const tiles = window.__ltds.tiles();
      const leaves = [];
      const visit = tile => { (tile?.children || []).forEach(visit);
        if (!(tile?.children || []).length && Number(tile?.geometricError) === 0) leaves.push(tile);
      };
      visit(tiles.root);
      return leaves.length === 2 && leaves.every(tile => tile.engineData?.scene
        && tiles.group.children.includes(tile.engineData.scene))
        && !tiles.downloadQueue?.running && !tiles.parseQueue?.running && !tiles.processNodeQueue?.running;
    })()`, 'synthetic multi-branch fixture did not reach its full leaf frontier', 20_000);
    await waitFor(client, `document.querySelector('#lod-status')?.textContent?.includes('full-detail')`,
      'settled zero-error frontier was never reported as full-detail', 5_000);

    const motionRequestIndex = client.events.length;
    const beforeMotion = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles(); const scenes = {};
      const visit = tile => { (tile?.children || []).forEach(visit);
        const uri = tile?.content?.uri || tile?.content?.url || '';
        if (!(tile?.children || []).length && Number(tile?.geometricError) === 0) {
          let mesh = null;
          tile.engineData?.scene?.traverse?.(object => { if (!mesh && object.isMesh) mesh = object; });
          const material = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
          scenes[uri] = {
            scene: tile.engineData?.scene?.uuid || null,
            geometry: mesh?.geometry?.uuid || null,
            material: material?.uuid || null,
            texture: material?.map?.uuid || null,
          };
        }
      };
      visit(tiles.root); return scenes;
    })()`);
    const canvas = await client.evaluate(`(() => { const r=document.querySelector('#three-container canvas').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    const findOrbitPoint = () => client.evaluate(`(() => {
      const controls = window.__ltds.controls();
      const tiles = window.__ltds.tiles();
      const camera = window.__ltds.camera();
      const r = document.querySelector('#three-container canvas').getBoundingClientRect();
      tiles.group.updateWorldMatrix(true, true);
      camera.updateMatrixWorld(true);
      let mesh = null;
      tiles.group.traverse(object => { if (!mesh && object.isMesh && object.geometry?.attributes?.position?.count >= 3) mesh = object; });
      if (!mesh) return null;
      const Vector3 = camera.position.constructor;
      const position = mesh.geometry.attributes.position;
      const center = new Vector3();
      for (let index = 0; index < 3; index++) center.add(new Vector3().fromBufferAttribute(position, index));
      center.multiplyScalar(1 / 3);
      mesh.localToWorld(center);
      center.project(camera);
      const projected = {
        x: r.left + (center.x + 1) * r.width / 2,
        y: r.top + (1 - center.y) * r.height / 2,
      };
      if (controls.surfacePick(controls._ndcFromClient(projected.x, projected.y))) return projected;
      for (let radius = 2; radius <= 24; radius += 2) {
        for (const [dx, dy] of [[radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
          const x = projected.x + dx;
          const y = projected.y + dy;
          if (controls.surfacePick(controls._ndcFromClient(x, y))) return { x, y };
        }
      }
      return null;
    })()`);
    let orbitPoint = await findOrbitPoint();
    assert.ok(orbitPoint, 'synthetic detail frontier did not expose a rendered surface for orbit testing');
    let observedActivity = false;
    const stableMotionSample = async (label) => {
      const motionDeadline = Date.now() + 500;
      while (Date.now() < motionDeadline) {
        const sample = await client.evaluate(`(() => {
          const tiles = window.__ltds.tiles(); let attachedLeaves=0; let positiveVisible=0;
          const visit = tile => { (tile?.children || []).forEach(visit);
            if (tile?.traversal?.visible === true && Number(tile?.geometricError) > 0) positiveVisible++;
            if (!(tile?.children || []).length && Number(tile?.geometricError) === 0
              && tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene)) attachedLeaves++;
          };
          visit(tiles.root);
          return {
            rootVisible: tiles.root?.traversal?.visible === true,
            rootAttached: Boolean(tiles.root?.engineData?.scene && tiles.group.children.includes(tiles.root.engineData.scene)),
            rootInFallback: tiles.lodFallbackTiles?.has(tiles.root) === true,
            attachedLeaves,
            positiveVisible,
          };
        })()`);
        assert.deepEqual(sample, {
          rootVisible: false, rootAttached: false, rootInFallback: false, attachedLeaves: 2, positiveVisible: 0,
        }, `${label} degraded the settled frontier: ${JSON.stringify(sample)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const cameraMatrix = () => client.evaluate(`(() => {
      const camera = window.__ltds.camera(); camera.updateMatrixWorld(true); return Array.from(camera.matrixWorld.elements);
    })()`);
    const assertCameraMoved = async (before, label) => {
      const after = await cameraMatrix();
      assert.notDeepEqual(after, before, `${label} did not change the camera matrix`);
    };
    for (const pixels of [1, 2, 4, 8]) {
      const beforeActivity = await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime`);
      const beforeMatrix = await cameraMatrix();
      await client.command('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: canvas.x, y: canvas.y, button: 'right', buttons: 2, clickCount: 1,
      });
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: canvas.x + pixels, y: canvas.y, button: 'right', buttons: 2,
      });
      observedActivity ||= await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime > ${beforeActivity}`);
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: canvas.x + pixels, y: canvas.y, button: 'right', buttons: 0, clickCount: 1,
      });
      await stableMotionSample(`a ${pixels}-pixel pan gesture`);
      await assertCameraMoved(beforeMatrix, `a ${pixels}-pixel pan gesture`);
    }
    orbitPoint = await findOrbitPoint();
    assert.ok(orbitPoint, 'panned detail frontier did not expose a rendered surface for orbit testing');
    for (const pixels of [1, 2, 4, 8]) {
      orbitPoint = await findOrbitPoint();
      assert.ok(orbitPoint, `settled detail frontier did not expose a rendered surface before a ${pixels}-pixel orbit gesture`);
      const beforeActivity = await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime`);
      const beforeMatrix = await cameraMatrix();
      await client.command('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: orbitPoint.x, y: orbitPoint.y, button: 'left', buttons: 1, clickCount: 1,
      });
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: orbitPoint.x + pixels, y: orbitPoint.y, button: 'left', buttons: 1,
      });
      observedActivity ||= await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime > ${beforeActivity}`);
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: orbitPoint.x + pixels, y: orbitPoint.y, button: 'left', buttons: 0, clickCount: 1,
      });
      await stableMotionSample(`a ${pixels}-pixel orbit gesture`);
      await assertCameraMoved(beforeMatrix, `a ${pixels}-pixel orbit gesture`);
    }
    for (const delta of [1, 2, 4, 8]) {
      const beforeActivity = await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime`);
      const beforeMatrix = await cameraMatrix();
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: canvas.x, y: canvas.y, button: 'none', buttons: 0, deltaX: 0, deltaY: delta,
      });
      observedActivity ||= await client.evaluate(`window.__ltds.controls().getInteractionState().lastActivityTime > ${beforeActivity}`);
      await stableMotionSample(`a ${delta}-unit wheel-zoom gesture`);
      await assertCameraMoved(beforeMatrix, `a ${delta}-unit wheel-zoom gesture`);
    }
    assert.equal(observedActivity, true, 'CDP pan, orbit, and zoom gestures did not reach EarthLikeControls interaction state');
    const afterMotion = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles(); const scenes = {};
      const visit = tile => { (tile?.children || []).forEach(visit);
        const uri = tile?.content?.uri || tile?.content?.url || '';
        if (!(tile?.children || []).length && Number(tile?.geometricError) === 0) {
          let mesh = null;
          tile.engineData?.scene?.traverse?.(object => { if (!mesh && object.isMesh) mesh = object; });
          const material = Array.isArray(mesh?.material) ? mesh.material[0] : mesh?.material;
          scenes[uri] = {
            scene: tile.engineData?.scene?.uuid || null,
            geometry: mesh?.geometry?.uuid || null,
            material: material?.uuid || null,
            texture: material?.map?.uuid || null,
          };
        }
      };
      visit(tiles.root); return scenes;
    })()`);
    assert.deepEqual(afterMotion, beforeMotion, 'tiny camera motion discarded already-decoded leaf scenes');
    const duplicateMotionRequests = client.events.slice(motionRequestIndex)
      .filter(event => event.method === 'Network.requestWillBeSent'
        && /\/leaf-(?:a\.b3dm|b\.glb)$/i.test(new URL(event.params.request.url).pathname))
      .map(event => new URL(event.params.request.url).pathname);
    assert.deepEqual(duplicateMotionRequests, [],
      `tiny camera motion re-requested cached leaf content: ${JSON.stringify(duplicateMotionRequests)}`);
    await client.evaluate(`window.__restoreLogicalShellBytes?.()`);
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
    await removeBrowserProfile(profile);
  }
});

test('production-weighted broad view completes focal Detail 20 without cache-admission deadlock', { timeout: 180_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for production-weighted LOD acceptance.');
    return;
  }

  const { makeGlb, TRIANGLE_A } = await import('./helpers/lod-fixture.mjs');
  const tileRoot = mkdtempSync(path.join(tmpdir(), 'ltds-weighted-lod-fixture-'));
  const validPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const tileBytes = makeGlb([TRIANGLE_A], validPng);
  const shellCount = 11;
  const centerShellIndex = Math.floor(shellCount / 2);
  let fineIndex = 0;
  const shell = Array.from({ length: shellCount }, (_, shellIndex) => {
    const x = (shellIndex - centerShellIndex) * 28;
    const leafCount = shellIndex === centerShellIndex ? 15 : 14;
    const children = Array.from({ length: leafCount }, (_, localIndex) => {
      const uri = `fine-${String(fineIndex++).padStart(3, '0')}.glb`;
      writeFileSync(path.join(tileRoot, uri), tileBytes);
      return {
        geometricError: 0,
        boundingVolume: {
          sphere: [
            x + ((localIndex % 5) - 2) * 4,
            (Math.floor(localIndex / 5) - 1) * 4,
            0,
            5,
          ],
        },
        content: { uri },
      };
    });
    const uri = `shell-${String(shellIndex).padStart(2, '0')}.glb`;
    writeFileSync(path.join(tileRoot, uri), tileBytes);
    return {
      geometricError: 6,
      boundingVolume: { sphere: [x, 0, 0, 20] },
      content: { uri },
      children,
    };
  });
  assert.equal(fineIndex, 155);
  writeFileSync(path.join(tileRoot, 'coarse.glb'), tileBytes);
  writeFileSync(path.join(tileRoot, 'tileset.json'), JSON.stringify({
    asset: { version: '1.0' },
    geometricError: 64,
    root: {
      refine: 'REPLACE',
      geometricError: 64,
      boundingVolume: { sphere: [0, 0, 0, 170] },
      content: { uri: 'coarse.glb' },
      children: shell,
    },
  }));

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client, fixture;
  try {
    fixture = await startFixture(tileRoot, {
      // This acceptance case validates the patched renderer package itself.
      // Force Vite to rebuild its optimized dependency so a prior browser run
      // cannot silently exercise an older renderer implementation.
      forceOptimizeDeps: true,
      assetDelayMs: relative => /^shell-\d+\.glb$/i.test(relative)
        ? 4_000
        : /^fine-\d+\.glb$/i.test(relative) ? 80 : 0,
    });
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-weighted-lod-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Network.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1440, screenHeight: 900,
    });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}&view=model` });
    await waitFor(client, `Boolean(window.__ltds?.tiles()?.root?.children?.length === ${shellCount})`,
      'production-weighted hierarchy did not initialize', 20_000);

    const logicalShellBytes = 1329 * 1024 * 1024;
    const logicalFineBytes = 24 * 1024 * 1024;
    await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const originalGetBytesUsed = tiles.getBytesUsed;
      const originalSetMemoryUsage = tiles.lruCache.setMemoryUsage;
      const shellBytes = ${logicalShellBytes} / ${shellCount};
      const fineBytes = ${logicalFineBytes};
      const decodedOnce = new WeakSet();
      const uriFor = tile => String(tile?.content?.uri || tile?.content?.url || '').split(/[?#]/, 1)[0];
      // Production byte plugins report decoded GPU/geometry allocations only
      // after a scene exists. Reserving the logical amount while the request is
      // merely queued would bypass the renderer's post-parse prospective check.
      const logicalBytes = tile => {
        if (tile?.engineData?.scene) decodedOnce.add(tile);
        if (!decodedOnce.has(tile)) return null;
        return /(?:^|\\/)shell-\\d+\\.glb$/i.test(uriFor(tile))
          ? shellBytes
          : /(?:^|\\/)fine-\\d+\\.glb$/i.test(uriFor(tile)) ? fineBytes : null;
      };
      tiles.getBytesUsed = function (tile) {
        const weighted = logicalBytes(tile);
        return weighted === null ? originalGetBytesUsed.call(this, tile) : weighted;
      };
      window.__weightedAdmissionTrace = [];
      tiles.lruCache.setMemoryUsage = function (tile, bytes) {
        const before = this.cachedBytes;
        const result = originalSetMemoryUsage.call(this, tile, bytes);
        window.__weightedAdmissionTrace.push({
          kind: 'set', uri: uriFor(tile), before, bytes, after: this.cachedBytes, max: this.maxBytesSize,
          loaded: tile?.internal?.loadingState, scene: Boolean(tile?.engineData?.scene),
        });
        if (window.__weightedAdmissionTrace.length > 40) window.__weightedAdmissionTrace.shift();
        return result;
      };
      tiles.addEventListener('tile-memory-pressure', event => {
        window.__weightedAdmissionTrace.push({
          kind: 'pressure', uri: uriFor(event.tile), before: tiles.lruCache.cachedBytes,
          bytes: event.bytesUsed, max: tiles.lruCache.maxBytesSize,
        });
        if (window.__weightedAdmissionTrace.length > 40) window.__weightedAdmissionTrace.shift();
      });
      for (const tile of tiles.lruCache.itemSet.keys()) {
        const weighted = logicalBytes(tile);
        if (weighted !== null && tile.internal?.loadingState === 4) {
          tiles.lruCache.setMemoryUsage(tile, weighted);
        }
      }
      window.__restoreProductionWeights = () => {
        tiles.getBytesUsed = originalGetBytesUsed;
        tiles.lruCache.setMemoryUsage = originalSetMemoryUsage;
        for (const tile of tiles.lruCache.itemSet.keys()) {
          tiles.lruCache.setMemoryUsage(tile, originalGetBytesUsed.call(tiles, tile));
        }
      };
      return true;
    })()`);

    const fineRequest = requestPath => /\/fine-\d+\.glb$/i.test(requestPath);
    const bootstrapDeadline = Date.now() + 20_000;
    let bootstrapPhase = null;
    while (Date.now() < bootstrapDeadline) {
      bootstrapPhase = await client.evaluate(`window.__ltds.state.lodRuntimeProfile?.bootstrapPhase`);
      if (bootstrapPhase === 'complete') break;
      assert.equal(fixture.requests.some(fineRequest), false,
        `prefetch descended into fine tiles while phase=${bootstrapPhase}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(bootstrapPhase, 'complete', 'production-weighted direct shell did not promote');

    const startup = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const diagnostics = window.__ltds.lodDiagnostics();
      return {
        requested: window.__ltds.state.lodRuntimeProfile?.requestedDetail,
        active: window.__ltds.state.lodRuntimeProfile?.activeDetail,
        policyKey: window.__ltds.state.lodRuntimeProfile?.memoryProfile?.policyKey,
        rawTarget: diagnostics.rawErrorTarget,
        target: tiles.errorTarget,
        softMiB: diagnostics.cache.softMiB,
        hardMiB: diagnostics.cache.maxMiB,
        shellMiB: diagnostics.prefetch.shellMiB,
        fallbackUris: [...(tiles.lodFallbackTiles || [])].map(tile => tile.content?.uri || tile.content?.url || ''),
        rootAttached: Boolean(tiles.root?.engineData?.scene && tiles.group.children.includes(tiles.root.engineData.scene)),
        rootVisible: tiles.root?.traversal?.visible === true,
      };
    })()`);
    assert.deepEqual({
      requested: startup.requested,
      active: startup.active,
      policyKey: startup.policyKey,
      rawTarget: startup.rawTarget,
      target: startup.target,
      softMiB: startup.softMiB,
      hardMiB: startup.hardMiB,
      shellMiB: startup.shellMiB,
      rootAttached: startup.rootAttached,
      rootVisible: startup.rootVisible,
    }, {
      requested: 20,
      active: 20,
      policyKey: 'roomy',
      rawTarget: 5.481,
      target: 5.481,
      softMiB: 3072,
      hardMiB: 3840,
      shellMiB: 1329,
      rootAttached: false,
      rootVisible: false,
    });
    assert.equal(startup.fallbackUris.length, shellCount);
    assert.deepEqual(startup.fallbackUris.sort(), Array.from({ length: shellCount }, (_, index) => `shell-${String(index).padStart(2, '0')}.glb`));

    const ownerDeadline = Date.now() + 15_000;
    let focalOwner = null;
    let lastFocalOwner = null;
    while (Date.now() < ownerDeadline && !focalOwner) {
      const candidate = await client.evaluate(`(() => {
        const tiles = window.__ltds.tiles();
        const owner = tiles.root.children.find(tile => tile.__ltdsFocalOwnerLocked === true);
        if (!owner) return null;
        return {
          uri: owner.content?.uri || owner.content?.url || '',
          overlap: owner.__ltdsFocusOverlap,
          maximumOverlap: Math.max(...tiles.root.children.map(tile => Number(tile.__ltdsFocusOverlap) || 0)),
          effectiveTarget: owner.__ltdsPeripheralErrorTarget,
          blockers: Number(owner.__ltdsOwnerPendingBlockers) || 0,
          childTargets: owner.children.map(tile => tile.__ltdsPeripheralErrorTarget),
        };
      })()`);
      lastFocalOwner = candidate || lastFocalOwner;
      focalOwner = candidate?.effectiveTarget === 5.481
        && candidate.blockers >= 1
        && candidate.childTargets.filter(Number.isFinite).every(value => value === 5.481)
        ? candidate
        : null;
      if (!focalOwner) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(focalOwner,
      `no focal REPLACE owner reached raw Detail 20 while its cut was cold: ${JSON.stringify(lastFocalOwner)}`);
    assert.equal(focalOwner.uri, `shell-${String(centerShellIndex).padStart(2, '0')}.glb`, JSON.stringify(focalOwner));
    assert.equal(focalOwner.overlap, focalOwner.maximumOverlap,
      `the locked owner was not the most camera-centered fallback: ${JSON.stringify(focalOwner)}`);
    assert.equal(focalOwner.effectiveTarget, 5.481, JSON.stringify(focalOwner));
    assert.ok(focalOwner.blockers >= 1, JSON.stringify(focalOwner));
    assert.equal(focalOwner.childTargets.filter(Number.isFinite).every(value => value === 5.481), true,
      `locked focal descendants did not retain raw Detail 20: ${JSON.stringify(focalOwner)}`);

    const focalCompletionDeadline = Date.now() + 15_000;
    let focalCut = null;
    while (Date.now() < focalCompletionDeadline) {
      focalCut = await client.evaluate(`(() => {
        const tiles = window.__ltds.tiles();
        const owner = tiles.root.children.find(tile => /shell-${String(centerShellIndex).padStart(2, '0')}\\.glb$/i.test(tile.content?.uri || tile.content?.url || ''));
        const attached = tile => Boolean(tile.engineData?.scene && tiles.group.children.includes(tile.engineData.scene));
        return {
          ownerAttached: attached(owner),
          ownerVisible: owner?.traversal?.visible === true,
          children: owner?.children?.length || 0,
          attachedChildren: owner?.children?.filter(attached).length || 0,
          cachedChildren: owner?.children?.filter(tile => tiles.lruCache.has(tile)).length || 0,
        };
      })()`);
      if (focalCut.children === focalCut.attachedChildren && !focalCut.ownerAttached) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(focalCut, {
      ownerAttached: false,
      ownerVisible: false,
      children: 15,
      attachedChildren: 15,
      cachedChildren: 15,
    }, `centered owner never completed its strict REPLACE cut: ${JSON.stringify(focalCut)}`);

    const sampleRuntime = () => client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const diagnostics = window.__ltds.lodDiagnostics();
      const attached = tile => Boolean(tile?.engineData?.scene && tiles.group.children.includes(tile.engineData.scene));
      const descendantsAttached = tile => {
        const result = [];
        const stack = [...(tile.children || [])];
        while (stack.length) {
          const next = stack.pop();
          if (attached(next)) result.push(next.content?.uri || next.content?.url || '');
          stack.push(...(next.children || []));
        }
        return result;
      };
      const replacementViolations = [];
      const coverageGaps = [];
      for (const owner of tiles.root.children) {
        const ownerUri = owner.content?.uri || owner.content?.url || '';
        const childAttached = descendantsAttached(owner);
        if (attached(owner) && childAttached.length) replacementViolations.push({ owner: ownerUri, children: childAttached });
        if (owner.traversal?.used === true && owner.traversal?.inFrustum === true && !attached(owner)) {
          const selected = owner.children.filter(tile => tile.traversal?.used === true && tile.traversal?.inFrustum === true);
          if (!selected.length || selected.some(tile => !attached(tile))) {
            coverageGaps.push({ owner: ownerUri, selected: selected.length, attached: selected.filter(attached).length });
          }
        }
      }
      const leaves = tiles.root.children.flatMap(owner => owner.children);
      const center = tiles.root.children[${centerShellIndex}];
      const centerRows = center.children.map(tile => ({
        uri: tile.content?.uri || tile.content?.url || '',
        attached: attached(tile),
        cached: tiles.lruCache.has(tile),
        scene: tile.engineData?.scene?.uuid || null,
      }));
      const cacheRows = [tiles.root, ...tiles.root.children, ...leaves]
        .filter(tile => tiles.lruCache.has(tile))
        .map(tile => ({
          uri: tile.content?.uri || tile.content?.url || 'root',
          bytes: tiles.lruCache.getMemoryUsage(tile),
          used: tiles.lruCache.isUsed(tile),
          attached: attached(tile),
          selected: tile.traversal?.used === true && tile.traversal?.inFrustum === true,
          errorTarget: tile.__ltdsPeripheralErrorTarget,
        }));
      const sum = (rows, predicate) => rows
        .filter(predicate)
        .reduce((total, row) => total + row.bytes, 0) / ${GiB};
      return {
        diagnostics,
        replacementViolations,
        coverageGaps,
        attachedFine: leaves.filter(attached).length,
        cachedFine: leaves.filter(tile => tiles.lruCache.has(tile)).length,
        cachedFineUris: leaves
          .filter(tile => tiles.lruCache.has(tile))
          .map(tile => tile.content?.uri || tile.content?.url || ''),
        selectedFine: leaves.filter(tile => tile.traversal?.used === true && tile.traversal?.inFrustum === true).length,
        centerRows,
        ownerRows: tiles.root.children.map(owner => ({
          uri: owner.content?.uri || owner.content?.url || '',
          overlap: owner.__ltdsFocusOverlap,
          locked: owner.__ltdsFocalOwnerLocked === true,
          conservative: owner.__ltdsConservativeRawSse === true,
          childOverlaps: owner.children.map(tile => Number(tile.__ltdsFocusOverlap) || 0),
        })),
        peripheralTargets: tiles.root.children.map(tile => tile.__ltdsPeripheralErrorTarget).filter(Number.isFinite),
        admissionTrace: [...(window.__weightedAdmissionTrace || [])],
        cacheBreakdown: {
          rows: cacheRows.length,
          usedGiB: sum(cacheRows, row => row.used),
          unusedGiB: sum(cacheRows, row => !row.used),
          shellGiB: sum(cacheRows, row => /^shell-/i.test(row.uri)),
          fineGiB: sum(cacheRows, row => /^fine-/i.test(row.uri)),
          selectedFineGiB: sum(cacheRows, row => /^fine-/i.test(row.uri) && row.selected),
          attachedFineGiB: sum(cacheRows, row => /^fine-/i.test(row.uri) && row.attached),
        },
      };
    })()`);
    const assertStrictCoverage = (sample, label) => {
      assert.deepEqual(sample.replacementViolations, [], `${label}: parent and descendant rendered together`);
      assert.deepEqual(sample.coverageGaps, [], `${label}: strict REPLACE coverage gap`);
      assert.ok(sample.diagnostics.attachedVisibleTiles > 0, `${label}: no attached visible coverage`);
      assert.ok(sample.diagnostics.cache.usedMiB <= sample.diagnostics.cache.maxMiB,
        `${label}: cache crossed hard cap: ${JSON.stringify({ cache: sample.diagnostics.cache, trace: sample.admissionTrace })}`);
    };

    let pressureSample = null;
    let lastPressureSample = null;
    let peakCacheMiB = 0;
    let deadlockStartedAt = null;
    let maximumBlockedMs = 0;
    const updateDeadlockWindow = (sample) => {
      const diagnostics = sample.diagnostics;
      peakCacheMiB = Math.max(peakCacheMiB, diagnostics.cache.usedMiB || 0);
      const blocked = diagnostics.cache.full && diagnostics.pendingRequiredTiles > 0
        && !diagnostics.queues.download && !diagnostics.queues.parse && !diagnostics.queues.process;
      if (blocked) {
        deadlockStartedAt ??= Date.now();
        maximumBlockedMs = Math.max(maximumBlockedMs, Date.now() - deadlockStartedAt);
      } else {
        deadlockStartedAt = null;
      }
    };
    const pressureDeadline = Date.now() + 45_000;
    while (Date.now() < pressureDeadline) {
      const sample = await sampleRuntime();
      lastPressureSample = sample;
      assertStrictCoverage(sample, 'broad-view admission');
      updateDeadlockWindow(sample);
      // The pressure scalar and the renderer's per-owner targets are applied
      // on adjacent animation frames. Sample only after both sides of that
      // contract are observable so this assertion cannot catch the transient
      // frame between them.
      if (sample.diagnostics.peripheralPressureScale > 1
        && sample.peripheralTargets.some(value => value > 5.481)) {
        pressureSample = sample;
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(pressureSample, `production-weighted broad view never activated adaptive peripheral pressure: ${JSON.stringify({
      diagnostics: lastPressureSample?.diagnostics,
      attachedFine: lastPressureSample?.attachedFine,
      cachedFine: lastPressureSample?.cachedFine,
      selectedFine: lastPressureSample?.selectedFine,
      peripheralTargets: lastPressureSample?.peripheralTargets,
      ownerRows: lastPressureSample?.ownerRows,
      cacheBreakdown: lastPressureSample?.cacheBreakdown,
      admissionTrace: lastPressureSample?.admissionTrace,
      peakCacheMiB,
      maximumBlockedMs,
    })}`);
    assert.equal(pressureSample.diagnostics.rawErrorTarget, 5.481);
    assert.equal(pressureSample.diagnostics.errorTarget, 5.481,
      'memory pressure mutated the global requested SSE');
    assert.ok(pressureSample.diagnostics.peripheralPressureScale >= 2
      && pressureSample.diagnostics.peripheralPressureScale <= 4, JSON.stringify(pressureSample.diagnostics));
    assert.ok(pressureSample.cachedFine < 155 && pressureSample.attachedFine < 155,
      `broad peripheral frontier was not bounded: ${JSON.stringify({ cached: pressureSample.cachedFine, attached: pressureSample.attachedFine })}`);
    assert.ok(pressureSample.peripheralTargets.some(value => value > 5.481),
      `peripheral targets did not adapt above raw Detail 20: ${JSON.stringify(pressureSample.peripheralTargets)}`);
    assert.ok(peakCacheMiB > 3072 && peakCacheMiB <= 3840,
      `fixture did not exercise Auto overflow admission safely: peak=${peakCacheMiB} MiB`);

    const beforeMotion = await sampleRuntime();
    assertStrictCoverage(beforeMotion, 'before tiny motion');
    assert.equal(beforeMotion.centerRows.every(row => row.attached && row.cached && row.scene), true,
      `focal cut was not warm before motion: ${JSON.stringify(beforeMotion.centerRows)}`);
    const centerScenes = Object.fromEntries(beforeMotion.centerRows.map(row => [row.uri, row.scene]));
    const requestCountsBefore = new Map(beforeMotion.cachedFineUris.map(uri => [
      uri,
      fixture.requests.filter(requestPath => requestPath.endsWith(`/${uri}`)).length,
    ]));
    const canvas = await client.evaluate(`(() => { const r=document.querySelector('#three-container canvas').getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    const sampleMovement = async (label) => {
      const deadline = Date.now() + 500;
      while (Date.now() < deadline) {
        const sample = await sampleRuntime();
        assertStrictCoverage(sample, label);
        updateDeadlockWindow(sample);
        assert.equal(sample.centerRows.every(row => row.attached && row.cached), true,
          `${label}: tiny movement dropped the warm focal cut`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    for (const pixels of [1, 2, 4, 8]) {
      await client.command('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: canvas.x, y: canvas.y, button: 'right', buttons: 2, clickCount: 1,
      });
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: canvas.x + pixels, y: canvas.y, button: 'right', buttons: 2,
      });
      await client.command('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: canvas.x + pixels, y: canvas.y, button: 'right', buttons: 0, clickCount: 1,
      });
      await sampleMovement(`${pixels}-pixel pan`);
    }
    await client.command('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: canvas.x, y: canvas.y, button: 'left', buttons: 1, clickCount: 1,
    });
    await client.command('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: canvas.x + 4, y: canvas.y, button: 'left', buttons: 1,
    });
    await client.command('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: canvas.x + 4, y: canvas.y, button: 'left', buttons: 0, clickCount: 1,
    });
    await sampleMovement('4-pixel orbit');

    const afterMotion = await sampleRuntime();
    assertStrictCoverage(afterMotion, 'after tiny motion');
    assert.deepEqual(Object.fromEntries(afterMotion.centerRows.map(row => [row.uri, row.scene])), centerScenes,
      'tiny camera movement discarded or recreated the warm focal scenes');
    for (const [uri, before] of requestCountsBefore) {
      const after = fixture.requests.filter(requestPath => requestPath.endsWith(`/${uri}`)).length;
      assert.equal(after, before, `tiny movement re-fetched cached ${uri}`);
    }

    const finalRecoveryDeadline = Date.now() + 8_000;
    let finalBlockedSample = null;
    while (deadlockStartedAt !== null && Date.now() < finalRecoveryDeadline) {
      finalBlockedSample = await sampleRuntime();
      assertStrictCoverage(finalBlockedSample, 'post-motion pressure recovery');
      updateDeadlockWindow(finalBlockedSample);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(deadlockStartedAt, null,
      `cache admission remained idle and blocked for ${maximumBlockedMs} ms after tiny motion: ${JSON.stringify({
        diagnostics: finalBlockedSample?.diagnostics,
        cacheBreakdown: finalBlockedSample?.cacheBreakdown,
        admissionTrace: finalBlockedSample?.admissionTrace,
      })}`);
    assert.ok(maximumBlockedMs < 8_000,
      `cache admission recovery exceeded its bounded pressure window: ${maximumBlockedMs} ms`);
    const fineRequests = fixture.requests.filter(fineRequest);
    const uniqueFineRequests = new Set(fineRequests);
    assert.ok(uniqueFineRequests.size >= 15 && uniqueFineRequests.size <= 155,
      `unexpected production frontier request count: ${uniqueFineRequests.size}`);
    const exceptions = client.events.filter(event => event.method === 'Runtime.exceptionThrown'
      && !event.params.exceptionDetails?.url?.includes('/@vite/client'));
    assert.deepEqual(exceptions, []);
    t.diagnostic(JSON.stringify({
      shellTiles: shellCount,
      fineTiles: 155,
      requestedFineUrls: uniqueFineRequests.size,
      focalOwner: focalOwner.uri,
      focalLeaves: focalCut.attachedChildren,
      rawDetail20: pressureSample.diagnostics.rawErrorTarget,
      peripheralPressureScale: pressureSample.diagnostics.peripheralPressureScale,
      peakCacheMiB,
      hardCacheMiB: pressureSample.diagnostics.cache.maxMiB,
      cachedFineAtPressure: pressureSample.cachedFine,
      attachedFineAtPressure: pressureSample.attachedFine,
      maximumBlockedMs,
    }));
    await client.evaluate(`window.__restoreProductionWeights?.()`);
  } finally {
    if (client) {
      await client.command('Page.close', {}, 2_000).catch(() => {});
      client.close();
    }
    if (browser) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
    }
    if (server) await new Promise(resolve => server.close(resolve));
    if (vite) await vite.close();
    rmSync(tileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    releaseLock();
    await removeBrowserProfile(profile);
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
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
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
    await removeBrowserProfile(profile);
  }
});

test('browser decodes Obj2Tiles KTX2 B3DM textures through the production tile path', { timeout: 90_000 }, async (t) => {
  const executable = browserPath();
  if (!executable) {
    t.skip('Chrome or Edge is required for KTX2 browser acceptance.');
    return;
  }

  const releaseLock = await acquireBrowserHarnessLock({ root });
  let browser, profile, server, vite, client;
  try {
    const fixture = await startFixture(path.join(root, 'test', 'fixtures', 'ktx2-tiles'));
    ({ server, vite } = fixture);
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-ktx2-browser-'));
    const devToolsPort = await reserveDevToolsPort();
    browser = spawn(executable, [
      '--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${profile}`, 'about:blank',
    ], { stdio: 'ignore' });
    const devTools = await waitForDevTools(devToolsPort, browser);
    const target = await (await fetch(`${devTools}/json/new?about:blank`, { method: 'PUT' })).json();
    client = await CdpClient.connect(target.webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');
    await client.command('Log.enable');
    await client.command('Network.enable');
    await client.command('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
      screenWidth: 1440, screenHeight: 900,
    });
    await client.command('Page.navigate', { url: `${fixture.origin}/?project=${fixtureId}` });
    try { await waitFor(client, `(() => {
      const tiles = window.__ltds?.tiles?.();
      if (!tiles?.root || !tiles.group.children.length) return false;
      let maps = 0;
      tiles.group.traverse(object => {
        const materials = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
        for (const material of materials) if (material.map?.image) maps += 1;
      });
      return maps > 0;
    })()`, 'KTX2 tile texture did not decode and attach', 60_000); } catch (error) {
      const runtime = await client.evaluate(`({
        status: document.querySelector('#lod-status')?.textContent,
        diagnostics: window.__ltds?.lodDiagnostics?.(),
        root: Boolean(window.__ltds?.tiles?.()?.root),
        groupChildren: window.__ltds?.tiles?.()?.group?.children?.length,
      })`);
      const errors = client.events.filter(event => event.method === 'Log.entryAdded'
        || event.method === 'Runtime.exceptionThrown' || event.method === 'Runtime.consoleAPICalled').slice(-20);
      throw new Error(`${error.message}; runtime=${JSON.stringify(runtime)}; events=${JSON.stringify(errors)}`);
    }

    const state = await client.evaluate(`(() => {
      const tiles = window.__ltds.tiles();
      const maps = [];
      tiles.group.traverse(object => {
        const materials = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
        for (const material of materials) if (material.map) maps.push({
          compressed: Boolean(material.map.isCompressedTexture),
          width: material.map.image?.width || 0,
          height: material.map.image?.height || 0,
        });
      });
      return {
        maps,
        errorPanel: getComputedStyle(document.querySelector('#error-panel')).display,
        cacheBytes: tiles.lruCache.cachedBytes,
      };
    })()`);
    assert.equal(state.errorPanel, 'none');
    assert.ok(state.maps.length > 0, JSON.stringify(state));
    assert.equal(state.maps.every(map => map.compressed && map.width > 0 && map.height > 0), true, JSON.stringify(state));
    assert.ok(state.cacheBytes > 0, JSON.stringify(state));
    const exceptions = client.events.filter(event => event.method === 'Runtime.exceptionThrown'
      && !event.params.exceptionDetails?.url?.includes('/@vite/client'));
    assert.deepEqual(exceptions, []);
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
    await removeBrowserProfile(profile);
  }
});
