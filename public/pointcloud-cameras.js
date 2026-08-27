(function pointCloudCameraModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudCameras = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPointCloudCameraModule() {
  const CAMERA_MARKER_COLORS = Object.freeze({
    orange: 0xEE5007,
    white: 0xFFFFFF,
    yellow: 0xFFA200,
  });

  const CAMERA_MARKER_OPACITY = Object.freeze({ normal: 0.7, hover: 1 });
  const DEFAULT_CAMERA_MARKER_SCALE = 0.5;
  const CAMERA_MARKER_STYLE = Object.freeze({ width: Math.hypot(1.64, 1.12, 0.76), maxPixels: 10, cellPixels: 18, maxVisible: 4000, pickRadius: 12 });

  function cameraMarkerScaleForView({ baseScale = DEFAULT_CAMERA_MARKER_SCALE } = {}) {
    const parsed = Number(baseScale);
    const requested = Number.isFinite(parsed) ? parsed : DEFAULT_CAMERA_MARKER_SCALE;
    return Math.max(0.1, Math.min(4, requested));
  }

  function selectCameraMarkerRepresentatives(candidates, { width, height, cellPixels = CAMERA_MARKER_STYLE.cellPixels, maxVisible = CAMERA_MARKER_STYLE.maxVisible, margin = CAMERA_MARKER_STYLE.maxPixels } = {}) {
    const viewportWidth = Number(width), viewportHeight = Number(height), cellSize = Number(cellPixels);
    const limit = Math.max(0, Math.floor(Number(maxVisible)) || 0);
    const viewportMargin = Math.max(0, Number(margin) || 0);
    if (!Array.isArray(candidates) || viewportWidth <= 0 || viewportHeight <= 0
      || !Number.isFinite(cellSize) || cellSize <= 0 || limit === 0) return [];
    const cells = new Map();
    for (const candidate of candidates) {
      const index = Number(candidate?.index), x = Number(candidate?.x), y = Number(candidate?.y), depth = Number(candidate?.depth);
      if (!Number.isInteger(index) || index < 0 || !Number.isFinite(x) || !Number.isFinite(y)
        || !Number.isFinite(depth) || depth <= 0
        || x < -viewportMargin || x > viewportWidth + viewportMargin
        || y < -viewportMargin || y > viewportHeight + viewportMargin) continue;
      const key = `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
      const current = cells.get(key);
      if (!current || depth < current.depth || (depth === current.depth && index < current.index)) cells.set(key, { index, depth });
    }
    return [...cells.values()]
      .sort((left, right) => left.depth - right.depth || left.index - right.index)
      .slice(0, limit)
      .map((candidate) => candidate.index)
      .sort((left, right) => left - right);
  }

  function pushTriangle(target, a, b, c) { target.push(...a, ...b, ...c); }
  function pushQuad(target, a, b, c, d) {
    pushTriangle(target, a, b, c);
    pushTriangle(target, a, c, d);
  }
  function pushBox(target, minX, maxX, minY, maxY, minZ, maxZ) {
    const nnn = [minX, minY, minZ], pnn = [maxX, minY, minZ];
    const ppn = [maxX, maxY, minZ], npn = [minX, maxY, minZ];
    const nnp = [minX, minY, maxZ], pnp = [maxX, minY, maxZ];
    const ppp = [maxX, maxY, maxZ], npp = [minX, maxY, maxZ];
    pushQuad(target, nnn, npn, ppn, pnn);
    pushQuad(target, nnp, pnp, ppp, npp);
    pushQuad(target, nnn, nnp, npp, npn);
    pushQuad(target, pnn, ppn, ppp, pnp);
    pushQuad(target, npn, npp, ppp, ppn);
    pushQuad(target, nnn, pnn, pnp, nnp);
  }
  function pushFrustumShell(target, { backX, backY, backZ, frontX, frontY, frontZ, caps = false }) {
    const back = [[-backX,-backY,backZ],[backX,-backY,backZ],[backX,backY,backZ],[-backX,backY,backZ]];
    const front = [[-frontX,-frontY,frontZ],[frontX,-frontY,frontZ],[frontX,frontY,frontZ],[-frontX,frontY,frontZ]];
    for (let index = 0; index < 4; index += 1) {
      const next = (index + 1) % 4;
      pushQuad(target, back[index], back[next], front[next], front[index]);
    }
    if (caps) {
      pushQuad(target, back[0], back[3], back[2], back[1]);
      pushQuad(target, front[0], front[1], front[2], front[3]);
    }
  }

  function cameraMarkerGeometryData() {
    const orange = [];
    pushBox(orange, -0.72, 0.72, -0.46, 0.46, -0.28, 0.02);
    const white = [];
    pushFrustumShell(white, { backX:0.82, backY:0.56, backZ:-0.02, frontX:0.44, frontY:0.30, frontZ:0.25 });
    const yellow = [];
    pushFrustumShell(yellow, { backX:0.34, backY:0.23, backZ:0.20, frontX:0.19, frontY:0.13, frontZ:0.48, caps:true });
    return { orange, white, yellow };
  }

  function normalizeCameraMarkers(value) {
    if (!Array.isArray(value) || value.length > 100_000) return [];
    const markers = [];
    for (const marker of value) {
      const translation = marker?.translation;
      const rotation = marker?.rotation;
      if (!Array.isArray(translation) || translation.length !== 3
        || !Array.isArray(rotation) || rotation.length !== 3
        || !translation.every(Number.isFinite) || !rotation.every(Number.isFinite)) continue;
      markers.push({ translation: translation.slice(), rotation: rotation.slice() });
    }
    return markers;
  }

  function cameraMarkerLocalFrame(value) {
    const markers = normalizeCameraMarkers(value);
    if (!markers.length) return { origin: [0, 0, 0], markers: [] };
    const origin = markers[0].translation.slice();
    return {
      origin,
      markers: markers.map((marker) => ({
        translation: marker.translation.map((coordinate, index) => coordinate - origin[index]),
        rotation: marker.rotation.slice(),
      })),
    };
  }

  function createCameraClickTracker({ threshold = 5 } = {}) {
    const limit = Number.isFinite(Number(threshold)) && Number(threshold) > 0 ? Number(threshold) : 5;
    const pointers = new Set();
    let start = null;
    function pointerDown(event) {
      pointers.add(event.pointerId);
      if (event.button !== 0 || pointers.size !== 1 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
        start = null;
        return;
      }
      start = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    }
    function pointerMove(event) {
      if (start?.pointerId === event.pointerId
        && Math.hypot(event.clientX - start.x, event.clientY - start.y) >= limit) start = null;
    }
    function pointerUp(event) {
      const candidate = start;
      pointers.delete(event.pointerId);
      start = null;
      if (!candidate || candidate.pointerId !== event.pointerId || event.button !== 0
        || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)
        || Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) >= limit) return null;
      return { x: event.clientX, y: event.clientY };
    }
    function pointerCancel(event) {
      pointers.delete(event.pointerId);
      start = null;
    }
    return Object.freeze({ pointerDown, pointerMove, pointerUp, pointerCancel });
  }

  function createPointCloudCameraLayer({ THREE, scene, dom, getCamera }) {
    if (!THREE?.InstancedMesh || !scene?.add || !dom?.getBoundingClientRect || typeof getCamera !== 'function') {
      throw new TypeError('invalid point-cloud camera layer dependencies');
    }
    const group = new THREE.Group();
    group.name = 'ltds-camera-positions';
    group.visible = false;
    scene.add(group);
    const raycaster = new THREE.Raycaster();
    let orangeMesh = null;
    let whiteMesh = null;
    let yellowMesh = null;
    let scale = DEFAULT_CAMERA_MARKER_SCALE;
    let markerWorldPositions = null;
    let markerLocalPositions = null;
    let markerQuaternions = null;
    let markerDepths = null;
    let drawToSource = [];
    let sourceToDraw = null;
    let hoveredSource = -1;
    let scaleSignature = '';
    let scaleUpdatedAt = 0;

    function disposeMeshes() {
      for (const mesh of [orangeMesh, whiteMesh, yellowMesh]) {
        if (!mesh) continue;
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      orangeMesh = null;
      whiteMesh = null;
      yellowMesh = null;
      markerWorldPositions = null;
      markerLocalPositions = null;
      markerQuaternions = null;
      markerDepths = null;
      drawToSource = [];
      sourceToDraw = null;
      hoveredSource = -1;
      scaleSignature = '';
    }

    function geometry(positions) {
      const value = new THREE.BufferGeometry();
      value.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      value.computeVertexNormals();
      return value;
    }

    function setMarkers(value) {
      const frame = cameraMarkerLocalFrame(value);
      const markers = frame.markers;
      disposeMeshes();
      group.position.set(frame.origin[0], frame.origin[1], frame.origin[2]);
      if (!markers.length) return 0;
      markerWorldPositions = new Float64Array(markers.length * 3);
      markerLocalPositions = new Float64Array(markers.length * 3);
      markerQuaternions = new Float32Array(markers.length * 4);
      markerDepths = new Float64Array(markers.length);
      sourceToDraw = new Int32Array(markers.length);
      sourceToDraw.fill(-1);
      const data = cameraMarkerGeometryData();
      const material = () => new THREE.MeshBasicMaterial({ transparent: true, opacity: CAMERA_MARKER_OPACITY.normal, side: THREE.FrontSide, depthWrite: false });
      orangeMesh = new THREE.InstancedMesh(geometry(data.orange), material(), markers.length);
      whiteMesh = new THREE.InstancedMesh(geometry(data.white), material(), markers.length);
      yellowMesh = new THREE.InstancedMesh(geometry(data.yellow), material(), markers.length);
      [orangeMesh, whiteMesh, yellowMesh].forEach((mesh, index) => {
        mesh.frustumCulled = false;
        mesh.renderOrder = index;
      });
      const quaternion = new THREE.Quaternion();
      const axis = new THREE.Vector3();
      markers.forEach((marker, index) => {
        const r = marker.rotation;
        const angle = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
        if (angle > 1e-9) axis.set(-r[0] / angle, -r[1] / angle, -r[2] / angle);
        else axis.set(0, 0, 1);
        quaternion.setFromAxisAngle(axis, angle);
        markerLocalPositions[index * 3] = marker.translation[0];
        markerLocalPositions[index * 3 + 1] = marker.translation[1];
        markerLocalPositions[index * 3 + 2] = marker.translation[2];
        markerQuaternions[index * 4] = quaternion.x;
        markerQuaternions[index * 4 + 1] = quaternion.y;
        markerQuaternions[index * 4 + 2] = quaternion.z;
        markerQuaternions[index * 4 + 3] = quaternion.w;
        markerWorldPositions[index * 3] = frame.origin[0] + marker.translation[0];
        markerWorldPositions[index * 3 + 1] = frame.origin[1] + marker.translation[1];
        markerWorldPositions[index * 3 + 2] = frame.origin[2] + marker.translation[2];
      });
      orangeMesh.setColorAt(0, new THREE.Color(CAMERA_MARKER_COLORS.orange));
      whiteMesh.setColorAt(0, new THREE.Color(CAMERA_MARKER_COLORS.white));
      yellowMesh.setColorAt(0, new THREE.Color(CAMERA_MARKER_COLORS.yellow));
      orangeMesh.count = 0;
      whiteMesh.count = 0;
      yellowMesh.count = 0;
      group.add(orangeMesh, whiteMesh, yellowMesh);
      updateView(true);
      return markers.length;
    }

    function setScale(value) {
      scale = cameraMarkerScaleForView({ baseScale: value });
      updateView(true);
    }

    function updateView(force = false) {
      if (!orangeMesh || !whiteMesh || !yellowMesh || !markerWorldPositions || !markerLocalPositions || !markerQuaternions) return false;
      const camera = getCamera();
      const rect = dom.getBoundingClientRect();
      if (!camera || !rect.width || !rect.height) return false;
      const now = performance.now();
      if (!force && now - scaleUpdatedAt < 100) return false;
      camera.updateMatrixWorld?.(true);
      const signature = [
        camera.position.x, camera.position.y, camera.position.z,
        camera.quaternion.x, camera.quaternion.y, camera.quaternion.z, camera.quaternion.w,
        camera.fov, camera.zoom, rect.width, rect.height, scale,
      ].map((value) => Number(value).toFixed(3)).join(':');
      scaleUpdatedAt = now;
      if (!force && signature === scaleSignature) return false;
      scaleSignature = signature;

      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const nextScale = new THREE.Vector3();
      const orangeColor = new THREE.Color(CAMERA_MARKER_COLORS.orange);
      const whiteColor = new THREE.Color(CAMERA_MARKER_COLORS.white);
      const yellowColor = new THREE.Color(CAMERA_MARKER_COLORS.yellow);
      const orangeHoverColor = orangeColor.clone().lerp(whiteColor, 0.25);
      const candidates = [];
      const pm = camera.projectionMatrix.elements;
      const vm = camera.matrixWorldInverse.elements;
      for (let source = 0; source < markerWorldPositions.length / 3; source += 1) {
        const offset = source * 3;
        const wx = markerWorldPositions[offset], wy = markerWorldPositions[offset + 1], wz = markerWorldPositions[offset + 2];
        const vx = vm[0]*wx + vm[4]*wy + vm[8]*wz + vm[12];
        const vy = vm[1]*wx + vm[5]*wy + vm[9]*wz + vm[13];
        const vz = vm[2]*wx + vm[6]*wy + vm[10]*wz + vm[14];
        const depth = -vz;
        markerDepths[source] = depth;
        const cx = pm[0]*vx + pm[4]*vy + pm[8]*vz + pm[12];
        const cy = pm[1]*vx + pm[5]*vy + pm[9]*vz + pm[13];
        const cw = pm[3]*vx + pm[7]*vy + pm[11]*vz + pm[15];
        if (cw <= 0) continue;
        candidates.push({
          index: source,
          x: (cx / cw * 0.5 + 0.5) * rect.width,
          y: (-cy / cw * 0.5 + 0.5) * rect.height,
          depth,
        });
      }
      const visibleSources = selectCameraMarkerRepresentatives(candidates, { width: rect.width, height: rect.height });
      drawToSource = visibleSources;
      sourceToDraw.fill(-1);
      for (let draw = 0; draw < visibleSources.length; draw += 1) {
        const source = visibleSources[draw];
        sourceToDraw[source] = draw;
        position.fromArray(markerLocalPositions, source * 3);
        quaternion.fromArray(markerQuaternions, source * 4);
        const visualScale = cameraMarkerScaleForView({
          baseScale: scale,
          depth: markerDepths[source],
          fovDegrees: camera.fov,
          zoom: camera.zoom,
          viewportHeight: rect.height,
        });
        nextScale.setScalar(visualScale);
        matrix.compose(position, quaternion, nextScale);
        orangeMesh.setMatrixAt(draw, matrix);
        whiteMesh.setMatrixAt(draw, matrix);
        yellowMesh.setMatrixAt(draw, matrix);
        const hovered = source === hoveredSource;
        orangeMesh.setColorAt(draw, hovered ? orangeHoverColor : orangeColor);
        whiteMesh.setColorAt(draw, whiteColor);
        yellowMesh.setColorAt(draw, hovered ? whiteColor : yellowColor);
      }
      orangeMesh.count = visibleSources.length;
      whiteMesh.count = visibleSources.length;
      yellowMesh.count = visibleSources.length;
      for (const mesh of [orangeMesh, whiteMesh, yellowMesh]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      return true;
    }

    function applySourceColor(source) {
      if (!sourceToDraw || !Number.isInteger(source) || source < 0 || source >= sourceToDraw.length) return;
      const draw = sourceToDraw[source];
      if (!Number.isInteger(draw) || draw < 0) return;
      const orange = new THREE.Color(CAMERA_MARKER_COLORS.orange);
      const white = new THREE.Color(CAMERA_MARKER_COLORS.white);
      const yellow = new THREE.Color(CAMERA_MARKER_COLORS.yellow);
      const hovered = source === hoveredSource;
      orangeMesh.setColorAt(draw, hovered ? orange.clone().lerp(white, 0.25) : orange);
      whiteMesh.setColorAt(draw, white);
      yellowMesh.setColorAt(draw, hovered ? white : yellow);
      for (const mesh of [orangeMesh, whiteMesh, yellowMesh]) {
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }

    function setHovered(sourceIndex) {
      const parsed = Number(sourceIndex);
      const next = Number.isInteger(parsed) && parsed >= 0 && parsed < (sourceToDraw?.length || 0) ? parsed : -1;
      if (next === hoveredSource) return false;
      const previous = hoveredSource;
      hoveredSource = next;
      applySourceColor(previous);
      applySourceColor(next);
      return true;
    }

    function setVisible(value) {
      group.visible = Boolean(value);
      if (group.visible) updateView(true);
      else setHovered(-1);
    }

    function pick(clientX, clientY) {
      if (!group.visible || !orangeMesh || !whiteMesh || !yellowMesh) return -1;
      const rect = dom.getBoundingClientRect();
      if (!rect.width || !rect.height) return -1;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      const camera = getCamera();
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects([orangeMesh, whiteMesh, yellowMesh], false)[0];
      if (Number.isInteger(hit?.instanceId)) return drawToSource[hit.instanceId];

      camera.updateMatrixWorld?.(true);
      const pm = camera.projectionMatrix.elements;
      const vm = camera.matrixWorldInverse.elements;
      const thresholdNdcX = CAMERA_MARKER_STYLE.pickRadius * 2 / rect.width;
      const thresholdNdcY = CAMERA_MARKER_STYLE.pickRadius * 2 / rect.height;
      let best = -1, bestDistance = Infinity;
      for (const source of drawToSource) {
        const offset = source * 3;
        const wx = markerWorldPositions[offset], wy = markerWorldPositions[offset + 1], wz = markerWorldPositions[offset + 2];
        const vx = vm[0]*wx + vm[4]*wy + vm[8]*wz + vm[12];
        const vy = vm[1]*wx + vm[5]*wy + vm[9]*wz + vm[13];
        const vz = vm[2]*wx + vm[6]*wy + vm[10]*wz + vm[14];
        const cx = pm[0]*vx + pm[4]*vy + pm[8]*vz + pm[12];
        const cy = pm[1]*vx + pm[5]*vy + pm[9]*vz + pm[13];
        const cw = pm[3]*vx + pm[7]*vy + pm[11]*vz + pm[15];
        if (cw <= 0) continue;
        const dx = (cx / cw - ndc.x) / thresholdNdcX;
        const dy = (cy / cw - ndc.y) / thresholdNdcY;
        const distance = dx*dx + dy*dy;
        if (distance < 1 && distance < bestDistance) { best = source; bestDistance = distance; }
      }
      return best;
    }

    function dispose() {
      disposeMeshes();
      scene.remove(group);
    }

    return Object.freeze({
      setMarkers, setScale, setVisible, setHovered, updateView, pick, dispose, group,
      get count() { return markerWorldPositions ? markerWorldPositions.length / 3 : 0; },
      get drawnCount() { return orangeMesh?.count || 0; },
    });
  }

  return Object.freeze({ CAMERA_MARKER_COLORS, CAMERA_MARKER_OPACITY, CAMERA_MARKER_STYLE, DEFAULT_CAMERA_MARKER_SCALE, cameraMarkerGeometryData, cameraMarkerLocalFrame, cameraMarkerScaleForView, selectCameraMarkerRepresentatives, createCameraClickTracker, normalizeCameraMarkers, createPointCloudCameraLayer });
}));
