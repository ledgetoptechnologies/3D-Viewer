// Central place for reading/validating server configuration from the
// environment. Keep this the only file that touches process.env directly so
// the rest of the server can be tested/reasoned about without env leakage.
'use strict';

const path = require('path');

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v);
}

const config = {
  port: parseInt(process.env.PORT || '8080', 10),

  // WebODM REST API (metadata only — never the WebODM Postgres DB directly).
  webodmApiUrl: (process.env.WEBODM_API_URL || '').replace(/\/+$/, ''),
  webodmUsername: process.env.WEBODM_USERNAME || '',
  webodmPassword: process.env.WEBODM_PASSWORD || '',

  // Read-only mount of WebODM's media/output storage (see docker-compose.yml).
  // Expected layout: {webodmMediaMount}/project/{projectId}/task/{taskId}/assets/...
  webodmMediaMount: process.env.WEBODM_MEDIA_MOUNT || '',

  // Optional writable mount for LOD derivatives (tileset.json/B3DM, EPT,
  // Draco GLB, viewer.json georeference overrides) that are NOT produced by
  // WebODM itself. Kept separate from WebODM's own directories so WebODM
  // cleanup/upgrades can never touch it. May be absent for MVP projects that
  // only show WebODM's native outputs.
  derivativesMount: process.env.DERIVATIVES_MOUNT || '',

  // Where the viewer's own small JSON metadata store lives (never a copy of
  // WebODM's DB — just cached sync results + viewer-only fields).
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),

  syncIntervalMinutes: parseFloat(process.env.SYNC_INTERVAL_MINUTES || '10'),
  syncOnStartup: bool(process.env.SYNC_ON_STARTUP, true),

  // Where the built frontend lives at runtime.
  distDir: process.env.DIST_DIR || path.join(__dirname, '..', 'dist'),
};

function validate() {
  const problems = [];
  if (!config.webodmApiUrl) problems.push('WEBODM_API_URL is required (e.g. https://webodm.example.com)');
  if (!config.webodmUsername) problems.push('WEBODM_USERNAME is required (use a dedicated read-only WebODM account)');
  if (!config.webodmPassword) problems.push('WEBODM_PASSWORD is required');
  if (!config.webodmMediaMount) problems.push('WEBODM_MEDIA_MOUNT is required (read-only bind mount of WebODM media/output storage)');
  return problems;
}

module.exports = { config, validate };
