'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const cookie = require('cookie');
const { config, validate } = require('./config');
const apiRouter = require('./api');
const assetsRouter = require('./assets');
const adminAuth = require('./adminAuth');
const shareApi = require('./shareApi');
const { startScheduler } = require('./sync');
const sync = require('./sync');
const { openDatabase } = require('./database');
const { ViewerRepository } = require('./repository');
const { migrateLegacyJson } = require('./legacyMigration');
const { createApiV1 } = require('./apiV1');

const problems = validate();
if (problems.length) {
  console.error('Invalid server configuration:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
if (config.sessionSecretGenerated) {
  console.warn('[warn] SESSION_SECRET not set — using a random secret for this process. ' +
    'All admin/share sessions will be invalidated on restart. Set SESSION_SECRET for production.');
}

// The named volume is empty on first deployment. Create the application-owned
// directory before readiness checks or metadata/database initialization.
try {
  fs.mkdirSync(config.dataDir, { recursive: true });
} catch (error) {
  console.error(`Cannot initialize viewer data directory: ${error.message}`);
  process.exit(1);
}

let database;
let repository;
try {
  database = openDatabase(config.databasePath);
  repository = new ViewerRepository(database);
  const migration = migrateLegacyJson(repository, config.dataDir);
  if (!migration.skipped && (migration.models || migration.shares)) {
    console.log('[migration] imported legacy registry:', JSON.stringify(migration));
  }
  sync.setRepository(repository);
  shareApi.setRepository(repository);
  assetsRouter.setRepository(repository);
} catch (error) {
  console.error(`Cannot initialize viewer database: ${error.message}`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
// Required so req.secure / req.ip reflect X-Forwarded-* from a reverse proxy
// (nginx/Caddy in front of this container) instead of the proxy's own connection.
app.set('trust proxy', config.trustProxyHops);

const frameAncestors = ["'self'", ...config.allowedEmbedOrigins].join(' ');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // Legacy Potree/admin shells still contain fixed inline bootstrap scripts.
    // Third-party script origins remain forbidden.
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://server.arcgisonline.com https://ledgetopdroneservices.com",
    "connect-src 'self' https://server.arcgisonline.com",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${frameAncestors}`,
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Session/share capability URLs can appear in nested model requests; never
  // forward them as a Referer to another request or origin.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Refuse production requests addressed to an unexpected virtual host. This
// prevents proxy/header confusion from leaking absolute URLs or cookies onto
// a sibling host behind the same reverse proxy.
app.use((req, res, next) => {
  const localProbe = req.path === '/api/v1/health' || req.path === '/api/v1/ready';
  if (config.production && !localProbe) {
    const host = String(req.headers.host || '').split(':', 1)[0].toLowerCase();
    if (host !== config.expectedHost) return res.status(421).json({ error: 'unexpected host' });
  }
  next();
});

app.get('/api/v1/health', (_req, res) => res.json({ ok: true }));
app.get('/api/v1/ready', (_req, res) => {
  const missing = [];
  try {
    fs.accessSync(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    missing.push('viewer data directory');
  }
  try {
    database.prepare('SELECT 1').get();
  } catch {
    missing.push('viewer database');
  }
  if (config.webodmEnabled) {
    try {
      fs.accessSync(config.webodmMediaMount, fs.constants.R_OK);
    } catch {
      missing.push('WebODM media mount');
    }
  }
  res.status(missing.length ? 503 : 200).json({ ok: missing.length === 0, missing });
});

app.use(express.json({
  limit: '100kb',
  verify(req, _res, buffer) {
    // HMAC verification must hash the exact octets Ops sent, not a
    // re-serialized JavaScript object.
    req.rawBody = Buffer.from(buffer);
  },
}));
app.use((req, res, next) => {
  req.cookies = cookie.parse(req.headers.cookie || '');
  next();
});

app.use(adminAuth.router);
app.use(shareApi);
app.use(createApiV1(repository));
app.use(apiRouter);
app.use(assetsRouter);

// Prevent direct requests for the legacy standalone shells from bypassing the
// Ops redirect through express.static when local administration is disabled.
app.get(['/index.html', '/admin-login.html'], (_req, res, next) => {
  if (config.emergencyAdminEnabled) return next();
  return res.redirect(302, config.opsBaseUrl);
});

// Built frontend (npx vite build -> dist/). In local dev, Vite's own dev
// server (npm run dev) proxies /api and /assets to this server instead —
// see vite.config.js.
// `index: false` is important here: express.static's default behavior would
// otherwise serve dist/index.html directly for GET '/', bypassing the admin
// login gate in the catch-all route below.
app.use(express.static(config.distDir, { index: false }));

// `/view/:token` and `/embed/:token` are public — access control happens
// API-side via the token (see server/shareApi.js). Normal administration lives
// in LTDS Ops, so the standalone password shell is reachable only when the
// explicit emergency switch is enabled.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/assets/') || req.path.startsWith('/session-assets/')) return next();
  const isShareRoute = req.path.startsWith('/view/')
    || req.path.startsWith('/embed/')
    || req.path === '/session'
    || req.path.startsWith('/session/');
  if (!isShareRoute && !config.emergencyAdminEnabled) {
    return res.redirect(302, config.opsBaseUrl);
  }
  if (!isShareRoute && !adminAuth.isAdminRequest(req)) {
    return res.sendFile(path.join(config.distDir, 'admin-login.html'), (err) => { if (err) next(err); });
  }
  res.sendFile(path.join(config.distDir, 'index.html'), (err) => { if (err) next(err); });
});

startScheduler();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    try { database.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}

app.listen(config.port, () => {
  console.log(`LTDS 3D Viewer server listening on :${config.port}`);
  console.log(`WebODM API: ${config.webodmApiUrl}`);
  console.log(`WebODM media mount: ${config.webodmMediaMount}`);
  if (config.derivativesMount) console.log(`Derivatives mount: ${config.derivativesMount}`);
});
