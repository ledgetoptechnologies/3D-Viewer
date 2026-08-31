'use strict';

const path = require('node:path');
const {
  ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256,
  CONTROLLED_CONVERTER_BINARY_SHA256,
} = require('../lod-converter-policy.cjs');
const CONTROLLED_CONVERTER_BINARY_SHA256_SET = new Set(CONTROLLED_CONVERTER_BINARY_SHA256);
const CONTROLLED_CONVERTER_COMMAND_SHA256_SET = new Set(ACCEPTED_CONTROLLED_CONVERTER_COMMAND_SHA256);

function meshAsset(assets, kind) {
  return assets.find((asset) => asset.kind === kind) || null;
}

function lodDerivativeSpecs(assets, { meshDerivativesEnabled = false, required = false } = {}) {
  const tiles = meshAsset(assets, 'tiles') || meshAsset(assets, 'nativeTiles');
  const obj = meshAsset(assets, 'obj');
  const glb = meshAsset(assets, 'glb');
  const optional = !required;

  // New processing/import work with an auditable textured source always gets
  // the current KTX2 contract. A bundled legacy JPEG tree is not sufficient
  // for the reduced-memory Viewer profile.
  if (required && obj && glb) {
    return [{ type: 'mesh_tiles', request: { optional: false } }];
  }

  if (tiles && glb) {
    return [{
      type: 'lod_audit',
      request: {
        tilesRootKey: tiles.rootKey || 'models',
        tilesRelativePath: path.posix.dirname(tiles.relativePath),
        optional,
      },
    }];
  }

  // OpenDroneMap Obj2Tiles accepts OBJ input. A GLB-only import must retain
  // its full-mesh fallback rather than queueing a conversion the tool cannot do.
  if (!tiles && obj && glb && meshDerivativesEnabled) return [{ type: 'mesh_tiles', request: { optional } }];
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
    && CONTROLLED_CONVERTER_COMMAND_SHA256_SET.has(String(provenance.converter?.commandSha256 || '').toLowerCase())
    && Boolean(obj?.sha256)
    && provenance.converter?.inputAsset === path.posix.basename(obj.relativePath || '')
    && provenance.converter?.inputSha256 === obj.sha256
    && CONTROLLED_CONVERTER_BINARY_SHA256_SET.has(String(provenance.converter?.binarySha256 || '').toLowerCase());
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
