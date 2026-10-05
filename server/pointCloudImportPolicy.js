'use strict';

const { lodDerivativeSpecs } = require('./lodDerivativePolicy');
const SUPPORTED_POINT_FORMATS = new Set(['laz', 'las']);
const digest = value => /^[a-f0-9]{64}$/i.test(String(value || ''));

function verifiedEptAsset(assets) {
  return assets.find(asset => asset.kind === 'ept' && digest(asset.sha256)
    && digest(asset.manifestSha256 || asset.manifest_sha256));
}

function pointCloudDerivativeSpecs(assets, { localDerivativesEnabled = false } = {}) {
  const point = assets.find(asset => asset.kind === 'pointCloud');
  if (!point || verifiedEptAsset(assets)) return [];
  if (!SUPPORTED_POINT_FORMATS.has(String(point.format || '').toLowerCase()) || !digest(point.sha256))
    throw Object.assign(new Error('Point-cloud indexing requires a hashed LAS or LAZ source. PLY is not supported; import an existing EPT dataset instead.'), { code: 'point_cloud_source_unsupported' });
  if (!localDerivativesEnabled)
    throw Object.assign(new Error('Point-cloud indexing is disabled on this Viewer deployment. Enable the verified local Entwine converter before importing raw LAS or LAZ files, or import an existing EPT dataset.'), { code: 'point_cloud_indexing_unavailable' });
  return [{ type: 'ept', request: { optional: false } }];
}

function importedDerivativeSpecs(assets, config) {
  return [...lodDerivativeSpecs(assets, { meshDerivativesEnabled: config.meshDerivativesEnabled, required: true }),
    ...pointCloudDerivativeSpecs(assets, config)];
}

// Early admission uses presence only to decide whether a converter is needed.
// EPT integrity is independently hashed before final derivative planning.
function assertPointCloudImportCapability(assets, config) {
  if (assets.some(asset => asset.kind === 'pointCloud') && !assets.some(asset => asset.kind === 'ept'))
    pointCloudDerivativeSpecs(assets, config);
}

module.exports = { SUPPORTED_POINT_FORMATS, assertPointCloudImportCapability, importedDerivativeSpecs, pointCloudDerivativeSpecs, verifiedEptAsset };
