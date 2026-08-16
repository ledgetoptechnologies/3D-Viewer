// Centralized, fail-closed server configuration. Application modules consume
// this object instead of reading process.env directly.
'use strict';

const crypto = require('crypto');
const path = require('path');

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function csv(value) {
  return String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function normalizedOrigin(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return '';
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch {
    return '';
  }
}

const environment = process.env.NODE_ENV || 'development';
const production = environment === 'production';
let sessionSecret = process.env.SESSION_SECRET || '';
let sessionSecretGenerated = false;
if (!sessionSecret && !production) {
  sessionSecret = crypto.randomBytes(32).toString('hex');
  sessionSecretGenerated = true;
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const publicBaseUrl = normalizedOrigin(process.env.PUBLIC_BASE_URL || '');
let serviceAuthKeys = null;
let serviceAuthKeysError = null;
if (process.env.SERVICE_AUTH_KEYS_JSON) {
  try {
    const parsed = JSON.parse(process.env.SERVICE_AUTH_KEYS_JSON);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('must be a JSON object');
    serviceAuthKeys = Object.fromEntries(Object.entries(parsed).map(([key, value]) => [String(key), String(value)]));
  } catch (error) {
    serviceAuthKeysError = error.message;
    serviceAuthKeys = {};
  }
}
const previousServiceKeyId = String(process.env.SERVICE_AUTH_PREVIOUS_KEY_ID || '').trim();
const previousServiceSecret = process.env.SERVICE_AUTH_PREVIOUS_SECRET || '';
if (!serviceAuthKeys && (previousServiceKeyId || previousServiceSecret)) {
  serviceAuthKeys = {
    [String(process.env.SERVICE_AUTH_KEY_ID || 'ops-v1').trim()]: process.env.SERVICE_AUTH_SECRET || '',
  };
  if (previousServiceKeyId && previousServiceSecret) serviceAuthKeys[previousServiceKeyId] = previousServiceSecret;
}

const config = {
  environment,
  production,
  port: positiveInteger(process.env.PORT, 8080),
  expectedHost: String(process.env.EXPECTED_HOST || '').trim().toLowerCase(),
  publicBaseUrl,
  opsBaseUrl: normalizedOrigin(process.env.OPS_BASE_URL || 'https://ops.ledgetopdroneservices.com'),
  allowedEmbedOrigins: csv(process.env.ALLOWED_EMBED_ORIGINS).map(normalizedOrigin).filter(Boolean),
  trustProxyHops: Math.min(positiveInteger(process.env.TRUST_PROXY_HOPS, 1), 5),

  dataDir,
  databasePath: process.env.DATABASE_PATH || path.join(dataDir, 'viewer.sqlite'),
  distDir: process.env.DIST_DIR || path.join(__dirname, '..', 'dist'),

  sessionSecret,
  sessionSecretGenerated,
  viewerSessionTtlSeconds: Math.min(positiveInteger(process.env.VIEWER_SESSION_TTL_SECONDS, 1800), 3600),
  sessionGrantTtlSeconds: Math.min(positiveInteger(process.env.SESSION_GRANT_TTL_SECONDS, 60), 300),

  serviceAuthKeyId: String(process.env.SERVICE_AUTH_KEY_ID || 'ops-v1').trim(),
  serviceAuthSecret: process.env.SERVICE_AUTH_SECRET || '',
  serviceAuthKeys,
  serviceAuthKeysError,
  previousServiceKeyId,
  previousServiceSecret,
  serviceAuthSkewSeconds: Math.min(positiveInteger(process.env.SERVICE_AUTH_SKEW_SECONDS, 300), 600),

  emergencyAdminEnabled: bool(process.env.EMERGENCY_ADMIN_ENABLED, !production),
  adminPassword: process.env.ADMIN_PASSWORD || '',

  webodmEnabled: bool(process.env.WEBODM_ENABLED, true),
  webodmApiUrl: (process.env.WEBODM_API_URL || '').replace(/\/+$/, ''),
  webodmUsername: process.env.WEBODM_USERNAME || '',
  webodmPassword: process.env.WEBODM_PASSWORD || '',
  webodmMediaMount: process.env.WEBODM_MEDIA_MOUNT || '',
  webodmRequestTimeoutMs: Math.min(positiveInteger(process.env.WEBODM_REQUEST_TIMEOUT_MS, 15000), 120000),
  derivativesMount: process.env.DERIVATIVES_MOUNT || '',
  terraImportMount: process.env.TERRA_IMPORT_MOUNT || '',
  syncIntervalMinutes: Number.parseFloat(process.env.SYNC_INTERVAL_MINUTES || '10'),
  syncOnStartup: bool(process.env.SYNC_ON_STARTUP, true),

  // When set, authorized files are handed to an internal Nginx location via
  // X-Accel-Redirect. When absent, Express sendFile remains available for
  // local development and tests.
  xAccelRedirectPrefix: String(process.env.X_ACCEL_REDIRECT_PREFIX || '').replace(/\/+$/, ''),
};

function validate() {
  const problems = [];
  if (!Number.isFinite(config.syncIntervalMinutes) || config.syncIntervalMinutes <= 0)
    problems.push('SYNC_INTERVAL_MINUTES must be a positive number');
  if (config.production && !config.publicBaseUrl)
    problems.push('PUBLIC_BASE_URL must be an exact HTTPS origin');
  if (config.production && !config.expectedHost)
    problems.push('EXPECTED_HOST is required in production');
  if (config.production && !config.opsBaseUrl)
    problems.push('OPS_BASE_URL must be an exact HTTPS origin');
  if (config.production && config.allowedEmbedOrigins.length === 0)
    problems.push('ALLOWED_EMBED_ORIGINS must include the exact Ops/client origin in production');
  if (!config.sessionSecret || config.sessionSecret.length < 32)
    problems.push('SESSION_SECRET must contain at least 32 characters');
  if (config.serviceAuthKeysError) problems.push(`SERVICE_AUTH_KEYS_JSON ${config.serviceAuthKeysError}`);
  if (Boolean(config.previousServiceKeyId) !== Boolean(config.previousServiceSecret))
    problems.push('SERVICE_AUTH_PREVIOUS_KEY_ID and SERVICE_AUTH_PREVIOUS_SECRET must be configured together');
  const configuredKeys = config.serviceAuthKeys || { [config.serviceAuthKeyId]: config.serviceAuthSecret };
  if (!Object.keys(configuredKeys).length)
    problems.push('at least one service authentication key is required');
  for (const [keyId, secret] of Object.entries(configuredKeys)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId))
      problems.push(`service key id ${keyId} is invalid`);
    if (secret.length < 32) problems.push(`service auth secret for ${keyId} must contain at least 32 characters`);
  }
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.serviceAuthKeyId))
    problems.push('SERVICE_AUTH_KEY_ID must contain only letters, numbers, dot, underscore, or hyphen');
  if (config.emergencyAdminEnabled && config.adminPassword.length < 16)
    problems.push('ADMIN_PASSWORD must contain at least 16 characters when emergency admin access is enabled');
  if (config.webodmEnabled) {
    if (!config.webodmApiUrl) problems.push('WEBODM_API_URL is required when WEBODM_ENABLED=true');
    if (!config.webodmUsername) problems.push('WEBODM_USERNAME is required when WEBODM_ENABLED=true');
    if (!config.webodmPassword) problems.push('WEBODM_PASSWORD is required when WEBODM_ENABLED=true');
    if (!config.webodmMediaMount) problems.push('WEBODM_MEDIA_MOUNT is required when WEBODM_ENABLED=true');
  }
  return problems;
}

module.exports = { bool, config, csv, normalizedOrigin, positiveInteger, validate };
