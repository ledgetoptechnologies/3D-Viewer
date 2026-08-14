# LTDS 3D Viewer

Client-facing photogrammetry viewer for self-hosted WebODM outputs. Three.js
(npm) app with Earth-style navigation, streamed LOD mesh, camera-position
photo browsing, labeled measurements, Potree point cloud, and streamed
GeoTIFF map layers — packaged as a single Docker container that auto-discovers
completed WebODM projects via WebODM's REST API.

## Architecture

- **Frontend** (`index.html`, `main.js`, `earth-controls.js`,
  `public/pointcloud.html`) — the three.js/Potree viewer. Loads no
  project-specific data at build time; everything comes from `GET /api/models`
  at runtime.
- **Backend** (`server/`) — a small Node/Express service that:
  - Authenticates to WebODM's REST API (`POST /api/token-auth/`) and lists
    projects/tasks. **It never queries WebODM's Postgres database directly.**
  - Verifies which output files actually exist on the read-only WebODM media
    mount for each completed task, and caches the result in a small local
    JSON file (`data/viewer-projects.json` — never a copy of WebODM's DB,
    just pointers + a few derived fields).
  - Serves the built frontend, the `/api/models` viewer API, and a
    `/assets/:id/...` route that streams the real files without ever
    exposing filesystem paths to the client.

See `server/config.js` for all environment variables.

## Running with Docker (production)

1. Copy `.env.example` to `.env` and fill in your WebODM API URL/credentials
   and the host path to WebODM's media/output storage (see "Read-only WebODM
   access" below).
2. `docker compose up -d --build`
3. Open `http://<host>:8080/`. The viewer syncs from WebODM on startup and
   every `SYNC_INTERVAL_MINUTES` after that; trigger a sync manually with
   `curl -X POST http://<host>:8080/api/sync`.

The container only ever receives network access to your WebODM instance's
HTTP(S) API and a **read-only** bind mount of WebODM's media/output storage.
It never gets WebODM's Postgres data, Redis/broker data, application source,
secrets, worker configuration, or the Docker socket.

### Read-only WebODM access

WebODM runs on a separate host from the viewer, so:

- **API**: create a dedicated, least-privilege WebODM user (view-only
  permission on the projects you want exposed) and put its credentials in
  `.env`. Do not use an admin account.
- **Storage**: `WEBODM_MEDIA_PATH` must point to WebODM's media root (default
  layout: `.../media/project/{id}/task/{id}/assets/...`). Since WebODM isn't
  on the same Docker host, mount that storage onto this host first (NFS/SMB
  — the same approach `serve-all.sh` used for local dev) and then point
  `WEBODM_MEDIA_PATH` at the local mount point. Docker Compose bind-mounts it
  into the container `:ro`.

## Multi-project support

Nothing in the frontend is hardcoded to a specific project any more. On load,
`main.js` calls `GET /api/models`, picks the project from `?project=` in the
URL (or the first available one), and fetches its full config from
`GET /api/models/:id`. A project switcher appears in the top bar whenever
more than one project is available.

Per-project config includes resolved asset URLs (mesh/tiles/point
cloud/orthophoto/DSM/DTM/camera shots — each `null` if that project doesn't
have it, which hides the corresponding tab/layer button) and georeferencing
(UTM zone + RTC origin, parsed from WebODM's `coords.txt`).

## Known limitations (by design, for this iteration)

- **No direct WebODM DB access, ever.** Metadata comes only from WebODM's
  REST API, per the original architecture handoff — this trades a little
  latency (polling/interval sync) for zero coupling to WebODM's schema.
- **LOD mesh tiles and the Potree EPT point cloud are NOT native WebODM
  outputs.** They're produced by a one-time external pipeline (Obj2Tiles +
  Entwine) that this iteration does not automate. A project only gets the
  fast streamed-LOD "3D Model" tab and the Potree "Point Cloud" tab if those
  derivatives already exist under `DERIVATIVES_PATH/{projectId}-{taskId}/`
  (`tileset.json` / `model.glb` / `ept/ept.json`, plus an optional
  `viewer.json` with `{ "bboxCenter": {x,y,z}, "pointCount": N }` for precise
  centering). Automating that conversion pipeline is future work.
- **Without derivatives**, newly auto-synced projects still work: the "3D
  Model" tab loads WebODM's native textured OBJ directly (no LOD, so this is
  slower for very large models), and the "Point Cloud" tab loads WebODM's raw
  georeferenced PLY directly into the same three.js scene (no Potree
  streaming, so budget it for smaller clouds). The orthophoto/DSM/DTM tabs
  always work as-is since those come straight from WebODM's own GeoTIFF
  outputs.
- **Original flight photos** (opening the full-res JPG behind a camera
  marker) aren't wired into auto-sync yet — camera positions still show from
  `shots.geojson` when present, but clicking one is a no-op until a photo
  archive location is configured per project.
- Share links, `/embed` and `/view` routes, and the broader LTDS Ops
  integration described in the original handoff are intentionally out of
  scope for this iteration.

## Local development

Run the backend and the Vite dev server side by side:

```bash
# terminal 1 — backend (reads server/config.js env vars)
WEBODM_API_URL=... WEBODM_USERNAME=... WEBODM_PASSWORD=... \
WEBODM_MEDIA_MOUNT=/path/to/webodm/media \
PORT=8090 npm run server

# terminal 2 — frontend, proxies /api and /assets to :8090 (see vite.config.js)
npm run dev
```

`npm run build && npm run server` reproduces the production single-process
setup locally (serves the built `dist/` from the same Express server).

`serve-all.sh` is a legacy fallback from before the backend existed (four raw
`http-server` processes with hardcoded paths for one project) — prefer the
Docker/backend setup above for anything beyond quick local Draco/tileset
debugging.

## Files

- `main.js` — app: bootstrap/project config, tabs, layers, measurements,
  cameras, GeoTIFF streaming
- `earth-controls.js` — `EarthLikeControls`: LEFT-drag orbits around the surface
  point under the cursor (pivot stays in the scene, camera never recenters),
  RIGHT-drag pans along the ground plane, wheel zooms toward the cursor,
  touch: 1-finger orbit / 2-finger pan+pinch. Polar angle clamped, zero-roll.
- `public/pointcloud.html` — isolated Potree 1.8 iframe (EPT, EarthControls with
  the same left/right swap, EDL, budget/size/color toolbar); config (EPT URL,
  title, point count) comes from its query string, set by `main.js`.
- `server/` — backend: WebODM API client, sync job, JSON metadata store, asset
  proxy, viewer API. See `server/config.js` for env vars.
- `serve-all.sh` — legacy local-dev-only asset server startup (see above).

## Georeferencing

Per-project UTM origin (RTC) and zone are parsed by `server/sync.js` from
WebODM's `coords.txt` (`odm_georeferencing/coords.txt`), e.g.:

```
WGS84 UTM 16N
367257 4759982 0
```

- GLB/OBJ: parent rotated `-π/2` X (Z-up→Y-up), child offset `-C` (model bbox
  center; `{0,0,0}` unless a `viewer.json` override is present — see "Known
  limitations")
- 3D Tiles: `3d-tiles-renderer` already applies its own up-axis fix; parent is
  rotated `π` X with offset `(-C.x, -C.z, C.y)` so tiles land exactly on the GLB
- Cameras (`shots.geojson` translations are absolute UTM): position − RTC, then
  the same GLB frame; rotation = axis-angle negated (WebODM convention)
- Statusbar `worldToUtm()` converts back for live E/N/elevation readout

## Feature notes

- **LOD mesh** (when tile derivatives exist): 33 B3DM tiles via Obj2Tiles,
  REPLACE refinement (root → LOD-1 → LOD-0 full res as you zoom). Detail
  slider maps to `tilesRenderer.errorTarget` (26 − slider).
- **Camera positions**: one `InstancedMesh` of view-frustum pyramids, gold
  highlight on hover, tooltip with filename. Size slider.
- **Measurements**: distance / area / volume with CSS2D labels pinned to the
  geometry (ft-in, sq ft / acres, cu yd). Esc cancels, right-click or Enter or
  double-click finishes polygons, tool auto-disarms after each measurement,
  finished measurements persist until Clear.
- **Ortho/DSM/DTM**: `GeoTIFF.fromUrl` HTTP range reads against the BigTIFF
  overview pyramid. A Leaflet `GridLayer` subclass reads windows per tile at
  the right overview level. Map auto-fits to the raster bounds over Esri World
  Imagery. DSM/DTM get viridis + hillshade, legend in ft, hover elevation
  readout.
- **Point cloud**: Potree in an iframe when an EPT dataset exists (its bundled
  Three r124 can't share the page with npm Three); otherwise a direct PLY
  point cloud in the main three.js scene.

## Pitfalls learned

- `3d-tiles-renderer@0.5.x`: use `addEventListener('load-tileset'|'load-model')`,
  NOT the removed `onLoadTileSet`/`onLoadModel` callbacks. Event `ev.scene`.
- Three r180+: `Vector3.subScaledVector` does not exist — use
  `addScaledVector(v, -s)`.
- Raycast picking on 8k-instance meshes / big tiles needs `three-mesh-bvh`
  (`firstHitOnly = true`); BVH build is queued one mesh per frame.
- BigTIFF + geotiff.js works with `fromUrl` range requests; DEM nodata is
  `-9999` (also guard `< -1000`).
- Point-cloud orbit/zoom must mirror `EarthLikeControls`' sign conventions
  exactly (negated drag deltas; wheel-zoom must dolly the camera position
  without ever calling `view.lookAt()`) — Potree's own `View.getSide()`
  confirms the `(cos(yaw), sin(yaw), 0)` right-vector approximation used in
  `pointcloud.html` is otherwise correct.
- Headless CDP verification: connect websocket with `suppress_origin=True`,
  drive with Input.dispatchMouseEvent; vite HMR means always hard-navigate
  after editing main.js before measuring behavior.
