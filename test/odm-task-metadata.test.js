'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MAX_STATS_BYTES, parseCrs, readOdmTaskMetadata } = require('../server/odmTaskMetadata');

function root(t) {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-metadata-'));
  t.after(() => fs.rmSync(value, { recursive: true, force: true }));
  fs.mkdirSync(path.join(value, 'odm_report'), { recursive: true });
  fs.mkdirSync(path.join(value, 'odm_georeferencing'), { recursive: true });
  return value;
}

test('reads authoritative WebODM-compatible statistics and projected CRS', (t) => {
  const directory = root(t);
  fs.writeFileSync(path.join(directory, 'odm_report', 'stats.json'), JSON.stringify({
    point_cloud_statistics: { dense: true, stats: { statistic: [{ count: 428498832 }] } },
    reconstruction_statistics: { reconstructed_points_count: 1234 },
    odm_processing_statistics: { average_gsd: 0.3048 },
    processing_statistics: { area: 115092.96, start_date: '2026-08-04T22:00:00Z', end_date: '2026-08-06T06:45:44Z' },
  }));
  fs.writeFileSync(path.join(directory, 'odm_georeferencing', 'proj.txt'), '+proj=utm +zone=16 +datum=WGS84 +units=m +no_defs');
  const value = readOdmTaskMetadata(directory);
  assert.ok(Math.abs(value.processingMetrics.averageGsdM - 0.003048) < 1e-12);
  assert.equal(value.processingMetrics.surveyedAreaM2, 115092.96);
  assert.equal(value.pointCount, 428498832);
  assert.equal(value.processingMetrics.reconstructedPointCount, 428498832);
  assert.equal(value.georef.crs, 'WGS 84 / UTM zone 16N');
});

test('falls back to sparse reconstruction count and ignores malformed optional metadata', (t) => {
  const directory = root(t);
  fs.writeFileSync(path.join(directory, 'odm_report', 'stats.json'), JSON.stringify({
    point_cloud_statistics: { dense: false },
    reconstruction_statistics: { reconstructed_points_count: 8123 },
  }));
  assert.equal(readOdmTaskMetadata(directory).pointCount, 8123);
  fs.writeFileSync(path.join(directory, 'odm_report', 'stats.json'), '{bad json');
  assert.deepEqual(readOdmTaskMetadata(directory), { processingMetrics: {}, georef: {}, pointCount: null });
  fs.writeFileSync(path.join(directory, 'odm_report', 'stats.json'), Buffer.alloc(MAX_STATS_BYTES + 1));
  assert.deepEqual(readOdmTaskMetadata(directory), { processingMetrics: {}, georef: {}, pointCount: null });
});

test('CRS parser preserves bounded source projection and handles southern UTM', () => {
  assert.deepEqual(parseCrs('+proj=utm +zone=55 +south +ellps=WGS84 +units=m'), {
    crs: 'WGS 84 / UTM zone 55S',
    proj: '+proj=utm +zone=55 +south +ellps=WGS84 +units=m',
  });
  assert.equal(parseCrs('EPSG:32616').epsg, 32616);
});
