# LOD derivative contract

The target interaction is Nira-like: show a lightweight overview immediately,
refine only the visible areas as they occupy more screen pixels, reach the full
source quality at close range, and return to lower-detail tiles as the camera
moves away. Nira itself uses server-side pixel streaming; this self-hosted
Viewer instead streams 3D Tiles to the browser and renders them locally.

## Required hierarchy

- `tileset.json` and every external child tileset use `REPLACE` refinement.
- Parent geometric errors decrease monotonically toward the leaves.
- Every terminal leaf has renderable content and `geometricError: 0`.
- Tiles are spatially partitioned. A chain of whole-model LOD files is not an
  acceptable substitute because approaching one area would download the whole
  high-resolution model.
- LOD-0 leaves preserve the source mesh geometry and textures. Intermediate
  levels may be decimated and may use reduced textures.
- All content uses local relative paths and every referenced file is non-empty.

The renderer calculates screen-space error every frame. Its configured error
target decides when a tile refines; there is no fixed camera-distance switch.
Ancestors remain available while children load, and the cache is reduced on
mobile/low-memory devices. Moving away naturally makes the coarse parent meet
the error target again, after which inactive detailed children can be evicted.

## Full-quality attestation

The trusted conversion job writes `lod-provenance.json` beside `tileset.json`:

```json
{
  "schemaVersion": 1,
  "sourceAsset": "model.glb",
  "sourceSha256": "<sha256 of the exact full mesh>",
  "geometry": "preserved",
  "textures": "preserved",
  "leafGeometricError": 0
}
```

Do not hand-author `geometry: "preserved"` or `textures: "preserved"`. The
conversion job must set them only after checking the aggregate LOD-0 output
against the source. The Viewer independently hashes the selected full mesh. A
missing, stale, renamed, or unverified attestation causes a safe fallback to the
actual GLB/OBJ instead of making a false full-quality claim.

## Validate before deployment

```bash
npm run validate:lod -- /path/to/derivatives/project-task /path/to/full/model.glb
```

The command recursively validates the root and external child tilesets,
zero-error leaf frontier, content paths/files, and provenance digest. A valid
result is necessary but real hardware QA is still required: start far away,
move close to several different regions, confirm detail increases without
holes, move back out, and verify memory settles rather than growing without
bound. Repeat on a representative phone viewport/device.
