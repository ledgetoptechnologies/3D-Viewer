(function pointCloudCameraModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LtdsPointCloudCameras = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createPointCloudCameraModule() {
  const CAMERA_MARKER_COLORS = Object.freeze({
    body: 0xEE5007,
    bodyHover: 0xF8CB2E,
    direction: 0xF8CB2E,
    directionHover: 0xFFFFFF,
  });

  function cameraMarkerGeometryData() {
    const w = 0.55, h = 0.41, length = 0.72;
    const body = [
      0, 0, 0, -w, -h, length,  w, -h, length,
      0, 0, 0,  w, -h, length,  w,  h, length,
      0, 0, 0,  w,  h, length, -w,  h, length,
      0, 0, 0, -w,  h, length, -w, -h, length,
      -w, -h, length,  w, -h, length,  w, h, length,
      -w, -h, length,  w,  h, length, -w, h, length,
    ];
    const aw = 0.18, ah = 0.14, tip = 1.8;
    const direction = [
      -aw, -ah, length,  aw, -ah, length, 0, 0, tip,
       aw, -ah, length,  aw,  ah, length, 0, 0, tip,
       aw,  ah, length, -aw,  ah, length, 0, 0, tip,
      -aw,  ah, length, -aw, -ah, length, 0, 0, tip,
      -aw, -ah, length,  aw,  ah, length, aw, -ah, length,
      -aw, -ah, length, -aw,  ah, length, aw,  ah, length,
    ];
    return { body, direction };
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
    let bodyMesh = null;
    let directionMesh = null;
    let scale = 1;

    function disposeMeshes() {
      for (const mesh of [bodyMesh, directionMesh]) {
        if (!mesh) continue;
        group.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
      bodyMesh = null;
      directionMesh = null;
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
      const data = cameraMarkerGeometryData();
      const bodyMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.48, side: THREE.DoubleSide, depthWrite: false });
      const directionMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.96, side: THREE.DoubleSide, depthWrite: false });
      bodyMesh = new THREE.InstancedMesh(geometry(data.body), bodyMaterial, markers.length);
      directionMesh = new THREE.InstancedMesh(geometry(data.direction), directionMaterial, markers.length);
      bodyMesh.frustumCulled = false;
      directionMesh.frustumCulled = false;
      directionMesh.renderOrder = 1;
      const matrix = new THREE.Matrix4();
      const quaternion = new THREE.Quaternion();
      const axis = new THREE.Vector3();
      const position = new THREE.Vector3();
      const markerScale = new THREE.Vector3();
      const bodyColor = new THREE.Color(CAMERA_MARKER_COLORS.body);
      const directionColor = new THREE.Color(CAMERA_MARKER_COLORS.direction);
      markers.forEach((marker, index) => {
        const r = marker.rotation;
        const angle = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2]);
        if (angle > 1e-9) axis.set(-r[0] / angle, -r[1] / angle, -r[2] / angle);
        else axis.set(0, 0, 1);
        quaternion.setFromAxisAngle(axis, angle);
        position.set(marker.translation[0], marker.translation[1], marker.translation[2]);
        markerScale.setScalar(scale);
        matrix.compose(position, quaternion, markerScale);
        bodyMesh.setMatrixAt(index, matrix);
        directionMesh.setMatrixAt(index, matrix);
        bodyMesh.setColorAt(index, bodyColor);
        directionMesh.setColorAt(index, directionColor);
      });
      bodyMesh.instanceMatrix.needsUpdate = true;
      bodyMesh.instanceColor.needsUpdate = true;
      directionMesh.instanceMatrix.needsUpdate = true;
      directionMesh.instanceColor.needsUpdate = true;
      group.add(bodyMesh, directionMesh);
      return markers.length;
    }

    function setScale(value) {
      scale = Math.max(0.1, Math.min(4, Number(value) || 1));
      if (!bodyMesh || !directionMesh) return;
      const matrix = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const previousScale = new THREE.Vector3();
      const nextScale = new THREE.Vector3(scale, scale, scale);
      for (let index = 0; index < bodyMesh.count; index += 1) {
        bodyMesh.getMatrixAt(index, matrix);
        matrix.decompose(position, quaternion, previousScale);
        matrix.compose(position, quaternion, nextScale);
        bodyMesh.setMatrixAt(index, matrix);
        directionMesh.setMatrixAt(index, matrix);
      }
      bodyMesh.instanceMatrix.needsUpdate = true;
      directionMesh.instanceMatrix.needsUpdate = true;
    }

    function setVisible(value) { group.visible = Boolean(value); }

    function pick(clientX, clientY) {
      if (!group.visible || !bodyMesh || !directionMesh) return -1;
      const rect = dom.getBoundingClientRect();
      if (!rect.width || !rect.height) return -1;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, getCamera());
      const hit = raycaster.intersectObjects([bodyMesh, directionMesh], false)[0];
      return Number.isInteger(hit?.instanceId) ? hit.instanceId : -1;
    }

    function dispose() {
      disposeMeshes();
      scene.remove(group);
    }

    return Object.freeze({ setMarkers, setScale, setVisible, pick, dispose, group, get count() { return bodyMesh?.count || 0; } });
  }

  return Object.freeze({ CAMERA_MARKER_COLORS, cameraMarkerGeometryData, cameraMarkerLocalFrame, createCameraClickTracker, normalizeCameraMarkers, createPointCloudCameraLayer });
}));
