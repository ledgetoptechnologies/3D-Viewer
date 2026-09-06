# Private measurements: identity and API contract

## Authorization boundaries

Viewer access does **not** confer workspace administration. A share grants access only to the referenced task/model version, or the tasks permitted through the shared project. Private measurements are personal annotations within that existing access; they do not grant import, processing, reconstruction, project editing, or sharing authority.

Personal records are scoped by trusted `(audience, subject, modelId, modelVersionId)`. The server reads all four from the live, signed Viewer session. Clients cannot override them in JSON, URLs, or query parameters. The UI exposes one personal list across model, point cloud, orthophoto, DSM and DTM. The immutable `spatial3d` and `map` collection fields retain creation/calculation provenance, not separate UI workspaces. No database migration or broader access is required.

View changes preserve record identity, selection, visibility, export choices, original coordinates and calculated results. A 3D measurement projects to a map by its horizontal coordinates; its saved 3D lengths do not silently become horizontal lengths. A map measurement's placeholder Z is never treated as measured elevation in 3D. Display-only placement uses a matching, explicitly unit-declared existing DSM/DTM, or a matching-version retained sampled boundary with explicit unit provenance. Missing source, unknown units, NoData, incompatible CRS or excessive native sampling extent leaves the saved record available with an unavailable-overlay explanation. It does not guess heights or submit processing jobs.

Vertex editing stays within the creation family (model/point cloud or orthophoto/DSM/DTM), avoiding accidental replacement of measured heights with map Z=0. Rename, visibility, deletion and export are shared across all views. Exports retain original geometry and provenance rather than display-only sampled elevations. Captures warn when a visible overlay is still pending or unavailable instead of silently omitting it. Sampling is cached, limited to two concurrent requests, uses shared background decoder workers, and aborts/ignores stale work after view changes, record replacement, disposal or lost access.

Both `view` and `measure` permissions must be true. Expiry, revocation, an unavailable review output, or a changed published active version denies access. New sessions for the same individual/version recover the same records; reprocessing does not move records onto changed geometry. Users cannot list, edit, delete, or export another user's records, including users at the same client company. Public shares cannot use persistence APIs.

### Operations handoff: individual client identity

The existing service-only `POST /api/v1/models/:modelId/sessions` contract accepts the optional boolean `permissions.personalMeasurements`. Operations may set this to **true only when the signed `subject` identifies a stable individual person**. Do not use a company, project, shared login, mutable email, or client-grant ID as that subject. Preserve the same subject on renewal and later visits. Staff sessions already use the trusted staff subject in the `ops` audience. `POST /api/v1/sessions/redeem` is the separate one-time grant redemption endpoint.

Legacy client grants omit the attestation and intentionally remain temporary-only. `GET /api/v1/measurements` returns an empty list and `capabilities.personalPersistence:false`, with a notice; mutations return `403 personal_measurement_identity_required`. This response does not reveal existing records for the unverified identity. The browser should retain in-memory measurements and explain that refresh loses them, rather than continuously retrying autosave.

No Operations repository changes are included here. Its integration agent must verify per-person identity before enabling this flag. An end user cannot enable it from the Viewer UI or a measurement request.

### Administrative calculation authority

Server calculations additionally require `X-Viewer-Admin-Authorization: Bearer <workspace token>`. The workspace token must be live, have explicit `viewer.processing.write`, and match the `ops` Viewer session's person. An `ops` audience alone, a client Viewer token, or workspace read access is insufficient. The separate administrative token is never stored in a measurement document or returned with a result. Job authority is checked for submission, retrieval, cancellation, and worker execution. Administrators decide whether to grant processing authority to another staff member; general viewing access does not imply it.

The isolated model tab does **not** receive this workspace token. Its already registered random review-controller BroadcastChannel carries narrowly typed measurement requests to the workspace. `measurement-calculation-broker.mjs` first verifies `/api/v1/sessions/current` using only the model's Viewer bearer, pins the same staff subject and exact model/version/mode/attempt, and only then attaches the workspace token to fixed calculation endpoints. It rejects arbitrary paths, client sessions, stale/foreign scope, missing write permission, redirects, duplicate channel request IDs, and late completion after sign-out. Fetches are bounded by 15-second timeouts. Routing descriptors persist no credentials.

Broker request: `{version:1,type:'ltds-viewer:measurement-request',requestId:<uuid>,modelId,modelVersionId,viewerToken,operation,payload}`. Operations are `capabilities` with `{}`, `create` with `{measurementId,request}`, `list` with `{measurementId}`, and `status`/`cancel` with `{measurementId,jobId}`. Responses are correlated `ltds-viewer:measurement-response` messages containing the exact model/version/request ID and either `ok:true,result` or `ok:false,code,status`. A closed/unavailable workspace cannot broker calculations; ordinary personal measurement tools remain independent.

## CRUD

All routes use explicit `Authorization: Bearer <viewer token>` and `Cache-Control:no-store`. Ambient Viewer cookies are not accepted by these APIs. They do not enable cross-origin credential sharing.

- `GET /api/v1/measurements?collection=spatial3d|map`: `{measurements, capabilities:{personalPersistence,serverCalculations}}`; omit collection for both.
- `GET /api/v1/measurements/capabilities`: capability flags without loading documents. Administratively authorized callers additionally receive registered eligible `calculationSources` with asset ID, kind, format, byte size, and explicitly supported `methods`—not server paths or credentials. Only advertised native DSM/DTM, EPT, and OBJ workflows are shown; unavailable reconstruction methods must not be invented by the UI.
- `GET /api/v1/measurements/:id`: `{measurement}`; another person's ID returns the same 404 as an absent ID.
- `POST /api/v1/measurements`: full document below. Returns 201, or 200 for the same creation ID and original normalized request. A changed retry returns 409.
- `PUT /api/v1/measurements/:id`: full document plus current `revision`; returns the next revision. Stale revisions return 409. ID, collection, kind, coordinate reference, and model version cannot change.
- `DELETE /api/v1/measurements/:id`: JSON `{revision}`; returns 204, including a matching retry. Tombstones prevent a delayed create retry from resurrecting a deletion. Personal geometry/results and job snapshots are cleared; only minimal identity/revision/timestamp/idempotency metadata remains.

```json
{
  "id": "9fc321ab-74ac-4c15-b451-acfa8f7b0b9f",
  "name": "North side",
  "collection": "spatial3d",
  "kind": "polygon",
  "vertices": [[400000.1234567,4500000,200],[400010,4500000,201],[400010,4500010,202]],
  "coordinateReference": {"crs":"EPSG:32616","verticalUnit":"m"},
  "visible": true,
  "source": {"kind":"dsm","assetId":"registered-asset-id"},
  "displayPreferences": {"units":"ft","showLabels":true,"color":"#ef5800"}
}
```

`kind` is distance or polygon. Coordinates and results retain full numerical precision; formatting to three decimals belongs in the display layer. The source reference identifies provenance only, never an arbitrary server file path. A calculation must resolve a registered asset against the exact version.

Optional `results` is a bounded JSON object. Browser-supplied results are always marked `calculationOrigin:"browser", verified:false`, regardless of claimed fields; they must never masquerade as server-verified survey outputs. Server calculations are stored and served separately. Successful responses add `modelId`, `modelVersionId`, `revision`, `createdAt`, and `updatedAt`; exclude these server-owned fields from update bodies other than revision.

Limits: 2,000 vertices, 256 KiB document, 1,000 live documents per person/version, 180 mutations/minute/person. Names are bounded to 200 characters. Requests reject unknown root fields, nonfinite/out-of-range coordinates, invalid units, deep/oversized result objects, and mismatched IDs. An edit cancels queued/running results for the preceding revision.

## Administrative model-tab interface

`measurement-admin-client.mjs` serializes correlated requests over the registered model controller channel, with finite timeouts and cancellation on client disposal. `measurement-admin-dialog.mjs` opens only after administrative capability verification. It lists recent jobs, submits an explicit source/method, refreshes progress, supports cancellation, and displays actual result warnings and coverage. Closing the dialog stops polling and releases its preview; it does not silently cancel an already accepted server job.

- Native raster surface calculation accepts a registered DSM/DTM source plus the selected reference definition. A source-elevation meter assertion is explicit when metadata is missing.
- Point-surface calculation accepts the registered EPT source, an explicit grid cell size equivalent to 0.001–100 meters, all/ground classification filter, and the reference definition. No automatic coarsening is hidden in the UI.
- Closed-mesh calculation accepts a registered OBJ source, explicit projected/local-ENU frame, a selected-object seed, and lower/upper elevations. Open or cropped geometry is not automatically sealed.
- Reconstructed estimate is shown only when the server advertises the verified native reconstruction runtime for an eligible OBJ/EPT source. The administrator must explicitly acknowledge inferred geometry, choose depth 6–9, provide normal-neighborhood radius and observation-support distance (positive and no greater than 100 meters), and verify the seed and vertical selection. OBJ requires a coordinate-frame declaration; EPT requires a meter-elevation assertion and all/ground filter. No inferred shell is labeled an observed solid-material volume.

Base elevation, offset, grid size, seed elevation, and vertical bounds use the selected display length units (decimal feet for imperial) and convert to meters only at the request boundary. Easting and northing inputs remain explicitly in coordinate-reference-system meters. Requests pin the saved revision. When saving a completed result advances that revision, the dialog accepts only the same geometry/version returned from its own attachment; changed geometry requires reopening. Old job revisions are labeled, not silently attached to new geometry.

`measurement-region-preview.mjs` shows only the calculated region with independent rotation and fit controls. Surface samples are orange above the gray reference and blue below it. Selected observed mesh geometry is cyan; explicitly inferred geometry is pink and labeled as estimated. Bounded geometry is translated before GPU conversion to preserve detail at large projected coordinates. WebGL/data failure leaves an explicit unavailable notice while retaining numerical results. Dialog close disposes controls, buffers, materials, observers, frame callbacks, and its WebGL context.

## Verification

`test/measurement-private-api.test.js` covers person/audience isolation, renewal, stale versions, public/cookie-only/expired/revoked/denied sessions, default-denied legacy client identities, retry-safe create/delete, revision conflicts, full-precision values, immutable record identity, bounds, forged identity, browser result provenance, cancelled stale jobs, and server-job denial for clients even with an unrelated staff capability.

Migration 32 creates private records and calculation jobs. Existing runtime/CI schema assertions are updated to 32; no existing model geometry is rewritten. Separate integration acceptance is still required for Operations' real client identity and renewal contract.

The browser store exposes `invalidate()` and `isInvalidated()`. Identity/access invalidation clears private records, statuses and drafts owned by the workspace, aborts outstanding requests, and fences late responses/queued mutations using a generation counter. The workspace must call invalidation when its trusted owner or model-version identity changes. HTTP 401/403 also fails closed. An expired signed-in session cannot silently become a temporary public workspace; explicit authenticated reload is required. Normal token renewal for the same trusted identity remains supported. Lifecycle regression tests cover late writes, late JSON, queued saves, deletion races and token loss.
