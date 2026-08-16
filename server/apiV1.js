'use strict';

const crypto = require('crypto');
const express = require('express');
const auth = require('./auth');
const { config } = require('./config');
const sync = require('./sync');
const { requireService } = require('./serviceAuth');
const { idempotent } = require('./serviceIdempotency');

const VIEWER_COOKIE = 'ltds_viewer';

function encodedAssetUrl(modelId, asset, assetToken = null) {
  if (!asset) return null;
  const relative = String(asset.relativePath || '').split(/[\\/]+/).map(encodeURIComponent).join('/');
  const prefix = assetToken
    ? `/session-assets/${encodeURIComponent(assetToken)}`
    : '/assets';
  return `${prefix}/${encodeURIComponent(modelId)}/${encodeURIComponent(asset.rootKey)}/${relative}`;
}

function toViewerConfig(model, { assetToken = null } = {}) {
  if (!model || !model.activeVersion) return null;
  const byKind = Object.fromEntries(model.activeVersion.assets.map((asset) => [asset.kind, asset]));
  const pointCloud = byKind.pointCloud;
  return {
    id: model.id,
    title: model.displayName,
    projectName: model.metadata.projectName || null,
    status: model.status,
    providerStatus: model.metadata.webodmStatus ?? null,
    statusLabel: String(model.status || '').toUpperCase(),
    available: model.status === 'ready' && model.activeVersion.status === 'ready',
    provider: model.provider,
    georef: model.activeVersion.georef || {},
    pointCount: model.activeVersion.pointCount ?? null,
    lodProvenance: model.metadata.lodProvenance || model.activeVersion.metadata.lodProvenance || null,
    assets: {
      glb: encodedAssetUrl(model.id, byKind.glb, assetToken),
      tiles: encodedAssetUrl(model.id, byKind.tiles, assetToken),
      ept: encodedAssetUrl(model.id, byKind.ept, assetToken),
      obj: encodedAssetUrl(model.id, byKind.obj, assetToken),
      ortho: encodedAssetUrl(model.id, byKind.ortho, assetToken),
      dsm: encodedAssetUrl(model.id, byKind.dsm, assetToken),
      dtm: encodedAssetUrl(model.id, byKind.dtm, assetToken),
      shots: encodedAssetUrl(model.id, byKind.shots, assetToken),
      pointCloud: encodedAssetUrl(model.id, pointCloud, assetToken),
      pointCloudFormat: pointCloud ? pointCloud.format : null,
    },
    activeVersion: {
      id: model.activeVersion.id,
      providerVersionId: model.activeVersion.providerVersionId,
      createdAt: model.activeVersion.createdAt,
      updatedAt: model.activeVersion.updatedAt,
    },
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
  };
}

function publicShareSummary(share) {
  return {
    id: share.id,
    modelId: share.modelId,
    versionPolicy: share.versionPolicy,
    modelVersionId: share.modelVersionId,
    hasPassword: share.hasPassword,
    permissions: share.permissions,
    label: share.label,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    updatedAt: share.updatedAt,
    expiresAt: share.expiresAt,
    displayUnits: share.displayUnits || config.defaultUnits,
    revokedAt: share.revokedAt,
    revokedBy: share.revokedBy,
    revokeReason: share.revokeReason,
    accessCount: share.accessCount,
    lastAccessedAt: share.lastAccessedAt,
  };
}

function permissions(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    view: input.view !== false,
    measure: input.measure !== false,
    cameras: input.cameras !== false,
    download: input.download === true,
  };
}

function validSubject(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}

function createImportWorker(repository) {
  let running = false;
  async function synchronizeWhenAvailable() {
    for (;;) {
      const result = await sync.runSync();
      if (!result.skipped) return result;
      // The scheduler and event-import worker share the same provider sync.
      // Wait instead of falsely failing a durable job merely because the
      // scheduled reconciliation won the startup race.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  async function run() {
    if (running) return;
    running = true;
    try {
      let job;
      while ((job = repository.claimPendingImport())) {
        try {
          if (job.provider !== 'webodm') throw Object.assign(new Error('provider is not implemented'), { code: 'unsupported_provider' });
          const result = await synchronizeWhenAvailable();
          if (result.errors && result.errors.length) throw Object.assign(new Error(result.errors.join('; ')), { code: 'provider_sync_failed' });
          const request = job.request || {};
          const alias = request.projectId !== undefined && request.taskId !== undefined
            ? `webodm-${request.projectId}-${request.taskId}`
            : job.identifier;
          const model = alias === '*' ? null : repository.getModel(String(alias));
          if (alias !== '*' && !model) throw Object.assign(new Error('completed dataset was not found after synchronization'), { code: 'model_not_found' });
          repository.completeImport(job.id, model && model.id);
          repository.audit({ actorType: 'service', actorId: job.createdBy, action: 'import.ready', entityType: 'import', entityId: job.id });
        } catch (error) {
          repository.failImport(job.id, error.code || 'import_failed', error.message || 'Import failed');
          repository.audit({ actorType: 'service', actorId: job.createdBy, action: 'import.failed', entityType: 'import', entityId: job.id, details: { code: error.code || 'import_failed' } });
        }
      }
    } finally {
      running = false;
    }
  }
  return { kick() { setImmediate(run); }, run };
}

function createApiV1(repository) {
  const router = express.Router();
  const serviceOnly = requireService(repository);
  const idempotentService = idempotent(repository);
  const importWorker = createImportWorker(repository);
  // Durable queue rows survive process restarts. Any job claimed by the old
  // process is returned to pending, then all pending work is resumed.
  repository.requeueInterruptedImports();
  importWorker.kick();

  function viewerToken(req) {
    const bearer = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return bearer ? bearer[1] : (req.cookies && req.cookies[VIEWER_COOKIE]);
  }

  function currentViewer(req) {
    const token = viewerToken(req);
    if (!token) return null;
    const session = repository.getViewerSessionByHash(auth.hashToken(token));
    if (!repository.viewerSessionLive(session) || session.permissions?.view === false) return null;
    return { token, session };
  }

  function sendCurrentSession(_req, res, session, accessToken) {
    const model = repository.getModel(session.modelId);
    if (!model || model.status !== 'ready' || model.activeVersionId !== session.modelVersionId)
      return res.status(404).json({ error: 'model version is no longer available' });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      model: toViewerConfig(model, { assetToken: accessToken }),
      permissions: session.permissions,
      sessionId: session.id,
      subject: session.subject,
      audience: session.audience,
      expiresAt: session.expiresAt,
      displayUnits: session.displayUnits || config.defaultUnits,
      accessToken,
      allowedEmbedOrigins: config.allowedEmbedOrigins,
    });
  }

  // Browser-facing endpoints use a one-time, short-lived grant. They never
  // accept or return the LTDS Ops service credential.
  router.post('/api/v1/sessions/redeem', (req, res) => {
    if (auth.rateLimited(`session-redeem:${req.ip}`, 30, 5 * 60 * 1000))
      return res.status(429).json({ error: 'too many attempts, try again later' });
    const grantId = req.body && req.body.grant;
    if (typeof grantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(grantId))
      return res.status(400).json({ error: 'invalid session grant' });
    const existing = currentViewer(req);
    const grant = repository.redeemSessionGrant(grantId);
    if (!grant) return res.status(410).json({ error: 'session grant expired or already redeemed' });
    const authorizedUntilMs = Date.parse(grant.permissions.__authorizedUntil || '');
    const ttlMs = Math.min(
      config.viewerSessionTtlSeconds * 1000,
      Number.isFinite(authorizedUntilMs) ? authorizedUntilMs - Date.now() : config.viewerSessionTtlSeconds * 1000,
    );
    if (ttlMs <= 0) return res.status(410).json({ error: 'LTDS authorization has expired' });
    const model = repository.getModel(grant.modelId);
    if (!model || model.status !== 'ready' || !model.activeVersionId || model.activeVersionId !== grant.permissions.__versionId)
      return res.status(404).json({ error: 'model not found' });
    const grantedPermissions = { ...grant.permissions };
    delete grantedPermissions.__authorizedUntil;
    delete grantedPermissions.__versionId;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    let accessToken;
    let session;
    const canRenew = existing
      && existing.session.modelId === grant.modelId
      && existing.session.modelVersionId === model.activeVersionId
      && existing.session.subject === grant.subject
      && existing.session.audience === grant.audience;
    if (canRenew) {
      accessToken = existing.token;
      session = repository.renewViewerSession(existing.session.id, { permissions: grantedPermissions, displayUnits: grant.displayUnits || config.defaultUnits, expiresAt });
    } else {
      accessToken = crypto.randomBytes(32).toString('base64url');
      session = repository.createViewerSession({
        tokenHash: auth.hashToken(accessToken),
        modelId: grant.modelId,
        modelVersionId: model.activeVersionId,
        subject: grant.subject,
        audience: grant.audience,
        permissions: grantedPermissions,
        displayUnits: grant.displayUnits || config.defaultUnits,
        expiresAt,
      });
    }
    if (!session) return res.status(410).json({ error: 'viewer session could not be renewed' });
    res.cookie(VIEWER_COOKIE, accessToken, auth.cookieAttrs(req, { maxAge: ttlMs }));
    repository.audit({ actorType: grant.audience, actorId: grant.subject, action: 'session.redeemed', entityType: 'model', entityId: grant.modelId });
    return sendCurrentSession(req, res, session, accessToken);
  });

  router.get('/api/v1/sessions/current', (req, res) => {
    const current = currentViewer(req);
    if (!current) return res.status(401).json({ error: 'viewer session required' });
    return sendCurrentSession(req, res, current.session, current.token);
  });

  router.get('/api/v1/models', serviceOnly, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ models: repository.listModels().map(toViewerConfig) });
  });

  router.get('/api/v1/models/:id', serviceOnly, (req, res) => {
    const model = repository.getModel(req.params.id);
    if (!model || model.status === 'unregistered') return res.status(404).json({ error: 'model not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ model: toViewerConfig(model) });
  });

  router.post('/api/v1/models/:id/sessions', serviceOnly, idempotentService, (req, res) => {
    const model = repository.getModel(req.params.id);
    if (!model || model.status !== 'ready' || !model.activeVersion)
      return res.status(404).json({ error: 'ready model not found' });
    const body = req.body || {};
    if (!body.modelVersionId) return res.status(400).json({ error: 'modelVersionId is required' });
    if (body.modelVersionId !== model.activeVersionId)
      return res.status(409).json({ error: 'requested model version is not active' });
    if (!validSubject(body.subject)) return res.status(400).json({ error: 'subject is required' });
    if (body.audience !== 'ops' && body.audience !== 'client')
      return res.status(400).json({ error: 'audience must be ops or client' });
    const grantedPermissions = permissions(body.permissions);
    if (!grantedPermissions.view) return res.status(400).json({ error: 'view permission is required' });
    if (body.displayUnits !== undefined && body.displayUnits !== 'imperial' && body.displayUnits !== 'metric')
      return res.status(400).json({ error: 'displayUnits must be imperial or metric' });
    if (!body.authorizationExpiresAt) return res.status(400).json({ error: 'authorizationExpiresAt is required' });
    const requestedAuthorizationExpiry = Date.parse(body.authorizationExpiresAt);
    if (!Number.isFinite(requestedAuthorizationExpiry) || requestedAuthorizationExpiry <= Date.now())
      return res.status(400).json({ error: 'authorizationExpiresAt must be in the future' });
    const authorizedUntil = new Date(Math.min(
      requestedAuthorizationExpiry,
      Date.now() + config.viewerSessionTtlSeconds * 1000,
    )).toISOString();
    const grantExpiresAt = new Date(Math.min(
      Date.parse(authorizedUntil),
      Date.now() + config.sessionGrantTtlSeconds * 1000,
    )).toISOString();
    const grant = repository.createSessionGrant({
      modelId: model.id,
      subject: body.subject,
      audience: body.audience,
      permissions: {
        ...grantedPermissions,
        __authorizedUntil: authorizedUntil,
        __versionId: model.activeVersionId,
      },
      displayUnits: body.displayUnits || config.defaultUnits,
      expiresAt: grantExpiresAt,
    });
    repository.audit({ actorType: 'service', actorId: req.servicePrincipal.keyId, action: 'session.created', entityType: 'model', entityId: model.id, details: { audience: body.audience, subject: body.subject } });
    const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      grant: grant.id,
      grantExpiresAt,
      sessionTtlSeconds: config.viewerSessionTtlSeconds,
      modelVersionId: model.activeVersionId,
      authorizationExpiresAt: authorizedUntil,
      redeemUrl: `${base}/api/v1/sessions/redeem`,
      embedUrl: `${base}/session/${encodeURIComponent(grant.id)}`,
    });
  });

  router.get('/api/v1/models/:id/shares', serviceOnly, (req, res) => {
    const model = repository.getModel(req.params.id);
    if (!model) return res.status(404).json({ error: 'model not found' });
    res.json({ shares: repository.listPublicShares(model.id).map(publicShareSummary) });
  });

  router.post('/api/v1/models/:id/shares', serviceOnly, idempotentService, async (req, res, next) => {
    try {
      const model = repository.getModel(req.params.id);
      if (!model || model.status !== 'ready') return res.status(404).json({ error: 'ready model not found' });
      const body = req.body || {};
      if (body.versionPolicy === 'pinned') {
        return res.status(422).json({ error: 'pinned shares are not supported until pinned-version asset resolution is available' });
      }
      let passwordHash = null;
      if (body.password !== undefined && body.password !== '') {
        if (String(body.password).length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });
        passwordHash = await auth.hashPassword(String(body.password));
      }
      let expiresAt = null;
      if (body.expiresAt !== undefined && body.expiresAt !== null) {
        const parsed = Date.parse(body.expiresAt);
        if (!Number.isFinite(parsed) || parsed <= Date.now()) return res.status(400).json({ error: 'expiresAt must be in the future' });
        expiresAt = new Date(parsed).toISOString();
      }
      const { token, tokenHash } = auth.newShareToken();
      if (body.displayUnits !== undefined && body.displayUnits !== 'imperial' && body.displayUnits !== 'metric')
        return res.status(400).json({ error: 'displayUnits must be imperial or metric' });
      const share = repository.createPublicShare({
        modelId: model.id,
        versionPolicy: 'latest',
        modelVersionId: null,
        publicIdHash: tokenHash,
        passwordHash,
        permissions: permissions(body.permissions),
        label: body.label ? String(body.label).slice(0, 120) : null,
        createdBy: body.createdBy ? String(body.createdBy).slice(0, 200) : req.servicePrincipal.keyId,
        expiresAt,
        displayUnits: body.displayUnits || config.defaultUnits,
      });
      repository.audit({ actorType: 'service', actorId: req.servicePrincipal.keyId, action: 'share.created', entityType: 'share', entityId: share.id, details: { modelId: model.id } });
      const base = config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({
        share: publicShareSummary(share),
        token,
        viewUrl: `${base}/view/${token}`,
        embedUrl: `${base}/embed/${token}`,
      });
    } catch (error) { next(error); }
  });

  router.delete('/api/v1/shares/:id', serviceOnly, idempotentService, (req, res) => {
    const share = repository.getPublicShare(req.params.id);
    if (!share) return res.status(404).json({ error: 'share not found' });
    const revoked = repository.revokePublicShare(share.id, {
      actorId: req.servicePrincipal.keyId,
      reason: req.body && req.body.reason ? req.body.reason : 'revoked',
    });
    repository.audit({ actorType: 'service', actorId: req.servicePrincipal.keyId, action: 'share.revoked', entityType: 'share', entityId: share.id });
    res.json({ share: publicShareSummary(revoked) });
  });

  router.post('/api/v1/imports', serviceOnly, idempotentService, (req, res) => {
    const body = req.body || {};
    if (body.provider !== 'webodm') return res.status(422).json({ error: 'only the webodm provider is currently implemented' });
    const hasIds = body.projectId !== undefined && body.taskId !== undefined;
    const identifier = hasIds ? `webodm-${body.projectId}-${body.taskId}` : body.identifier;
    if (typeof identifier !== 'string' || identifier.length < 1 || identifier.length > 240)
      return res.status(400).json({ error: 'identifier or projectId/taskId is required' });
    const job = repository.createImportJob({ provider: 'webodm', identifier, request: body, createdBy: req.servicePrincipal.keyId });
    repository.audit({ actorType: 'service', actorId: req.servicePrincipal.keyId, action: 'import.queued', entityType: 'import', entityId: job.id });
    importWorker.kick();
    res.status(202).json({ import: job });
  });

  router.post('/api/v1/imports/rescan', serviceOnly, idempotentService, (req, res) => {
    const job = repository.createImportJob({ provider: 'webodm', identifier: '*', request: { rescan: true }, createdBy: req.servicePrincipal.keyId });
    importWorker.kick();
    res.status(202).json({ import: job });
  });

  router.get('/api/v1/imports', serviceOnly, (req, res) => {
    res.json({ imports: repository.listImportJobs(req.query.limit) });
  });

  return router;
}

module.exports = { VIEWER_COOKIE, createApiV1, createImportWorker, encodedAssetUrl, permissions, publicShareSummary, toViewerConfig };
