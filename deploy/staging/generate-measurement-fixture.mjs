#!/usr/bin/env node
/**
 * Create a bounded, ordinary WebODM/ODM-style task folder for staging-only
 * DSM/DTM measurement acceptance. This tool never contacts a server and never
 * mutates a Viewer database or service. Pass a new, empty destination path via
 * --output; it will refuse to overwrite an existing fixture or receipt.
 *
 * The TIFFs encode horizontal EPSG:32616 and vertical linear units in metres
 * (GeoTIFF VerticalUnitsGeoKey=9001). A vertical datum is intentionally not
 * claimed. The adjacent receipt records the synthetic raster values and
 * independently calculated cut/fill expectations; it is not an ODM report.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { nativeTiffFixture } from '../../test/helpers/native-tiff-fixture.mjs';
import { fromArrayBuffer } from 'geotiff';
import { readRasterBandMetadata, resolveRasterVerticalUnits } from '../../raster-vertical-units.mjs';
import { createSurfaceAccumulator } from '../../measurement-volume.mjs';
import { formatElevation, formatVolume } from '../../unit-formatters.mjs';

const MAX_TOTAL_BYTES = 1024 * 1024;
const WIDTH = 2, HEIGHT = 2;
const ORIGIN_E = 500_000, ORIGIN_N = 4_800_002, PIXEL_SIZE_M = 1;
const REFERENCE_ELEVATION_M = 100.125;
const RASTERS = Object.freeze({
  dsm: Object.freeze({ path: 'odm_dem/dsm.tif', valueM: 101.125 }),
  dtm: Object.freeze({ path: 'odm_dem/dtm.tif', valueM: 100.625 }),
});
const POLYGON = Object.freeze([
  [ORIGIN_E, ORIGIN_N],
  [ORIGIN_E + WIDTH * PIXEL_SIZE_M, ORIGIN_N],
  [ORIGIN_E + WIDTH * PIXEL_SIZE_M, ORIGIN_N - HEIGHT * PIXEL_SIZE_M],
  [ORIGIN_E, ORIGIN_N - HEIGHT * PIXEL_SIZE_M],
]);
const PROJ_TEXT = 'EPSG:32616\n';

function setTiffTagDoubles(buffer, tagId, values) {
  const entryCount = buffer.readUInt16LE(8);
  for (let index = 0; index < entryCount; index += 1) {
    const entry = 10 + index * 12;
    if (buffer.readUInt16LE(entry) !== tagId) continue;
    const type = buffer.readUInt16LE(entry + 2);
    const count = buffer.readUInt32LE(entry + 4);
    if (type !== 12 || count !== values.length) throw new Error(`Unexpected TIFF tag ${tagId} layout`);
    const offset = buffer.readUInt32LE(entry + 8);
    for (let item = 0; item < count; item += 1) buffer.writeDoubleLE(values[item], offset + item * 8);
    return;
  }
  throw new Error(`Missing required TIFF tag ${tagId}`);
}

function writeRaster(values) {
  if (!Array.isArray(values) || values.length !== WIDTH * HEIGHT || values.some(value => !Number.isFinite(value))) {
    throw new Error('Raster values must be four finite elevations.');
  }
  // This helper emits a genuine one-band IEEE float32 GeoTIFF with EPSG:32616,
  // vertical units in metres, and pixel-is-area semantics. Patch the tiepoint
  // and pixel block to place it at a valid UTM coordinate with known values.
  const bytes = nativeTiffFixture({ width: WIDTH, height: HEIGHT, rowsPerStrip: HEIGHT, externalPadding: 0, verticalUnit: 9001 });
  setTiffTagDoubles(bytes, 33922, [0, 0, 0, ORIGIN_E, ORIGIN_N, 0]);

  const entryCount = bytes.readUInt16LE(8);
  let stripOffset = null, stripBytes = null;
  for (let index = 0; index < entryCount; index += 1) {
    const entry = 10 + index * 12;
    const tagId = bytes.readUInt16LE(entry), type = bytes.readUInt16LE(entry + 2), count = bytes.readUInt32LE(entry + 4);
    if (![273, 279].includes(tagId)) continue;
    if (type !== 4 || count !== 1) throw new Error(`Unexpected TIFF strip tag ${tagId} layout`);
    const value = bytes.readUInt32LE(entry + 8);
    if (tagId === 273) stripOffset = value;
    else stripBytes = value;
  }
  if (stripOffset === null || stripBytes !== values.length * 4 || stripOffset + stripBytes > bytes.length) {
    throw new Error('Unexpected TIFF raster block layout.');
  }
  values.forEach((value, index) => bytes.writeFloatLE(value, stripOffset + index * 4));
  return bytes;
}

function expectedSurface(kind, valueM) {
  // Independent closed-form oracle: every cell has the same height and area;
  // do not use the application's integrator to manufacture its own expected.
  const footprintM2 = WIDTH * HEIGHT * PIXEL_SIZE_M ** 2;
  const signedVolumeM3 = footprintM2 * (valueM - REFERENCE_ELEVATION_M);
  const cutM3 = Math.max(0, signedVolumeM3), fillM3 = Math.max(0, -signedVolumeM3), netM3 = cutM3 - fillM3;
  return {
    sourceKind: kind,
    sampleElevationM: valueM,
    sampleElevationMetric: formatElevation(valueM, 'metric'),
    sampleElevationImperial: formatElevation(valueM, 'imperial'),
    cutM3, fillM3, netM3,
    cutMetric: formatVolume(cutM3, 'metric'),
    fillMetric: formatVolume(fillM3, 'metric'),
    netMetric: formatVolume(netM3, 'metric'),
    cutImperial: formatVolume(cutM3, 'imperial'),
    fillImperial: formatVolume(fillM3, 'imperial'),
    netImperial: formatVolume(netM3, 'imperial'),
    footprintM2, coverage: 1, sampleCount: WIDTH * HEIGHT,
  };
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

/** Generate in-memory source files and a separate receipt; no disk I/O occurs. */
export function createMeasurementFixture() {
  const files = new Map([
    [RASTERS.dsm.path, writeRaster(Array(WIDTH * HEIGHT).fill(RASTERS.dsm.valueM))],
    [RASTERS.dtm.path, writeRaster(Array(WIDTH * HEIGHT).fill(RASTERS.dtm.valueM))],
    ['odm_georeferencing/proj.txt', Buffer.from(PROJ_TEXT, 'utf8')],
  ]);
  const totalFixtureBytes = [...files.values()].reduce((sum, file) => sum + file.byteLength, 0);
  if (totalFixtureBytes > MAX_TOTAL_BYTES) throw new Error('Generated source fixture exceeds the 1 MiB limit.');
  const receipt = {
    schema: 'ltds-staging-measurement-fixture-v1',
    fixtureOnly: true,
    warning: 'Synthetic numerical fixture only. It does not establish survey accuracy, real-world completeness, or a vertical datum.',
    provenance: {
      horizontalCrs: 'EPSG:32616',
      geotiffProjectedCSTypeGeoKey: 32616,
      projectedLinearUnitsGeoKey: 9001,
      verticalUnitsGeoKey: 4099,
      verticalUnitsCode: 9001,
      verticalUnit: 'm',
      verticalDatum: 'unspecified',
      rasterType: 'PixelIsArea',
      producer: 'Codex deterministic staging fixture generator',
      isOdmProcessingReport: false,
    },
    raster: {
      width: WIDTH, height: HEIGHT, samplesPerPixel: 1, sampleType: 'IEEE float32',
      pixelSizeM: [PIXEL_SIZE_M, PIXEL_SIZE_M], originUpperLeft: [ORIGIN_E, ORIGIN_N],
      files: Object.fromEntries([...files].filter(([name]) => name.endsWith('.tif')).map(([name, bytes]) => [name, {
        byteSize: bytes.byteLength, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      }])),
      expectedValuesRowMajor: Object.fromEntries(Object.entries(RASTERS).map(([kind, spec]) => [kind, Array(WIDTH * HEIGHT).fill(spec.valueM)])),
    },
    calculation: {
      method: 'surface-cut-fill',
      polygonEastingNorthingM: POLYGON,
      reference: { type: 'custom', elevationM: REFERENCE_ELEVATION_M },
      expectedBySurface: Object.fromEntries(Object.entries(RASTERS).map(([kind, spec]) => [kind, expectedSurface(kind, spec.valueM)])),
    },
    fixtureBytes: totalFixtureBytes,
  };
  const receiptBytes = Buffer.byteLength(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  if (totalFixtureBytes + receiptBytes > MAX_TOTAL_BYTES) throw new Error('Fixture and receipt together exceed the 1 MiB limit.');
  return { files, receipt };
}

/** Independently parse both GeoTIFFs and recompute their known volume values. */
export async function verifyMeasurementFixture(fixture = createMeasurementFixture()) {
  const { files, receipt } = fixture;
  const totalBytes = [...files.values()].reduce((sum, file) => sum + file.byteLength, 0);
  if (totalBytes !== receipt.fixtureBytes || totalBytes > MAX_TOTAL_BYTES) throw new Error('Fixture byte count is inconsistent or exceeds 1 MiB.');
  for (const [kind, spec] of Object.entries(RASTERS)) {
    const bytes = files.get(spec.path);
    if (!bytes) throw new Error(`Missing ${kind.toUpperCase()} source file.`);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (digest !== receipt.raster.files[spec.path]?.sha256) throw new Error(`${kind.toUpperCase()} digest does not match receipt.`);
    const tiff = await fromArrayBuffer(toArrayBuffer(bytes));
    try {
      const image = await tiff.getImage(0), geoKeys = image.getGeoKeys();
      const actualValues = [...await image.readRasters({ samples: [0], interleave: true })];
      const metadata = await readRasterBandMetadata(image);
      const units = resolveRasterVerticalUnits(image, { bandMetadata: metadata });
      const origin = image.getOrigin(), resolution = image.getResolution();
      if (image.getWidth() !== WIDTH || image.getHeight() !== HEIGHT || image.getSamplesPerPixel() !== 1) throw new Error(`${kind.toUpperCase()} raster dimensions/bands differ from fixture receipt.`);
      if (geoKeys.ProjectedCSTypeGeoKey !== 32616 || geoKeys.ProjLinearUnitsGeoKey !== 9001 || geoKeys.VerticalUnitsGeoKey !== 9001 || units.verticalFactor !== 1 || units.verticalUnitBasis !== 'raster-metadata') throw new Error(`${kind.toUpperCase()} has missing/conflicting CRS or explicit vertical-unit metadata.`);
      if (origin[0] !== ORIGIN_E || origin[1] !== ORIGIN_N || resolution[0] !== PIXEL_SIZE_M || resolution[1] !== -PIXEL_SIZE_M) throw new Error(`${kind.toUpperCase()} affine transform differs from receipt.`);
      if (actualValues.some(value => value !== spec.valueM)) throw new Error(`${kind.toUpperCase()} samples differ from the known elevations.`);
      const expected = receipt.calculation.expectedBySurface[kind];
      const recomputed = expectedSurface(kind, actualValues[0]);
      if (JSON.stringify(recomputed) !== JSON.stringify(expected)) throw new Error(`${kind.toUpperCase()} volume does not match independent raster-value calculation.`);
      const vertices = POLYGON.map(([easting, northing]) => [easting, northing, REFERENCE_ELEVATION_M]);
      const accumulator = createSurfaceAccumulator({ vertices, reference: { type: 'custom', elevationM: REFERENCE_ELEVATION_M } });
      accumulator.addGrid({ values: Float64Array.from(actualValues), width: WIDTH, height: HEIGHT,
        bounds: { minE: ORIGIN_E, maxE: ORIGIN_E + WIDTH * PIXEL_SIZE_M,
          minN: ORIGIN_N - HEIGHT * PIXEL_SIZE_M, maxN: ORIGIN_N } });
      const actualCalculation = accumulator.result();
      for (const name of ['cutM3', 'fillM3', 'netM3', 'footprintM2', 'coverage', 'sampleCount']) {
        if (actualCalculation[name] !== expected[name]) throw new Error(`${kind.toUpperCase()} application calculation differs from its analytic ${name} expectation.`);
      }
      if (formatElevation(actualValues[0], 'metric') !== expected.sampleElevationMetric ||
          formatElevation(actualValues[0], 'imperial') !== expected.sampleElevationImperial ||
          formatVolume(actualCalculation.netM3, 'metric') !== expected.netMetric ||
          formatVolume(actualCalculation.netM3, 'imperial') !== expected.netImperial) {
        throw new Error(`${kind.toUpperCase()} display precision or volume-unit formatting differs from its expected receipt.`);
      }
    } finally { await tiff.close(); }
  }
  const proj = files.get('odm_georeferencing/proj.txt')?.toString('utf8');
  if (proj !== PROJ_TEXT || receipt.provenance.verticalDatum !== 'unspecified') throw new Error('Fixture CRS or datum provenance is ambiguous.');
  return { fixtureBytes: totalBytes, sourceFiles: files.size, surfaces: Object.keys(RASTERS), verified: true };
}

function parseOutputArgument(argv) {
  const index = argv.indexOf('--output');
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) return null;
  return path.resolve(argv[index + 1]);
}

function writeNewFixture(outputDirectory, fixture) {
  const parent = path.dirname(outputDirectory), leaf = path.basename(outputDirectory);
  if (!leaf || leaf === '.' || leaf === '..' || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error('--output must name a new directory under an existing parent directory.');
  }
  const receiptPath = `${outputDirectory}.receipt.json`;
  if (fs.existsSync(outputDirectory) || fs.existsSync(receiptPath)) throw new Error('Refusing to overwrite an existing fixture directory or receipt.');
  const receipt = Buffer.from(`${JSON.stringify(fixture.receipt, null, 2)}\n`, 'utf8');
  if (fixture.receipt.fixtureBytes + receipt.byteLength > MAX_TOTAL_BYTES) throw new Error('Fixture and receipt together exceed the 1 MiB limit.');
  fs.mkdirSync(outputDirectory);
  for (const [relativePath, bytes] of fixture.files) {
    const destination = path.join(outputDirectory, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const descriptor = fs.openSync(destination, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  }
  const descriptor = fs.openSync(receiptPath, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, receipt); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  return { outputDirectory, receiptPath, fixtureBytes: fixture.receipt.fixtureBytes, receiptBytes: receipt.byteLength };
}

async function main(argv) {
  const fixture = createMeasurementFixture();
  const verified = await verifyMeasurementFixture(fixture);
  const output = parseOutputArgument(argv);
  if (argv.includes('--self-test')) process.stdout.write(`${JSON.stringify({ ...verified, selfTest: 'passed' }, null, 2)}\n`);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node deploy/staging/generate-measurement-fixture.mjs --self-test [--output NEW_DIRECTORY]\n');
    return;
  }
  if (output) process.stdout.write(`${JSON.stringify(writeNewFixture(output, fixture), null, 2)}\n`);
  if (!argv.includes('--self-test') && !output) throw new Error('Use --self-test or provide --output NEW_DIRECTORY.');
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(`measurement fixture: ${error.message}\n`); process.exitCode = 1; });
}
