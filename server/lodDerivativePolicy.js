'use strict';

const path = require('node:path');
const CONTROLLED_CONVERTER_BINARY_SHA256 = new Set(['40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274','c54dbcbe953640f2aa0e7c2568709108a97063dac492781c9560a5042e46d9b1']);

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
  const obj = meshAsset(assets, 'obj');
  if (!glb || !provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return null;
  const exactV2 = provenance.schemaVersion === 2
    && provenance.geometry === 'bounded-triangle-equivalence'
    && provenance.textures === 'byte-identical-material-equivalence'
    && provenance.audit?.algorithm === 'ltds-glb-leaf-equivalence-v2';
  const controlledV3 = provenance.schemaVersion === 3
    && provenance.geometry === 'controlled-bidirectional-surface-equivalence'
    && provenance.textures === 'controlled-atlas-material-equivalence'
    && provenance.audit?.algorithm === 'ltds-obj2tiles-surface-equivalence-v3'
    && provenance.converter?.name === 'OpenDroneMap/Obj2Tiles'
    && provenance.converter?.version === '1.6.2'
    && provenance.converter?.commandSha256 === '7d82c354b3d65985e602454c0bcc204fe8e75d8efc1826b76a5681d85c34f681'
    && Boolean(obj?.sha256)
    && provenance.converter?.inputAsset === path.posix.basename(obj.relativePath || '')
    && provenance.converter?.inputSha256 === obj.sha256
    && CONTROLLED_CONVERTER_BINARY_SHA256.has(String(provenance.converter?.binarySha256 || '').toLowerCase());
  if ((!exactV2 && !controlledV3)
    || provenance.sourceSha256 !== glb.sha256
    || provenance.tilesManifestSha256 !== meshAsset(assets, 'tiles')?.manifestSha256
    || provenance.sourceAsset !== path.posix.basename(glb.relativePath || '')
    || provenance.leafGeometricError !== 0
    || !Number.isInteger(provenance.audit?.artifactCount)
    || provenance.audit.artifactCount < 2) return null;
  return provenance;
}

function viewerEligibleAssets(metadata, assets) {
  const provenance = verifiedLodProvenance(metadata, assets);
  return assets.filter((asset) => asset.kind !== 'tiles' || provenance);
}

module.exports = { lodDerivativeSpecs, verifiedLodProvenance, viewerEligibleAssets };
