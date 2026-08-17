'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseGcpInterchange } = require('../server/gcpImport');

test('generic CSV GCP interchange normalizes EPSG:4326 coordinates and metric elevations', () => {
  const parsed = parseGcpInterchange({
    format: 'generic-csv-v1',
    content: 'point_id,label,latitude,longitude,elevation_m,description\nGCP-01,"North, target",44.5001,-88.1002,243.84,"painted nail"\n',
  });
  assert.equal(parsed.crs, 'EPSG:4326');
  assert.equal(parsed.elevationUnits, 'm');
  assert.match(parsed.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(parsed.points, [{
    externalId: 'GCP-01', label: 'North, target', latitude: 44.5001,
    longitude: -88.1002, elevationM: 243.84, description: 'painted nail',
  }]);
});

test('generic GeoJSON GCP interchange requires 3D Point features', () => {
  const parsed = parseGcpInterchange({
    format: 'generic-geojson-v1',
    content: JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { point_id: 'A', label: 'Target A' },
        geometry: { type: 'Point', coordinates: [-88.1, 44.5, 250] },
      }],
    }),
  });
  assert.equal(parsed.points[0].longitude, -88.1);
  assert.equal(parsed.points[0].elevationM, 250);
  assert.throws(() => parseGcpInterchange({
    format: 'generic-geojson-v1',
    content: JSON.stringify({ type: 'FeatureCollection', features: [{
      type: 'Feature', properties: { point_id: 'A', label: 'A' },
      geometry: { type: 'Point', coordinates: [-88.1, 44.5] },
    }] }),
  }), /3D Point/);
});

test('generic GCP parser rejects guessed vendor schemas, extra columns, duplicate IDs and invalid ranges', () => {
  assert.throws(() => parseGcpInterchange({ format: 'emlid-csv', content: 'Name,Lat,Lon\nA,1,2' }), (error) => error.code === 'unsupported_gcp_format');
  assert.throws(() => parseGcpInterchange({
    format: 'generic-csv-v1',
    content: 'point_id,label,latitude,longitude,elevation_m,unknown\nA,A,44,-88,1,value\n',
  }), /unsupported columns/);
  assert.throws(() => parseGcpInterchange({
    format: 'generic-csv-v1',
    content: 'point_id,label,latitude,longitude,elevation_m\nA,A,44,-88,1\na,B,44,-88,1\n',
  }), /duplicate point_id/);
  assert.throws(() => parseGcpInterchange({
    format: 'generic-csv-v1',
    content: 'point_id,label,latitude,longitude,elevation_m\nA,A,91,-88,1\n',
  }), /latitude/);
});
