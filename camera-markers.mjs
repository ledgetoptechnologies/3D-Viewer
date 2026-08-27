export const CAMERA_MARKER_COLORS = Object.freeze({
  orange: 0xEE5007,
  white: 0xFFFFFF,
  yellow: 0xFFA200,
});

export const CAMERA_MARKER_OPACITY = Object.freeze({
  normal: 0.7,
  hover: 1,
});

export const DEFAULT_CAMERA_MARKER_SCALE = 0.5;

export const CAMERA_MARKER_STYLE = Object.freeze({
  width: Math.hypot(1.64, 1.12, 0.76),
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

export function cameraMarkerGeometryData() {
  // Independently drawn camera-view glyph. The orange rear housing marks the
  // shot position, the translucent white bevel reads as a camera frustum, and
  // the yellow tapered lens makes the +Z viewing direction unmistakable.
  const orange = [];
  pushBox(orange, -0.72, 0.72, -0.46, 0.46, -0.28, 0.02);

  const white = [];
  pushFrustumShell(white, {
    backX: 0.82, backY: 0.56, backZ: -0.02,
    frontX: 0.44, frontY: 0.30, frontZ: 0.25,
  });

  const yellow = [];
  pushFrustumShell(yellow, {
    backX: 0.34, backY: 0.23, backZ: 0.20,
    frontX: 0.19, frontY: 0.13, frontZ: 0.48,
    caps: true,
  });
  return { orange, white, yellow };
}
