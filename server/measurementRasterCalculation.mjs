import fs from 'node:fs';
import crypto from 'node:crypto';
import { fromFile } from 'geotiff';
import { createSurfaceAccumulator } from '../measurement-volume.mjs';
import { insideSelection } from './measurementSelection.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function nativeRasterDefinition(image, request) {
  const keys = image.getGeoKeys(), directory = image.fileDirectory, epsg = Number(String(request.coordinateReference.crs).replace(/^EPSG:/i, ''));
  const rasterCrs = Number(keys.ProjectedCSTypeGeoKey), metres = Number(keys.ProjLinearUnitsGeoKey) === 9001 || ((rasterCrs >= 32601 && rasterCrs <= 32660)||(rasterCrs>=32701&&rasterCrs<=32760));
  if (!metres || rasterCrs !== epsg) fail('measurement_source_crs_mismatch');
  const vertical = keys.VerticalUnitsGeoKey;
  if (Number(keys.GTRasterTypeGeoKey || 1) !== 1) fail('measurement_pixel_is_point_unsupported');
  if (vertical !== undefined && Number(vertical) !== 9001) fail('measurement_source_vertical_units_unsupported');
  if (vertical === undefined && request.sourceVerticalUnit !== 'm') fail('measurement_source_vertical_units_required');
  const transform = directory.ModelTransformation;
  if (transform && (transform[1] !== 0 || transform[4] !== 0)) fail('measurement_rotated_raster_unsupported');
  const [ox, oy] = image.getOrigin(), [dx, dy] = image.getResolution();
  if (![ox, oy, dx, dy].every(Number.isFinite) || dx <= 0 || dy >= 0) fail('measurement_raster_transform_unsupported');
  const bytesPerSample = Math.max(...(directory.BitsPerSample || [64])) / 8;
  const blockBytes = (directory.TileWidth || image.getWidth()) * Math.min(directory.TileLength || directory.RowsPerStrip || image.getHeight(), image.getHeight()) * (directory.SamplesPerPixel || 1) * bytesPerSample;
  if (!Number.isFinite(blockBytes) || blockBytes > 64 * 1024 * 1024) fail('measurement_raster_block_too_large');
  return { ox, oy, dx, dy, crs: `EPSG:${rasterCrs}`, verticalUnit: 'm', verticalUnitBasis: vertical === undefined ? 'administrator-declared' : 'raster-metadata', width: image.getWidth(), height: image.getHeight() };
}
export async function calculateNativeRaster(absolutePath, request, { signal, maxCells = 2_000_000, windowSize = 128, onProgress = () => {} } = {}) {
  const check = () => { if (signal?.aborted) fail('measurement_cancelled'); };
  const sourceStat = await fs.promises.stat(absolutePath);
  if (!sourceStat.isFile() || sourceStat.size !== Number(request.source.byteSize)) fail('measurement_source_changed');
  // Hashed imported assets are immutable by contract; verify that contract before
  // reading, then compare inode/size/mtime after integration as a second guard.
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(absolutePath, { highWaterMark: 1024 * 1024, signal })) { check(); hash.update(chunk); }
  if (hash.digest('hex') !== request.source.sha256) fail('measurement_source_changed');
  const tiff = await fromFile(absolutePath);
  try {
    const image = await tiff.getImage(0), definition = nativeRasterDefinition(image, request), { ox, oy, dx, dy, width, height } = definition;
    const xs = request.vertices.map(p => p[0]), ys = request.vertices.map(p => p[1]);
    const left = Math.max(0, Math.floor((Math.min(...xs) - ox) / dx)), right = Math.min(width, Math.ceil((Math.max(...xs) - ox) / dx));
    const top = Math.max(0, Math.floor((Math.max(...ys) - oy) / dy)), bottom = Math.min(height, Math.ceil((Math.min(...ys) - oy) / dy));
    const cells = Math.max(0, right - left) * Math.max(0, bottom - top);
    if (cells > maxCells) fail('measurement_limit');
    let vertices=request.vertices;
    if(request.collection==='map'&&request.reference?.type!=='custom'){
      vertices=[];
      for(const [e,n]of request.vertices){
        const x=Math.floor((e-ox)/dx),y=Math.floor((n-oy)/dy);
        if(x<0||y<0||x>=width||y>=height)fail('measurement_boundary_elevation_unavailable');
        const values=await image.readRasters({window:[x,y,x+1,y+1],samples:[0],interleave:true,signal}),z=Number(values[0]),nodata=image.getGDALNoData();
        if(!Number.isFinite(z)||(nodata!=null&&z===Number(nodata)))fail('measurement_boundary_elevation_unavailable');
        vertices.push([e,n,z]);
      }
    }
    const accumulator = createSurfaceAccumulator({ vertices, reference: request.reference, maxCells });
    let processed = 0;
    const previewSamples = [], previewStride = Math.max(1, Math.ceil(cells / 4096));
    for (let row = top; row < bottom; row += windowSize) for (let col = left; col < right; col += windowSize) {
      check();
      const r = Math.min(right, col + windowSize), b = Math.min(bottom, row + windowSize);
      const values = await image.readRasters({ window: [col, row, r, b], samples: [0], interleave: true, signal });
      const rawNodata = image.getGDALNoData();
      for(let y=0;y<b-row;y++)for(let x=0;x<r-col;x++){
        const index=(row+y-top)*(right-left)+(col+x-left),z=Number(values[y*(r-col)+x]);
        if(index%previewStride||previewSamples.length>=4096||!Number.isFinite(z)||(rawNodata!=null&&z===Number(rawNodata)))continue;
        const e=ox+(col+x+.5)*dx,n=oy+(row+y+.5)*dy,baseZ=accumulator.reference.sample(e,n);
        if(Number.isFinite(baseZ)&&insideSelection(e,n,vertices))previewSamples.push([e,n,z,baseZ]);
      }
      accumulator.addGrid({ values, width: r - col, height: b - row, bounds: { minE: ox + col * dx, maxE: ox + r * dx, maxN: oy + row * dy, minN: oy + b * dy }, nodata: rawNodata == null ? NaN : Number(rawNodata) });
      processed += (r - col) * (b - row); onProgress(processed / Math.max(1, cells));
      // Let abort, memory guards, and heartbeats execute between bounded reads.
      await new Promise(resolve => setImmediate(resolve));
    }
    check();
    const finalStat = await fs.promises.stat(absolutePath);
    if (['size','ino','dev','mtimeMs','ctimeMs'].some(k => sourceStat[k] !== finalStat[k])) fail('measurement_source_changed');
    const result = accumulator.result();
    return { ...result, calculationOrigin: 'server-native-raster', preview:{previewOnly:true,samples:previewSamples,referencePatches:accumulator.reference.patches.map(patch=>patch.polygon.map(p=>[p[0],p[1],patch.sample(p[0],p[1])]))}, source: { assetId: request.source.id, kind: request.source.kind, sha256: request.source.sha256, modelVersionId: request.modelVersionId, resolutionM: [dx, -dy], crs: definition.crs, verticalUnit: definition.verticalUnit, verticalUnitBasis: definition.verticalUnitBasis }, warnings: [...result.warnings, ...(definition.verticalUnitBasis === 'administrator-declared' ? ['Raster vertical units were declared as metres by the requesting administrator; they were not encoded in the raster.'] : [])] };
  } finally { await tiff.close(); }
}
