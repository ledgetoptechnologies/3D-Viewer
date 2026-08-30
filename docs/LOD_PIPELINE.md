# LOD derivative contract

The target interaction is Nira-like: show a lightweight overview immediately,
refine only the visible areas as they occupy more screen pixels, reach the full
source quality at close range, and return to lower-detail tiles as the camera
moves away. Nira itself uses server-side pixel streaming; this self-hosted
Viewer instead streams 3D Tiles to the browser and renders them locally.

## Required hierarchy

- `tileset.json` and every external child tileset use `REPLACE` refinement.
- Parent geometric errors decrease monotonically toward the leaves.
- Every internal tile has a strictly positive geometric error. An internal
  zero-error tile already satisfies the renderer's refinement target, making
  its nominally full-quality children unreachable.
- Every terminal leaf has renderable content and `geometricError: 0`.
- Tiles are spatially partitioned. A chain of whole-model LOD files is not an
  acceptable substitute because approaching one area would download the whole
  high-resolution model.
- LOD-0 leaves preserve the source mesh geometry and textures. Intermediate
  levels may be decimated and may use reduced textures.
- All content uses local relative paths and every referenced file is non-empty.

The renderer calculates screen-space error every frame. Its configured error
target decides when a tile refines; there is no fixed camera-distance switch.
When the camera is inside a tile bounding volume, the renderer may report an
infinite screen-space error. A visible terminal leaf with `geometricError: 0`
still satisfies the target because it has no finer child to request. Infinite
error on a non-terminal or non-zero-error tile remains unsatisfied and continues
to block warmup advancement. The queue priority also treats positive infinity
as the highest screen-space error, so a refinable branch containing the camera
is not sorted behind distant finite-error work. Malformed non-finite values
remain lowest priority.

The persisted and runtime hierarchy remain `REPLACE`. The renderer keeps the
currently displayed parent until its selected children are content-ready, but
`loadAncestors`, sibling preload, and ancestor-sibling preload are disabled so
replaced off-view paths can become unused and leave the cache. The Viewer does
not manually toggle cached scene visibility, tile active/visible state, or LRU
usage.

The Viewer starts with requested Detail 16 and active Detail 13
(`errorTarget = 32`). After that complete visible frontier settles it advances
once to Detail 16 (`errorTarget = 15.023`). Raising the slider explicitly
requests finer visible coverage. Desktop requests above Detail 13 advance in
bounded three-detail stages (`13 → 16 → 19 → 22 → requested`) only after each
visible frontier meets its active target and all renderer queues settle.
Clients reporting 4 GiB or less are capped at Detail 13 and use a separate
768 MiB cache profile.

The desktop cache retains 0.4 GiB below a 1.75 GiB maximum, with 8 warm entries
and a 1,024-item failsafe. The byte ceiling is the real memory guard. A low
48-item ceiling is invalid because a camera-selected frontier can contain more
than 48 small leaves and branch parents while using almost none of the byte
budget. The reduced profile retains 640 MiB below 768 MiB, with 256 warm and
512 maximum entries. Both profiles unload 20 percent per eviction pass once
unused content exceeds their warm floors.

Two consecutive one-second full-cache, idle-queue samples with a selected
in-frustum tile still pending request bounded cache-admission recovery. The soft
byte floor is lowered only far enough to release one stale LRU tile and is never
set to zero. Cache pressure never lowers `activeDetail`, changes the requested
screen-space-error target, or latches a global quality ceiling.

A local 64-leaf, eight-branch browser stress fixture reproduced the production
symptom with the former 48-item cap. At Detail 16 the cache stopped at 48 items
while using about 9 KiB against the 1.75 GiB ceiling, all queues were idle, 16
selected leaves remained pending, and only five of seven selected rows had
fine coverage. Raising only the failsafe item cap to 1,024 allowed the same pose
to settle with all 56 selected leaves attached, zero pending tiles, and no
cache pressure. A wide zoom-out returned to eight coarse branch tiles and the
close return restored all selected detail.

The exact authenticated production dataset remains the final release gate. See
[`VIEWER_LOD_CAMERA_HANDOFF.md`](VIEWER_LOD_CAMERA_HANDOFF.md) for historical
measurements, superseded approaches, and diagnostic commands.

## Full-quality attestation

The conversion job must run the repository audit; it must not hand-author a
preservation assertion:

```bash
npm run audit:lod -- /path/to/derivatives/project-task /path/to/derivatives/project-task/model.glb
```

The bundled, checksum-pinned converter accepts textured OBJ. Experimental
generation requires both the OBJ (including its MTL/textures) and an independent
companion GLB. Standard WebODM task backups commonly satisfy this source
contract with `assets/odm_texturing/odm_textured_model_geo.obj` and
`assets/odm_texturing/odm_textured_model_geo.glb`. Native imported tiles are
quarantined, audited, and registered only after the proof succeeds. Production
enables automatic generation and bounded legacy-model reconciliation by
default. Verified imported tiles are reused; an eligible textured OBJ plus
companion GLB with no valid tiles receives one durable generation attempt, and
a terminal current-revision failure permits only the existing explicit manual
retry. Operators may deliberately disable generation with
`MESH_DERIVATIVES_ENABLED=false`; disabling it does not make an unverified or
missing tileset interactive.

GLB-only and OBJ-only inputs deliberately remain downloadable originals, but
are not interactive Viewer layers. The runtime image does not contain a pinned mesh interchange
converter, and format conversion alone is not proof that node transforms,
materials, samplers, UVs, texture bytes, and coordinates survived. Do not add a
best-effort conversion or declare generated tiles valid without an independent
source mesh that the audit can compare. Supporting a single-format source needs
a separately pinned converter, conversion-preservation tests for representative
textured and georeferenced fixtures, and the same fail-closed LOD audit before
registration.

Only after the v2 audit has parsed and compared the source GLB (including
checksum-locked Draco decoding when `KHR_draco_mesh_compression` is required)
with the aggregate zero-error leaf frontier does it atomically write
`lod-provenance.json` beside `tileset.json`:

```json
{
  "schemaVersion": 2,
  "sourceAsset": "model.glb",
  "sourceSha256": "<sha256 of the exact full mesh>",
  "geometry": "bounded-triangle-equivalence",
  "textures": "byte-identical-material-equivalence",
  "leafGeometricError": 0,
  "audit": {
    "algorithm": "ltds-glb-leaf-equivalence-v2",
    "coordinateTolerance": 0.000001,
    "maxNumericDelta": 0,
    "triangleCount": 123456,
    "leafTriangleCount": 130000,
    "duplicateLeafTriangleCount": 6544,
    "equivalenceSha256": "<sha256 of canonical source triangles/materials>",
    "artifacts": [
      { "uri": "tileset.json", "sha256": "<sha256>", "byteLength": 1234 },
      { "uri": "tiles/leaf-0.b3dm", "sha256": "<sha256>", "byteLength": 5678 }
    ]
  }
}
```

The audit compares canonical, winding-preserving triangle streams after GLB
node transforms, 3D Tiles transforms, JSON `RTC_CENTER`, and `CESIUM_RTC`. It
compares every vertex attribute used by each primitive, render-affecting
material state, sampler state, and the exact bytes of every used texture. It
also records a SHA-256 and byte length for every tileset, leaf, and external
texture dependency. At model discovery the Viewer independently re-hashes the
selected source and all recorded artifacts. A missing, changed, renamed,
legacy-v1, or hand-authored assertion removes the tiles from the interactive
Viewer instead of falling back to browser decoding or making a false
full-quality claim. The original GLB remains available through authenticated
Operations downloads.

The default coordinate/attribute tolerance is `1e-6` model units and the audit
records the largest observed delta. `--tolerance` may lower it or raise it only
as far as `1e-3`; choose a bound appropriate for the source coordinate units.

### Deliberately unsupported proof cases

The v2 algorithm decodes `KHR_draco_mesh_compression` through the repository's
locked `draco3d` dependency and fails closed on malformed accessor/semantic
bindings. It still fails closed for meshopt-compressed geometry, sparse
accessors, morphs, skins, GPU instancing, non-triangle primitives, external GLB
buffers, alternate compressed texture-source extensions, binary
`RTC_CENTER`, or remote URLs. Decode these into the supported GLB/B3DM subset
inside the trusted conversion job before auditing.

Spatial partitioning itself is supported by v2 when leaves retain the source
triangles. Exact opaque copies at adjoining partition boundaries are treated as
bounded overlap and recorded separately; missing triangles and additional
non-source geometry still fail closed. If an imported/native tiler clips
triangles at tile boundaries, retriangulates the surface, or repacks texture
atlases, v2 rejects it because exact equivalence is no longer provable.
The production Obj2Tiles invocation deliberately uses a bounded texture-atlas
contract instead of `--keeptextures`: on a representative 2.53 GiB textured
WebODM model, `--keeptextures` duplicated source textures into more than 157
GiB before completion. The bounded invocation completed in about three minutes
and produced a 0.89 GiB hierarchy. Its full-detail frontier contains 1,270,357
leaf draw triangles for 1,148,233 source triangles because Obj2Tiles performs
61,062 boundary-edge splits, adding two triangles per split, and repacks the
texture atlases. Locally generated output therefore uses an opt-in schema-v3
controlled-converter proof instead of weakening v2. V3 binds the approved
architecture-specific Obj2Tiles 1.6.2 executable digest and exact command, the
GLB and OBJ digests, every audited artifact, a valid zero-error frontier,
full-detail bounds/area/centroid/second moments, deterministic bidirectional
BVH samples in rebased coordinates, and all-triangle opaque textured
base-color/TEXCOORD_0 coverage. Shifted or missing patches, unapproved
executables, missing UVs, and untextured materials fail closed. Production Compose still queues this optional generation
by default so missing derivatives and failures are visible in Background Work.
The server uses the same enabled fallback when an older deployment omits the
variable; operators can set `MESH_DERIVATIVES_ENABLED=false` to disable it.
Verified imported tiles may stream. The original GLB is never an interactive
layer and remains available only through authenticated Operations downloads.
A model without verified tiles is explicitly unavailable or processing in 3D
mode instead of risking a full-resolution browser decode.
Automatic generation remains verification-gated: a current-revision failure
leaves the original mesh published and requires an explicit manual retry.
Migration 23 records the LOD recovery revision on every derivative job. When a
shipped validator or converter fix increments that revision, startup
maintenance may reopen each older terminal `mesh_tiles` or rejected
`lod_audit` job exactly once with a compare-and-swap. New or first-leased jobs
are stamped at the current revision, so ordinary failures cannot enter an
automatic retry loop; the single authorized manual retry remains a separate,
unchanged budget. The worker emits bounded reconciliation counts and a safe
error code, and records every system recovery in the audit log. Imported/native
tiles always stay on exact v2; only the trusted local generation call site may
request controlled v3. Do not manually change either provenance or recovery
record.

## Validate before deployment

```bash
npm run validate:lod -- /path/to/derivatives/project-task /path/to/full/model.glb
```

Run the audit first, then this independent validator. It recursively validates
the root and external child tilesets, zero-error leaf frontier, content
paths/files, source digest, and every artifact digest in the audit evidence. A
valid result is necessary but real hardware QA is still required: start far away,
move close to several different regions, confirm detail increases without
holes, move back out, and verify memory settles rather than growing without
bound. Repeat on a representative phone viewport/device.
