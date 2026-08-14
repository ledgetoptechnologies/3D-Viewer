'use strict';

const express = require('express');
const path = require('path');
const { config, validate } = require('./config');
const apiRouter = require('./api');
const assetsRouter = require('./assets');
const { startScheduler } = require('./sync');

const problems = validate();
if (problems.length) {
  console.error('Invalid server configuration:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');

app.use(apiRouter);
app.use(assetsRouter);

// Built frontend (npx vite build -> dist/). In local dev, Vite's own dev
// server (npm run dev) proxies /api and /assets to this server instead —
// see vite.config.js.
app.use(express.static(config.distDir));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/assets/')) return next();
  res.sendFile(path.join(config.distDir, 'index.html'), (err) => { if (err) next(err); });
});

startScheduler();

app.listen(config.port, () => {
  console.log(`LTDS 3D Viewer server listening on :${config.port}`);
  console.log(`WebODM API: ${config.webodmApiUrl}`);
  console.log(`WebODM media mount: ${config.webodmMediaMount}`);
  if (config.derivativesMount) console.log(`Derivatives mount: ${config.derivativesMount}`);
});
