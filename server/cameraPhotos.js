'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_SHOTS_BYTES = 32 * 1024 * 1024;

function cameraPhotoContentType(filename) {
  return /\.jpe?g$/i.test(String(filename || '')) ? 'image/jpeg' : null;
}

function validCameraFilename(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 1024) return null;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return null;
  const segments = value.split('/');
  if (!segments.length || segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return cameraPhotoContentType(value) ? value : null;
}

// Most WebODM task backups keep photos at the backup root. Some preserve a
// nested images/ path in both the file inventory and shots.geojson. Match the
// exact normalized key in either case; never guess between duplicate basenames.
function discoverCameraPhotoLinks(root, discovered) {
  const shots = discovered?.assets?.find((asset) => asset.kind === 'shots');
  if (!shots || !Number.isSafeInteger(shots.byteSize) || shots.byteSize > MAX_SHOTS_BYTES) return [];
  let document;
  try {
    const absolute = path.resolve(root, ...String(shots.relativePath).split('/'));
    const resolvedRoot = path.resolve(root);
    if (!absolute.startsWith(`${resolvedRoot}${path.sep}`)) return [];
    document = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    return [];
  }
  if (!document || document.type !== 'FeatureCollection' || !Array.isArray(document.features)) return [];

  const photosByKey = new Map();
  for (const file of discovered.files || []) {
    const filename = validCameraFilename(file.relativePath);
    if (!filename || !file.sha256 || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0) continue;
    photosByKey.set(filename, file);
  }
  const links = [];
  const seen = new Set();
  for (const feature of document.features) {
    const filename = validCameraFilename(feature?.properties?.filename);
    if (!filename || seen.has(filename)) continue;
    seen.add(filename);
    const file = photosByKey.get(filename);
    if (!file) continue;
    links.push({
      filename,
      relativePath: file.relativePath,
      byteSize: file.byteSize,
      sha256: file.sha256,
      contentType: cameraPhotoContentType(filename),
    });
  }
  return links;
}

module.exports = {
  MAX_SHOTS_BYTES,
  cameraPhotoContentType,
  discoverCameraPhotoLinks,
  validCameraFilename,
};
