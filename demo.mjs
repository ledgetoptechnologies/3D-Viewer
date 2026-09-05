import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { EarthLikeControls } from './earth-controls.js';
import { configureLodRenderer, detailToErrorTarget } from './lod-policy.mjs';
import { installLodKtx2Support } from './lod-ktx2.mjs';
import { installLodLoadingBudget } from './lod-loading-budget.mjs';
import { installLodAdmissionThrottle } from './lod-admission-throttle.mjs';
import { installLodResourceLifecycle } from './lod-resource-lifecycle.mjs';
import { FIXTURE_SHA256, DEMO_CATALOG, fixturePath, syntheticCloud } from './fixture-policy.mjs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
const viewport = document.querySelector('#viewport');
const status = document.querySelector('#status');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#111418');
const camera = new THREE.PerspectiveCamera(55, 1, 0.01, 100);
const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.06;
let tiles, cloud, decoder, lifecycle, budget, admission;
let rootShown = false, rootFrames = 0, startupFrames = 0, lastTime = performance.now(), fatal = null;
const controls = new EarthLikeControls(camera, renderer.domElement, {
  minDistance: 0.08, maxDistance: 30,
  surfacePick(ndc) {
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(cloud || tiles?.group || scene, true);
    return hits[0]?.point || null;
  }
});
function resetView() { controls.setView(new THREE.Vector3(2.8, 3.2, 3.8), new THREE.Vector3()); }
function fail(error) { fatal = error.message; status.textContent = `Demo stopped: ${fatal}`; }
async function verifiedFetch(url, options) {
  const name = fixturePath(url, location.origin);
  const response = await fetch(name, options);
  if (!response.ok) throw new Error(`Synthetic fixture request failed (${response.status})`);
  const bytes = await response.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
  if (digest !== FIXTURE_SHA256[name]) throw new Error('Synthetic fixture integrity check failed');
  return new Response(bytes, { headers: response.headers });
}
function disposeView() {
  if (tiles) {
    scene.remove(tiles.group);
    tiles.dispose();
    lifecycle.dispose(); budget.dispose(); admission.dispose(); decoder.dispose();
    tiles = null; lifecycle = null; budget = null; admission = null; decoder = null;
  }
  if (cloud) { scene.remove(cloud); cloud.geometry.dispose(); cloud.material.dispose(); cloud = null; }
}
function loadMode() {
  disposeView(); fatal = null; rootShown = false; rootFrames = 0; startupFrames = 0;
  if (document.querySelector('#mode').value === 'cloud') {
    const data = syntheticCloud();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    geometry.computeBoundingSphere();
    cloud = new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.035, vertexColors: true, sizeAttenuation: true }));
    scene.add(cloud);
  } else {
    tiles = new TilesRenderer(DEMO_CATALOG[0].tileset);
    // This synthetic plane's glTF vertices are XZ with a -Y front normal.
    // B3DM's Y-up correction first rotates it into the authored XY bound.
    // Rotate that complete tile frame +90 degrees into our Y-up display:
    // both bounds and geometry become horizontal, with their front facing up.
    tiles.group.rotation.x = Math.PI / 2;
    tiles.fetchData = verifiedFetch;
    configureLodRenderer(tiles, {
      camera, renderer,
      detail: Number(document.querySelector('#detail').value),
      memoryProfile: document.querySelector('#memory').value,
      deviceMemoryGiB: navigator.deviceMemory,
      interactionStateProvider: () => controls.getInteractionState()
    });
    tiles.__ltdsDistanceDemand = { enabled: true };
    // The synthetic hierarchy has just one child: show its root for two frames,
    // then use normal strict REPLACE traversal. No production audit is bypassed.
    tiles.maxDepth = 1;
    decoder = installLodKtx2Support(tiles, renderer);
    lifecycle = installLodResourceLifecycle(tiles);
    admission = installLodAdmissionThrottle(tiles);
    budget = installLodLoadingBudget(tiles);
    tiles.addEventListener('load-error', event => fail(event.error || new Error('Fixture failed to load')));
    tiles.addEventListener('load-model', ({ scene: tileScene }) => {
      let textured = false;
      tileScene.traverse(mesh => {
        for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
          if (material?.map) textured = true;
        }
      });
      if (!textured) fail(new Error('Synthetic KTX2 texture did not decode; check browser console and graphics support'));
    });
    scene.add(tiles.group);
  }
  resetView(); resize();
}
function resize() {
  const width = viewport.clientWidth, height = viewport.clientHeight;
  renderer.setSize(width, height);
  camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix();
  tiles?.setResolutionFromRenderer(camera, renderer);
}
function snapshot() {
  const visible = tiles ? [...tiles.visibleTiles] : [];
  const textureFormats = new Set();
  for (const tile of visible) tile.engineData.scene?.traverse(mesh => {
    for (const material of (Array.isArray(mesh.material) ? mesh.material : [mesh.material])) {
      if (material?.map) textureFormats.add(`${material.map.isCompressedTexture ? 'compressed' : 'uncompressed'}:${material.map.format}`);
    }
  });
  return { mode: cloud ? 'cloud' : 'mesh', ready: !!cloud || visible.length > 0, rootShown,
    visibleTiles: visible.length, textureFormats: [...textureFormats],
    cacheBytes: tiles?.lruCache.cachedBytes || 0, loading: budget?.snapshot?.() || null,
    points: cloud?.geometry.attributes.position.count || 0, error: fatal,
    camera: camera.position.toArray(), rawTarget: tiles?.errorTarget || null };
}
// Read-only, non-sensitive browser QA diagnostics. No tokens or project data.
window.demoSnapshot = snapshot;
renderer.setAnimationLoop(now => {
  const dt = Math.min((now - lastTime) / 1000, 0.1); lastTime = now;
  controls.update(dt); camera.updateMatrixWorld();
  if (tiles && !fatal) {
    tiles.update(); lifecycle.drainBVH();
    if (tiles.root && tiles.visibleTiles.has(tiles.root)) { rootShown = true; rootFrames++; }
    if (rootFrames >= 2) tiles.maxDepth = Infinity;
    if (++startupFrames > 3600 && !rootShown) fail(new Error('Synthetic root did not become visible'));
  }
  renderer.render(scene, camera);
  status.dataset.diagnostics = JSON.stringify(snapshot());
  if (!fatal) {
    const state = snapshot();
    status.textContent = cloud ? `${state.points.toLocaleString()} synthetic points · same camera controls as mesh`
      : `${state.visibleTiles} visible tile(s) · ${(state.cacheBytes / 1048576).toFixed(2)} MiB tracked tile cache · SSE ${state.rawTarget?.toFixed(3)} · ${state.textureFormats.join(', ') || 'Loading compressed textures…'}`;
  }
});
document.querySelector('#home').addEventListener('click', resetView);
document.querySelector('#mode').addEventListener('change', loadMode);
document.querySelector('#memory').addEventListener('change', loadMode);
document.querySelector('#detail').addEventListener('input', event => {
  document.querySelector('#detail-value').value = event.target.value;
  if (tiles) tiles.errorTarget = detailToErrorTarget(navigator.deviceMemory <= 4 ? Math.min(13, Number(event.target.value)) : Number(event.target.value));
});
window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => { renderer.setAnimationLoop(null); disposeView(); controls.dispose(); renderer.dispose(); });
loadMode();
