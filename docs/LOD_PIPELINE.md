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
The persisted hierarchy remains `REPLACE`. Only after a renderable root passes
validation may the runtime set that root to `ADD` as a whole-model coarse
backdrop; it never changes the source manifest. Ancestor/sibling preload stays
disabled so only the active view branch remains pinned. When the backdrop is
active, a post-update pass releases a stale zero-error leaf only after its
parent is out of the frustum or already meets the error target. The cache is
reduced on mobile/low-memory devices. Moving away naturally makes the coarse
parent meet the error target again, after which inactive detailed children can
be evicted.

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
quarantined, audited, and registered only after the proof succeeds. Automatic
generation and legacy generation backfill remain default-off; an explicit
operator opt-in permits a single bounded attempt and a manual retry.

GLB-only and OBJ-only inputs deliberately remain on their available full-mesh
fallback. The runtime image does not contain a pinned mesh interchange
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
legacy-v1, or hand-authored assertion causes a safe fallback to the actual GLB
instead of a false full-quality claim.

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

Spatial partitioning itself is supported when leaves retain the source
triangles. If a tiler clips triangles at tile boundaries or retriangulates the
surface, triangle topology differs and this algorithm cannot prove exact
equivalence even when the rendered surfaces look the same. Likewise, texture
atlas repacking or lossless re-encoding changes texture bytes and is rejected.
The production Obj2Tiles invocation deliberately uses a bounded texture-atlas
contract instead of `--keeptextures`: on a representative 2.53 GiB textured
WebODM model, `--keeptextures` duplicated source textures into more than 157
GiB before completion. The bounded invocation completed in about three minutes
and produced a 0.89 GiB hierarchy, but its full-detail frontier retriangulated
the 1,148,233 source triangles into 1,270,357 leaf triangles, so the v2 audit
correctly rejected it. `MESH_DERIVATIVES_ENABLED` therefore defaults to false.
Verified imported tiles may stream. The original GLB remains a guarded fallback
only when the browser's reported memory or Chromium heap ceiling leaves enough
decode headroom; an oversized GLB with no verified tiles is explicitly
unavailable instead of risking a tab crash.
Automatic generation must stay opt-in/experimental until a separately
versioned surface-and-appearance proof is implemented; do not loosen the v2
result or manually change the provenance file.

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
