// Serves files from the read-only WebODM mount / derivatives mount without
// ever exposing real filesystem paths to the client. The frontend only ever
// sees `/assets/:projectId/:root/<relative path>` URLs.
'use strict';

const path = require('path');
const express = require('express');
const store = require('./store');
const shareStore = require('./shareStore');
const auth = require('./auth');
const { isAdminRequest } = require('./adminAuth');
const { SHARE_COOKIE } = require('./shareApi');

const router = express.Router();

// Resolve `relPath` under `root`, refusing anything that escapes it.
function safeResolve(root, relPath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.sep}${relPath}`);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

// Authorized if the caller is an admin, OR has a valid share session for
// THIS exact project. The referenced share is looked up live on every
// request (cheap in-memory check) so revoking it takes effect immediately
// instead of waiting out the session cookie's TTL.
function isAuthorizedForProject(req, projectId) {
  if (isAdminRequest(req)) return true;
  const cookieVal = req.cookies && req.cookies[SHARE_COOKIE];
  const payload = cookieVal ? auth.verify(cookieVal) : null;
  if (!payload || payload.viewerProjectId !== projectId) return false;
  const share = shareStore.getById(payload.shareId);
  return shareStore.isLive(share) && share.viewerProjectId === projectId;
}

router.get('/assets/:id/:root/*', (req, res) => {
  if (!isAuthorizedForProject(req, req.params.id)) {
    return res.status(403).json({ error: 'not authorized' });
  }
  const project = store.getById(req.params.id);
  if (!project) return res.status(404).json({ error: 'unknown project' });

  const rootKey = req.params.root;
  const rootPath = project.assetRoots && project.assetRoots[rootKey];
  if (!rootPath) return res.status(404).json({ error: 'unknown asset root' });

  const rel = req.params[0] || '';
  const abs = safeResolve(rootPath, rel);
  if (!abs) return res.status(400).json({ error: 'invalid path' });

  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      res.status(err.status || 404).json({ error: 'asset not found' });
    }
  });
});

module.exports = router;
