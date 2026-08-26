export const CAMERA_MARKER_COLORS = Object.freeze({
  body: 0xEE5007,
  bodyHover: 0xF8CB2E,
  lens: 0xF8CB2E,
  lensHover: 0xFFFFFF,
});

export const CAMERA_MARKER_OPACITY = Object.freeze({
  body: 0.62,
  lens: 0.72,
});

export const CAMERA_MARKER_STYLE = Object.freeze({
  width: Math.hypot(1.62, 1, 0.70),
  maxPixels: 10,
  cellPixels: 18,
  maxVisible: 4000,
  pickRadius: 12,
});

export function cameraMarkerScaleForView({
  baseScale = 1,
} = {}) {
  return Math.max(0.1, Math.min(4, Number(baseScale) || 1));
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

function pushLens(target, {
  centerX = -0.08,
  centerY = 0,
  radius = 0.25,
  backZ = 0.20,
  frontZ = 0.48,
  segments = 12,
} = {}) {
  const backCenter = [centerX, centerY, backZ];
  const frontCenter = [centerX, centerY, frontZ];
  for (let index = 0; index < segments; index += 1) {
    const angle = index * Math.PI * 2 / segments;
    const nextAngle = (index + 1) * Math.PI * 2 / segments;
    const back = [centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius, backZ];
    const nextBack = [centerX + Math.cos(nextAngle) * radius, centerY + Math.sin(nextAngle) * radius, backZ];
    const front = [back[0], back[1], frontZ];
    const nextFront = [nextBack[0], nextBack[1], frontZ];
    pushQuad(target, back, nextBack, nextFront, front);
    pushTriangle(target, backCenter, nextBack, back);
    pushTriangle(target, frontCenter, front, nextFront);
  }
}

export function cameraMarkerGeometryData() {
  const body = [];
  // Compact WebODM-style camera housing centered on the optical origin.
  pushBox(body, -0.72, 0.72, -0.42, 0.42, -0.22, 0.20);
  pushBox(body, -0.30, 0.18, 0.42, 0.58, -0.12, 0.12);
  pushBox(body, 0.72, 0.90, -0.32, 0.28, -0.18, 0.16);

  const lens = [];
  pushLens(lens);
  return { body, lens };
}
