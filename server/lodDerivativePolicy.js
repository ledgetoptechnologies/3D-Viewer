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

function verifiedLodProvenance(metadata, assets) {
  const provenance = metadata?.lodProvenance;
  const glb = meshAsset(assets, 'glb');
  if (!glb || !provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return null;
  if (provenance.schemaVersion !== 2
    || provenance.sourceSha256 !== glb.sha256
    || provenance.tilesManifestSha256 !== meshAsset(assets, 'tiles')?.manifestSha256
    || provenance.sourceAsset !== path.posix.basename(glb.relativePath || '')
    || provenance.geometry !== 'bounded-triangle-equivalence'
    || provenance.textures !== 'byte-identical-material-equivalence'
    || provenance.leafGeometricError !== 0
    || provenance.audit?.algorithm !== 'ltds-glb-leaf-equivalence-v2'
    || !Number.isInteger(provenance.audit?.artifactCount)
    || provenance.audit.artifactCount < 2) return null;
  return provenance;
}

function viewerEligibleAssets(metadata, assets) {
  const provenance = verifiedLodProvenance(metadata, assets);
  return assets.filter((asset) => asset.kind !== 'tiles' || provenance);
}

module.exports = { lodDerivativeSpecs, verifiedLodProvenance, viewerEligibleAssets };
