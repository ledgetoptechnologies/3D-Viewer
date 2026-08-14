// Serves files from the read-only WebODM mount / derivatives mount without
// ever exposing real filesystem paths to the client. The frontend only ever
// sees `/assets/:projectId/:root/<relative path>` URLs.
'use strict';

const path = require('path');
const express = require('express');
const store = require('./store');

const router = express.Router();

// Resolve `relPath` under `root`, refusing anything that escapes it.
function safeResolve(root, relPath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.sep}${relPath}`);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

router.get('/assets/:id/:root/*', (req, res) => {
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
