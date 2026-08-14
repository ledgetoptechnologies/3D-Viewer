'use strict';

const express = require('express');
const store = require('./store');
const sync = require('./sync');
const { TASK_STATUS } = require('./webodmClient');

const router = express.Router();

function assetUrl(projectId, entry) {
  if (!entry) return null;
  return `/assets/${projectId}/${entry.root}/${entry.rel}`;
}

// Shape consumed by main.js / index.html / pointcloud.html. Never includes
// assetRoots (real filesystem paths) or WebODM credentials.
function toClientConfig(p) {
  const a = p.relAssets || {};
  return {
    id: p.id,
    title: p.title,
    projectName: p.projectName,
    status: p.status,
    statusLabel: Object.keys(TASK_STATUS).find((k) => TASK_STATUS[k] === p.status) || 'UNKNOWN',
    available: p.available,
    georef: p.georef,
    pointCount: p.pointCount,
    assets: {
      glb: assetUrl(p.id, a.glb),
      tiles: assetUrl(p.id, a.tiles),
      ept: assetUrl(p.id, a.ept),
      obj: assetUrl(p.id, a.obj),
      ortho: assetUrl(p.id, a.ortho),
      dsm: assetUrl(p.id, a.dsm),
      dtm: assetUrl(p.id, a.dtm),
      shots: assetUrl(p.id, a.shots),
      ply: assetUrl(p.id, a.ply),
    },
    lastSyncedAt: p.lastSyncedAt,
  };
}

router.get('/api/models', (req, res) => {
  const models = store.getAll()
    .filter((p) => p.available)
    .map(toClientConfig)
    .sort((a, b) => a.title.localeCompare(b.title));
  res.json(models);
});

router.get('/api/models/:id', (req, res) => {
  const p = store.getById(req.params.id);
  if (!p || !p.available) return res.status(404).json({ error: 'model not found' });
  res.json(toClientConfig(p));
});

router.post('/api/sync', async (req, res) => {
  try {
    const result = await sync.runSync();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
