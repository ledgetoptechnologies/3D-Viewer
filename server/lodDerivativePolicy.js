'use strict';

const path = require('node:path');

function meshAsset(assets, kind) {
  return assets.find((asset) => asset.kind === kind) || null;
}

function lodDerivativeSpecs(assets, { meshDerivativesEnabled = false } = {}) {
  const tiles = meshAsset(assets, 'tiles') || meshAsset(assets, 'nativeTiles');
  const obj = meshAsset(assets, 'obj');
  const glb = meshAsset(assets, 'glb');

  if (tiles && glb) {
    return [{
      type: 'lod_audit',
      request: {
        tilesRootKey: tiles.rootKey || 'models',
        tilesRelativePath: path.posix.dirname(tiles.relativePath),
        generateFromObjOnFailure: Boolean(meshDerivativesEnabled && obj && glb),
        optional: true,
      },
    }];
  }

  // OpenDroneMap Obj2Tiles accepts OBJ input. A GLB-only import must retain
  // its full-mesh fallback rather than queueing a conversion the tool cannot do.
  if (!tiles && obj && glb && meshDerivativesEnabled) return [{ type: 'mesh_tiles', request: { optional: true } }];
  return [];
}

module.exports = { lodDerivativeSpecs };
