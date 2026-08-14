# LTDS 3D Viewer — Rome Dam

Client-facing photogrammetry viewer for WebODM outputs. Three.js (npm) app with
Earth-style navigation, streamed LOD mesh, camera-position photo browsing,
labeled measurements, Potree point cloud, and streamed GeoTIFF map layers.

## Start everything

```bash
~/ltds-3d-viewer/serve-all.sh
```

| Port | Serves | Source |
|------|--------|--------|
| 8080 | Vite app (dev) | `~/ltds-3d-viewer` |
| 8081 | GLB, 3D Tiles, Draco, Potree, pointcloud.html | `~/ltds-3d-viewer/public` (local disk, fast) |
| 8082 | EPT point cloud, GeoTIFFs, shots.geojson | SMB `/mnt/Share/.../WebODM/extracted` |
| 8083 | Original flight photos (full-res JPG) | SMB `/mnt/drone_jobs/.../8-4-26 Map/Map All` |

Production build: `npx vite build` then `npx vite preview --host 0.0.0.0 --port 8080`
(or serve `dist/` behind the reverse proxy; 8081/8082/8083 still required).

## Files

- `main.js` — app: tabs, layers, measurements, cameras, GeoTIFF streaming
- `earth-controls.js` — `EarthLikeControls`: LEFT-drag orbits around the surface
  point under the cursor (pivot stays in the scene, camera never recenters),
  RIGHT-drag pans along the ground plane, wheel zooms toward the cursor,
  touch: 1-finger orbit / 2-finger pan+pinch. Polar angle clamped, zero-roll.
- `public/pointcloud.html` — isolated Potree 1.8 iframe (EPT, EarthControls with
  the same left/right swap, EDL, budget/size/color toolbar)
- `serve-all.sh` — idempotent server startup

## Georeferencing

All frames reconciled through the WebODM RTC center (`coords.txt` line 2 =
CESIUM_RTC of the GLB): **E 367257, N 4759982, UTM 16N** and the local model
bbox center `C = (-10.998, -30.591, 202.374)`.

- GLB: parent rotated `-π/2` X (Z-up→Y-up), child offset `-C`
- 3D Tiles: `3d-tiles-renderer` already applies its own up-axis fix; parent is
  rotated `π` X with offset `(-C.x, -C.z, C.y)` so tiles land exactly on the GLB
- Cameras (`shots.geojson` translations are absolute UTM): position − RTC, then
  the same GLB frame; rotation = axis-angle negated (WebODM convention)
- Statusbar `worldToUtm()` converts back for live E/N/elevation readout

## Feature notes

- **LOD mesh** is the default layer (33 B3DM tiles via Obj2Tiles, REPLACE
  refinement: root → LOD-1 → LOD-0 full res as you zoom). Detail slider maps to
  `tilesRenderer.errorTarget` (26 − slider). Full-res 898 MB Draco GLB loads
  only when the "Full-Res Mesh" layer is clicked.
- **Camera positions**: one `InstancedMesh` of view-frustum pyramids (8352
  shots), gold highlight on hover, tooltip with filename, click opens the
  original photo from :8083 with altitude/time + download link. Size slider.
- **Measurements**: distance / area / volume with CSS2D labels pinned to the
  geometry (ft-in, sq ft / acres, cu yd). Esc cancels, right-click or Enter or
  double-click finishes polygons, tool auto-disarms after each measurement,
  finished measurements persist until Clear.
- **Ortho/DSM/DTM**: `GeoTIFF.fromUrl` HTTP range reads against the BigTIFF
  overview pyramid (9 levels, 256px tiles). A Leaflet `GridLayer` subclass
  reads windows per tile at the right overview level — full 27025×40757 detail
  when zoomed, nothing close to full-file downloads. Map auto-fits to the
  raster bounds over Esri World Imagery. DSM/DTM get viridis + hillshade,
  legend in ft, hover elevation readout.
- **Point cloud**: Potree in an iframe (its bundled Three r124 can't share the
  page with npm Three). 428M-point EPT streams over :8082.

## Pitfalls learned

- `3d-tiles-renderer@0.5.x`: use `addEventListener('load-tileset'|'load-model')`,
  NOT the removed `onLoadTileSet`/`onLoadModel` callbacks. Event `ev.scene`.
- Three r180+: `Vector3.subScaledVector` does not exist — use
  `addScaledVector(v, -s)`.
- Raycast picking on 8k-instance meshes / big tiles needs `three-mesh-bvh`
  (`firstHitOnly = true`); BVH build is queued one mesh per frame.
- BigTIFF + geotiff.js works with `fromUrl` range requests; DEM nodata is
  `-9999` (also guard `< -1000`).
- http-server supports HTTP Range out of the box (needed for GeoTIFF + photos).
- Headless CDP verification: connect websocket with `suppress_origin=True`,
  drive with Input.dispatchMouseEvent; vite HMR means always hard-navigate
  after editing main.js before measuring behavior.
