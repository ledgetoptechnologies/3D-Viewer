'use strict';

const crypto = require('node:crypto');

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_POINTS = 5000;
const CSV_REQUIRED = ['point_id', 'label', 'latitude', 'longitude', 'elevation_m'];

function invalid(message, code = 'invalid_gcp_input') {
  return Object.assign(new Error(message), { code });
}

function text(value, maximum, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw invalid(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${field} must be text`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maximum) throw invalid(`${field} is invalid`);
  return normalized || null;
}

function number(value, field, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum)
    throw invalid(`${field} is outside its accepted range`);
  return parsed;
}

function canonicalPoint(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`point ${index + 1} is invalid`);
  return {
    externalId: text(value.externalId, 120, `point ${index + 1} point_id`, { required: true }),
    label: text(value.label, 160, `point ${index + 1} label`, { required: true }),
    latitude: number(value.latitude, `point ${index + 1} latitude`, -90, 90),
    longitude: number(value.longitude, `point ${index + 1} longitude`, -180, 180),
    elevationM: number(value.elevationM, `point ${index + 1} elevation_m`, -12000, 100000),
    description: text(value.description, 2000, `point ${index + 1} description`),
  };
}

function validatePoints(points) {
  if (!Array.isArray(points) || !points.length) throw invalid('at least one GCP is required');
  if (points.length > MAX_POINTS) throw invalid(`GCP input exceeds ${MAX_POINTS} points`, 'gcp_input_too_large');
  const result = points.map(canonicalPoint);
  const ids = new Set();
  for (const point of result) {
    const folded = point.externalId.toLocaleLowerCase('en-US');
    if (ids.has(folded)) throw invalid(`duplicate point_id: ${point.externalId}`);
    ids.add(folded);
  }
  return result;
}

function parseCsvRows(source) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') {
      if (value) throw invalid('quote must begin at the start of a CSV field');
      quoted = true;
    } else if (character === ',') {
      row.push(value); value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, '')); value = '';
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
    } else value += character;
  }
  if (quoted) throw invalid('CSV contains an unterminated quoted field');
  row.push(value.replace(/\r$/, ''));
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function parseCsv(source) {
  const rows = parseCsvRows(source.replace(/^\uFEFF/, ''));
  if (rows.length < 2) throw invalid('CSV must include a header and at least one point');
  const headers = rows[0].map((cell) => cell.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw invalid('CSV headers must be unique');
  for (const required of CSV_REQUIRED)
    if (!headers.includes(required)) throw invalid(`CSV is missing required column ${required}`);
  const allowed = new Set([...CSV_REQUIRED, 'description']);
  if (headers.some((header) => !allowed.has(header)))
    throw invalid('CSV contains unsupported columns; use the documented generic-v1 schema');
  return validatePoints(rows.slice(1).map((cells, index) => {
    if (cells.length !== headers.length) throw invalid(`CSV row ${index + 2} has the wrong number of columns`);
    const record = Object.fromEntries(headers.map((header, column) => [header, cells[column]]));
    return {
      externalId: record.point_id,
      label: record.label,
      latitude: record.latitude,
      longitude: record.longitude,
      elevationM: record.elevation_m,
      description: record.description,
    };
  }));
}

function parseGeoJson(source) {
  let value;
  try { value = JSON.parse(source); }
  catch { throw invalid('GeoJSON is not valid JSON'); }
  if (!value || value.type !== 'FeatureCollection' || !Array.isArray(value.features))
    throw invalid('GeoJSON must be a FeatureCollection');
  return validatePoints(value.features.map((feature, index) => {
    if (!feature || feature.type !== 'Feature' || feature.geometry?.type !== 'Point' ||
      !Array.isArray(feature.geometry.coordinates) || feature.geometry.coordinates.length < 3)
      throw invalid(`GeoJSON feature ${index + 1} must be a 3D Point`);
    const properties = feature.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties))
      throw invalid(`GeoJSON feature ${index + 1} requires properties`);
    return {
      externalId: properties.point_id,
      label: properties.label,
      longitude: feature.geometry.coordinates[0],
      latitude: feature.geometry.coordinates[1],
      elevationM: feature.geometry.coordinates[2],
      description: properties.description,
    };
  }));
}

function parseGcpInterchange({ format, content }) {
  if (!['generic-csv-v1', 'generic-geojson-v1'].includes(format))
    throw invalid('unsupported GCP format; Emlid imports require a representative sample', 'unsupported_gcp_format');
  if (typeof content !== 'string' || !content.trim()) throw invalid('GCP content is required');
  if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES)
    throw invalid('GCP input is too large', 'gcp_input_too_large');
  const points = format === 'generic-csv-v1' ? parseCsv(content) : parseGeoJson(content);
  return {
    crs: 'EPSG:4326',
    elevationUnits: 'm',
    sourceSha256: crypto.createHash('sha256').update(content, 'utf8').digest('hex'),
    points,
  };
}

module.exports = {
  CSV_REQUIRED,
  MAX_POINTS,
  MAX_SOURCE_BYTES,
  parseGcpInterchange,
};
