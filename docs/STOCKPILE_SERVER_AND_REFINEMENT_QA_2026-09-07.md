# Stockpile server workflow and point-cloud refinement — in progress

This is a working QA record, not a release or completion attestation.

## User requirements

- Ordinary stockpile workflow: outline the pile, receive volume and an honest
  side-section preview, without routine exposure to server job mechanics.
- All normal stockpile volume calculations use the Viewer server worker, for
  staff and authorized clients, with a separate ephemeral lifecycle needed for
  public/temporary measurements. This does not grant general processing authority.
- Preserve personal ownership and immutable model/version/revision scope.
- Point-cloud movement is now reported smooth by the user. The remaining
  reported problem is insufficient local refinement when zooming closer.
  Preserve the working controls and do not substitute a lower density.

## Local implementation

- The production normal surface inspector selects the server calculator through
  a direct, scoped Viewer-bearer client. Missing/delayed authority or a failed
  request cannot silently select browser volume calculation.
- The signed-in personal raster path is implemented locally. Verified individual
  staff/client sessions can create/list/read/cancel only their own native DSM/DTM
  surface jobs on the authorized immutable model version. They do not receive
  import, reprocessing, reconstruction or general processing permission.
  Advanced methods retain the separate matching-person staff capability.
- Public-link and temporary-identity server calculations are implemented locally
  through the separate schema-33 `ephemeral_measurement_jobs` lifecycle. They
  require valid measurement access, the exact displayed model version and a
  hashed random per-page handle; shared raster sources must be published.
  Same-page recovery uses measurement-scoped lists and geometry hashes with
  fixed-order CRS/unit values. Refresh creates a new handle and restores no old
  public records. No permanent personal row or synthetic individual is created.
- Temporary results/work expire after at most fifteen minutes or earlier grant
  expiry; refresh/close does not promise immediate server cancellation. The
  private and temporary lanes share the global twenty queued/running-job ceiling
  and existing heavy-job admission. Temporary retention additionally caps forty
  rows per grant/version scope. Final lifecycle/full-suite acceptance is pending.
  No Operations repository changes were made.
- New polygons save first, then open their automatic surface calculation. Opening
  an existing polygon does not submit a new job. One request creates the job;
  subsequent requests only poll that identifier.
- Results must match the measurement revision, source, model version and base.
  Switching views, closing or losing access retires the observer; it does not
  falsely claim that an accepted server job was cancelled.
- Normal inspector resume/cancel is implemented locally: before submission, the
  helper checks the same revision and source/base/unit parameters for queued,
  running or completed work. Matching work is observed/retrieved rather than
  deliberately duplicated; a create race triggers another check. Different
  active settings expose cancellation in the ordinary inspector. Closing stops
  observation; reopening and calculating with the same settings resumes it.
- Recognized unit/source/raster/conflict errors survive the broker and channel as
  exact allowlisted codes. Raw server messages and unknown codes are not exposed.
  The ordinary inspector maps common errors to plain-language guidance.
- Explicit nonmetric horizontal units are no longer overridden by a UTM code in
  native server raster validation.
- Missing vertical metadata remains an explicit guard. An ordinary server metre
  assertion is recorded as `requester-declared`, not falsely attributed to an
  administrator. Separate staff authority retains `administrator-declared`.
  Neither declaration is independent proof of the actual source units.

## County Road D: live observation

The deployed ababb06 Viewer normal surface inspector was tested on the existing
`QA 2026-09-06 — feed pile` measurement. It rejected calculation because the raster
does not encode recognized elevation units. The confirmation remained unchecked;
no result or geometry was changed. Running the same raster on the server alone
does not establish its units.

Current import records preserve source hashes and provider labels, but not an
authoritative vertical-unit pipeline contract. Provider name, filename, horizontal
EPSG, or an ODM software tag is insufficient evidence by itself. Original data
must not be silently modified or reprocessed to work around this.

### Read-only source inspection handoff

On the exact immutable County Road D version, inspect:

1. DSM band unit, VerticalUnits GeoKey and any vertical CRS/WKT declaration.
2. EPT `srs.wkt` vertical axis and retained georeference summary/info metadata.
3. Original WebODM task generation metadata/logs, if available, including engine
   version, alignment/GCP/geolocation settings and the DSM's exact hash.

Return the declared vertical units and the evidence bound to that asset hash.
If absent, report absence instead of confirming meters. Do not edit Operations
code, metadata, source TIFFs, share grants, or processing jobs for this inspection.
Future import work should retain a small verified unit-provenance record bound to
the immutable asset; nontechnical users should not repeatedly configure it.

## Live cloud observations before the new selection patch

One Viewer cloud frame, RGB, fixed size 1, requested budget 10M, EDL initially on;
framebuffer 875 × 822. App diagnostics measure CPU stages, not GPU execution.

| View/sample | Submitted points | Frame mean/max | Update/render | Uploads |
| --- | ---: | --- | --- | --- |
| Initial settled broad view | 7,456,299 | 11.8 / 17.9 ms | 0.3 / 0.6 ms | 0 |
| After orbit | 9,968,515 | 15.6 / 28.3 ms | 0.3 / 0.8 ms | 0 |
| Closer view after adaptation | 4,808,466 | 22.4 / 56.5 ms | 0.4 / 0.8 ms | 0 |
| Temporary EDL-off sample | 5,583,898 average | 25.0 / 55.6 ms | 0.4 / 0.8 ms | 0 |

These are sequential UI observations, not a controlled before/after benchmark.
They do not establish a GPU bottleneck or demonstrate that adaptation fixes the
reported issue. Display defaults were restored and the Viewer returned to DSM.
The diagnostics button was obscured by parent reset/fullscreen controls; it was
activated via keyboard. Local CSS now reserves that top-right control space.

## Selection regression

The installed pinned Potree visibility routine allowed level <=2 nodes to bypass
visibility/budget decisions and broke the entire traversal when one node exceeded
the remaining global budget. An off-screen node could therefore starve local
detail. The build-time patch removes the coarse override and skips an oversized
subtree while continuing eligible siblings. Parent-first additive traversal and
the requested ceiling remain intact.

Actual installed-routine tests reproduce 0 or 50k selected points with the old
code where a visible 60k node should fit a 100k budget; the patch selects 60k.
These tests stub geometry/render I/O and do not prove dense live rendering.
Independent review identifies remaining-frontier traversal CPU cost as a live
verification requirement.

The local patch also reports per-cloud, spatially eligible budget-blocked demand
and whether selected ancestor geometry is actually drawn/settled. The adaptive
budget can make a bounded recovery probe even below 70% population when a whole
eligible additive node cannot fit the remaining budget. Empty/loading scenes or
off-screen nodes do not justify growth. Requested ceilings, overload rollback
and backoff remain in force. This addresses a selector/adaptation deadlock;
installed-routine fixtures are not proof of live dense zoom performance.

## Verification so far

- Final source-bearing isolated Linux image: 1,407 tests, 1,386 passed, zero
  failed, 21 environment-dependent skips; process exited successfully. Log:
  `data/qa/stockpile-server-source-tests.log`. Network disabled, no production
  data mounted. Includes the actual patched Potree bundle and schema 33.
  Skips require Chromium/real tile fixtures or a host-bind environment; they
  are not counted as passing browser/deployment tests.
- Later helper/direct-client/dialog focused tests: 46 passed, zero failed.
- Actual installed-Potree selector/demand tests: 35 passed, zero failed/skipped.
  Geometry/render I/O is isolated; this does not establish real dense GPU timing.
- Production-contract checks: 9 passed, zero failed.
- Separate final Windows/headless browser regression run: 43 tests, 39 passed,
  zero failed, 4 skipped for the unavailable real tile dataset fixture. Includes
  model detail/foreground retention, camera-photo rendering, history/refresh
  teardown, KTX2/CSP, normal server inspector, public project sharing, session
  renewal and desktop/mobile workspace/download recovery. Log:
  `data/qa/stockpile-final-browser-tests.log`. This is isolated test data, not a
  deployed County Road D performance or volume acceptance test.
- Isolated real headless-browser inspector tests: 4 passed, zero failed/skipped.
  Shipped helper, direct client, dialog and styles call only a synthetic loopback
  API. Covered queued/completed recovery without duplicate submission, result
  presentation and keyboard-inspectable sampled chart, missing-unit error without
  guessed confirmation or fallback, and cancellation without a new result save.
  This verifies UI/transport behavior, not real raster integration accuracy.
  Screenshot `data/qa/stockpile-server-browser-inspector.png` was visually checked.
  Windows retained locks on disposable browser profiles; cleanup reported those
  locks instead of forcing unrelated deletion.
- These are separate focused snapshots, not additive final-suite totals.
- Private/temporary backend checks: 28 passed, including direct client/helper
  through HTTP and worker result delivery, geometry-hash agreement, exact-version
  rejection and older active-job recovery without personal-row creation.
- Production image build succeeded locally. No new release pushed from this batch.
- An initial attempt to run the whole source suite in the production-only image
  lacked test source/dev dependencies. It is invalid QA, not a passing gate; its
  exact disposable container was stopped after the corrected source-image run.
- The Windows full-suite attempt finished unsuccessfully. Observed failures
  included Linux-specific `/proc/self/fdinfo` expectations and browser timeouts;
  not every failure has been classified. Do not conflate it with the Linux run
  or label all failures environmental without evidence. The subsequent isolated
  browser run above passed the previously timed-out lifecycle and KTX2 cases.

## Not yet proven

- Actual County Road D stockpile units and independently checked live volume.
- Dense live local-refinement behavior and navigation timing after deployment.
- Live/deployed acceptance of the normal inspector's resume/cancel flow beyond
  the isolated synthetic browser checks.
- Live/deployed public/temporary lifecycle acceptance: refresh reset,
  exact-version and per-measurement scope, expiration/revocation and shared
  admission/resource bounds.

The thread goal remains active.
