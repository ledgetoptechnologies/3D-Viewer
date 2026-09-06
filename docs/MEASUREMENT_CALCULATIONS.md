# Bounded private measurement calculations

## Permission boundary

Viewing a shared project or task never grants processing authority. Browser-side bounded existing-raster calculations remain separate from server jobs. Every server calculation create/list/read/cancel request requires both the live Viewer bearer for the exact immutable model version and a separate matching-person Operations admin bearer with explicit `viewer.processing.write`. `audience: ops`, ordinary account access, sharing, and personal measurement persistence alone are not sufficient. The worker rechecks both sessions, current model/version availability, ownership and revision while running and before storing results.

Jobs snapshot saved canonical `[E,N,Z]` metre vertices, collection, coordinate reference, registered source asset identity, method and settings. Client paths and alternate geometry are not accepted. Source files are hash-verified. Measurement edits cancel queued/running jobs; deletion cancels jobs and removes their retained private input/result. Terminal calculation history is bounded to twenty per measurement. Job responses never expose source paths or capability hashes. A stopped worker marks expired leases failed instead of silently retrying costly work.

## Methods and what they mean

| Method | Authoritative input | Result and limitations |
| --- | --- | --- |
| `surface-cut-fill` | Original registered DSM/DTM GeoTIFF, image 0 | Native-cell 2.5D surface above/below the selected base. No overview or display-tile calculation. |
| `point-surface-cut-fill` | Original EPT manifest and every intersecting hierarchy node | All source points contribute to a topmost-point grid at an explicit requested cell size; optional ground class 2. This is a 2.5D surface, not the enclosed volume of a car/building. |
| `closed-mesh` | Original OBJ, explicitly declared projected or local-ENU frame | Seed-selected connected original mesh component within the selected polygon and elevation bounds; only a validated closed manifold produces a volume. Cropping that opens the object fails. |
| `reconstructed-estimate` | Selected original OBJ surface vertices or all selected native EPT points | Explicit opt-in screened-Poisson reconstruction, then closed-mesh validation. Every generated face is inferred. The output is an estimate, never an observed-object/exact volume. |

Surface references are boundary-triangulated, fitted plane, explicit custom horizontal elevation, or lowest/highest/average boundary elevation, with optional offset. Map measurements store placeholder Z coordinates; server calculations resample boundary elevations from the native raster/requested native-point grid for every non-custom reference. Missing boundary elevation fails rather than implicitly using zero. Spatial 3D measurements use their saved picked boundary elevation.

Surface integration clips each native cell against the polygon and the piecewise-linear base patches, then clips positive and negative portions before integrating. Fractional edge cells and base sign crossings are accounted for. Nodata, missing point cells and missing raster extent stay missing, produce incomplete coverage, and are never filled with zero. Values retain double precision; displayed decimal places are not a claim of survey accuracy. Grid calculations model each cell's height as constant, so input resolution and sampling remain physical limitations.

GeoTIFF requires matching projected CRS and metre horizontal units; WGS84 UTM CRS implies metre horizontal units. Point EPT currently requires matching WGS84 UTM. Explicit encoded non-metre vertical units fail. Where vertical units are absent the administrator must declare metres, recorded as a warning/provenance field. Pixel-is-point, rotation, non-north-up rasters and codec blocks exceeding 64 MiB fail rather than guessing transformations. OBJ coordinate-frame declarations are explicit; local ENU uses only registered immutable version RTC offsets. Unsupported frames/CRS fail.

Closed-mesh validation checks exact coincident vertex welding, finite vertices, nondegenerate unique triangular faces, one connected component, two opposite-oriented faces per edge, single vertex fans, and triangle self-intersections using a bounded BVH search. It computes shifted-origin signed-tetrahedron volume. It does not fill holes, simplify a source into a box, or accept disconnected shells as one object.

## Reconstruction support and provenance

The existing worker image builds the official [PoissonRecon](https://github.com/mkazhdan/PoissonRecon) C++ executable from commit `262b0f539d404057d1f36e1adc07fc9388678899` (18.76). Source archive SHA-256: `4a07ad091a63cc8403c57a8906b97b41d07c2fd87aa8aad0e7680dac20c4dcd5`.

`third_party/poissonrecon/262b0f5-two-threads.patch` pins the internal thread pool to two threads. Docker verifies the patch SHA-256 as well as the archive, builds with double precision, standard C++17/OpenMP, and no fast-math. The source license and build receipt are included in `/opt/poisson`. There is no new service, external API, runtime package download, or Open3D wheel dependency. Capability discovery advertises reconstruction only when this installed executable and pinned build receipt are present.

Reconstruction request:

```json
{
  "revision": 1,
  "method": "reconstructed-estimate",
  "sourceAssetId": "registered-native-source-id",
  "sourceCoordinateFrame": "projected",
  "selection": { "seed": [367000, 4759000, 100], "minElevationM": 98, "maxElevationM": 105 },
  "reconstruction": { "depth": 6, "normalRadiusM": 0.3, "supportDistanceM": 0.08, "acknowledgeInferredGeometry": true }
}
```

EPT uses `sourceVerticalUnit: "m"` and optional `classFilter`, without an OBJ frame choice. Normals use bounded 24-neighbor PCA within the explicit radius, seeded connectivity, and consistent neighbor orientation. Depth is 6–9; radii/support distance must be positive and at most 100 metres. Sparse, unstable, excessively large or unclosed results fail. Seed connectivity can exclude disconnected points; counts are recorded.

The result records source identity, reconstruction settings, engine commit/precision/thread count, selected/excluded point counts, closed-mesh checks and nearest-source-distance percentiles. Generated geometry must remain within the selected polygon and vertical limits; edges crossing concave boundaries also fail. An estimate that extends outside fails with `measurement_reconstruction_outside_selection`; expand the selection deliberately if appropriate. The implementation does not clip and seal an escaped shape to manufacture a volume. The support distance overlay reports proximity only: a generated underside may be close to observed points without ever having been observed. All preview faces are marked inferred; unsupported-area fraction additionally reports triangles with vertices farther than the explicitly chosen support distance. Poisson can bridge gaps, invent an underside and smooth edges. These estimates need independent real-object validation before commercial quantity claims.

## Resource and privacy limits

- Existing processing worker only; one active measurement job, with symmetric database admission against heavy dataset/processing/derivative jobs. Maximum twenty queued/running measurement jobs globally.
- Default two million native cells; configurable cap up to sixteen million, with an additional thirty-million cell/reference-patch operation limit. No silent coarsening.
- Native TIFF reads in 128-cell windows. EPT uses at most 20,000 intersecting nodes/10,000 hierarchy pages, 64 MiB per node, two million decoded points per node and twenty million points read per selection.
- Reconstruction accepts 50–100,000 selected unique sample candidates, with at most 200,000 output vertices/faces and 32 MiB generated ASCII output. Closed source selection similarly caps 200,000 vertices/faces. Intersection validation has a finite test budget.
- V8 old-space capped at 1 GiB. Default total calculation memory 4 GiB; parent RSS checks run independently of child event-loop activity. Native subprocess RSS plus Node RSS is also checked. Two native threads; deadline default 300 seconds, configurable maximum 900 seconds; native Poisson has its own 240-second deadline.
- Cancellation, revoked access, changed measurement revision, timeout or lost lease kills the child process group, including native descendants on Linux. Private scratch directories are removed after termination. Only bounded previews/results are persisted; source rasters, clouds and full reconstructed meshes are not copied into measurement rows.

Environment controls: `MEASUREMENT_CALCULATIONS_ENABLED`, `MEASUREMENT_MAX_CELLS`, `MEASUREMENT_MEMORY_MIB`, `MEASUREMENT_TIMEOUT_MS`, `MEASUREMENT_POISSON_BIN`.

## Verification and remaining deployment checks

Focused tests cover exact fractional cells, base cut/fill crossings, projected-coordinate stability, negative and zero elevation, nodata/coverage, map boundary resampling, source hashes, native TIFF windows, all-level EPT binary reads, bundled offline LAZ decoding, closed/open/intersecting meshes, PCA normal orientation, parser bounds, job ownership/revision/revocation and explicit estimate acknowledgement.

Both amd64 and ARM64 pinned native source stages compiled and executed their usage smoke successfully. The final non-root amd64 runtime candidate (`ltds-viewer:measurement-runtime-candidate`) passed 36 focused calculation/private-API tests with zero skips, mounting only read-only tests—not replacement application code. Native reconstruction of an analytic unit sphere and a full original-EPT-to-reconstruction sphere pipeline stayed within an explicit 0.2 m³ tolerance of 4π/3. This verifies a bounded synthetic case, not a general accuracy guarantee. ARM64 reconstruction numerical comparison beyond the compile/executable smoke has not been run.

Before production acceptance, verify the final full worker image with real projected datasets, sparse/occluded surfaces, permission revocation during native work, worker restart, competing imports, and client network requests demonstrating no job capability. Compare quantities against a known reference object and record source accuracy, base selection, point spacing and support warnings. No processing job or production dataset was launched by the local tests.
