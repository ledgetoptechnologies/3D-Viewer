import './node_modules/geotiff/dist-browser/geotiff.js';

const browserGeoTiff = globalThis.GeoTIFF;

if (!browserGeoTiff?.fromUrl || !browserGeoTiff?.Pool) {
  throw new Error('GeoTIFF browser runtime is unavailable');
}

export const fromUrl = browserGeoTiff.fromUrl;
export const Pool = browserGeoTiff.Pool;
