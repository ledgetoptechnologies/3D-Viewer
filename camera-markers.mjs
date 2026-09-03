export const CAMERA_MARKER_COLORS = Object.freeze({
  body: 0x6F7782,
  face: 0xD8DEE6,
  cue: 0xF8CB2E,
  tab: 0xEE5007,
});

export const CAMERA_MARKER_OPACITY = Object.freeze({
  normal: 0.82,
  hover: 1,
});

export const DEFAULT_CAMERA_MARKER_SCALE = 0.5;

export const CAMERA_MARKER_STYLE = Object.freeze({
  width: Math.hypot(1.48, 1.13, 0.41),
  maxPixels: 10,
  cellPixels: 18,
  maxVisible: 4000,
  pickRadius: 12,
});

export function cameraMarkerScaleForView({
  baseScale = DEFAULT_CAMERA_MARKER_SCALE,
} = {}) {
  const parsed = Number(baseScale);
  const requested = Number.isFinite(parsed) ? parsed : DEFAULT_CAMERA_MARKER_SCALE;
  return Math.max(0.1, Math.min(4, requested));
}

export function selectCameraMarkerRepresentatives(candidates, {
  width,
  height,
  cellPixels = CAMERA_MARKER_STYLE.cellPixels,
  maxVisible = CAMERA_MARKER_STYLE.maxVisible,
  margin = CAMERA_MARKER_STYLE.maxPixels,
} = {}) {
  const viewportWidth = Number(width);
  const viewportHeight = Number(height);
  const cellSize = Number(cellPixels);
  const limit = Math.max(0, Math.floor(Number(maxVisible)) || 0);
  const viewportMargin = Math.max(0, Number(margin) || 0);
  if (!Array.isArray(candidates) || viewportWidth <= 0 || viewportHeight <= 0
    || !Number.isFinite(cellSize) || cellSize <= 0 || limit === 0) return [];

  const cells = new Map();
  for (const candidate of candidates) {
    const index = Number(candidate?.index);
    const x = Number(candidate?.x);
    const y = Number(candidate?.y);
    const depth = Number(candidate?.depth);
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(x) || !Number.isFinite(y)
      || !Number.isFinite(depth) || depth <= 0
      || x < -viewportMargin || x > viewportWidth + viewportMargin
      || y < -viewportMargin || y > viewportHeight + viewportMargin) continue;
    const key = `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;
    const current = cells.get(key);
    if (!current || depth < current.depth || (depth === current.depth && index < current.index)) {
      cells.set(key, { index, depth });
    }
  }

  return [...cells.values()]
    .sort((left, right) => left.depth - right.depth || left.index - right.index)
    .slice(0, limit)
    .map((candidate) => candidate.index)
    .sort((left, right) => left - right);
}

function pushTriangle(target, a, b, c) {
  target.push(...a, ...b, ...c);
}

function pushQuad(target, a, b, c, d) {
  pushTriangle(target, a, b, c);
  pushTriangle(target, a, c, d);
}

function pushBox(target, minX, maxX, minY, maxY, minZ, maxZ) {
  const nnn = [minX, minY, minZ];
  const pnn = [maxX, minY, minZ];
  const ppn = [maxX, maxY, minZ];
  const npn = [minX, maxY, minZ];
  const nnp = [minX, minY, maxZ];
  const pnp = [maxX, minY, maxZ];
  const ppp = [maxX, maxY, maxZ];
  const npp = [minX, maxY, maxZ];
  pushQuad(target, nnn, npn, ppn, pnn);
  pushQuad(target, nnp, pnp, ppp, npp);
  pushQuad(target, nnn, nnp, npp, npn);
  pushQuad(target, pnn, ppn, ppp, pnp);
  pushQuad(target, npn, npp, ppp, ppn);
  pushQuad(target, nnn, pnn, pnp, nnp);
}

function pushFrustumShell(target, {
  backX, backY, backZ, frontX, frontY, frontZ, caps = false,
}) {
  const back = [
    [-backX, -backY, backZ], [backX, -backY, backZ],
    [backX, backY, backZ], [-backX, backY, backZ],
  ];
  const front = [
    [-frontX, -frontY, frontZ], [frontX, -frontY, frontZ],
    [frontX, frontY, frontZ], [-frontX, frontY, frontZ],
  ];
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    pushQuad(target, back[index], back[next], front[next], front[index]);
  }
  if (caps) {
    pushQuad(target, back[0], back[3], back[2], back[1]);
    pushQuad(target, front[0], front[1], front[2], front[3]);
  }
}

function pushDisc(target, centerX, centerY, z, radius, segments = 20) {
  for (let index = 0; index < segments; index += 1) {
    const angle0 = index / segments * Math.PI * 2;
    const angle1 = (index + 1) / segments * Math.PI * 2;
    pushTriangle(target,
      [centerX, centerY, z],
      [centerX + Math.cos(angle0) * radius, centerY + Math.sin(angle0) * radius, z],
      [centerX + Math.cos(angle1) * radius, centerY + Math.sin(angle1) * radius, z]);
  }
}

export function cameraMarkerGeometryData() {
  // WebODM-inspired camera-view glyph, rebuilt from primitives. The shallow
  // neutral body and light face make front/back obvious, amber face samples
  // mark +Z, and the LTDS-orange tab identifies local +Y (image-up).
  const body = [];
  pushFrustumShell(body, {
    backX: 0.74, backY: 0.48, backZ: -0.26,
    frontX: 0.58, frontY: 0.40, frontZ: 0.12,
  });
  pushQuad(body,
    [-0.74, -0.48, -0.26], [-0.74, 0.48, -0.26],
    [0.74, 0.48, -0.26], [0.74, -0.48, -0.26]);

  const face = [];
  pushQuad(face,
    [-0.56, -0.38, 0.13], [0.56, -0.38, 0.13],
    [0.56, 0.38, 0.13], [-0.56, 0.38, 0.13]);

  const cue = [];
  for (const centerX of [-0.16, 0, 0.16]) pushDisc(cue, centerX, 0, 0.15, 0.055);

  const tab = [];
  pushBox(tab, -0.13, 0.13, 0.38, 0.65, -0.04, 0.10);
  return { body, face, cue, tab };
}
