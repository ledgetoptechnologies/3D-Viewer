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
    mount and registers canonical models, versions, assets, imports, shares,
    and browser sessions in `data/viewer.sqlite`. Legacy JSON is migrated once
    and retained only for old admin/share route compatibility.
  - Serves the built frontend, the versioned `/api/v1` Ops API, legacy
    `/api/models` routes, and a
    `/assets/:id/...` route that streams the real files without ever
    exposing filesystem paths to the client.

See `server/config.js` for all environment variables.

## Running with Docker (production)

1. Copy `.env.example` to `.env`. Set the public Viewer origin/hostname,
   exact Ops/client embed origins, independent 32+ character
   `SERVICE_AUTH_SECRET` and `SESSION_SECRET` values, WebODM API credentials,
   and the host path to WebODM's media/output storage (see "Read-only WebODM
   access" below). Leave emergency admin disabled for normal Ops-managed
   production access.
2. `docker compose up -d --build`
3. Open `http://<host>:8080/` and sign in with `ADMIN_PASSWORD`. The viewer
   syncs from WebODM on startup and every `SYNC_INTERVAL_MINUTES` after that;
   trigger a sync manually with
   `curl -X POST -H "Authorization: Bearer $ADMIN_PASSWORD" http://<host>:8080/api/sync`.

For a standalone/break-glass deployment, set `EMERGENCY_ADMIN_ENABLED=true`
and provide a unique `ADMIN_PASSWORD` of at least 16 characters before using
the admin login or the legacy sync command above. The container exposes
`GET /api/v1/health` for liveness and `GET /api/v1/ready` for its writable data
directory plus required mounts; Docker Compose uses the readiness endpoint.

The container only ever receives network access to your WebODM instance's
HTTP(S) API and a **read-only** bind mount of WebODM's media/output storage.
It never gets WebODM's Postgres data, Redis/broker data, application source,
secrets, worker configuration, or the Docker socket.

### Read-only WebODM access

WebODM runs on a separate host from the viewer, so:

- **API**: create a dedicated, least-privilege WebODM user (view-only
  permission on the projects you want exposed) and put its credentials in
  `.env`. Do not use an admin account.
- **Storage**: WebODM's own `docker-compose.yml` bind-mounts a host directory
  as its media root:
  ```yaml
  webapp:
    volumes:
      - ${WO_MEDIA_DIR}:/webodm/app/media:z
  worker:
    volumes:
      - ${WO_MEDIA_DIR}:/webodm/app/media:z
  ```
  (If that compose file also declares an `appmedia:`/`dbdata:` named volume
  under top-level `volumes:`, it's unused — every service overrides it with
  the bind mount above via `WO_MEDIA_DIR`/`WO_DB_DIR` env vars.)

  `WEBODM_MEDIA_PATH` needs to resolve to that exact same directory (WebODM's
  Django `MEDIA_ROOT`, containing `project/{id}/task/{id}/assets/...` — this
  is what `server/sync.js` walks). Concretely:

  1. On the WebODM host, in the directory containing WebODM's
     `docker-compose.yml`, run `grep WO_MEDIA_DIR .env` to get the real path
     (e.g. it may itself be a TrueNAS NFS/SMB mount rather than local disk).
  2. Re-share that directory (NFS/SMB) to the viewer's Docker host, since the
     two aren't on the same machine.
  3. Mount that share on the viewer's Docker host at some local path and set
     `WEBODM_MEDIA_PATH` in `.env` to it.
  4. `docker-compose.yml` bind-mounts `WEBODM_MEDIA_PATH` into the viewer
     container **read-only** at `/mnt/webodm` (`WEBODM_MEDIA_MOUNT`). Never
     point this at `WO_DB_DIR` (Postgres data) or mount anything else from
     WebODM's compose file (Redis, secrets, app source, Docker socket).

## Multi-project support

Nothing in the frontend is hardcoded to a specific project any more. In admin
mode, `main.js` calls `GET /api/models`, picks the project from `?project=` in
the URL (or the first available one), and fetches its full config from
`GET /api/models/:id`. A project switcher appears in the top bar whenever
more than one project is available.

Per-project config includes resolved asset URLs (mesh/tiles/point
cloud/orthophoto/DSM/DTM/camera shots — each `null` if that project doesn't
have it, which hides the corresponding tab/layer button) and georeferencing
(UTM zone + RTC origin, parsed from WebODM's `coords.txt`).

## Authentication & share links

The Viewer deliberately has no duplicate LTDS user database. LTDS Ops remains
the identity/ACL source of truth and calls the versioned API with signed HMAC
requests. The old shared admin password is break-glass compatibility only.

- **Ops/client sessions**: Ops calls `POST /api/v1/models/:id/sessions` with
  the authorized subject, audience, active model-version ID, permission set,
  and required future authorization expiry. The browser redeems the returned one-use
  grant for a random, model-and-version-scoped capability; only its SHA-256
  hash is stored. Capability asset paths work when third-party cookies are
blocked and do not collide across simultaneous embeds. Renewal extends the
  same database session in place, so active 3D Tiles/EPT loaders retain stable
  URLs. Iframe renewal messages are accepted only from exact configured embed
origins.
  Capability paths must be excluded/redacted from reverse-proxy and Cloudflare
  URL logs; `deploy/nginx-viewer.conf.example` disables Nginx access logging
  for those routes.

- **Admin mode** (`/`, no token in the URL): requires signing in with
  `ADMIN_PASSWORD` (a minimal login page is served until you do — see
  `public/admin-login.html`). Signed in as admin, you get the full internal
  catalog, the project switcher, and a **Share** button in the top bar for
  creating/listing/revoking links for the selected project. `GET /api/models`,
  `GET /api/models/:id`, and `POST /api/sync` all require this same admin
  session (or `Authorization: Bearer $ADMIN_PASSWORD` for scripts/cron).
- **Share links**: created via the Share modal (or
  `POST /api/models/:id/share-links`, admin-only), each one gets a random
  256-bit token (only its SHA-256 hash is ever stored — the raw token is
  returned once, at creation time, and cannot be retrieved again). A link can
  optionally have a password (scrypt-hashed) and/or an expiry, and can disable
  the measuring tools and/or camera-position layer for that link specifically
  via `permissions: { measure, cameras }`. Revoking a link
  (`DELETE /api/share-links/:id`) is a soft-delete that takes effect
  immediately — asset requests re-check the live share record on every
  request rather than trusting a cached session.
- **`/view/:token`** opens the full toolbar (measurements, camera photos,
  layer switching) for that one project; **`/embed/:token`** is the same
  model with the sidebar/topbar hidden, meant for `<iframe>` embedding (e.g.
  from LTDS Ops), leaving only the reset/fullscreen controls and an optional
  measurement toggle.
- **Cross-origin embedding requires HTTPS.** Secure cookies remain for
  top-level compatibility, but embedded session/asset authorization does not
  depend on third-party cookies. Put this app behind TLS in production.
- **Not implemented**: annotations, source-file download controls, and
  original flight-photo access. Pinned-version public shares are rejected
  until pinned-version asset resolution is implemented; `latest` works now.

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
  Model" tab prefers WebODM's native `textured_model.glb` when present
  (confirmed available on current WebODM versions) and falls back to the raw
  textured OBJ otherwise; the "Point Cloud" tab loads WebODM's raw
  georeferenced point cloud directly into the same three.js scene —
  `.laz`/`.las` via `@loaders.gl/las` (WebODM's current default point-cloud
  export; **note: only LAS/LAZ spec up to v1.3 is supported**, no Potree
  streaming so budget it for smaller clouds). Georeferenced positions are
  decoded as Float64 and rebased against `coords.txt` before conversion to the
  GPU's Float32 buffers, preserving local detail at UTM-scale coordinates.
  `.ply` remains an older-WebODM fallback. The orthophoto/DSM/DTM tabs always work as-is since those come
  straight from WebODM's own GeoTIFF outputs.
- **Exact on-disk asset paths are still a best-effort guess.** `server/sync.js`
  tries both the classic nested ODM pipeline layout (`odm_texturing/`,
  `odm_orthophoto/`, ...) and flat filenames matching WebODM's
  `available_assets` names (confirmed against a live instance:
  `textured_model.glb`, `georeferenced_model.laz`, `orthophoto.tif`,
  `dsm.tif`, `dtm.tif`, `shots.geojson`), but the read-only mount is WebODM's
  actual persistent media volume, so it's worth spot-checking
  `data/viewer-projects.json` after the first sync against a real project to
  confirm the right files were found.
- **Original flight photos** (opening the full-res JPG behind a camera
  marker) aren't wired into auto-sync yet — camera positions still show from
  `shots.geojson` when present, but clicking one is a no-op until a photo
  archive location is configured per project.
- The canonical registry uses SQLite WAL mode and versioned startup
  migrations. Legacy JSON stores remain temporarily so the standalone admin
  UI and previously issued share links continue to work during transition.
- Event imports currently implement the `webodm` provider. `POST
  /api/v1/imports` queues non-blocking reconciliation; Terra receives an
  explicit unsupported-provider response until its importer exists. A queued
  `/api/v1/imports/rescan` recovery path is available.

## Versioned LTDS Ops API

Service routes require HMAC over method, exact path/query, timestamp, nonce,
and SHA-256 of the exact body bytes. Nonces are single-use. Configure one
`SERVICE_AUTH_KEY_ID` + `SERVICE_AUTH_SECRET`, or `SERVICE_AUTH_KEYS_JSON` as
a JSON object containing both current and previous keys during rotation.
For a simple two-key rollout, set the complete
`SERVICE_AUTH_PREVIOUS_KEY_ID`/`SERVICE_AUTH_PREVIOUS_SECRET` pair, deploy the
Viewer first, switch Ops to the new current key, then remove the previous pair.
Service mutations require `Idempotency-Key` (`428` when absent). Retries must
reuse that key with a fresh HMAC
nonce. The Viewer returns the original status/body for an identical retry and
returns `409` if the key is reused with a different method, path, or body.
Credential-bearing replay bodies are encrypted at rest and pruned after 24h.

- `GET /api/v1/models`; `GET /api/v1/models/:id`
- `POST /api/v1/models/:id/sessions`
- `GET|POST /api/v1/models/:id/shares`; `DELETE /api/v1/shares/:id`
- `POST /api/v1/imports`; `POST /api/v1/imports/rescan`; `GET /api/v1/imports`
- Browser: `POST /api/v1/sessions/redeem`; `GET /api/v1/sessions/current`
- Public probes: `GET /api/v1/health`; `GET /api/v1/ready`

Session-grant responses are `Cache-Control: no-store`; the service secret is
never exposed to browser code. Required `authorizationExpiresAt` only shortens the
configured Viewer TTL, and `modelVersionId` prevents an authorization for one
version silently following a newly activated version. Iframe messages use
`version: 1` and the `ltds-viewer:ready`, `session-expiring`, `renew-session`,
`session-renewed`, and `session-renewal-failed` event types.

## Local development

Run the backend and the Vite dev server side by side:

```bash
# terminal 1 — backend (reads server/config.js env vars)
WEBODM_API_URL=... WEBODM_USERNAME=... WEBODM_PASSWORD=... \
WEBODM_MEDIA_MOUNT=/path/to/webodm/media \
ADMIN_PASSWORD=dev-only \
PORT=8090 npm run server

# terminal 2 — frontend, proxies /api and /assets to :8090 (see vite.config.js)
npm run dev
```

Note: `npm run dev` uses Vite's own dev server for `/`, which does NOT run
the admin-login gate in `server/index.js` (that only applies when this app's
own Express server serves `index.html`, i.e. `npm run server`/production).
`/view/:token` and `/embed/:token` behave the same in both, since their auth
is token-based via the API, not the login page.

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
- `server/` — backend: WebODM provider/sync, SQLite registry/migrations,
  signed v1 API, legacy compatibility, session/share authorization, protected
  asset delivery, admin login, and auth primitives (`auth.js` — capabilities,
  hashing, share tokens). See `server/config.js` for env vars.
- `public/admin-login.html` — minimal standalone login page served when
  there's no valid admin session (see `server/index.js`).
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

- **LOD mesh** (when verified tile derivatives exist): hierarchical B3DM tiles,
  REPLACE refinement (root → intermediate LODs → LOD-0 full res as you zoom). Detail
  slider maps to `tilesRenderer.errorTarget` (26 − slider). The status bar says
  `LOD: full-detail` only when every visible tile is on the declared zero-error
  frontier. Invalid hierarchy or tile-load failures fail over to the independent
  GLB when it is available. Resize/orientation changes also refresh the render
  resolution used by the screen-space-error calculation.

  Zero geometric error verifies renderer convergence, not conversion provenance:
  the tiles match the full mesh only if the derivative pipeline generated every
  LOD-0 leaf from that exact source without decimation or reduced textures. Keep
  the source fingerprint and triangle/texture audit produced by the conversion
  job with the derivative set; mounted project assets are not stored in this repo,
  so filename conventions alone cannot prove equivalence.

  Production LOD sets therefore require `lod-provenance.json` beside
  `tileset.json`. Without a valid record, the viewer safely switches to the
  actual full mesh (or disables the invalid LOD layer if no full mesh exists):

  ```json
  {
    "schemaVersion": 1,
    "sourceAsset": "model.glb",
    "sourceSha256": "<64 lowercase hex characters>",
    "geometry": "preserved",
    "textures": "preserved",
    "leafGeometricError": 0
  }
  ```

  This is a conversion-pipeline attestation, not a file to hand-author. The
  trusted conversion job must only write `geometry: "preserved"` and
  `textures: "preserved"` after its LOD-0 audit succeeds. At sync time the
  Viewer streams and SHA-256 hashes the selected full GLB/OBJ and exposes the
  attestation only when `sourceAsset` and `sourceSha256` match that exact file.
  Otherwise the client automatically loads the actual full mesh. The zoomed-in
  quality claim therefore fails closed instead of trusting a filename or
  `geometricError: 0` by itself.
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
  Three r124 can't share the page with npm Three); otherwise a direct
  LAZ/LAS (via `@loaders.gl/las`) or PLY point cloud in the main three.js
  scene.

## Verification

Run `npm run check` before building an image. The suite covers direct LAS
Float64 decoding before UTM rebasing, point-cloud-only initialization, protected
EPT metadata/nodes with HTTP range and HEAD behavior, live share revocation,
LOD hierarchy/provenance/fallback policy, production health/readiness, the
model registry migration, and service-request replay protection. The Docker
build additionally asserts the exact Potree, jQuery, Three.js, and LAS/LAZ
runtime files requested by `pointcloud.html`.

Before promoting a new project, stage it with the real mounted assets and
verify both the EPT view and close-range LOD frontier on representative desktop
and mobile hardware. Raw LAS/LAZ fallback is intentionally limited to LAS 1.3
and below and loads the whole file; large field clouds should use EPT.

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
