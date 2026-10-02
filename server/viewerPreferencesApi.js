'use strict';

const express = require('express');
const auth = require('./auth');
const PROFILES = new Set(['default', 'alternate']);

function createViewerPreferencesApi(repository) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Account preferences never use an ambient cookie or a public capability.
    const token = String(req.get('authorization') || '').match(/^Bearer\s+([A-Za-z0-9_-]{16,256})$/i)?.[1];
    const session = token && repository.getViewerSessionByHash(auth.hashToken(token));
    if (!session || !repository.viewerSessionLive(session) || session.permissions?.view !== true
        || !['ops', 'client'].includes(session.audience) || typeof session.subject !== 'string'
        || !session.subject.trim() || session.subject.length > 200
        || (session.audience === 'client' && session.permissions.personalMeasurements !== true)) {
      return res.status(403).json({code:'viewer_preferences_identity_required'});
    }
    req.preferenceIdentity = {audience:session.audience, subject:session.subject};
    next();
  });
  const read = identity => {
    const row = repository.database.prepare('SELECT mouse_profile,sidebar_collapsed FROM viewer_user_preferences WHERE audience=? AND subject=?').get(identity.audience, identity.subject);
    return {mouseProfile:row?.mouse_profile || 'default', sidebarCollapsed:row ? Boolean(row.sidebar_collapsed) : null};
  };
  router.get('/', (req, res) => res.json({preferences:read(req.preferenceIdentity)}));
  router.put('/', (req, res) => {
    const input = req.body;
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !['mouseProfile','sidebarCollapsed'].includes(key))
        || !PROFILES.has(input.mouseProfile) || typeof input.sidebarCollapsed !== 'boolean') {
      return res.status(400).json({code:'invalid_viewer_preferences'});
    }
    const identity = req.preferenceIdentity;
    if (repository.rateLimited?.(`viewer-preferences:${identity.audience}:${identity.subject}`, 120, 60_000)) return res.status(429).json({code:'viewer_preferences_rate_limited'});
    repository.database.prepare(`INSERT INTO viewer_user_preferences(audience,subject,mouse_profile,sidebar_collapsed,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(audience,subject) DO UPDATE SET mouse_profile=excluded.mouse_profile,sidebar_collapsed=excluded.sidebar_collapsed,updated_at=excluded.updated_at`)
      .run(identity.audience,identity.subject,input.mouseProfile,Number(input.sidebarCollapsed),new Date().toISOString());
    res.json({preferences:read(identity)});
  });
  return router;
}

module.exports = {createViewerPreferencesApi};
