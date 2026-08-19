'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_STATS_BYTES = 8 * 1024 * 1024;
const MAX_PROJ_BYTES = 16 * 1024;

function optionalRegularFile(root, relativePath, maxBytes) {
  let current = path.resolve(root);
  for (const part of relativePath.split('/')) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) return null;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) return null;
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.size > maxBytes) return null;
  return current;
}

function firstOptionalRegularFile(root, relativePath, maxBytes) {
  return optionalRegularFile(root, relativePath, maxBytes)
    || optionalRegularFile(root, `assets/${relativePath}`, maxBytes);
}

function finiteNonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safePointCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function parseCrs(projText) {
  const raw = String(projText || '').trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 4096);
  if (!raw) return {};
  const epsg = raw.match(/(?:EPSG[:=]|\+init=epsg:)(\d{3,6})/i)?.[1];
  const zone = raw.match(/(?:^|\s)\+zone=(\d{1,2})(?:\s|$)/)?.[1];
  const south = /(?:^|\s)\+south(?:\s|$)/.test(raw);
  const wgs84 = /(?:^|\s)\+(?:datum=WGS84|ellps=WGS84)(?:\s|$)/i.test(raw);
  let crs = epsg ? `EPSG:${epsg}` : null;
  if (!crs && zone && /(?:^|\s)\+proj=utm(?:\s|$)/.test(raw)) crs = `${wgs84 ? 'WGS 84 / ' : ''}UTM zone ${Number(zone)}${south ? 'S' : 'N'}`;
  return { ...(crs ? { crs } : {}), proj: raw, ...(epsg ? { epsg: Number(epsg) } : {}) };
}

function readOdmTaskMetadata(root) {
  const result = { processingMetrics: {}, georef: {}, pointCount: null };
  const statsPath = firstOptionalRegularFile(root, 'odm_report/stats.json', MAX_STATS_BYTES);
  if (statsPath) {
    try {
      const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      const dense = stats?.point_cloud_statistics?.dense === true;
      const denseCount = safePointCount(stats?.point_cloud_statistics?.stats?.statistic?.[0]?.count);
      const sparseCount = safePointCount(stats?.reconstruction_statistics?.reconstructed_points_count);
      result.pointCount = dense && denseCount !== null ? denseCount : sparseCount;
      const averageGsdCm = finiteNonnegative(stats?.odm_processing_statistics?.average_gsd);
      const surveyedAreaM2 = finiteNonnegative(stats?.processing_statistics?.area);
      const startDate = typeof stats?.processing_statistics?.start_date === 'string' ? stats.processing_statistics.start_date.slice(0, 64) : null;
      const endDate = typeof stats?.processing_statistics?.end_date === 'string' ? stats.processing_statistics.end_date.slice(0, 64) : null;
      result.processingMetrics = {
        ...(averageGsdCm !== null ? { averageGsdM: averageGsdCm / 100 } : {}),
        ...(surveyedAreaM2 !== null ? { surveyedAreaM2 } : {}),
        ...(result.pointCount !== null ? { reconstructedPointCount: result.pointCount } : {}),
        ...(startDate ? { processingStartedAt: startDate } : {}),
        ...(endDate ? { processingEndedAt: endDate } : {}),
      };
    } catch {
      // ODM statistics are optional metadata. Malformed files must not block
      // recovery of otherwise valid processing outputs.
    }
  }
  const projPath = firstOptionalRegularFile(root, 'odm_georeferencing/proj.txt', MAX_PROJ_BYTES);
  if (projPath) {
    try { result.georef = parseCrs(fs.readFileSync(projPath, 'utf8')); } catch { /* optional metadata */ }
  }
  return result;
}

module.exports = { MAX_PROJ_BYTES, MAX_STATS_BYTES, parseCrs, readOdmTaskMetadata };
