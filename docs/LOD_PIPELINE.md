# LOD derivative contract

The investigation, CesiumJS comparison, Obj2Tiles contracts, branch history,
and Codex review checklist are in [LOD_RESEARCH_AND_CODEX_REVIEW.md](LOD_RESEARCH_AND_CODEX_REVIEW.md).

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
error on a non-terminal or non-zero-error tile remains unsatisfied.

With ancestor loading disabled, queue priority is camera-driven rather than
SSE-driven: used and in-frustum content first, then nearest camera distance,
then shallow depth for stable ties. Sorting by highest SSE first starves nearby
zero-error leaves behind farther positive-error parents and produces the exact
symptom where distant regions sharpen before the foreground.

The persisted and runtime hierarchy remain `REPLACE`. The renderer keeps the
currently displayed parent until its selected children are content-ready, but
`loadAncestors`, sibling preload, and ancestor-sibling preload are disabled so
replaced fine paths can become unused and leave the cache. The Viewer does not
manually toggle cached scene visibility or tile active/visible state.

A renderable-root hierarchy bootstraps complete coverage before normal detail:

1. Select and display the root overview.
2. Select a coarse frontier whose target is above every direct-child SSE but
   below the root SSE. Keep the root visible until the frontier is attached and
   all queues settle.
3. Capture that complete coarse frontier and only then enable camera-driven
   refinement. Detail 16 starts one bounded refinement step beyond the completed
   frontier instead of staying equal to the bootstrap target or immediately
   selecting the entire zero-error hierarchy. On the church hierarchy the
   temporary target is 1,024 and the steady Detail 16 target is 512.

The captured coarse frontier alone is retained in the LRU and registered as a
scoped `REPLACE` fallback. Returning to Home can therefore display a captured
coarse branch that was not active in the previous close frame while its newly
selected descendants continue loading. This does not enable ancestor loading,
retain unrelated intermediate/fine paths, or render an overlapping root
backdrop. The renderer uses a shared LRU, so the narrow retention wrapper is
restored on every tile renderer disposal before another model can load. Clients
reporting 4 GiB or less settle on the complete renderable root, remain capped at
Detail 13, and keep the separate 768 MiB reduced-memory profile; the church's
roughly 1.27 GiB coarse frontier cannot safely replace that root on this budget.

The ordinary desktop cache retains 0.4 GiB below a 1.75 GiB maximum, with 8
warm entries and a 1,024-item failsafe. The byte ceiling is the real memory
guard. A low 48-item ceiling is invalid because a camera-selected frontier can
contain more than 48 small leaves and branch parents while using almost none of
the byte budget. When a measured complete overview is at least 0.75 GiB and
already consumes most of the ordinary ceiling, the runtime grants bounded
branch-completion headroom equal to overview bytes plus 1.75 GiB, capped at
3 GiB. Small models stay at 1.75 GiB and reduced-memory clients never expand.

The reduced profile retains 640 MiB below 768 MiB, with 256 warm and 512
maximum entries. Both profiles unload 20 percent per eviction pass once unused
content exceeds their warm floors. Two consecutive one-second full-cache,
idle-queue samples with a selected in-frustum tile still pending request bounded
cache-admission recovery. Cache pressure never lowers `activeDetail`, changes
the requested screen-space-error target, or latches a global quality ceiling.

The generated browser fixtures verify complete coarse startup, descendant
refinement, scoped fallback on camera return, stable tiny movement, and shared
LRU lifecycle cleanup. The authenticated church hierarchy verifies the
large-model path: 16/16 coarse tiles attached before refinement; all 48 sampled
bootstrap, close, orbit, and return frames retained structural coverage; steady
Detail 16 moved from target 1,024 to 512; and 12 fine leaves rendered in the
unchanged close view within 30 seconds. Return immediately recovered complete
coverage with captured coarse fallbacks while selected intermediate work kept
streaming. No runtime exceptions occurred. A forced 4 GiB run kept complete root
coverage across all sampled frames and honestly remained root-only because the
required church replacement frontier exceeded its 768 MiB cache.

See [`VIEWER_LOD_CAMERA_HANDOFF.md`](VIEWER_LOD_CAMERA_HANDOFF.md) for historical
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
`assets/odm_texturing/odm_textured_model_geo.glb`. Production requires current
KTX2 generation for eligible new OBJ+GLB work even when the bundle includes
legacy JPEG tiles. The generated tree is registered only after its controlled
proof succeeds. Existing ready and published versions are immutable: there is
no legacy-model reconciliation or manual in-place retry. Operators may set
`MESH_DERIVATIVES_ENABLED=false`, but an eligible required job then fails closed
instead of becoming ready with missing or legacy streaming assets.

GLB-only and OBJ-only inputs deliberately remain downloadable originals, but
are not interactive Viewer layers. The runtime image contains the pinned
Obj2Tiles converter for the audited OBJ+GLB contract only; format conversion
alone is not proof that node transforms, materials, samplers, UVs, texture
bytes, and coordinates survived. Do not add a best-effort single-format
conversion or declare generated tiles valid without an independent source mesh
that the audit can compare. Supporting a single-format source needs a
separately pinned converter, conversion-preservation tests for representative
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
GiB before completion. Current generation adds `--texture-format Ktx2
--ktx2-quality 192`, producing ETC1S textures that remain GPU-compressed through
Three.js `KTX2Loader`. The runtime smoke test executes the pinned converter,
requires generated `KHR_texture_basisu` / `image/ktx2` payloads, runs the
controlled audit, and fails the image build if any stage is missing.

Locally generated output uses schema-v3 controlled-converter proof instead of
weakening exact v2. V3 binds the approved architecture-specific Obj2Tiles 1.6.2
executable digest and exact KTX2 command, the GLB and OBJ digests, every audited
artifact, a valid zero-error frontier, full-detail bounds/area/centroid/second
moments, deterministic bidirectional BVH samples in rebased coordinates, and
all-triangle opaque textured base-color/TEXCOORD_0 coverage. The controlled
path accepts bound `KHR_texture_basisu` sources while imported exact-v2 audits
continue to reject alternate compressed sources unless their exact texture
identity can be proved. Shifted or missing patches, unapproved executables,
missing UVs, and untextured materials fail closed.
The server enables the worker stage when an older deployment omits the variable.
Setting `MESH_DERIVATIVES_ENABLED=false` makes eligible required OBJ+GLB work
fail closed; it does not bypass KTX2 readiness. Verified imported tiles may
stream when no eligible OBJ+GLB source is available.
The original GLB is never an interactive layer and remains available only through
authenticated Operations downloads. A model without verified tiles is explicitly
unavailable or processing in 3D mode instead of risking a full-resolution browser
decode.

Automatic generation remains verification-gated. New NodeODM and import work
with an eligible OBJ+GLB mesh stays in `derivatives` until the required KTX2 tree
verifies, even when the source bundle includes legacy JPEG tiles. A terminal
failure is reported as a failed job rather than a misleading ready result.

Successful ready and published versions are immutable. The worker does not run
legacy LOD discovery/recovery, does not switch an active asset row in place, and
does not expose manual in-place generation or retry. Existing verified JPEG
provenance remains readable. Upgrading an existing model requires a new
processing attempt/model version, which is reviewed before explicit publication.
Imported/native tiles stay on exact v2; only the trusted local generation call
site may request controlled v3. Do not manually change provenance or derivative
state.

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
