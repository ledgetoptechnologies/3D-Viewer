'use strict';

const express = require('express');
const store = require('./store');
const shareStore = require('./shareStore');
const auth = require('./auth');
const { requireAdmin } = require('./adminAuth');
const { toClientConfig } = require('./api');

const SHARE_COOKIE = 'ltds_share';
const SHARE_SESSION_TTL_MS = 60 * 60 * 1000; // 60 minutes; revocation is still checked live (see below)

const router = express.Router();

function shareSummary(s) {
  return {
    id: s.id,
    active: s.active,
    hasPassword: !!s.passwordHash,
    expiresAt: s.expiresAt || null,
    permissions: s.permissions,
    createdAt: s.createdAt,
    lastAccessedAt: s.lastAccessedAt,
    accessCount: s.accessCount || 0,
  };
}

function issueShareSession(req, res, share) {
  const cookieVal = auth.sign({ shareId: share.id, viewerProjectId: share.viewerProjectId }, SHARE_SESSION_TTL_MS);
  res.cookie(SHARE_COOKIE, cookieVal, auth.cookieAttrs(req, { maxAge: SHARE_SESSION_TTL_MS }));
}

function hasUnlockedSession(req, share) {
  const cookieVal = req.cookies && req.cookies[SHARE_COOKIE];
  const payload = cookieVal ? auth.verify(cookieVal) : null;
  return !!(payload && payload.shareId === share.id);
}

// ── Admin: create / list / revoke share links for a project ──────────────
router.post('/api/models/:id/share-links', requireAdmin, async (req, res) => {
  const project = store.getById(req.params.id);
  if (!project || !project.available) return res.status(404).json({ error: 'model not found' });

  const body = req.body || {};
  const { token, tokenHash } = auth.newShareToken();

  let passwordHash = null;
  if (body.password) {
    if (String(body.password).length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
    passwordHash = await auth.hashPassword(String(body.password));
  }

  let expiresAt = null;
  const days = Number(body.expiresDays);
  if (Number.isFinite(days) && days > 0) {
    expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }

  const permissions = {
    measure: !(body.permissions && body.permissions.measure === false),
    cameras: !(body.permissions && body.permissions.cameras === false),
  };

  const share = shareStore.create({ viewerProjectId: project.id, tokenHash, passwordHash, expiresAt, permissions });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    ...shareSummary(share),
    // The raw token is only ever returned here, at creation time.
    token,
    viewUrl: `${base}/view/${token}`,
    embedUrl: `${base}/embed/${token}`,
  });
});

router.get('/api/models/:id/share-links', requireAdmin, (req, res) => {
  const shares = shareStore.getAllForProject(req.params.id)
    .map(shareSummary)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json(shares);
});

router.delete('/api/share-links/:id', requireAdmin, (req, res) => {
  const share = shareStore.getById(req.params.id);
  if (!share) return res.status(404).json({ error: 'not found' });
  shareStore.update(share.id, { active: false });
  res.json({ ok: true });
});

// ── Public: validate a token / unlock a password-protected one ───────────
router.get('/api/share/:token', (req, res) => {
  const share = shareStore.getByTokenHash(auth.hashToken(req.params.token));
  if (!share) return res.status(404).json({ error: 'link not found' });
  if (!shareStore.isLive(share)) return res.status(410).json({ error: 'link expired or revoked' });

  const project = store.getById(share.viewerProjectId);
  if (!project || !project.available) return res.status(404).json({ error: 'model not found' });

  if (share.passwordHash && !hasUnlockedSession(req, share)) {
    return res.status(401).json({ requiresPassword: true });
  }

  shareStore.recordAccess(share.id);
  issueShareSession(req, res, share);
  res.json({ ...toClientConfig(project), permissions: share.permissions, shareExpiresAt: share.expiresAt || null });
});

router.post('/api/share/:token/unlock', async (req, res) => {
  if (auth.rateLimited(`share-unlock:${req.params.token}:${req.ip}`, 8, 5 * 60 * 1000)) {
    return res.status(429).json({ error: 'too many attempts, try again later' });
  }
  const share = shareStore.getByTokenHash(auth.hashToken(req.params.token));
  if (!share) return res.status(404).json({ error: 'link not found' });
  if (!shareStore.isLive(share)) return res.status(410).json({ error: 'link expired or revoked' });
  if (!share.passwordHash) return res.status(400).json({ error: 'this link does not require a password' });

  const ok = await auth.verifyPassword(String((req.body && req.body.password) || ''), share.passwordHash);
  if (!ok) return res.status(401).json({ error: 'incorrect password' });

  const project = store.getById(share.viewerProjectId);
  if (!project || !project.available) return res.status(404).json({ error: 'model not found' });

  shareStore.recordAccess(share.id);
  issueShareSession(req, res, share);
  res.json({ ...toClientConfig(project), permissions: share.permissions, shareExpiresAt: share.expiresAt || null });
});

module.exports = router;
module.exports.SHARE_COOKIE = SHARE_COOKIE;
