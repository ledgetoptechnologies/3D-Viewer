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
const { VIEWER_COOKIE } = require('./apiV1');
const { config } = require('./config');

const router = express.Router();
let canonicalRepository = null;

function setRepository(repository) {
  canonicalRepository = repository;
}

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

  const viewerCookie = req.cookies && req.cookies[VIEWER_COOKIE];
  const viewer = viewerCookie && canonicalRepository
    ? canonicalRepository.getViewerSessionByHash(auth.hashToken(viewerCookie))
    : null;
  if (canonicalRepository?.viewerSessionLive(viewer) && viewer.permissions?.view !== false) {
    const requestedModelId = canonicalRepository.resolveModelId(projectId);
    const model = requestedModelId ? canonicalRepository.getModel(requestedModelId) : null;
    if (requestedModelId
      && requestedModelId === viewer.modelId
      && model?.status === 'ready'
      && model.activeVersionId === viewer.modelVersionId) return true;
  }

  const cookieVal = req.cookies && req.cookies[SHARE_COOKIE];
  const payload = cookieVal ? auth.verify(cookieVal) : null;
  if (!payload) return false;
  if (payload.modelId && canonicalRepository) {
    const requestedModelId = canonicalRepository.resolveModelId(projectId);
    const share = canonicalRepository.getPublicShare(payload.shareId);
    return requestedModelId === payload.modelId
      && canonicalRepository.publicShareLive(share)
      && share.modelId === payload.modelId;
  }
  if (payload.viewerProjectId !== projectId) return false;
  const legacyShare = shareStore.getById(payload.shareId);
  return shareStore.isLive(legacyShare) && legacyShare.viewerProjectId === projectId;
}

function canonicalAssetRoot(model, rootKey) {
  const source = model && model.activeVersion && model.activeVersion.sourceLocator || {};
  const legacyRoot = source.legacyAssetRoots && source.legacyAssetRoots[rootKey];
  if (legacyRoot) return legacyRoot;
  if (model.provider === 'webodm' && source.projectId !== null && source.taskId !== null) {
    if (rootKey === 'webodm') {
      return path.join(config.webodmMediaMount, 'project', String(source.projectId), 'task', String(source.taskId), 'assets');
    }
    if (rootKey === 'derivatives' && config.derivativesMount) {
      return path.join(config.derivativesMount, `${source.projectId}-${source.taskId}`);
    }
  }
  return null;
}

function resolveProject(projectId, rootKey) {
  const project = store.getById(projectId);
  if (project) return { project, rootPath: project.assetRoots && project.assetRoots[rootKey] };
  if (!canonicalRepository) return { project: null, rootPath: null };
  const model = canonicalRepository.getModel(projectId);
  return { project: model, rootPath: canonicalAssetRoot(model, rootKey) };
}

function pathTokenAuthorized(req, projectId) {
  if (!canonicalRepository) return false;
  const requestedModelId = canonicalRepository.resolveModelId(projectId);
  if (!requestedModelId) return false;
  const viewer = canonicalRepository.getViewerSessionByHash(auth.hashToken(req.params.token));
  if (canonicalRepository.viewerSessionLive(viewer)) {
    const model = canonicalRepository.getModel(requestedModelId);
    return viewer.permissions?.view !== false
      && viewer.modelId === requestedModelId
      && model?.status === 'ready'
      && model.activeVersionId === viewer.modelVersionId;
  }
  const payload = auth.verify(req.params.token);
  if (!payload) return false;
  if (payload.kind === 'share-asset') {
    if (payload.modelId) {
      const share = canonicalRepository.getPublicShare(payload.shareId);
      const model = canonicalRepository.getModel(requestedModelId);
      return payload.modelId === requestedModelId
        && canonicalRepository.publicShareLive(share)
        && share.modelId === requestedModelId
        && model?.status === 'ready'
        && (share.versionPolicy !== 'pinned' || share.modelVersionId === model.activeVersionId);
    }
    const share = shareStore.getById(payload.shareId);
    return shareStore.isLive(share) && share.viewerProjectId === projectId;
  }
  return false;
}

function xAccelLocation(abs) {
  if (!config.xAccelRedirectPrefix) return null;
  const roots = [
    ['webodm', config.webodmMediaMount],
    ['derivatives', config.derivativesMount],
    ['terra', config.terraImportMount],
  ];
  for (const [name, root] of roots) {
    if (!root) continue;
    const relative = path.relative(path.resolve(root), abs);
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) {
      const encoded = relative.split(path.sep).map(encodeURIComponent).join('/');
      return `${config.xAccelRedirectPrefix}/${name}/${encoded}`;
    }
  }
  return null;
}

function sendAsset(req, res) {
  const { project, rootPath } = resolveProject(req.params.id, req.params.root);
  if (!project) return res.status(404).json({ error: 'unknown project' });
  if (!rootPath) return res.status(404).json({ error: 'unknown asset root' });

  const rel = req.params[0] || '';
  const abs = safeResolve(rootPath, rel);
  if (!abs) return res.status(400).json({ error: 'invalid path' });

  // Authorization/revocation is evaluated for every request. Prevent an
  // intermediary or browser cache from serving a previously authorized URL
  // after its session/share has expired or been revoked.
  res.setHeader('Cache-Control', 'private, no-store');

  const accelerated = xAccelLocation(abs);
  if (accelerated) {
    res.setHeader('X-Accel-Redirect', accelerated);
    return res.end();
  }
  return res.sendFile(abs, (err) => {
    if (err && !res.headersSent) {
      res.status(err.status || 404).json({ error: 'asset not found' });
    }
  });
}

router.get('/assets/:id/:root/*', (req, res) => {
  if (!isAuthorizedForProject(req, req.params.id)) {
    return res.status(403).json({ error: 'not authorized' });
  }
  return sendAsset(req, res);
});

// Capability URL used by embedded Viewer sessions and public shares. Keeping
// the scoped browser credential in the asset URL makes iframe delivery work
// even when the browser blocks third-party cookies. Relative 3D Tiles/EPT
// children inherit this path prefix automatically.
router.get('/session-assets/:token/:id/:root/*', (req, res) => {
  if (!pathTokenAuthorized(req, req.params.id)) return res.status(403).json({ error: 'not authorized' });
  return sendAsset(req, res);
});

module.exports = router;
module.exports.setRepository = setRepository;
module.exports.safeResolve = safeResolve;
module.exports.xAccelLocation = xAccelLocation;
