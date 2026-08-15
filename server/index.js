'use strict';

const express = require('express');
const path = require('path');
const cookie = require('cookie');
const { config, validate } = require('./config');
const apiRouter = require('./api');
const assetsRouter = require('./assets');
const adminAuth = require('./adminAuth');
const shareApi = require('./shareApi');
const { startScheduler } = require('./sync');

const problems = validate();
if (problems.length) {
  console.error('Invalid server configuration:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
if (config.sessionSecretGenerated) {
  console.warn('[warn] SESSION_SECRET not set — using a random secret for this process. ' +
    'All admin/share sessions will be invalidated on restart. Set SESSION_SECRET for production.');
}

const app = express();
app.disable('x-powered-by');
// Required so req.secure / req.ip reflect X-Forwarded-* from a reverse proxy
// (nginx/Caddy in front of this container) instead of the proxy's own connection.
app.set('trust proxy', true);

app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  req.cookies = cookie.parse(req.headers.cookie || '');
  next();
});

app.use(adminAuth.router);
app.use(shareApi);
app.use(apiRouter);
app.use(assetsRouter);

// Built frontend (npx vite build -> dist/). In local dev, Vite's own dev
// server (npm run dev) proxies /api and /assets to this server instead —
// see vite.config.js.
// `index: false` is important here: express.static's default behavior would
// otherwise serve dist/index.html directly for GET '/', bypassing the admin
// login gate in the catch-all route below.
app.use(express.static(config.distDir, { index: false }));

// `/view/:token` and `/embed/:token` are public — access control happens
// client-side/API-side via the token (see server/shareApi.js). Every other
// path is the internal/admin app and requires a logged-in admin session;
// unauthenticated visitors get a minimal login page instead of the SPA.
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/assets/')) return next();
  const isShareRoute = req.path.startsWith('/view/') || req.path.startsWith('/embed/');
  if (!isShareRoute && !adminAuth.isAdminRequest(req)) {
    return res.sendFile(path.join(config.distDir, 'admin-login.html'), (err) => { if (err) next(err); });
  }
  res.sendFile(path.join(config.distDir, 'index.html'), (err) => { if (err) next(err); });
});

startScheduler();

app.listen(config.port, () => {
  console.log(`LTDS 3D Viewer server listening on :${config.port}`);
  console.log(`WebODM API: ${config.webodmApiUrl}`);
  console.log(`WebODM media mount: ${config.webodmMediaMount}`);
  if (config.derivativesMount) console.log(`Derivatives mount: ${config.derivativesMount}`);
});
