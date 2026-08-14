import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { EarthLikeControls } from './earth-controls.js';

// BVH-accelerated raycasting (critical for pivot picking on huge meshes)
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ───────────────────────────────────────────────────────────────
// Data endpoints
// ───────────────────────────────────────────────────────────────
const LOCAL_BASE = 'http://192.168.60.92:8081';
const SMB_BASE   = 'http://192.168.60.92:8082';
const PHOTO_BASE = 'http://192.168.60.92:8083';

const GLB_URL    = `${LOCAL_BASE}/models/odm_textured_model_geo.glb`;
const TILES_URL  = `${LOCAL_BASE}/3d-tiles/tileset.json`;
const SHOTS_URL  = `${SMB_BASE}/odm_report/shots.geojson`;
const ORTHO_URL  = `${SMB_BASE}/odm_orthophoto/odm_orthophoto.tif`;
const DSM_URL    = `${SMB_BASE}/odm_dem/dsm.tif`;
const DTM_URL    = `${SMB_BASE}/odm_dem/dtm.tif`;

// ───────────────────────────────────────────────────────────────
// Georeferencing (WebODM: coords.txt / CESIUM_RTC center)
// Local model coords are Z-up meters relative to RTC (UTM 16N).
// ───────────────────────────────────────────────────────────────
const RTC = { e: 367257, n: 4759982, z: 0 };
// Center of the local model bounding box (from the OBJ/GLB vertex range)
const C = {
  x: (-138.653305 + 116.656517) / 2,   // -10.998394
  y: (-240.065369 + 178.883759) / 2,   // -30.590805
  z: (164.319672 + 240.427872) / 2     // 202.373772
};

const METERS_TO_FT = 3.28084;
const UTM_ZONE_LON0 = -87 * Math.PI / 180;   // zone 16N

// world (three.js Y-up, model centered at origin) <-> UTM
function worldToUtm(p) {
  return {
    e: p.x + C.x + RTC.e,
    n: -p.z + C.y + RTC.n,
    alt: p.y + C.z + RTC.z
  };
}

function utmToWorld(e, n, alt) {
  return new THREE.Vector3(
    e - RTC.e - C.x,
    alt - RTC.z - C.z,
    -(n - RTC.n - C.y)
  );
}

// ───────────────────────────────────────────────────────────────
// DOM refs
// ───────────────────────────────────────────────────────────────
const dom = {};
['loading-overlay','loading-text','loading-progress','error-panel','error-message',
 'three-container','leaflet-map','cloud-container','fps','mem-display','coords',
 'mode-status','cloud-status','tris-status','lod-status','measure-output','dem-legend',
 'dem-hover','legend-canvas','dem-legend-labels','photo-modal','photo-img','photo-title',
 'photo-meta','photo-close','photo-download','photo-spinner','cam-tooltip','labels-container',
 'dem-settings','dem-colormap','dem-shading','dem-min','dem-max'
].forEach(id => { dom[id.replace(/-([a-z])/g, (m,c)=>c.toUpperCase())] = document.getElementById(id); });

const state = {
  activeMode: 'model',
  glbLoaded: false, glbLoading: false,
  camerasLoaded: false, camerasLoading: false, camerasVisible: false,
  activeTool: 'none',
  measure: null,           // in-progress measurement
  measurements: [],        // finished measurements
  pcIframeLoaded: false
};

let scene, camera, renderer, labelRenderer, controls, clock;
let glbParent, glbOffset, tilesParent;
let tilesRenderer = null;
let camGroupParent, camInstances = null, camFeatures = [];
let raycaster, hoverRaycaster;
let map, orthoLayers = null, demLayers = { dsm: null, dtm: null };
let mapViews = {};            // per-tab map center/zoom retention
// WebODM-style DEM rendering settings (shared by DSM/DTM, like WebODM's layer panel)
const demSettings = {
  cmap: 'viridis',
  shade: 1.0,          // hillshade intensity 0..2
  minFt: null,         // null = auto from data
  maxFt: null
};
let geoDatasets = {};        // url -> { tiff, images[], ... }
let geoPool = null;
let lastFps = performance.now(), frames = 0;
let bvhQueue = [];
let homeView = null;

init();

function init() {
  initThree();
  bindUI();
  loadTiles();          // LOD tiles are the default mesh
  loadCameras();        // prepare camera positions (hidden until toggled)
  startLoop();
}

// ───────────────────────────────────────────────────────────────
// THREE setup
// ───────────────────────────────────────────────────────────────
function initThree() {
  dom.threeContainer.style.display = 'block';
  const rect = dom.threeContainer.getBoundingClientRect();

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050505);

  camera = new THREE.PerspectiveCamera(60, rect.width / rect.height, 0.05, 60000);
  camera.position.set(0, 260, 320);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(rect.width, rect.height);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  dom.threeContainer.appendChild(renderer.domElement);

  labelRenderer = new CSS2DRenderer({ element: dom.labelsContainer });
  labelRenderer.setSize(rect.width, rect.height);

  clock = new THREE.Clock();
  raycaster = new THREE.Raycaster();
  raycaster.firstHitOnly = true;
  hoverRaycaster = new THREE.Raycaster();
  hoverRaycaster.firstHitOnly = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  const sun = new THREE.DirectionalLight(0xffffff, 1.35);
  sun.position.set(150, 300, 120);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35);
  fill.position.set(-120, 180, -150);
  scene.add(fill);

  // GLB frame: rotate Z-up -> Y-up, then center offset
  glbParent = new THREE.Group();
  glbParent.rotation.x = -Math.PI / 2;
  glbOffset = new THREE.Group();
  glbOffset.position.set(-C.x, -C.y, -C.z);
  glbParent.add(glbOffset);
  glbParent.visible = false;
  scene.add(glbParent);

  // 3D Tiles frame: renderer already applied its own up-axis correction;
  // content lands in (x, -z, y). A pi X-rotation + offset aligns with GLB world.
  tilesParent = new THREE.Group();
  tilesParent.rotation.x = Math.PI;
  tilesParent.position.set(-C.x, -C.z, C.y);
  scene.add(tilesParent);

  // Cameras share the GLB frame
  camGroupParent = new THREE.Group();
  camGroupParent.rotation.x = -Math.PI / 2;
  const camOffset = new THREE.Group();
  camOffset.name = 'camOffset';
  camOffset.position.set(-C.x, -C.y, -C.z);
  camGroupParent.add(camOffset);
  camGroupParent.visible = false;
  scene.add(camGroupParent);

  controls = new EarthLikeControls(camera, renderer.domElement, {
    surfacePick: pickSurface,
    minPolar: 0.02,
    maxPolar: Math.PI - 0.03,      // full range: orbit under the model like WebODM
    fallbackPlaneY: 18,            // ~avg terrain height in world frame
    minDistance: 0.4,
    maxDistance: 6000
  });
  scene.add(controls.pivotIndicator);

  renderer.domElement.addEventListener('pointerup', onPointerUp);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.domElement.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);
}

function onResize() {
  const rect = dom.threeContainer.getBoundingClientRect();
  if (rect.width > 0) {
    camera.aspect = rect.width / rect.height;
    camera.updateProjectionMatrix();
    renderer.setSize(rect.width, rect.height);
    labelRenderer.setSize(rect.width, rect.height);
  }
  if (map) setTimeout(() => map.invalidateSize(), 80);
}

// Raycast pick against whichever mesh layers are visible
function pickSurface(ndc) {
  raycaster.setFromCamera(ndc, camera);
  const targets = [];
  if (tilesParent.visible && tilesRenderer) targets.push(tilesRenderer.group);
  if (glbParent.visible) targets.push(glbOffset);
  if (!targets.length) return null;
  const hits = raycaster.intersectObjects(targets, true);
  return hits.length ? hits[0].point : null;
}

function queueBVH(mesh) {
  if (!mesh.geometry || mesh.geometry.boundsTree) return;
  bvhQueue.push(mesh);
}
function drainBVH() {
  if (!bvhQueue.length) return;
  const mesh = bvhQueue.shift();
  if (mesh.geometry && !mesh.geometry.boundsTree) {
    try { mesh.geometry.computeBoundsTree(); } catch (e) { /* non-indexed edge case */ }
  }
}

// ───────────────────────────────────────────────────────────────
// 3D Tiles (default LOD mesh — streams low-res far, full-res close)
// ───────────────────────────────────────────────────────────────
function loadTiles() {
  if (tilesRenderer) return;
  updateLoading('Streaming LOD tiles...', '');
  tilesRenderer = new TilesRenderer(TILES_URL);
  tilesRenderer.setCamera(camera);
  tilesRenderer.setResolutionFromRenderer(camera, renderer);
  const detailSlider = document.getElementById('lod-detail');
  tilesRenderer.errorTarget = detailSlider ? 26 - parseInt(detailSlider.value, 10) : 6;
  // REPLACE refinement stalls if the byte cache can't hold parent + all
  // children simultaneously (16 x ~25MB decoded textures > default 0.4GB).
  tilesRenderer.lruCache.minBytesSize = 1.5 * 1024 * 1024 * 1024;
  tilesRenderer.lruCache.maxBytesSize = 2.5 * 1024 * 1024 * 1024;
  tilesRenderer.lruCache.minSize = 600;
  tilesRenderer.lruCache.maxSize = 800;

  tilesRenderer.addEventListener('load-tileset', () => {
    hideLoading();
    if (!homeView) {
      setHomeView();
      controls.setView(homeView.position, homeView.lookAt);
    }
  });
  tilesRenderer.addEventListener('load-model', (ev) => {
    ev.scene.traverse((c) => {
      if (c.isMesh) {
        // B3DM tiles come in as PBR (metalness=1) and render black without an
        // environment map. Convert to unlit like the GLB (KHR_materials_unlit).
        // FrontSide (backface culling) matches WebODM: from below, the ground
        // is see-through so you can inspect undersides of structures.
        const old = c.material;
        const map = old.map || null;
        if (map) map.colorSpace = THREE.SRGBColorSpace;
        c.material = new THREE.MeshBasicMaterial({ map, side: THREE.FrontSide });
        c.material.toneMapped = false;
        if (old.dispose) old.dispose();
        queueBVH(c);
      }
    });
  });
  tilesRenderer.addEventListener('load-error', (ev) => {
    console.error('Tiles load error', ev);
  });
  tilesParent.add(tilesRenderer.group);
}

// Free ~2.5GB of decoded tile textures/geometry. Needed before the 898MB GLB
// Draco decode: cache + decode together OOM'd the renderer (heap hit 2.7GB).
function disposeTiles() {
  if (!tilesRenderer) return;
  tilesParent.remove(tilesRenderer.group);
  tilesRenderer.dispose();
  tilesRenderer = null;
}

function setHomeView() {
  // model spans roughly x -128..128, z -210..210 world; hover SE at 45deg
  const target = new THREE.Vector3(0, 18, 0);
  const dist = 420;
  homeView = {
    position: new THREE.Vector3(target.x, target.y + dist * 0.72, target.z + dist),
    lookAt: target
  };
}

function resetCamera() {
  if (!homeView) setHomeView();
  controls.setView(homeView.position, homeView.lookAt);
}

function topDownView() {
  controls.setView(new THREE.Vector3(0, 560, 0.01), new THREE.Vector3(0, 18, 0));
}

// ───────────────────────────────────────────────────────────────
// Full-res GLB (on demand)
// ───────────────────────────────────────────────────────────────
function loadGLB() {
  if (state.glbLoaded) { glbParent.visible = true; return; }
  if (state.glbLoading) return;
  state.glbLoading = true;
  // Free the ~2.5GB tile cache BEFORE the 898MB Draco decode — both at once
  // OOM-killed the renderer process (observed heap ~2.7GB at crash).
  disposeTiles();
  tilesParent.visible = false;
  updateLoading('Loading full-resolution Draco mesh...', '0%');

  const draco = new DRACOLoader();
  draco.setDecoderPath('/draco/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  loader.load(GLB_URL, (gltf) => {
    gltf.scene.traverse((child) => {
      if (child.isMesh) {
        child.material.side = THREE.FrontSide;   // WebODM-style see-through from below
        if (child.material.map) child.material.map.colorSpace = THREE.SRGBColorSpace;
        queueBVH(child);
      }
    });
    glbOffset.add(gltf.scene);
    state.glbLoaded = true;
    state.glbLoading = false;
    applyMeshLayer();
    hideLoading();
  }, (xhr) => {
    if (xhr.total) {
      const pct = ((xhr.loaded / xhr.total) * 100).toFixed(0);
      updateLoading('Loading full-resolution Draco mesh...', `${pct}% (${(xhr.loaded / 1048576).toFixed(0)} MB)`);
    }
  }, (err) => {
    console.error('GLB load error', err);
    state.glbLoading = false;
    hideLoading();
    showError(`Failed to load full-res mesh from ${GLB_URL}.`);
    document.getElementById('layer-glb').classList.remove('active');
    document.getElementById('layer-tiles').classList.add('active');
    applyMeshLayer();   // rebuilds the disposed tiles renderer
  });
}

// ───────────────────────────────────────────────────────────────
// Camera positions (shots.geojson -> instanced frustums)
// ───────────────────────────────────────────────────────────────
function buildFrustumGeometry() {
  // Pyramid: apex at origin (camera center), base = image plane along +Z (view dir)
  const w = 0.55, h = 0.41, L = 0.72;
  const v = [
    0,0,0,  -w,-h,L,   w,-h,L,     // bottom
    0,0,0,   w,-h,L,   w, h,L,     // right
    0,0,0,   w, h,L,  -w, h,L,     // top
    0,0,0,  -w, h,L,  -w,-h,L,     // left
    -w,-h,L,  w,-h,L,  w,h,L,      // base 1
    -w,-h,L,  w,h,L,  -w,h,L       // base 2
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

async function loadCameras() {
  if (state.camerasLoaded || state.camerasLoading) return;
  state.camerasLoading = true;
  try {
    const res = await fetch(SHOTS_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const geojson = await res.json();
    camFeatures = geojson.features;

    const geo = buildFrustumGeometry();
    const mat = new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false
    });
    camInstances = new THREE.InstancedMesh(geo, mat, camFeatures.length);
    camInstances.frustumCulled = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const axis = new THREE.Vector3();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const baseScale = 1.0;   // WebODM-like small markers; user adjusts via slider
    const orange = new THREE.Color(0xEE5007);

    camFeatures.forEach((feat, i) => {
      const t = feat.properties.translation;
      const r = feat.properties.rotation;
      const angle = Math.sqrt(r[0]*r[0] + r[1]*r[1] + r[2]*r[2]);
      if (angle > 1e-9) axis.set(-r[0]/angle, -r[1]/angle, -r[2]/angle);
      else axis.set(0, 0, 1);
      q.setFromAxisAngle(axis, angle);
      pos.set(t[0] - RTC.e, t[1] - RTC.n, t[2] - RTC.z);
      scl.setScalar(baseScale);
      m.compose(pos, q, scl);
      camInstances.setMatrixAt(i, m);
      camInstances.setColorAt(i, orange);
    });
    camInstances.instanceMatrix.needsUpdate = true;
    camInstances.instanceColor.needsUpdate = true;
    camGroupParent.getObjectByName('camOffset').add(camInstances);
    state.camerasLoaded = true;
    window.__ltdsCams = camFeatures.length;
  } catch (err) {
    console.error('Camera shots load failed', err);
  } finally {
    state.camerasLoading = false;
  }
}

function setCameraScale(s) {
  if (!camInstances) return;
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), old = new THREE.Vector3();
  for (let i = 0; i < camInstances.count; i++) {
    camInstances.getMatrixAt(i, m);
    m.decompose(p, q, old);
    m.compose(p, q, new THREE.Vector3(s, s, s));
    camInstances.setMatrixAt(i, m);
  }
  camInstances.instanceMatrix.needsUpdate = true;
}

let hoveredCam = -1;
let camWorldPos = null;   // Float32Array of instance world positions (lazy)

function ensureCamWorldPositions() {
  if (camWorldPos || !camInstances) return;
  camInstances.updateMatrixWorld(true);
  const n = camInstances.count;
  camWorldPos = new Float32Array(n * 3);
  const a = camInstances.instanceMatrix.array;
  const mw = camInstances.matrixWorld.elements;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const ix = a[o + 12], iy = a[o + 13], iz = a[o + 14];
    camWorldPos[i*3]   = mw[0]*ix + mw[4]*iy + mw[8]*iz  + mw[12];
    camWorldPos[i*3+1] = mw[1]*ix + mw[5]*iy + mw[9]*iz  + mw[13];
    camWorldPos[i*3+2] = mw[2]*ix + mw[6]*iy + mw[10]*iz + mw[14];
  }
}

function pickCameraInstance(ndc) {
  if (!state.camerasVisible || !camInstances) return -1;
  hoverRaycaster.setFromCamera(ndc, camera);
  const hits = hoverRaycaster.intersectObject(camInstances, false);
  if (hits.length) return hits[0].instanceId;

  // Fallback: markers can be a few pixels at default size — pick the nearest
  // instance whose projection is within ~12 px of the cursor.
  ensureCamWorldPositions();
  if (!camWorldPos) return -1;
  const rect = renderer.domElement.getBoundingClientRect();
  const pm = camera.projectionMatrix.elements;
  const vm = camera.matrixWorldInverse.elements;
  const thresholdNdcX = (24 / rect.width);    // ~12px radius in NDC
  const thresholdNdcY = (24 / rect.height);
  let best = -1, bestD = Infinity;
  for (let i = 0; i < camInstances.count; i++) {
    const wx = camWorldPos[i*3], wy = camWorldPos[i*3+1], wz = camWorldPos[i*3+2];
    const vx = vm[0]*wx + vm[4]*wy + vm[8]*wz  + vm[12];
    const vy = vm[1]*wx + vm[5]*wy + vm[9]*wz  + vm[13];
    const vz = vm[2]*wx + vm[6]*wy + vm[10]*wz + vm[14];
    const cx = pm[0]*vx + pm[4]*vy + pm[8]*vz  + pm[12];
    const cy = pm[1]*vx + pm[5]*vy + pm[9]*vz  + pm[13];
    const cw = pm[3]*vx + pm[7]*vy + pm[11]*vz + pm[15];
    if (cw <= 0) continue;
    const dx = (cx / cw - ndc.x) / thresholdNdcX;
    const dy = (cy / cw - ndc.y) / thresholdNdcY;
    const d = dx*dx + dy*dy;
    if (d < 1 && d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function highlightCam(idx) {
  if (!camInstances) return;
  const orange = new THREE.Color(0xEE5007);
  const gold = new THREE.Color(0xF8CB2E);
  if (hoveredCam >= 0 && hoveredCam !== idx) camInstances.setColorAt(hoveredCam, orange);
  if (idx >= 0) camInstances.setColorAt(idx, gold);
  camInstances.instanceColor.needsUpdate = true;
  hoveredCam = idx;
}

// Photo modal zoom/pan state (WebODM-style image inspection)
const photoView = { scale: 1, tx: 0, ty: 0, dragging: false, sx: 0, sy: 0, stx: 0, sty: 0, moved: false };

function applyPhotoTransform() {
  dom.photoImg.style.transform = `translate(${photoView.tx}px, ${photoView.ty}px) scale(${photoView.scale})`;
}

function resetPhotoView() {
  photoView.scale = 1; photoView.tx = 0; photoView.ty = 0;
  applyPhotoTransform();
}

function openPhoto(idx) {
  const feat = camFeatures[idx];
  if (!feat) return;
  resetPhotoView();
  const fn = feat.properties.filename;
  const url = `${PHOTO_BASE}/${encodeURIComponent(fn)}`;
  const altFt = Math.round((feat.geometry?.coordinates?.[2] || 0) * METERS_TO_FT);
  const time = feat.properties.capture_time
    ? new Date(feat.properties.capture_time * 1000).toLocaleString()
    : '';
  dom.photoTitle.textContent = fn;
  dom.photoMeta.textContent = `Altitude ${altFt} ft MSL${time ? '  ·  ' + time : ''}`;
  dom.photoSpinner.style.display = 'block';
  dom.photoImg.style.opacity = '0';
  dom.photoImg.onload = () => {
    dom.photoSpinner.style.display = 'none';
    dom.photoImg.style.opacity = '1';
  };
  dom.photoImg.onerror = () => {
    dom.photoSpinner.style.display = 'none';
    dom.photoMeta.textContent = 'Photo not available — original images not served yet.';
  };
  dom.photoImg.src = url;
  dom.photoDownload.href = url;
  dom.photoDownload.download = fn;
  dom.photoModal.style.display = 'flex';
}

function closePhoto() {
  dom.photoModal.style.display = 'none';
  dom.photoImg.src = '';
  resetPhotoView();
}

function bindPhotoViewer() {
  const wrap = document.getElementById('photo-imgwrap');

  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = dom.photoImg.getBoundingClientRect();
    const prev = photoView.scale;
    const factor = Math.pow(0.9, e.deltaY / 100);
    const next = Math.min(40, Math.max(1, prev * factor));
    if (next === prev) return;
    // zoom toward the cursor: keep the image point under the mouse fixed.
    // rect is the TRANSFORMED box, so its center = layout center + (tx, ty);
    // cursor offset from that transformed center works out to tx += cx*(1-k).
    const k = next / prev;
    const cx = e.clientX - (rect.left + rect.width / 2);
    const cy = e.clientY - (rect.top + rect.height / 2);
    photoView.scale = next;
    photoView.tx += cx * (1 - k);
    photoView.ty += cy * (1 - k);
    if (photoView.scale === 1) { photoView.tx = 0; photoView.ty = 0; }
    applyPhotoTransform();
  }, { passive: false });

  wrap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    photoView.dragging = true;
    photoView.moved = false;
    photoView.sx = e.clientX; photoView.sy = e.clientY;
    photoView.stx = photoView.tx; photoView.sty = photoView.ty;
    wrap.setPointerCapture?.(e.pointerId);
    dom.photoImg.style.cursor = 'grabbing';
    e.preventDefault();
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!photoView.dragging) return;
    const dx = e.clientX - photoView.sx;
    const dy = e.clientY - photoView.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) photoView.moved = true;
    photoView.tx = photoView.stx + dx;
    photoView.ty = photoView.sty + dy;
    applyPhotoTransform();
  });
  window.addEventListener('pointerup', () => {
    photoView.dragging = false;
    dom.photoImg.style.cursor = '';
  });
  wrap.addEventListener('dblclick', (e) => {
    e.preventDefault();
    resetPhotoView();
  });
}

// ───────────────────────────────────────────────────────────────
// Measurements (labels + escape + persistence)
// ───────────────────────────────────────────────────────────────
const measureRoot = new THREE.Group();

function initMeasureRoot() { scene.add(measureRoot); }
initMeasureRoot();

function makeLabel(text, cls = 'mlabel') {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  const obj = new CSS2DObject(div);
  obj.center.set(0.5, 1.35);
  return obj;
}

function makeMarker(point) {
  const geo = new THREE.SphereGeometry(1, 20, 20);
  const mat = new THREE.MeshBasicMaterial({ color: 0xEE5007, depthTest: false, transparent: true, opacity: 0.95 });
  const mk = new THREE.Mesh(geo, mat);
  mk.position.copy(point);
  mk.userData.isMarker = true;
  mk.renderOrder = 999;
  return mk;
}

function lineMaterial() {
  return new THREE.LineBasicMaterial({ color: 0xF8CB2E, depthTest: false, transparent: true, opacity: 0.95 });
}

function setTool(tool) {
  if (tool === 'clear') { clearAllMeasurements(); tool = 'none'; }
  if (state.measure) cancelActiveMeasure();
  state.activeTool = tool;
  document.querySelectorAll('#panel-measure .tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  renderer.domElement.classList.toggle('measuring', tool !== 'none');
  if (tool !== 'none') {
    state.measure = {
      tool, points: [], markers: [], group: new THREE.Group(),
      line: null, previewLine: null, previewLabel: null, labels: []
    };
    measureRoot.add(state.measure.group);
    setMeasureHint();
  } else {
    dom.measureOutput.textContent = '';
  }
}

function setMeasureHint() {
  const m = state.measure;
  if (!m) return;
  const n = m.points.length;
  if (m.tool === 'distance') {
    dom.measureOutput.textContent = n === 0
      ? 'Click the first point on the model.'
      : 'Click the second point. Esc or right-click cancels.';
  } else {
    dom.measureOutput.textContent = n < 3
      ? `Click to add points (${n} placed, need 3+). Esc/right-click cancels.`
      : `${n} points placed. Double-click, Enter, or right-click to finish.`;
  }
}

function addMeasurePoint(point) {
  const m = state.measure;
  if (!m) return;
  // ignore duplicate clicks (double-click finish fires two pointerups)
  if (m.points.length) {
    const last = m.points[m.points.length - 1];
    if (last.distanceTo(point) < 0.02) return;
  }
  m.points.push(point.clone());
  const mk = makeMarker(point);
  m.group.add(mk);
  m.markers.push(mk);

  if (m.tool === 'distance' && m.points.length === 2) { finishMeasure(); return; }
  redrawActiveMeasure();
  setMeasureHint();
}

function redrawActiveMeasure(cursorPoint = null) {
  const m = state.measure;
  if (!m) return;
  // main polyline
  if (m.line) { m.group.remove(m.line); m.line.geometry.dispose(); }
  m.line = null;
  if (m.points.length >= 2) {
    const pts = m.points.slice();
    if ((m.tool === 'area' || m.tool === 'volume') && pts.length > 2) pts.push(pts[0]);
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    m.line = new THREE.Line(g, lineMaterial());
    m.line.renderOrder = 998;
    m.group.add(m.line);
  }
  // rubber-band preview to the cursor
  if (m.previewLine) { m.group.remove(m.previewLine); m.previewLine.geometry.dispose(); m.previewLine = null; }
  if (m.previewLabel) { m.group.remove(m.previewLabel); m.previewLabel.element.remove(); m.previewLabel = null; }
  if (cursorPoint && m.points.length >= 1) {
    const last = m.points[m.points.length - 1];
    const g = new THREE.BufferGeometry().setFromPoints([last, cursorPoint]);
    m.previewLine = new THREE.Line(g, new THREE.LineDashedMaterial({
      color: 0xffffff, dashSize: 1.2, gapSize: 0.8, depthTest: false, transparent: true, opacity: 0.7
    }));
    m.previewLine.computeLineDistances();
    m.previewLine.renderOrder = 998;
    m.group.add(m.previewLine);
    const segFt = last.distanceTo(cursorPoint) * METERS_TO_FT;
    m.previewLabel = makeLabel(formatFtIn(segFt), 'mlabel preview');
    m.previewLabel.position.copy(new THREE.Vector3().addVectors(last, cursorPoint).multiplyScalar(0.5));
    m.group.add(m.previewLabel);
  }
}

function finishMeasure() {
  const m = state.measure;
  if (!m) return;
  const need = m.tool === 'distance' ? 2 : 3;
  if (m.points.length < need) { cancelActiveMeasure(); setTool('none'); return; }

  if (m.previewLine) { m.group.remove(m.previewLine); m.previewLine.geometry.dispose(); m.previewLine = null; }
  if (m.previewLabel) { m.group.remove(m.previewLabel); m.previewLabel.element.remove(); m.previewLabel = null; }

  if (m.tool === 'distance') {
    const [a, b] = m.points;
    const distFt = a.distanceTo(b) * METERS_TO_FT;
    const horizFt = Math.hypot(a.x - b.x, a.z - b.z) * METERS_TO_FT;
    const vertFt = Math.abs(a.y - b.y) * METERS_TO_FT;
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(g, lineMaterial());
    line.renderOrder = 998;
    m.group.add(line);
    const label = makeLabel(formatFtIn(distFt));
    label.element.title = `Horizontal ${formatFtIn(horizFt)} · Vertical ${formatFtIn(vertFt)}`;
    label.position.copy(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
    m.group.add(label);
    m.labels.push(label);
    dom.measureOutput.innerHTML =
      `<b>Distance:</b> ${formatFtIn(distFt)}<br><span class="sub">Horizontal ${formatFtIn(horizFt)} · Vertical ${formatFtIn(vertFt)}</span>`;
  } else {
    // close the loop
    if (m.line) { m.group.remove(m.line); m.line.geometry.dispose(); m.line = null; }
    const loop = m.points.slice(); loop.push(loop[0]);
    const g = new THREE.BufferGeometry().setFromPoints(loop);
    const line = new THREE.Line(g, lineMaterial());
    line.renderOrder = 998;
    m.group.add(line);

    const fillGeom = triangulateShape(m.points);
    if (fillGeom) {
      const fill = new THREE.Mesh(fillGeom, new THREE.MeshBasicMaterial({
        color: 0xEE5007, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthTest: false
      }));
      fill.renderOrder = 997;
      m.group.add(fill);
    }
    const centroid = m.points.reduce((acc, p) => acc.add(p), new THREE.Vector3()).divideScalar(m.points.length);
    const areaM2 = polygonArea3D(m.points);
    const areaSqFt = areaM2 * METERS_TO_FT * METERS_TO_FT;

    if (m.tool === 'area') {
      const label = makeLabel(formatSqFt(areaSqFt));
      label.position.copy(centroid);
      m.group.add(label);
      m.labels.push(label);
      dom.measureOutput.innerHTML = `<b>Area:</b> ${formatSqFt(areaSqFt)}`;
    } else {
      const ys = m.points.map(p => p.y);
      const depthM = Math.max(...ys) - Math.min(...ys);
      const volCuFt = areaM2 * depthM * Math.pow(METERS_TO_FT, 3);
      const volCuYd = volCuFt / 27;
      const label = makeLabel(`≈ ${Math.round(volCuYd).toLocaleString()} cu yd`);
      label.position.copy(centroid);
      m.group.add(label);
      m.labels.push(label);
      dom.measureOutput.innerHTML =
        `<b>Volume (prism approx):</b> ≈ ${Math.round(volCuYd).toLocaleString()} cu yd<br><span class="sub">${Math.round(volCuFt).toLocaleString()} cu ft · base ${formatSqFt(areaSqFt)} · depth ${formatFtIn(depthM * METERS_TO_FT)}</span>`;
    }
  }

  state.measurements.push(m.group);
  state.measure = null;
  // auto-disarm: user must pick a tool again for the next measurement
  state.activeTool = 'none';
  document.querySelectorAll('#panel-measure .tool-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === 'none');
  });
  renderer.domElement.classList.remove('measuring');
}

function cancelActiveMeasure() {
  const m = state.measure;
  if (!m) return;
  measureRoot.remove(m.group);
  disposeGroup(m.group);
  state.measure = null;
  dom.measureOutput.textContent = '';
}

function clearAllMeasurements() {
  cancelActiveMeasure();
  state.measurements.forEach((g) => { measureRoot.remove(g); disposeGroup(g); });
  state.measurements = [];
  dom.measureOutput.textContent = '';
}

function disposeGroup(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
    if (o.isCSS2DObject && o.element?.parentNode) o.element.parentNode.removeChild(o.element);
  });
  group.clear();
}

function exitMeasureTool() {
  if (state.measure && state.measure.tool !== 'distance' && state.measure.points.length >= 3) {
    finishMeasure();   // finishMeasure disarms the tool and keeps the readout
  } else {
    cancelActiveMeasure();
    setTool('none');
  }
}

// geometry helpers
function triangulateShape(points) {
  if (points.length < 3) return null;
  const { origin, u, v } = fitPlane(points);
  const shapePts = points.map((p) => {
    const d = new THREE.Vector3().subVectors(p, origin);
    return new THREE.Vector2(d.dot(u), d.dot(v));
  });
  const geom = new THREE.ShapeGeometry(new THREE.Shape(shapePts));
  const pos = geom.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const p3 = new THREE.Vector3().copy(origin).addScaledVector(u, x).addScaledVector(v, y);
    pos.setXYZ(i, p3.x, p3.y, p3.z);
  }
  geom.computeVertexNormals();
  return geom;
}

function fitPlane(points) {
  const origin = points.reduce((a, b) => a.clone().add(b), new THREE.Vector3()).divideScalar(points.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const p of points) {
    const d = new THREE.Vector3().subVectors(p, origin);
    xx += d.x * d.x; xy += d.x * d.y; xz += d.x * d.z;
    yy += d.y * d.y; yz += d.y * d.z; zz += d.z * d.z;
  }
  const n = new THREE.Vector3(xy * yz - xz * yy, xz * xy - xx * yz, xx * yy - xy * xy);
  if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
  n.normalize();
  let u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(u.dot(n)) > 0.9) u.set(0, 1, 0);
  u.addScaledVector(n, -u.dot(n)).normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  return { origin, u, v };
}

function polygonArea3D(points) {
  if (points.length < 3) return 0;
  const { origin, u, v } = fitPlane(points);
  let area2 = 0;
  for (let i = 0; i < points.length; i++) {
    const p0 = points[i], p1 = points[(i + 1) % points.length];
    const d0 = new THREE.Vector3().subVectors(p0, origin);
    const d1 = new THREE.Vector3().subVectors(p1, origin);
    area2 += d0.dot(u) * d1.dot(v) - d1.dot(u) * d0.dot(v);
  }
  return Math.abs(area2) * 0.5;
}

function formatFtIn(totalFeet) {
  const totalInches = Math.round(totalFeet * 12);
  const ft = Math.floor(totalInches / 12);
  const inch = totalInches % 12;
  return `${ft}' ${inch}"`;
}
function formatSqFt(sqft) {
  if (sqft >= 43560) return `${(sqft / 43560).toFixed(2)} acres`;
  return `${Math.round(sqft).toLocaleString()} sq ft`;
}

// ───────────────────────────────────────────────────────────────
// Pointer routing (placement, camera clicks, hover)
// ───────────────────────────────────────────────────────────────
function eventNdc(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}

function onPointerUp(e) {
  if (state.activeMode !== 'model') return;
  if (!controls.wasClick()) return;

  const ndc = eventNdc(e);
  if (e.button === 2) {
    // right-click: finish or cancel the measurement in progress
    if (state.activeTool !== 'none') { exitMeasureTool(); }
    return;
  }
  if (e.button !== 0) return;

  if (state.activeTool !== 'none') {
    const hit = pickSurface(ndc);
    if (hit) addMeasurePoint(hit);
    return;
  }
  // camera marker click -> photo popup
  const camIdx = pickCameraInstance(ndc);
  if (camIdx >= 0) openPhoto(camIdx);
}

let lastHover = 0;
function onPointerMove(e) {
  if (state.activeMode !== 'model') return;
  const now = performance.now();
  if (now - lastHover < 70) return;
  lastHover = now;
  const ndc = eventNdc(e);

  // measurement rubber band
  if (state.measure && state.measure.points.length >= 1) {
    const hit = pickSurface(ndc);
    if (hit) redrawActiveMeasure(hit);
  }

  // statusbar coordinates under cursor
  const surf = (state.measure) ? null : pickSurface(ndc);
  if (surf) {
    const u = worldToUtm(surf);
    dom.coords.textContent = `E ${u.e.toFixed(1)}  N ${u.n.toFixed(1)}  El ${Math.round(u.alt * METERS_TO_FT)} ft`;
  }

  // camera hover
  if (state.camerasVisible && state.activeTool === 'none') {
    const idx = pickCameraInstance(ndc);
    highlightCam(idx);
    if (idx >= 0) {
      dom.camTooltip.textContent = camFeatures[idx].properties.filename;
      dom.camTooltip.style.display = 'block';
      dom.camTooltip.style.left = (e.clientX + 14) + 'px';
      dom.camTooltip.style.top = (e.clientY + 10) + 'px';
      renderer.domElement.style.cursor = 'pointer';
    } else {
      dom.camTooltip.style.display = 'none';
      renderer.domElement.style.cursor = '';
    }
  }
}

function onDoubleClick() {
  if (state.activeTool !== 'none' && state.measure && state.measure.points.length >= 3) {
    finishMeasure();
  }
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    if (dom.photoModal.style.display === 'flex') { closePhoto(); return; }
    if (state.activeTool !== 'none') { cancelActiveMeasure(); setTool('none'); }
  } else if (e.key === 'Enter') {
    if (state.measure && state.measure.points.length >= 3) finishMeasure();
  }
}

// ───────────────────────────────────────────────────────────────
// GeoTIFF streaming (ortho / DSM / DTM) — HTTP range reads
// ───────────────────────────────────────────────────────────────
function ensureMap() {
  if (map) return;
  dom.leafletMap.style.display = 'block';
  map = L.map(dom.leafletMap, { zoomControl: true, attributionControl: true, maxZoom: 24 });
  // Detail tiles must sit ABOVE the overview imageOverlay (overlayPane z=400).
  // Leaflet's default tilePane is z=200, which buried the hi-res tiles and
  // made zooming look like it never sharpened.
  map.createPane('gtiff');
  map.getPane('gtiff').style.zIndex = 450;
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles © Esri', maxZoom: 24, maxNativeZoom: 19
  }).addTo(map);
  map.setView([42.981, -88.628], 15);

  map.on('mousemove', (e) => {
    const ds = state.activeMode === 'dsm' ? geoDatasets[DSM_URL]
             : state.activeMode === 'dtm' ? geoDatasets[DTM_URL] : null;
    if (ds) showDemHover(e, ds); else dom.demHover.style.display = 'none';
  });
}

async function getDataset(url, isDem) {
  if (geoDatasets[url]) return geoDatasets[url];
  if (!geoPool) geoPool = new GeoTIFF.Pool(Math.min(4, navigator.hardwareConcurrency || 2));
  const tiff = await GeoTIFF.fromUrl(url, { allowFullFile: false, blockSize: 262144, cacheSize: 128 });
  const count = await tiff.getImageCount();
  const images = [];
  for (let i = 0; i < count; i++) images.push(await tiff.getImage(i));
  const image = images[0];
  const bbox = image.getBoundingBox();
  const [minE, minN, maxE, maxN] = bbox;
  const sw = utmToLatLon(minE, minN);
  const ne = utmToLatLon(maxE, maxN);
  const ds = {
    tiff, images, isDem,
    W: image.getWidth(), H: image.getHeight(),
    minE, minN, maxE, maxN,
    llBounds: [[sw[0], sw[1]], [ne[0], ne[1]]],
    nodata: parseFloat(image.fileDirectory?.GDAL_NODATA ?? 'NaN')
  };
  if (isDem) {
    // stats from the smallest overview
    const smallest = images[images.length - 1];
    const raster = await smallest.readRasters({ pool: geoPool });
    let min = Infinity, max = -Infinity;
    const band = raster[0];
    for (let i = 0; i < band.length; i++) {
      const v = band[i];
      if (isFinite(v) && v > -1000 && v < 10000 && v !== ds.nodata) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    ds.min = min; ds.max = max;
  }
  geoDatasets[url] = ds;
  return ds;
}

// Leaflet layer that reads GeoTIFF windows per tile (progressive sharpening)
const GeoTiffGridLayer = L.GridLayer.extend({
  initialize: function (ds, renderFn, options) {
    L.GridLayer.prototype.initialize.call(this, options);
    this.ds = ds;
    this.renderFn = renderFn;
  },
  createTile: function (coords, done) {
    const tile = document.createElement('canvas');
    const size = this.getTileSize();
    tile.width = size.x; tile.height = size.y;
    const ds = this.ds;

    const nw = this._map.unproject([coords.x * size.x, coords.y * size.y], coords.z);
    const se = this._map.unproject([(coords.x + 1) * size.x, (coords.y + 1) * size.y], coords.z);
    const [minE0, maxN0] = latLonToUtm(nw.lat, nw.lng);
    const [maxE0, minN0] = latLonToUtm(se.lat, se.lng);

    // full-res pixel window
    const pxPerM = ds.W / (ds.maxE - ds.minE);
    let sx = (minE0 - ds.minE) * pxPerM;
    let ex = (maxE0 - ds.minE) * pxPerM;
    let sy = (ds.maxN - maxN0) * (ds.H / (ds.maxN - ds.minN));
    let ey = (ds.maxN - minN0) * (ds.H / (ds.maxN - ds.minN));

    if (ex <= 0 || ey <= 0 || sx >= ds.W || sy >= ds.H) { setTimeout(() => done(null, tile), 0); return tile; }

    // choose overview level whose window is closest to 256px
    const winW = ex - sx;
    let level = Math.max(0, Math.min(ds.images.length - 1, Math.floor(Math.log2(winW / size.x))));
    const img = ds.images[level];
    const s = img.getWidth() / ds.W;

    const pad = this.ds.isDem ? 1 / s : 0;   // margin for hillshade neighbors
    const csx = Math.max(0, sx - pad), csy = Math.max(0, sy - pad);
    const cex = Math.min(ds.W, ex + pad), cey = Math.min(ds.H, ey + pad);

    const wsx = Math.floor(csx * s), wsy = Math.floor(csy * s);
    const wex = Math.min(img.getWidth(), Math.ceil(cex * s));
    const wey = Math.min(img.getHeight(), Math.ceil(cey * s));
    if (wex - wsx < 1 || wey - wsy < 1) { setTimeout(() => done(null, tile), 0); return tile; }

    // output raster size proportional to the clamped window
    const outW = Math.max(1, Math.round(size.x * (cex - csx) / winW));
    const outH = Math.max(1, Math.round(size.y * (cey - csy) / (ey - sy)));

    img.readRasters({
      window: [wsx, wsy, wex, wey],
      width: outW,
      height: outH,
      pool: geoPool,
      resampleMethod: ds.isDem ? 'nearest' : 'bilinear',
      interleave: false,
      fillValue: ds.isDem ? (isNaN(ds.nodata) ? -9999 : ds.nodata) : 0
    }).then((raster) => {
      const rw = raster.width, rh = raster.height;
      const cvs = this.renderFn(raster, rw, rh, ds);
      const ctx = tile.getContext('2d');
      // place the clamped window into the right sub-rect of the tile
      const dx = ((csx - sx) / winW) * size.x;
      const dy = ((csy - sy) / (ey - sy)) * size.y;
      const dw = ((cex - csx) / winW) * size.x;
      const dh = ((cey - csy) / (ey - sy)) * size.y;
      ctx.imageSmoothingEnabled = !ds.isDem;
      ctx.drawImage(cvs, dx, dy, dw, dh);
      done(null, tile);
    }).catch((err) => { done(err, tile); });

    return tile;
  }
});

function renderOrthoTile(raster, w, h) {
  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(w, h);
  const r = raster[0], g = raster[1] || raster[0], b = raster[2] || raster[0];
  const a = raster.length >= 4 ? raster[3] : null;
  for (let i = 0; i < w * h; i++) {
    img.data[i*4] = r[i]; img.data[i*4+1] = g[i]; img.data[i*4+2] = b[i];
    img.data[i*4+3] = a ? a[i] : 255;
  }
  ctx.putImageData(img, 0, 0);
  return cvs;
}

function renderDemTile(raster, w, h, ds) {
  const band = raster[0];
  const nodata = isNaN(ds.nodata) ? -9999 : ds.nodata;
  const cvs = document.createElement('canvas');
  cvs.width = w; cvs.height = h;
  const ctx = cvs.getContext('2d');
  const img = ctx.createImageData(w, h);
  const lo = demSettings.minFt != null ? demSettings.minFt / METERS_TO_FT : ds.min;
  const hi = demSettings.maxFt != null ? demSettings.maxFt / METERS_TO_FT : ds.max;
  const range = (hi - lo) || 1;
  const cmap = COLORMAPS[demSettings.cmap] || COLORMAPS.viridis;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = band[i];
      const bad = !isFinite(v) || v === nodata || v < -1000;
      if (bad) { img.data[i*4+3] = 0; continue; }
      const rgb = sampleCmap(cmap, (v - lo) / range);
      const z = (demSettings.shade <= 0 || x === 0 || y === 0 || x === w-1 || y === h-1)
        ? 1 : hillshadeFactor(band, w, h, x, y);
      img.data[i*4] = Math.min(255, rgb[0] * z);
      img.data[i*4+1] = Math.min(255, rgb[1] * z);
      img.data[i*4+2] = Math.min(255, rgb[2] * z);
      img.data[i*4+3] = 240;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cvs;
}

async function overviewCanvas(ds, renderFn, maxDim = 1400) {
  let idx = ds.images.length - 1;
  for (let i = 0; i < ds.images.length; i++) {
    const im = ds.images[i];
    if (Math.max(im.getWidth(), im.getHeight()) <= maxDim) { idx = i; break; }
  }
  const im = ds.images[idx];
  const raster = await im.readRasters({ pool: geoPool, interleave: false });
  return renderFn(raster, im.getWidth(), im.getHeight(), ds);
}

async function showOrtho() {
  updateStatus('Mode: Orthophoto');
  try {
    if (!orthoLayers) {
      updateLoading('Opening orthophoto (streaming)...', '');
      const ds = await getDataset(ORTHO_URL, false);
      const ov = await overviewCanvas(ds, renderOrthoTile, 3400);
      const overlay = L.imageOverlay(ov.toDataURL('image/png'), ds.llBounds, { opacity: 1 });
      const grid = new GeoTiffGridLayer(ds, renderOrthoTile, {
        tileSize: 256, minZoom: 12, maxZoom: 24, bounds: L.latLngBounds(ds.llBounds), updateWhenZooming: false, keepBuffer: 2, pane: 'gtiff'
      });
      orthoLayers = { overlay, grid, ds };
      hideLoading();
    }
    orthoLayers.overlay.addTo(map);
    orthoLayers.grid.addTo(map);
    restoreOrFit('ortho', orthoLayers.ds.llBounds);
    applyOrthoOpacity();
  } catch (err) {
    console.error('ortho error', err);
    hideLoading();
    showError('Could not stream the orthophoto GeoTIFF.');
  }
}

async function showDEM(type) {
  updateStatus(`Mode: ${type.toUpperCase()}`);
  const url = type === 'dsm' ? DSM_URL : DTM_URL;
  try {
    if (!demLayers[type]) {
      updateLoading(`Opening ${type.toUpperCase()} (streaming)...`, '');
      const ds = await getDataset(url, true);
      const ov = await overviewCanvas(ds, renderDemTile, 2048);
      const overlay = L.imageOverlay(ov.toDataURL('image/png'), ds.llBounds, { opacity: 0.94 });
      const grid = new GeoTiffGridLayer(ds, renderDemTile, {
        tileSize: 256, minZoom: 12, maxZoom: 24, bounds: L.latLngBounds(ds.llBounds), opacity: 0.94, updateWhenZooming: false, keepBuffer: 2, pane: 'gtiff'
      });
      demLayers[type] = { overlay, grid, ds };
      hideLoading();
    }
    const dl = demLayers[type];
    dl.overlay.addTo(map);
    dl.grid.addTo(map);
    restoreOrFit(type, dl.ds.llBounds);
    dom.demLegend.style.display = 'flex';
    applyDemOpacity();
    refreshLegendFor(dl.ds);
  } catch (err) {
    console.error(`${type} error`, err);
    hideLoading();
    showError(`Could not stream the ${type.toUpperCase()} GeoTIFF.`);
  }
}

function restoreOrFit(mode, bounds) {
  if (mapViews[mode]) {
    map.setView(mapViews[mode].center, mapViews[mode].zoom, { animate: false });
  } else {
    map.fitBounds(bounds, { padding: [20, 20] });
  }
}

function rememberMapView(mode) {
  if (map && (mode === 'ortho' || mode === 'dsm' || mode === 'dtm')) {
    mapViews[mode] = { center: map.getCenter(), zoom: map.getZoom() };
  }
}

function refreshLegendFor(ds) {
  const lo = demSettings.minFt != null ? demSettings.minFt / METERS_TO_FT : ds.min;
  const hi = demSettings.maxFt != null ? demSettings.maxFt / METERS_TO_FT : ds.max;
  updateLegend(lo, hi);
}

function applyOrthoOpacity() {
  if (!orthoLayers) return;
  const v = parseInt(document.getElementById('ortho-opacity').value, 10) / 100;
  orthoLayers.overlay.setOpacity(v);
  orthoLayers.grid.setOpacity(v);
}

function applyDemOpacity() {
  const v = parseInt(document.getElementById('dem-opacity').value, 10) / 100;
  ['dsm', 'dtm'].forEach((t) => {
    if (demLayers[t]) { demLayers[t].overlay.setOpacity(v); demLayers[t].grid.setOpacity(v); }
  });
}

async function applyDemSettings() {
  demSettings.cmap = dom.demColormap.value;
  demSettings.shade = parseFloat(dom.demShading.value);
  const mn = dom.demMin.value.trim(), mx = dom.demMax.value.trim();
  demSettings.minFt = mn === '' ? null : parseFloat(mn);
  demSettings.maxFt = mx === '' ? null : parseFloat(mx);

  for (const t of ['dsm', 'dtm']) {
    const dl = demLayers[t];
    if (!dl) continue;
    const ov = await overviewCanvas(dl.ds, renderDemTile, 2048);
    dl.overlay.setUrl(ov.toDataURL('image/png'));
    dl.grid.redraw();
  }
  const active = state.activeMode === 'dtm' ? demLayers.dtm : demLayers.dsm;
  if (active) refreshLegendFor(active.ds);
  applyDemOpacity();
}

function resetDemSettings() {
  dom.demColormap.value = 'viridis';
  dom.demShading.value = '1';
  document.getElementById('dem-shading-val').textContent = '1.0';
  dom.demMin.value = '';
  dom.demMax.value = '';
  document.getElementById('dem-opacity').value = '95';
  document.getElementById('dem-opacity-val').textContent = '95%';
  applyDemSettings();
}

function removeMapOverlays() {
  if (!map) return;
  [orthoLayers, demLayers.dsm, demLayers.dtm].forEach((l) => {
    if (l) { map.removeLayer(l.overlay); map.removeLayer(l.grid); }
  });
}

function showDemHover(e, layer) {
  const ds = layer.ds || layer;
  if (!ds.images) return;
  const { lat, lng } = e.latlng;
  const [E, N] = latLonToUtm(lat, lng);
  if (E < ds.minE || E > ds.maxE || N < ds.minN || N > ds.maxN) { dom.demHover.style.display = 'none'; return; }
  const lvl = Math.min(2, ds.images.length - 1);
  const img = ds.images[lvl];
  const s = img.getWidth() / ds.W;
  const px = Math.floor((E - ds.minE) / (ds.maxE - ds.minE) * ds.W * s);
  const py = Math.floor((ds.maxN - N) / (ds.maxN - ds.minN) * ds.H * s);
  img.readRasters({ window: [px, py, px + 1, py + 1], pool: geoPool }).then((r) => {
    const v = r[0][0];
    if (isFinite(v) && v > -1000 && v !== ds.nodata) {
      dom.demHover.textContent = `Elevation: ${Math.round(v * METERS_TO_FT)} ft`;
      dom.demHover.style.display = 'block';
    } else dom.demHover.style.display = 'none';
  }).catch(() => {});
}

function updateLegend(minM, maxM) {
  const ctx = dom.legendCanvas.getContext('2d');
  const H = dom.legendCanvas.height;
  for (let y = 0; y < H; y++) {
    const t = 1 - y / H;
    const rgb = viridis(t);
    ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    ctx.fillRect(0, y, dom.legendCanvas.width, 1);
  }
  const minFt = Math.round(minM * METERS_TO_FT), maxFt = Math.round(maxM * METERS_TO_FT);
  dom.demLegendLabels.innerHTML = `<span>${maxFt}</span><span>${Math.round((minFt + maxFt) / 2)}</span><span>${minFt}</span>`;
}

// UTM <-> WGS84 (zone 16N)
function utmToLatLon(e, n) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, e0 = 500000;
  const eSq = 2 * f - f * f;
  const e1 = (1 - Math.sqrt(1 - eSq)) / (1 + Math.sqrt(1 - eSq));
  const x = e - e0, M = n / k0;
  const mu = M / (a * (1 - eSq / 4 - 3 * eSq * eSq / 64 - 5 * eSq ** 3 / 256));
  const j1 = 3 * e1 / 2 - 27 * e1 ** 3 / 32, j2 = 21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32;
  const j3 = 151 * e1 ** 3 / 96, j4 = 1097 * e1 ** 4 / 512;
  const fp = mu + j1 * Math.sin(2 * mu) + j2 * Math.sin(4 * mu) + j3 * Math.sin(6 * mu) + j4 * Math.sin(8 * mu);
  const ep2 = eSq / (1 - eSq);
  const c1 = ep2 * Math.cos(fp) ** 2, t1 = Math.tan(fp) ** 2;
  const r1 = a * (1 - eSq) / Math.pow(1 - eSq * Math.sin(fp) ** 2, 1.5);
  const n1 = a / Math.sqrt(1 - eSq * Math.sin(fp) ** 2);
  const d = x / (n1 * k0);
  const lat = fp - (n1 * Math.tan(fp) / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24 + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720);
  const lon = UTM_ZONE_LON0 + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120) / Math.cos(fp);
  return [lat * 180 / Math.PI, lon * 180 / Math.PI];
}

function latLonToUtm(latDeg, lonDeg) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996;
  const eSq = 2 * f - f * f, ep2 = eSq / (1 - eSq);
  const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
  const N = a / Math.sqrt(1 - eSq * Math.sin(lat) ** 2);
  const T = Math.tan(lat) ** 2;
  const Cc = ep2 * Math.cos(lat) ** 2;
  const A = Math.cos(lat) * (lon - UTM_ZONE_LON0);
  const M = a * ((1 - eSq / 4 - 3 * eSq ** 2 / 64 - 5 * eSq ** 3 / 256) * lat
    - (3 * eSq / 8 + 3 * eSq ** 2 / 32 + 45 * eSq ** 3 / 1024) * Math.sin(2 * lat)
    + (15 * eSq ** 2 / 256 + 45 * eSq ** 3 / 1024) * Math.sin(4 * lat)
    - (35 * eSq ** 3 / 3072) * Math.sin(6 * lat));
  const E = k0 * N * (A + (1 - T + Cc) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * Cc - 58 * ep2) * A ** 5 / 120) + 500000;
  const Nn = k0 * (M + N * Math.tan(lat) * (A * A / 2 + (5 - T + 9 * Cc + 4 * Cc * Cc) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * Cc - 330 * ep2) * A ** 6 / 720));
  return [E, Nn];
}

// WebODM-style colormaps (matplotlib equivalents WebODM offers for DEM layers)
const COLORMAPS = {
  viridis: [
    [0.00,68,1,84],[0.05,72,33,115],[0.10,67,62,133],[0.15,56,88,140],[0.20,45,113,142],
    [0.25,37,137,141],[0.30,33,161,135],[0.40,41,184,127],[0.50,66,206,113],[0.60,97,225,96],
    [0.70,134,238,78],[0.80,172,244,64],[0.90,210,247,62],[1.00,253,231,37]
  ],
  jet: [
    [0.00,0,0,131],[0.125,0,60,170],[0.375,5,255,255],[0.625,255,255,0],
    [0.875,250,0,0],[1.00,128,0,0]
  ],
  terrain: [
    [0.00,51,51,153],[0.15,0,120,255],[0.25,0,204,102],[0.50,255,255,102],
    [0.75,153,102,51],[1.00,255,255,255]
  ],
  gray: [[0.00,0,0,0],[1.00,255,255,255]],
  plasma: [
    [0.00,13,8,135],[0.15,84,2,163],[0.30,139,10,165],[0.45,185,50,137],
    [0.60,219,92,104],[0.75,244,136,73],[0.90,254,188,43],[1.00,240,249,33]
  ],
  rdylgn: [
    [0.00,165,0,38],[0.20,215,48,39],[0.35,253,174,97],[0.50,255,255,191],
    [0.65,166,217,106],[0.80,102,189,99],[1.00,0,104,55]
  ]
};

function sampleCmap(stops, t) {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const A = stops[i-1], B = stops[i];
      const p = (t - A[0]) / ((B[0] - A[0]) || 1);
      return [Math.round(A[1]+(B[1]-A[1])*p), Math.round(A[2]+(B[2]-A[2])*p), Math.round(A[3]+(B[3]-A[3])*p)];
    }
  }
  const L = stops[stops.length - 1];
  return [L[1], L[2], L[3]];
}

function viridis(t) { return sampleCmap(COLORMAPS.viridis, t); }

function hillshadeFactor(values, w, h, x, y) {
  const z = (a, b) => values[b * w + a];
  const A = z(x-1,y-1), B = z(x,y-1), Cc = z(x+1,y-1);
  const D = z(x-1,y), F = z(x+1,y);
  const G = z(x-1,y+1), Hh = z(x,y+1), J = z(x+1,y+1);
  const dzdx = ((Cc + 2*F + J) - (A + 2*D + G)) / 8;
  const dzdy = ((G + 2*Hh + J) - (A + 2*B + Cc)) / 8;
  const slope = Math.atan(Math.sqrt(dzdx*dzdx + dzdy*dzdy));
  const aspect = Math.atan2(dzdy, -dzdx);
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  const hs = Math.sin(alt) * Math.cos(slope) + Math.cos(alt) * Math.sin(slope) * Math.cos(az - aspect);
  const k = Math.min(2, Math.max(0, demSettings.shade));
  // k=0 flat color, k=1 default relief, k=2 strong relief
  const base = 1 - 0.45 * k;
  return base + 0.45 * k * Math.max(0, hs);
}

// ───────────────────────────────────────────────────────────────
// Point cloud (Potree in an isolated iframe)
// ───────────────────────────────────────────────────────────────
function showPointCloud() {
  if (!state.pcIframeLoaded) {
    const iframe = document.createElement('iframe');
    iframe.id = 'pc-iframe';
    iframe.src = '/pointcloud.html';
    iframe.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:none;background:#050505;';
    dom.cloudContainer.appendChild(iframe);
    state.pcIframeLoaded = true;
  }
  dom.cloudStatus.textContent = 'Cloud: 428M pts (EPT)';
}

// ───────────────────────────────────────────────────────────────
// View sync between 3D mesh tab and Potree point cloud tab
// (WebODM behavior: switching keeps the exact same camera view)
// ───────────────────────────────────────────────────────────────
function getViewTargetWorld() {
  const hit = pickSurface(new THREE.Vector2(0, 0));   // screen center
  if (hit) return hit;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  if (Math.abs(dir.y) > 1e-4) {
    const t = (18 - camera.position.y) / dir.y;
    if (isFinite(t) && t > 0 && t < 20000) return camera.position.clone().addScaledVector(dir, t);
  }
  return camera.position.clone().addScaledVector(dir, 150);
}

function pushViewToPointCloud(retries = 40) {
  const f = document.getElementById('pc-iframe');
  const w = f && f.contentWindow;
  if (!w || typeof w.__setViewUTM !== 'function') {
    if (retries > 0) setTimeout(() => pushViewToPointCloud(retries - 1), 250);
    return;
  }
  if (state.activeMode !== 'cloud') return;   // user already left the tab
  const camU = worldToUtm(camera.position);
  const tgtU = worldToUtm(getViewTargetWorld());
  try { w.__setViewUTM(camU.e, camU.n, camU.alt, tgtU.e, tgtU.n, tgtU.alt); } catch (err) { /* iframe busy */ }
}

function pullViewFromPointCloud() {
  const f = document.getElementById('pc-iframe');
  const w = f && f.contentWindow;
  if (!w || !w.viewer || !w.__pcViewReady) return;
  try {
    const view = w.viewer.scene.view;
    const p = view.position;
    const pv = view.getPivot();
    const camW = utmToWorld(p.x, p.y, p.z);
    const tgtW = utmToWorld(pv.x, pv.y, pv.z);
    if (camW.distanceTo(tgtW) < 0.01) return;
    controls.setView(camW, tgtW);
  } catch (err) { /* keep current view */ }
}

// ───────────────────────────────────────────────────────────────
// UI
// ───────────────────────────────────────────────────────────────
function bindUI() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      switchMode(btn.dataset.mode);
    });
  });

  // mesh source: tiles OR full-res GLB (radio behavior)
  document.getElementById('layer-tiles').addEventListener('click', () => {
    document.getElementById('layer-tiles').classList.add('active');
    document.getElementById('layer-glb').classList.remove('active');
    applyMeshLayer();
  });
  document.getElementById('layer-glb').addEventListener('click', () => {
    document.getElementById('layer-glb').classList.add('active');
    document.getElementById('layer-tiles').classList.remove('active');
    applyMeshLayer();
  });

  // cameras
  document.getElementById('layer-cameras').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.toggle('active');
    state.camerasVisible = btn.classList.contains('active');
    camGroupParent.visible = state.camerasVisible;
    document.getElementById('cam-size-row').style.display = state.camerasVisible ? 'flex' : 'none';
    if (state.camerasVisible && !state.camerasLoaded) loadCameras();
    if (!state.camerasVisible) { dom.camTooltip.style.display = 'none'; renderer.domElement.style.cursor = ''; }
  });
  document.getElementById('cam-size').addEventListener('input', (e) => {
    setCameraScale(parseFloat(e.target.value));
  });

  // Ortho / DEM settings
  document.getElementById('ortho-opacity').addEventListener('input', (e) => {
    document.getElementById('ortho-opacity-val').textContent = e.target.value + '%';
    applyOrthoOpacity();
  });
  document.getElementById('dem-opacity').addEventListener('input', (e) => {
    document.getElementById('dem-opacity-val').textContent = e.target.value + '%';
    applyDemOpacity();
  });
  dom.demShading.addEventListener('input', (e) => {
    document.getElementById('dem-shading-val').textContent = parseFloat(e.target.value).toFixed(1);
  });
  document.getElementById('dem-apply').addEventListener('click', applyDemSettings);
  document.getElementById('dem-reset').addEventListener('click', resetDemSettings);

  // LOD detail slider
  document.getElementById('lod-detail').addEventListener('input', (e) => {
    if (tilesRenderer) tilesRenderer.errorTarget = 26 - parseInt(e.target.value, 10);
  });

  document.querySelectorAll('#panel-measure .tool-btn[data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });
  document.getElementById('tool-clear').addEventListener('click', () => setTool('clear'));

  document.getElementById('btn-reset').addEventListener('click', resetCamera);
  document.getElementById('btn-top').addEventListener('click', topDownView);
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.getElementById('btn-reset-float').addEventListener('click', resetCamera);
  document.getElementById('btn-fullscreen-float').addEventListener('click', toggleFullscreen);
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('collapsed');
    setTimeout(onResize, 300);
  });

  dom.photoClose.addEventListener('click', closePhoto);
  dom.photoModal.addEventListener('click', (e) => { if (e.target === dom.photoModal) closePhoto(); });
  bindPhotoViewer();
}

function applyMeshLayer() {
  const tilesActive = document.getElementById('layer-tiles').classList.contains('active');
  tilesParent.visible = tilesActive;
  if (tilesActive) {
    glbParent.visible = false;
    loadTiles();               // rebuild if disposed for the GLB (no-op otherwise)
  } else if (state.glbLoaded) {
    disposeTiles();            // GLB is in memory; tile cache is dead weight
    glbParent.visible = true;
  } else {
    loadGLB();
  }
}

function switchMode(mode) {
  rememberMapView(state.activeMode);   // keep the view of the tab we're leaving
  const prevMode = state.activeMode;
  state.activeMode = mode;
  const is3D = mode === 'model';
  const isPC = mode === 'cloud';
  dom.threeContainer.style.display = is3D ? 'block' : 'none';
  dom.labelsContainer.style.display = is3D ? 'block' : 'none';
  dom.cloudContainer.style.display = isPC ? 'block' : 'none';
  dom.leafletMap.style.display = (!is3D && !isPC) ? 'block' : 'none';
  dom.demLegend.style.display = 'none';
  dom.demHover.style.display = 'none';
  dom.camTooltip.style.display = 'none';

  // sidebar panel visibility per tab
  const isDem = mode === 'dsm' || mode === 'dtm';
  document.getElementById('panel-3d-layers').style.display = is3D ? 'block' : 'none';
  document.getElementById('panel-nav').style.display = (is3D || isPC) ? 'block' : 'none';
  document.getElementById('panel-measure').style.display = is3D ? 'block' : 'none';
  document.getElementById('panel-camera').style.display = is3D ? 'block' : 'none';
  document.getElementById('panel-ortho').style.display = mode === 'ortho' ? 'block' : 'none';
  document.getElementById('panel-dem').style.display = isDem ? 'block' : 'none';

  if (is3D) {
    updateStatus('Mode: 3D Model');
    if (prevMode === 'cloud') pullViewFromPointCloud();   // WebODM-style view carry-over
    onResize();
  } else if (isPC) {
    updateStatus('Mode: Point Cloud');
    showPointCloud();
    if (prevMode === 'model') pushViewToPointCloud();
  } else {
    ensureMap();
    removeMapOverlays();
    map.invalidateSize();
    if (mode === 'ortho') showOrtho();
    else showDEM(mode);
  }
}

function updateStatus(t) { dom.modeStatus.textContent = t; }
function updateLoading(t, p) {
  dom.loadingOverlay.classList.remove('hidden');
  dom.loadingText.textContent = t;
  dom.loadingProgress.textContent = p || '';
}
function hideLoading() { dom.loadingOverlay.classList.add('hidden'); }
function showError(msg) {
  dom.errorMessage.textContent = msg;
  dom.errorPanel.style.display = 'block';
  setTimeout(() => { dom.errorPanel.style.display = 'none'; }, 10000);
}
function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
}

// ───────────────────────────────────────────────────────────────
// Render loop
// ───────────────────────────────────────────────────────────────
let statTimer = 0;
function startLoop() {
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.1);

    if (state.activeMode === 'model') {
      controls.update(dt);
      camera.updateMatrixWorld();
      if (tilesRenderer && tilesParent.visible) tilesRenderer.update();
      drainBVH();

      // scale measurement markers with camera distance
      measureRoot.traverse((o) => {
        if (o.userData.isMarker) {
          const d = o.position.distanceTo(camera.position);
          o.scale.setScalar(Math.min(4, Math.max(0.06, d / 90)));
        }
      });

      renderer.render(scene, camera);
      labelRenderer.render(scene, camera);

      frames++;
      const now = performance.now();
      if (now - lastFps >= 1000) {
        dom.fps.textContent = frames;
        frames = 0; lastFps = now;
        statTimer++;
        updateStats();
      }
    }
  }
  requestAnimationFrame(loop);
}

function updateStats() {
  if (performance.memory) {
    dom.memDisplay.textContent = Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB';
  }
  let tris = 0;
  if (tilesParent.visible && tilesRenderer) {
    const countVisible = (obj) => {
      if (!obj.visible) return;
      if (obj.isMesh && obj.geometry) {
        tris += obj.geometry.index ? obj.geometry.index.count / 3 : (obj.geometry.attributes.position?.count || 0) / 3;
      }
      for (const c of obj.children) countVisible(c);
    };
    countVisible(tilesRenderer.group);
    const vis = tilesRenderer.stats ? tilesRenderer.stats.visible : 0;
    dom.lodStatus.textContent = `LOD: ${vis} tile${vis === 1 ? '' : 's'}`;
  } else if (glbParent.visible) {
    glbOffset.traverse((o) => {
      if (o.isMesh && o.geometry) tris += o.geometry.index ? o.geometry.index.count / 3 : (o.geometry.attributes.position?.count || 0) / 3;
    });
    dom.lodStatus.textContent = 'LOD: full-res';
  }
  dom.trisStatus.textContent = 'Tris: ' + (tris > 1e6 ? (tris / 1e6).toFixed(1) + 'M' : Math.round(tris / 1000) + 'K');
}

// expose for debugging/verification
window.__ltds = { scene: () => scene, camera: () => camera, controls: () => controls,
  tiles: () => tilesRenderer, state, worldToUtm, latLonToUtm, utmToLatLon };
