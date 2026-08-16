// Periodic + on-demand sync: WebODM API (metadata) + read-only filesystem
// (asset existence checks) -> the viewer's own small JSON store. Never
// touches WebODM's database and never copies WebODM's master data — only
// caches paths/metadata pointers, per the project handoff.
'use strict';

const fs = require('fs');
const path = require('path');
const webodm = require('./webodmClient');
const store = require('./store');
const { config } = require('./config');
const { verifyLodProvenance } = require('./lodProvenance');
const { legacyModelInput } = require('./legacyMigration');

let canonicalRepository = null;

function setRepository(repository) {
  canonicalRepository = repository;
}

// Standard ODM output, e.g.:
//   WGS84 UTM 16N
//   367257 4759982 0
// Line 1 gives the UTM zone (used to derive the zone's central meridian for
// the UTM<->lat/lon math in main.js); line 2 is the RTC/local origin offset
// applied to every other ODM output file.
function parseCoordsTxt(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const zoneMatch = lines[0].match(/UTM\s+(\d+)\s*([NS])/i);
  const offsetParts = lines[1].split(/\s+/).map(Number);
  if (!zoneMatch || offsetParts.length < 3 || offsetParts.some(Number.isNaN)) return null;
  const zone = parseInt(zoneMatch[1], 10);
  const hemisphere = zoneMatch[2].toUpperCase();
  const utmZoneLon0Deg = zone * 6 - 183; // standard UTM central-meridian formula
  return {
    utmZone: zone,
    hemisphere,
    utmZoneLon0Deg,
    rtc: { e: offsetParts[0], n: offsetParts[1], z: offsetParts[2] },
  };
}

function fileIfExists(p) {
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

function firstExisting(paths) {
  for (const p of paths) { if (fileIfExists(p)) return p; }
  return null;
}

function webodmAssetsDir(projectId, taskId) {
  return path.join(config.webodmMediaMount, 'project', String(projectId), 'task', String(taskId), 'assets');
}

function derivativesDir(projectId, taskId) {
  if (!config.derivativesMount) return null;
  return path.join(config.derivativesMount, `${projectId}-${taskId}`);
}

// Resolve everything we know how to display for one completed WebODM task.
async function buildRecord(project, task) {
  const id = `webodm-${project.id}-${task.id}`;
  const assetsDir = webodmAssetsDir(project.id, task.id);
  const derivDir = derivativesDir(project.id, task.id);

  const coordsPath = firstExisting([
    path.join(assetsDir, 'odm_georeferencing', 'coords.txt'),
    path.join(assetsDir, 'coords.txt'),
  ]);
  let georef = { utmZoneLon0Deg: null, rtc: { e: 0, n: 0, z: 0 } };
  if (coordsPath) {
    try {
      const parsed = parseCoordsTxt(fs.readFileSync(coordsPath, 'utf8'));
      if (parsed) georef = { utmZoneLon0Deg: parsed.utmZoneLon0Deg, rtc: parsed.rtc };
    } catch { /* ignore unreadable coords.txt */ }
  }

  // Optional manual/derived overrides (bbox center isn't reliably derivable
  // server-side without parsing the full mesh — see README "Known limitations").
  let bboxCenter = { x: 0, y: 0, z: 0 };
  let pointCount = null;
  let titleOverride = null;
  const viewerJsonPath = derivDir && firstExisting([path.join(derivDir, 'viewer.json')]);
  if (viewerJsonPath) {
    try {
      const vj = JSON.parse(fs.readFileSync(viewerJsonPath, 'utf8'));
      if (vj.bboxCenter) bboxCenter = vj.bboxCenter;
      if (vj.pointCount) pointCount = vj.pointCount;
      if (vj.title) titleOverride = vj.title;
    } catch { /* ignore malformed override file */ }
  }

  const assetRoots = { webodm: assetsDir };
  if (derivDir) assetRoots.derivatives = derivDir;

  // Candidate paths cover BOTH the classic nested ODM pipeline layout
  // (odm_texturing/, odm_orthophoto/, ...) and flat top-level filenames
  // matching WebODM's `available_assets` names exactly (confirmed against a
  // live WebODM instance: textured_model.glb, georeferenced_model.laz,
  // orthophoto.tif, dsm.tif, dtm.tif, shots.geojson) — we don't have
  // filesystem access to every WebODM version to know which one is on disk,
  // so we try both rather than guessing a single layout.
  const rel = {
    glbDerivative: firstExisting([derivDir && path.join(derivDir, 'model.glb')].filter(Boolean)),
    tileset: firstExisting([derivDir && path.join(derivDir, 'tileset.json')].filter(Boolean)),
    eptDerivative: firstExisting([derivDir && path.join(derivDir, 'ept', 'ept.json')].filter(Boolean)),
    // Native WebODM textured mesh — modern WebODM ships a ready-to-use GLB
    // directly (`textured_model.glb`), which is much simpler/faster to load
    // than the raw OBJ fallback below.
    glbNative: firstExisting([
      path.join(assetsDir, 'textured_model.glb'),
      path.join(assetsDir, 'odm_texturing', 'textured_model.glb'),
      path.join(assetsDir, 'odm_texturing', 'odm_textured_model_geo.glb'),
    ]),
    objModel: firstExisting([
      path.join(assetsDir, 'odm_texturing', 'odm_textured_model_geo.obj'),
      path.join(assetsDir, 'odm_texturing_25d', 'odm_textured_model_geo.obj'),
      path.join(assetsDir, 'odm_texturing', 'textured_model.obj'),
    ]),
    ortho: firstExisting([
      path.join(assetsDir, 'odm_orthophoto', 'odm_orthophoto.tif'),
      path.join(assetsDir, 'orthophoto.tif'),
    ]),
    dsm: firstExisting([
      path.join(assetsDir, 'odm_dem', 'dsm.tif'),
      path.join(assetsDir, 'dsm.tif'),
    ]),
    dtm: firstExisting([
      path.join(assetsDir, 'odm_dem', 'dtm.tif'),
      path.join(assetsDir, 'dtm.tif'),
    ]),
    shots: firstExisting([
      path.join(assetsDir, 'odm_report', 'shots.geojson'),
      path.join(assetsDir, 'shots.geojson'),
    ]),
    eptNative: firstExisting([path.join(assetsDir, 'entwine_pointcloud', 'ept.json')]),
    // LAZ is WebODM's current default point-cloud export
    // (`georeferenced_model.laz`). Uncompressed LAS uses the same loaders.gl
    // decoder and is still emitted by some ODM configurations, so discover
    // both before falling back to PLY.
    lazModel: firstExisting([
      path.join(assetsDir, 'odm_georeferencing', 'odm_georeferenced_model.laz'),
      path.join(assetsDir, 'odm_georeferencing', 'georeferenced_model.laz'),
      path.join(assetsDir, 'georeferenced_model.laz'),
      path.join(assetsDir, 'odm_georeferencing', 'odm_georeferenced_model.las'),
      path.join(assetsDir, 'odm_georeferencing', 'georeferenced_model.las'),
      path.join(assetsDir, 'georeferenced_model.las'),
    ]),
    plyModel: firstExisting([
      path.join(assetsDir, 'odm_georeferencing', 'odm_georeferenced_model.ply'),
      path.join(assetsDir, 'odm_filterpoints', 'point_cloud.ply'),
      path.join(assetsDir, 'georeferenced_model.ply'),
    ]),
  };

  const selectedFullMesh = rel.glbDerivative || rel.glbNative || rel.objModel;
  const lodProvenancePath = derivDir && firstExisting([path.join(derivDir, 'lod-provenance.json')]);
  let lodProvenance = null;
  if (lodProvenancePath && selectedFullMesh) {
    const verification = await verifyLodProvenance(lodProvenancePath, selectedFullMesh);
    if (verification.verified) lodProvenance = verification.provenance;
  }

  // Present = at least the orthophoto or a mesh/point-cloud is viewable.
  const hasAnyAsset = Object.values(rel).some(Boolean);

  return {
    id,
    webodmProjectId: project.id,
    webodmTaskId: task.id,
    title: titleOverride || task.name || project.name || id,
    projectName: project.name,
    status: task.status,
    available: hasAnyAsset,
    georef: { ...georef, bboxCenter },
    pointCount,
    lodProvenance,
    assetRoots,
    // Paths are stored relative to their root so assets.js can safely
    // re-join them without ever exposing the absolute host filesystem path.
    relAssets: {
      glb: rel.glbDerivative
        ? { root: 'derivatives', rel: path.relative(derivDir, rel.glbDerivative) }
        : (rel.glbNative ? { root: 'webodm', rel: path.relative(assetsDir, rel.glbNative) } : null),
      tiles: rel.tileset ? { root: 'derivatives', rel: path.relative(derivDir, rel.tileset) } : null,
      ept: rel.eptDerivative
        ? { root: 'derivatives', rel: path.relative(derivDir, rel.eptDerivative) }
        : (rel.eptNative ? { root: 'webodm', rel: path.relative(assetsDir, rel.eptNative) } : null),
      obj: rel.objModel ? { root: 'webodm', rel: path.relative(assetsDir, rel.objModel) } : null,
      ortho: rel.ortho ? { root: 'webodm', rel: path.relative(assetsDir, rel.ortho) } : null,
      dsm: rel.dsm ? { root: 'webodm', rel: path.relative(assetsDir, rel.dsm) } : null,
      dtm: rel.dtm ? { root: 'webodm', rel: path.relative(assetsDir, rel.dtm) } : null,
      shots: rel.shots ? { root: 'webodm', rel: path.relative(assetsDir, rel.shots) } : null,
      // Direct (non-Potree) point cloud fallback — format tells the client
      // which loader to use (loaders.gl LASLoader for .las/.laz, three.js
      // PLYLoader for .ply). Prefers LAZ since that's WebODM's current default.
      pointCloud: rel.lazModel
        ? {
            root: 'webodm',
            rel: path.relative(assetsDir, rel.lazModel),
            format: path.extname(rel.lazModel).slice(1).toLowerCase(),
          }
        : (rel.plyModel ? { root: 'webodm', rel: path.relative(assetsDir, rel.plyModel), format: 'ply' } : null),
    },
    lastSyncedAt: new Date().toISOString(),
  };
}

let running = false;

async function runSync() {
  if (running) return { skipped: true, reason: 'sync already in progress' };
  running = true;
  const result = { syncedAt: new Date().toISOString(), projects: 0, tasks: 0, completed: 0, errors: [] };
  try {
    const projects = await webodm.listProjects();
    result.projects = projects.length;
    const keepIds = [];
    for (const project of projects) {
      let tasks = [];
      try {
        tasks = await webodm.listTasks(project.id);
      } catch (err) {
        result.errors.push(`project ${project.id}: ${err.message}`);
        continue;
      }
      result.tasks += tasks.length;
      for (const task of tasks) {
        if (task.status !== webodm.TASK_STATUS.COMPLETED) continue;
        result.completed += 1;
        try {
          const record = await buildRecord(project, task);
          store.upsert(record);
          if (canonicalRepository) canonicalRepository.upsertModelVersion(legacyModelInput(record));
          keepIds.push(record.id);
        } catch (err) {
          result.errors.push(`task ${project.id}/${task.id}: ${err.message}`);
        }
      }
    }
    store.removeMissing(keepIds);
  } catch (err) {
    result.errors.push(err.message);
  } finally {
    running = false;
  }
  return result;
}

function startScheduler() {
  if (!config.webodmEnabled) {
    console.log('[sync] WebODM synchronization disabled');
    return;
  }
  if (config.syncOnStartup) {
    runSync().then((r) => console.log('[sync] startup sync:', JSON.stringify(r)));
  }
  const intervalMs = Math.max(1, config.syncIntervalMinutes) * 60 * 1000;
  setInterval(() => {
    runSync().then((r) => console.log('[sync] scheduled sync:', JSON.stringify(r)));
  }, intervalMs);
}

module.exports = { buildRecord, runSync, setRepository, startScheduler, parseCoordsTxt };
